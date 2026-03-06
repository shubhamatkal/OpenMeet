package sfu

import (
	"log"
	"sync"

	"github.com/pion/webrtc/v4"
)

// broadcasterKey returns a unique key for a track broadcaster.
func broadcasterKey(peerID, kind string) string {
	return peerID + "/" + kind
}

// Room represents one group meeting.
type Room struct {
	ID     string
	hostID string // userID of the first peer — they admit/deny knockers
	mu     sync.RWMutex
	peers  map[string]*Peer

	// pendingKnocks: peerID → channel that receives true (admit) or false (deny).
	knockMu      sync.Mutex
	pendingKnocks map[string]chan bool

	// broadcasters fan out each peer's published tracks to all other peers.
	// Key: broadcasterKey(peerID, kind)
	bcMu         sync.RWMutex
	broadcasters map[string]*TrackBroadcaster
}

// IsEmpty returns true if no peers have joined yet.
func (r *Room) IsEmpty() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.peers) == 0
}

// Join adds a peer to the room. Must be called before SetRemoteDescription so
// that AddSenderTrack calls are included in the server's answer SDP.
func (r *Room) Join(p *Peer) {
	r.mu.Lock()
	if r.hostID == "" {
		r.hostID = p.ID // first joiner is the host
	}
	r.peers[p.ID] = p
	r.mu.Unlock()
	log.Printf("sfu: peer %s (%s) joined room %s", p.ID, p.User.Name, r.ID)
}

// Knock registers a pending knock and notifies the host.
// Returns a channel that will receive true (admit) or false (deny).
func (r *Room) Knock(knocker *Peer) chan bool {
	ch := make(chan bool, 1)

	r.knockMu.Lock()
	r.pendingKnocks[knocker.ID] = ch
	r.knockMu.Unlock()

	// Notify the host.
	r.mu.RLock()
	host, ok := r.peers[r.hostID]
	r.mu.RUnlock()
	if ok {
		host.SendJSON(map[string]any{
			"type": "knock",
			"user": map[string]any{
				"id":     knocker.ID,
				"name":   knocker.User.Name,
				"avatar": knocker.User.Avatar,
			},
		})
	}
	return ch
}

// AdmitKnocker sends true on the knock channel for userID.
func (r *Room) AdmitKnocker(userID string) {
	r.knockMu.Lock()
	ch, ok := r.pendingKnocks[userID]
	delete(r.pendingKnocks, userID)
	r.knockMu.Unlock()
	if ok {
		ch <- true
	}
}

// DenyKnocker sends false on the knock channel for userID.
func (r *Room) DenyKnocker(userID string) {
	r.knockMu.Lock()
	ch, ok := r.pendingKnocks[userID]
	delete(r.pendingKnocks, userID)
	r.knockMu.Unlock()
	if ok {
		ch <- false
	}
}

// AddExistingTracksTo wires up all currently-published tracks from existing peers
// into newPeer's PeerConnection and registers newPeer as a sink in each broadcaster
// so it receives live RTP once ICE connects. Returns the number of tracks added.
// Call this BEFORE triggering renegotiation (not before CreateAnswer — adding tracks
// to the answerer's PC and including them in the answer creates mismatched m-sections
// that the browser ignores; renegotiation is the correct WebRTC mechanism instead).
func (r *Room) AddExistingTracksTo(newPeer *Peer) int {
	r.bcMu.RLock()
	defer r.bcMu.RUnlock()

	added := 0
	for key, bc := range r.broadcasters {
		lt, err := newPeer.AddSenderTrack(bc.SenderPeerID, bc.src)
		if err != nil {
			log.Printf("sfu: AddExistingTracksTo %s key=%s: %v", newPeer.ID, key, err)
			continue
		}
		bc.AddSink(newPeer.ID, lt)
		added++
		log.Printf("sfu: AddExistingTracksTo → added %s track to peer %s", key, newPeer.ID)
	}
	log.Printf("sfu: AddExistingTracksTo peer %s: %d tracks added", newPeer.ID, added)
	return added
}

// OnTrack is called when a peer's track arrives (after ICE connects).
// It creates a broadcaster for the track and wires it to all other peers,
// then triggers renegotiation so the other browsers pick up the new track.
func (r *Room) OnTrack(senderPeer *Peer, remote *webrtc.TrackRemote) {
	key := broadcasterKey(senderPeer.ID, remote.Kind().String())
	bc := newBroadcaster(remote, senderPeer.ID)

	r.bcMu.Lock()
	r.broadcasters[key] = bc
	r.bcMu.Unlock()

	// Collect current peers (excluding sender) to wire up.
	r.mu.RLock()
	targets := make([]*Peer, 0, len(r.peers)-1)
	for id, p := range r.peers {
		if id != senderPeer.ID {
			targets = append(targets, p)
		}
	}
	r.mu.RUnlock()

	for _, target := range targets {
		lt, err := target.AddSenderTrack(senderPeer.ID, remote)
		if err != nil {
			log.Printf("sfu: OnTrack AddSenderTrack to %s: %v", target.ID, err)
			continue
		}
		bc.AddSink(target.ID, lt)
		target.ScheduleRenegotiate()
	}

	// Start broadcasting (one goroutine reads RTP, fans out to all sinks).
	go bc.Run()

	log.Printf("sfu: broadcasting %s/%s from peer %s to %d targets",
		remote.Kind(), remote.ID(), senderPeer.ID, len(targets))
}

// Leave removes the peer from the room and cleans up its broadcaster sinks.
func (r *Room) Leave(peerID string) {
	r.mu.Lock()
	delete(r.peers, peerID)
	remaining := len(r.peers)
	r.mu.Unlock()

	// Remove this peer as a sink from all broadcasters it was subscribed to.
	r.bcMu.Lock()
	for _, bc := range r.broadcasters {
		bc.RemoveSink(peerID)
	}
	// Remove broadcasters published BY this peer.
	for key, bc := range r.broadcasters {
		if bc.SenderPeerID == peerID {
			delete(r.broadcasters, key)
		}
	}
	r.bcMu.Unlock()

	log.Printf("sfu: peer %s left room %s (remaining: %d)", peerID, r.ID, remaining)

	if remaining == 0 {
		destroyIfEmpty(r.ID)
	}
}

// PeerCount returns the number of connected peers.
func (r *Room) PeerCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.peers)
}

// BroadcastToOthers sends a message to all peers in the room except the sender.
func (r *Room) BroadcastToOthers(senderID string, msg map[string]any) {
	r.mu.RLock()
	targets := make([]*Peer, 0, len(r.peers))
	for id, p := range r.peers {
		if id != senderID {
			targets = append(targets, p)
		}
	}
	r.mu.RUnlock()
	for _, p := range targets {
		go p.SendJSON(msg)
	}
}

// SendMediaStateTo sends the current mic/camera state of every other peer to the
// given peer. Call this right after a new peer joins so they see existing mute states.
func (r *Room) SendMediaStateTo(newPeer *Peer) {
	r.mu.RLock()
	type entry struct {
		id       string
		micOn    bool
		cameraOn bool
	}
	states := make([]entry, 0, len(r.peers))
	for id, p := range r.peers {
		if id == newPeer.ID {
			continue
		}
		states = append(states, entry{id: id, micOn: p.MicOn, cameraOn: p.CameraOn})
	}
	r.mu.RUnlock()

	for _, s := range states {
		newPeer.SendJSON(map[string]any{"type": "peer-mic-state", "userID": s.id, "on": s.micOn})
		newPeer.SendJSON(map[string]any{"type": "peer-camera-state", "userID": s.id, "on": s.cameraOn})
	}
}

// BroadcastRoomState sends the current participant list to every peer in the room.
// Should be called after any join or leave event.
func (r *Room) BroadcastRoomState() {
	r.mu.RLock()
	peerList := make([]map[string]any, 0, len(r.peers))
	for _, p := range r.peers {
		peerList = append(peerList, map[string]any{
			"id":     p.ID,
			"name":   p.User.Name,
			"avatar": p.User.Avatar,
		})
	}
	targets := make([]*Peer, 0, len(r.peers))
	for _, p := range r.peers {
		targets = append(targets, p)
	}
	r.mu.RUnlock()

	msg := map[string]any{"type": "room-state", "peers": peerList}
	for _, p := range targets {
		go p.SendJSON(msg)
	}
}
