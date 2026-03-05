package sfu

import "sync"

var (
	rooms   = make(map[string]*Room)
	roomsMu sync.Mutex
)

// GetOrCreate returns the existing room or creates a new one.
func GetOrCreate(meetID string) *Room {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	r, ok := rooms[meetID]
	if !ok {
		r = &Room{
			ID:           meetID,
			peers:        make(map[string]*Peer),
			broadcasters: make(map[string]*TrackBroadcaster),
		}
		rooms[meetID] = r
	}
	return r
}

func destroyIfEmpty(meetID string) {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	r, ok := rooms[meetID]
	if !ok {
		return
	}
	r.mu.RLock()
	empty := len(r.peers) == 0
	r.mu.RUnlock()

	if empty {
		delete(rooms, meetID)
	}
}
