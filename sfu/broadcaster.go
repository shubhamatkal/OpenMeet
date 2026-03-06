package sfu

import (
	"log"
	"sync"

	"github.com/pion/webrtc/v4"
)

// TrackBroadcaster reads RTP from one TrackRemote and fans it out to multiple
// TrackLocalStaticRTP sinks. New sinks can be added at any time (for late joiners).
type TrackBroadcaster struct {
	src          *webrtc.TrackRemote
	SenderPeerID string // userID of the peer who published this track
	mu           sync.RWMutex
	sinks        map[string]*webrtc.TrackLocalStaticRTP // peerID → sink
	closed       bool
}

func newBroadcaster(src *webrtc.TrackRemote, senderPeerID string) *TrackBroadcaster {
	return &TrackBroadcaster{
		src:          src,
		SenderPeerID: senderPeerID,
		sinks:        make(map[string]*webrtc.TrackLocalStaticRTP),
	}
}

// AddSink registers a new sink. Safe to call after Run() has started.
func (b *TrackBroadcaster) AddSink(peerID string, sink *webrtc.TrackLocalStaticRTP) {
	b.mu.Lock()
	b.sinks[peerID] = sink
	b.mu.Unlock()
}

// RemoveSink removes a sink (called when a peer leaves).
func (b *TrackBroadcaster) RemoveSink(peerID string) {
	b.mu.Lock()
	delete(b.sinks, peerID)
	b.mu.Unlock()
}

// Run reads RTP packets and forwards them to all registered sinks.
// Exits when the source track closes. Should be called in a goroutine.
func (b *TrackBroadcaster) Run() {
	for {
		pkt, _, err := b.src.ReadRTP()
		if err != nil {
			b.mu.Lock()
			b.closed = true
			b.mu.Unlock()
			log.Printf("sfu: broadcaster closed for track %s/%s", b.src.Kind(), b.src.ID())
			return
		}
		b.mu.RLock()
		for _, sink := range b.sinks {
			// Ignore individual write errors — a slow/broken peer shouldn't stop others.
			_ = sink.WriteRTP(pkt)
		}
		b.mu.RUnlock()
	}
}
