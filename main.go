package main

import (
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

// --- Meet storage ---

// A Meet holds up to 2 WebSocket connections (peer[0] = host, peer[1] = guest).
type Meet struct {
	peers []*websocket.Conn
}

// meets is a map: meetID (string) → Meet struct
var meets = make(map[string]*Meet)

// mu guards all reads and writes to `meets`
var mu sync.Mutex

// --- WebSocket upgrader ---

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// --- WebSocket handler ---

func handleWS(w http.ResponseWriter, r *http.Request) {
	meetID := r.URL.Query().Get("meetID")
	if meetID == "" {
		http.Error(w, "meetID param required", http.StatusBadRequest)
		return
	}

	// Upgrade HTTP → WebSocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade error:", err)
		return
	}
	defer conn.Close()

	// --- Add peer to meet ---
	mu.Lock()
	meet, exists := meets[meetID]
	if !exists {
		meet = &Meet{}
		meets[meetID] = meet
	}

	// Only 2 peers allowed. Send "meet-full" to the 3rd+ connection then close it.
	if len(meet.peers) >= 2 {
		mu.Unlock()
		log.Printf("Meet %s is full — rejecting connection", meetID)
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"meet-full"}`))
		conn.Close()
		return
	}

	meet.peers = append(meet.peers, conn)
	peerIndex := len(meet.peers) - 1 // 0 = host, 1 = guest
	mu.Unlock()

	log.Printf("Peer %d joined meet %s", peerIndex, meetID)

	// --- Relay loop: read from this peer, forward to the other ---
	for {
		msgType, msg, err := conn.ReadMessage()
		if err != nil {
			log.Printf("Peer %d left meet %s", peerIndex, meetID)
			break
		}

		mu.Lock()
		for i, peer := range meet.peers {
			if i == peerIndex {
				continue // don't echo back to sender
			}
			if err := peer.WriteMessage(msgType, msg); err != nil {
				log.Println("write error:", err)
			}
		}
		mu.Unlock()
	}

	// --- Cleanup on disconnect ---
	mu.Lock()
	hostLeft := peerIndex == 0 // peer 0 is always the host

	// Remove this peer from the slice
	meet.peers = append(meet.peers[:peerIndex], meet.peers[peerIndex+1:]...)

	// If the host left and a guest is still connected, tell the guest the meet is over.
	// After the slice removal, the former guest is now at index 0.
	if hostLeft && len(meet.peers) > 0 {
		meet.peers[0].WriteMessage(websocket.TextMessage, []byte(`{"type":"meet-ended"}`))
		log.Printf("Host left meet %s — notified guest", meetID)
	}

	// If meet is empty, remove it from the map entirely
	if len(meet.peers) == 0 {
		delete(meets, meetID)
		log.Printf("Meet %s closed", meetID)
	}
	mu.Unlock()
}

// --- Main ---

func main() {
	// Serve static files from ./static/
	fs := http.FileServer(http.Dir("./static"))
	http.Handle("/", fs)

	// WebSocket signaling endpoint
	http.HandleFunc("/ws", handleWS)

	log.Println("OpenMeet started → http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
