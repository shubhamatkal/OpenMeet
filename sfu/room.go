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
	ID    string
	mu    sync.RWMutex
	peers map[string]*Peer

	// broadcasters fan out each peer's published tracks to all other peers.
	// Key: broadcasterKey(peerID, kind)
	bcMu         sync.RWMutex
	broadcasters map[string]*TrackBroadcaster
}

// Join adds a peer to the room. Must be called before SetRemoteDescription so
// that AddSenderTrack calls are included in the server's answer SDP.
func (r *Room) Join(p *Peer) {
	r.mu.Lock()
	r.peers[p.ID] = p
	r.mu.Unlock()
	log.Printf("sfu: peer %s (%s) joined room %s", p.ID, p.User.Name, r.ID)
}

// AddExistingTracksTo wires up all currently-published tracks from existing peers
// into newPeer's PeerConnection. Call this BEFORE CreateAnswer so the tracks are
// included in the initial SDP answer. Also registers newPeer as a sink in each
// broadcaster so it receives live RTP once ICE connects.
func (r *Room) AddExistingTracksTo(newPeer *Peer) {
	r.bcMu.RLock()
	defer r.bcMu.RUnlock()

	for key, bc := range r.broadcasters {
		senderPeerID := bc.src.StreamID() // StreamID = peerID set when broadcaster was created
		lt, err := newPeer.AddSenderTrack(senderPeerID, bc.src)
		if err != nil {
			log.Printf("sfu: AddExistingTracksTo %s key=%s: %v", newPeer.ID, key, err)
			continue
		}
		bc.AddSink(newPeer.ID, lt)
	}
}

// OnTrack is called when a peer's track arrives (after ICE connects).
// It creates a broadcaster for the track and wires it to all other peers,
// then triggers renegotiation so the other browsers pick up the new track.
func (r *Room) OnTrack(senderPeer *Peer, remote *webrtc.TrackRemote) {
	key := broadcasterKey(senderPeer.ID, remote.Kind().String())
	bc := newBroadcaster(remote)

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
		go target.Renegotiate()
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
		if bc.src.StreamID() == peerID {
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
