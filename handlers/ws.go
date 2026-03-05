package handlers

import (
	"context"
	"encoding/json"
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

type Meet struct {
	peers     []*websocket.Conn
	peerUsers []*models.User
	userIDs   []string // parallel to peers — for duplicate session detection
}

var meets = make(map[string]*Meet)
var mu sync.Mutex

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// CheckUserInMeet returns whether the authenticated user is currently in the given meet.
// GET /api/meet/check?meetID=xxx
func CheckUserInMeet(w http.ResponseWriter, r *http.Request) {
	meetID := r.URL.Query().Get("meetID")
	userID := r.Context().Value(middleware.UserIDKey).(string)

	mu.Lock()
	alreadyIn := false
	if meet, ok := meets[meetID]; ok {
		for _, uid := range meet.userIDs {
			if uid == userID {
				alreadyIn = true
				break
			}
		}
	}
	mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"alreadyIn": alreadyIn})
}

// HandleWS is the WebSocket signaling endpoint. Requires JWT via ?token= query param.
func HandleWS(w http.ResponseWriter, r *http.Request) {
	meetID := r.URL.Query().Get("meetID")
	if meetID == "" {
		http.Error(w, "meetID param required", http.StatusBadRequest)
		return
	}

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

	// Detect duplicate session (same user already in this meet)
	isDuplicate := false
	for _, uid := range meet.userIDs {
		if uid == userID {
			isDuplicate = true
			break
		}
	}
	mu.Unlock()

	if isDuplicate {
		// Notify new connection; then wait for force-join or close.
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"already-in-meet"}`))

		// Read messages until we get force-join (ignore others like knock sent in onopen).
		for {
			_, rawMsg, err := conn.ReadMessage()
			if err != nil {
				return // client disconnected or cancelled
			}
			var fm struct {
				Type string `json:"type"`
			}
			json.Unmarshal(rawMsg, &fm)
			if fm.Type == "force-join" {
				break
			}
			// Any other message type is silently ignored while we wait.
		}

		// Evict the old connection for this user.
		mu.Lock()
		for j, uid := range meet.userIDs {
			if uid == userID {
				old := meet.peers[j]
				old.WriteMessage(websocket.TextMessage, []byte(`{"type":"session-replaced"}`))
				old.Close()
				meet.peers     = append(meet.peers[:j],     meet.peers[j+1:]...)
				meet.peerUsers = append(meet.peerUsers[:j], meet.peerUsers[j+1:]...)
				meet.userIDs   = append(meet.userIDs[:j],   meet.userIDs[j+1:]...)
				break
			}
		}
		mu.Unlock()
	}

	// Check meet capacity then add peer.
	mu.Lock()
	if len(meet.peers) >= 2 {
		mu.Unlock()
		log.Printf("Meet %s is full — rejecting %s", meetID, user.Name)
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"meet-full"}`))
		conn.Close()
		return
	}

	meet.peers     = append(meet.peers, conn)
	meet.peerUsers = append(meet.peerUsers, &user)
	meet.userIDs   = append(meet.userIDs, userID)
	peerIndex := len(meet.peers) - 1
	mu.Unlock()

	log.Printf("Peer %d (%s) joined meet %s", peerIndex, user.Name, meetID)

	// Relay loop — forward every message to the other peer.
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

	// Cleanup on disconnect.
	mu.Lock()

	currentIdx := -1
	for i, p := range meet.peers {
		if p == conn {
			currentIdx = i
			break
		}
	}

	if currentIdx != -1 {
		meet.peers     = append(meet.peers[:currentIdx],     meet.peers[currentIdx+1:]...)
		meet.peerUsers = append(meet.peerUsers[:currentIdx], meet.peerUsers[currentIdx+1:]...)
		meet.userIDs   = append(meet.userIDs[:currentIdx],   meet.userIDs[currentIdx+1:]...)

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
