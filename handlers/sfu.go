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
	Type      string                     `json:"type"`
	SDP       string                     `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit   `json:"candidate,omitempty"`
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
	room.Join(peer)
	defer func() {
		room.Leave(userID)
		room.BroadcastRoomState()
	}()

	// Tell everyone (including the new joiner) who is in the room.
	room.BroadcastRoomState()

	log.Printf("sfu: %s (%s) connected to room %s", userID, user.Name, meetID)

	// ICE candidate trickle — send server candidates to browser.
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		peer.SendJSON(map[string]any{
			"type":      "ice-candidate",
			"candidate": init,
		})
	})

	// OnTrack — when the browser's track arrives, broadcast it to other peers.
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		log.Printf("sfu: OnTrack %s/%s from %s", remote.Kind(), remote.ID(), userID)
		room.OnTrack(peer, remote)
	})

	// WebSocket read loop — handle offer, answer, ice-candidate from browser.
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
			// Browser sends an offer. This happens on initial connect AND on renegotiation
			// triggered by the browser (e.g., adding screen share later).
			sdp := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: msg.SDP}
			if err := pc.SetRemoteDescription(sdp); err != nil {
				log.Println("sfu: SetRemoteDescription:", err)
				continue
			}

			// Add existing peers' tracks to this peer's PC before creating answer,
			// so the initial SDP includes them.
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
			peer.SendJSON(map[string]any{
				"type": "answer",
				"sdp":  answer.SDP,
			})

		case "answer":
			// Browser answers a renegotiation offer that the server sent.
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
		}
	}
}
