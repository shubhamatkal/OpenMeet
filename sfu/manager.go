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
			ID:            meetID,
			peers:         make(map[string]*Peer),
			pendingKnocks: make(map[string]chan bool),
			broadcasters:  make(map[string]*TrackBroadcaster),
		}
		rooms[meetID] = r
	}
	return r
}

// RoomExists returns true if an active SFU room exists for the given meetID.
func RoomExists(meetID string) bool {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	_, ok := rooms[meetID]
	return ok
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
