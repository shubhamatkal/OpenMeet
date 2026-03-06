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
	UserID    string                   `json:"userID,omitempty"`
	On        bool                     `json:"on"` // for mic-state / camera-state
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
		ID:       userID,
		User:     &user,
		PC:       pc,
		MicOn:    true,
		CameraOn: true,
	}
	peer.SetWS(conn)

	// Single WS reader goroutine — the only goroutine that calls conn.ReadMessage().
	// This avoids concurrent-read races between the knock-wait phase and the main loop.
	msgCh := make(chan []byte, 32)
	go func() {
		defer close(msgCh)
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			msgCh <- raw
		}
	}()

	// Join (or create) the room.
	room := sfu.GetOrCreate(meetID)

	// ── Knock / admit flow ────────────────────────────────────────────────────
	if !room.IsEmpty() {
		peer.SendJSON(map[string]any{"type": "waiting"})
		admitCh := room.Knock(peer)

	waitLoop:
		for {
			select {
			case ok := <-admitCh:
				if !ok {
					peer.SendJSON(map[string]any{"type": "denied"})
					log.Printf("sfu: %s denied entry to room %s", user.Name, meetID)
					return
				}
				log.Printf("sfu: %s admitted to room %s", user.Name, meetID)
				break waitLoop

			case _, open := <-msgCh:
				if !open {
					// Client disconnected while waiting.
					room.DenyKnocker(userID)
					log.Printf("sfu: %s disconnected while waiting for admission", user.Name)
					return
				}
				// Ignore any messages sent during the waiting phase.
			}
		}
	}

	// ── Peer is admitted (or was first in room) ───────────────────────────────
	// Send exactly one "admitted" — whether the peer knocked or was first.
	peer.SendJSON(map[string]any{"type": "admitted"})

	room.Join(peer)
	defer func() {
		room.Leave(userID)
		room.BroadcastRoomState()
	}()

	room.BroadcastRoomState()
	// Send existing peers' mic/camera states to the new joiner so they see
	// mute indicators immediately without waiting for a toggle event.
	room.SendMediaStateTo(peer)
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

	// Main WebSocket message loop.
	for raw := range msgCh {
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
			// NOTE: do NOT call AddExistingTracksTo before CreateAnswer.
			// An SDP answer cannot add new m-sections beyond what was in the offer;
			// browsers silently ignore extra m-sections, so ontrack never fires.
			// Instead we send a clean answer first, then renegotiate.
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

			// Wire up existing tracks and renegotiate so the browser learns about them
			// via a proper server-initiated offer (the correct WebRTC mechanism).
			go func() {
				if n := room.AddExistingTracksTo(peer); n > 0 {
					peer.Renegotiate()
				}
			}()

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

		case "leave":
			// Client explicitly left — return immediately so the deferred
			// room.Leave + BroadcastRoomState fires right away for other peers.
			return

		case "admit":
			if msg.UserID != "" {
				room.AdmitKnocker(msg.UserID)
			}

		case "deny":
			if msg.UserID != "" {
				room.DenyKnocker(msg.UserID)
			}

		case "mic-state":
			peer.MicOn = msg.On
			room.BroadcastToOthers(userID, map[string]any{
				"type":   "peer-mic-state",
				"userID": userID,
				"on":     msg.On,
			})

		case "camera-state":
			peer.CameraOn = msg.On
			room.BroadcastToOthers(userID, map[string]any{
				"type":   "peer-camera-state",
				"userID": userID,
				"on":     msg.On,
			})
		}
	}

	log.Printf("sfu: peer %s disconnected", userID)
}
