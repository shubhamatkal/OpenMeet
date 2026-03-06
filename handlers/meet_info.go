package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/shubhamatkal/OpenMeet/sfu"
)

// HandleMeetInfo returns the meeting type (group or 1to1) for a given meetID.
// This lets guests detect whether to use the SFU or P2P path without needing
// the type encoded in the URL.
func HandleMeetInfo(w http.ResponseWriter, r *http.Request) {
	meetID := r.URL.Query().Get("meetID")
	if meetID == "" {
		http.Error(w, "meetID required", http.StatusBadRequest)
		return
	}

	meetType := "1to1"
	if sfu.RoomExists(meetID) {
		meetType = "group"
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"type": meetType})
}
