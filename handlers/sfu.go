package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"

	"github.com/shubhamatkal/OpenMeet/db"
	"github.com/shubhamatkal/OpenMeet/middleware"
	"github.com/shubhamatkal/OpenMeet/models"
	"github.com/shubhamatkal/OpenMeet/sfu"
)

// signalingMsg is the JSON shape for all WS messages in the SFU path.
type signalingMsg struct {
	Type      string                   `json:"type"`
	SDP       string                   `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
	UserID    string                   `json:"userID,omitempty"` // for admit / deny
}

var sfuUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// HandleSFU is the WebSocket endpoint for group meetings.
// Route: GET /sfu?meetID=xxx   (JWT via ?token= or Authorization header — handled by middleware.Auth)
func HandleSFU(w http.ResponseWriter, r *http.Request) {
	meetID := r.URL.Query().Get("meetID")
	if meetID == "" {
		http.Error(w, "meetID required", http.StatusBadRequest)
		return
	}

	// Fetch the authenticated user.
	userID := r.Context().Value(middleware.UserIDKey).(string)
	oid, _ := primitive.ObjectIDFromHex(userID)
	var user models.User
	if err := db.Users().FindOne(context.Background(), bson.M{"_id": oid}).Decode(&user); err != nil {
		http.Error(w, "user not found", http.StatusUnauthorized)
		return
	}

	// Upgrade to WebSocket.
	conn, err := sfuUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("sfu: upgrade error:", err)
		return
	}
	defer conn.Close()

	// Build Pion PeerConnection.
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	})
	if err != nil {
		log.Println("sfu: NewPeerConnection:", err)
		return
	}
	defer pc.Close()

	peer := &sfu.Peer{
		ID:   userID,
		User: &user,
		PC:   pc,
	}
	// Set the exported WS field so Peer.SendJSON works.
	peer.SetWS(conn)

	// Join (or create) the room.
	room := sfu.GetOrCreate(meetID)

	// ── Knock / admit flow ────────────────────────────────────────────────────
	// If the room already has people, make the new peer knock and wait for the
	// host to admit or deny them before starting the WebRTC handshake.
	if !room.IsEmpty() {
		peer.SendJSON(map[string]any{"type": "waiting"})
		admitCh := room.Knock(peer)

		// Drain WS in a goroutine so the connection stays alive while waiting.
		// Signal on wsDone when the client disconnects.
		wsDone := make(chan struct{})
		go func() {
			defer close(wsDone)
			for {
				if _, _, err := conn.ReadMessage(); err != nil {
					return
				}
			}
		}()

		select {
		case admitted := <-admitCh:
			if !admitted {
				peer.SendJSON(map[string]any{"type": "denied"})
				log.Printf("sfu: %s denied entry to room %s", user.Name, meetID)
				return
			}
			peer.SendJSON(map[string]any{"type": "admitted"})
			log.Printf("sfu: %s admitted to room %s", user.Name, meetID)
		case <-wsDone:
			room.DenyKnocker(userID)
			log.Printf("sfu: %s disconnected while waiting for admission", user.Name)
			return
		}
	}

	// ── Peer is admitted (or was first in room) ───────────────────────────────
	// Tell the browser it's clear to start camera + WebRTC.
	peer.SendJSON(map[string]any{"type": "admitted"})

	room.Join(peer)
	defer func() {
		room.Leave(userID)
		room.BroadcastRoomState()
	}()

	room.BroadcastRoomState()
	log.Printf("sfu: %s (%s) joined room %s", userID, user.Name, meetID)

	// ICE candidate trickle — send server candidates to browser.
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		peer.SendJSON(map[string]any{
			"type":      "ice-candidate",
			"candidate": c.ToJSON(),
		})
	})

	// OnTrack — when the browser's track arrives, broadcast it to other peers.
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		log.Printf("sfu: OnTrack %s/%s from %s", remote.Kind(), remote.ID(), userID)
		room.OnTrack(peer, remote)
	})

	// WebSocket read loop — handle offer, answer, ice-candidate, admit, deny.
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			log.Printf("sfu: peer %s disconnected: %v", userID, err)
			break
		}

		var msg signalingMsg
		if err := json.Unmarshal(raw, &msg); err != nil {
			log.Println("sfu: bad message:", err)
			continue
		}

		switch msg.Type {

		case "offer":
			sdp := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: msg.SDP}
			if err := pc.SetRemoteDescription(sdp); err != nil {
				log.Println("sfu: SetRemoteDescription:", err)
				continue
			}
			room.AddExistingTracksTo(peer)
			answer, err := pc.CreateAnswer(nil)
			if err != nil {
				log.Println("sfu: CreateAnswer:", err)
				continue
			}
			if err := pc.SetLocalDescription(answer); err != nil {
				log.Println("sfu: SetLocalDescription:", err)
				continue
			}
			peer.SendJSON(map[string]any{"type": "answer", "sdp": answer.SDP})

		case "answer":
			sdp := webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: msg.SDP}
			if err := pc.SetRemoteDescription(sdp); err != nil {
				log.Println("sfu: SetRemoteDescription (answer):", err)
			}

		case "ice-candidate":
			if msg.Candidate != nil {
				if err := pc.AddICECandidate(*msg.Candidate); err != nil {
					log.Println("sfu: AddICECandidate:", err)
				}
			}

		case "admit":
			if msg.UserID != "" {
				room.AdmitKnocker(msg.UserID)
			}

		case "deny":
			if msg.UserID != "" {
				room.DenyKnocker(msg.UserID)
			}
		}
	}
}
