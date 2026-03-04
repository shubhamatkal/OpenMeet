# OpenMeet

A minimal peer-to-peer meet app built with Go and WebRTC. The Go server only handles signaling (WebSocket relay) — audio and video flow directly browser-to-browser.

## Run

```bash
go run main.go
# open http://localhost:8080
```

## How it works

1. Both browsers connect to the Go server via WebSocket
2. Go server relays signaling messages (offer / answer / ICE candidates) between them
3. Once browsers find each other, video streams directly — Go server is no longer involved.
