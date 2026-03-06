package sfu

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"

	"github.com/shubhamatkal/OpenMeet/models"
)

// Peer represents one browser connected to the SFU.
type Peer struct {
	ID   string
	User *models.User
	PC   *webrtc.PeerConnection

	wsMu sync.Mutex
	ws   *websocket.Conn

	renegotiateMu    sync.Mutex
	renegotiateTimer *time.Timer

	// Media state — kept in sync with the browser's toggleMic / toggleCamera signals.
	MicOn    bool
	CameraOn bool
}

// SetWS sets the WebSocket connection. Must be called before the peer is used.
func (p *Peer) SetWS(conn *websocket.Conn) {
	p.wsMu.Lock()
	p.ws = conn
	p.wsMu.Unlock()
}

// SendJSON sends a JSON message to this peer's browser.
func (p *Peer) SendJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		log.Println("sfu: marshal error:", err)
		return
	}
	p.wsMu.Lock()
	defer p.wsMu.Unlock()
	if err := p.ws.WriteMessage(websocket.TextMessage, b); err != nil {
		log.Printf("sfu: ws write to %s: %v", p.ID, err)
	}
}

// AddSenderTrack adds a local outgoing track to this peer's PeerConnection.
// The browser will receive media from this track once ICE connects.
// The stream ID is set to senderPeerID so the browser can identify whose track it is
// via track.streams[0].id.
func (p *Peer) AddSenderTrack(senderPeerID string, remote *webrtc.TrackRemote) (*webrtc.TrackLocalStaticRTP, error) {
	lt, err := webrtc.NewTrackLocalStaticRTP(
		remote.Codec().RTPCodecCapability,
		senderPeerID+"-"+remote.Kind().String(), // unique track ID
		senderPeerID,                             // stream ID — browser reads as streams[0].id
	)
	if err != nil {
		return nil, err
	}
	if _, err = p.PC.AddTrack(lt); err != nil {
		return nil, err
	}
	return lt, nil
}

// ScheduleRenegotiate coalesces rapid Renegotiate calls (e.g. audio + video tracks
// arriving in quick succession) into a single renegotiation after a short delay.
func (p *Peer) ScheduleRenegotiate() {
	p.renegotiateMu.Lock()
	defer p.renegotiateMu.Unlock()
	if p.renegotiateTimer != nil {
		p.renegotiateTimer.Reset(150 * time.Millisecond)
		return
	}
	p.renegotiateTimer = time.AfterFunc(150*time.Millisecond, func() {
		p.renegotiateMu.Lock()
		p.renegotiateTimer = nil
		p.renegotiateMu.Unlock()
		p.Renegotiate()
	})
}

// Renegotiate sends a new SDP offer to this peer so it picks up newly-added tracks.
func (p *Peer) Renegotiate() {
	offer, err := p.PC.CreateOffer(nil)
	if err != nil {
		log.Printf("sfu: renegotiate CreateOffer for %s: %v", p.ID, err)
		return
	}
	if err = p.PC.SetLocalDescription(offer); err != nil {
		log.Printf("sfu: renegotiate SetLocalDescription for %s: %v", p.ID, err)
		return
	}
	log.Printf("sfu: renegotiate → sending offer to %s", p.ID)
	p.SendJSON(map[string]any{
		"type": "offer",
		"sdp":  offer.SDP,
	})
}
