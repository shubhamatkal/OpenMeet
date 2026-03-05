package handlers

import (
	"context"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"

	"github.com/shubhamatkal/OpenMeet/db"
	"github.com/shubhamatkal/OpenMeet/middleware"
	"github.com/shubhamatkal/OpenMeet/models"
)

// --- Meet storage ---

type Meet struct {
	peers     []*websocket.Conn
	peerUsers []*models.User // parallel slice: user info per peer
}

var meets = make(map[string]*Meet)
var mu sync.Mutex

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// HandleWS is the WebSocket signaling endpoint (requires auth via middleware).
func HandleWS(w http.ResponseWriter, r *http.Request) {
	meetID := r.URL.Query().Get("meetID")
	if meetID == "" {
		http.Error(w, "meetID param required", http.StatusBadRequest)
		return
	}

	// Resolve the authenticated user
	userID := r.Context().Value(middleware.UserIDKey).(string)
	oid, _ := primitive.ObjectIDFromHex(userID)
	var user models.User
	if err := db.Users().FindOne(context.Background(), bson.M{"_id": oid}).Decode(&user); err != nil {
		http.Error(w, "user not found", http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade error:", err)
		return
	}
	defer conn.Close()

	mu.Lock()
	meet, exists := meets[meetID]
	if !exists {
		meet = &Meet{}
		meets[meetID] = meet
	}

	if len(meet.peers) >= 2 {
		mu.Unlock()
		log.Printf("Meet %s is full — rejecting %s", meetID, user.Name)
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"meet-full"}`))
		conn.Close()
		return
	}

	meet.peers = append(meet.peers, conn)
	meet.peerUsers = append(meet.peerUsers, &user)
	peerIndex := len(meet.peers) - 1
	mu.Unlock()

	log.Printf("Peer %d (%s) joined meet %s", peerIndex, user.Name, meetID)

	for {
		msgType, msg, err := conn.ReadMessage()
		if err != nil {
			log.Printf("Peer %d (%s) left meet %s", peerIndex, user.Name, meetID)
			break
		}

		mu.Lock()
		for i, peer := range meet.peers {
			if i == peerIndex {
				continue
			}
			if err := peer.WriteMessage(msgType, msg); err != nil {
				log.Println("write error:", err)
			}
		}
		mu.Unlock()
	}

	// --- Cleanup on disconnect ---
	mu.Lock()

	currentIdx := -1
	for i, p := range meet.peers {
		if p == conn {
			currentIdx = i
			break
		}
	}

	if currentIdx != -1 {
		meet.peers = append(meet.peers[:currentIdx], meet.peers[currentIdx+1:]...)
		meet.peerUsers = append(meet.peerUsers[:currentIdx], meet.peerUsers[currentIdx+1:]...)

		hostLeft := peerIndex == 0

		if hostLeft && len(meet.peers) > 0 {
			meet.peers[0].WriteMessage(websocket.TextMessage, []byte(`{"type":"meet-ended"}`))
			log.Printf("Host left meet %s — notified guest", meetID)
		}

		if !hostLeft && len(meet.peers) > 0 {
			meet.peers[0].WriteMessage(websocket.TextMessage, []byte(`{"type":"peer-left"}`))
			log.Printf("Guest left meet %s — notified host", meetID)
		}

		if len(meet.peers) == 0 {
			delete(meets, meetID)
			log.Printf("Meet %s closed", meetID)
		}
	}

	mu.Unlock()
}
