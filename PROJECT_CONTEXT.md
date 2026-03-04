# Project Context: WebRTC Video Chat in Go

## Purpose of This Document

This document is the full context for building a peer-to-peer video chat application
using Go (backend) and WebRTC (browser). It is written for use with Claude Code or
any AI coding assistant. The goal of this project is **learning and exploration** —
understanding how WebRTC works, how Go handles real-time networking, and how to ship
a clean open source project.
We can say this as p2p videochat app.

---

## What We Are Building

A minimal, working video chat application where:
- First person can open the main page and there he can create the videochat or can join the existing google meet using the direct url or the meet code.
- Like google meet one can share the link or the code.
- Other user can join the videochat via the direct link or using the code.
- They see and hear each other via direct peer-to-peer video

**Key constraint:** The Go server never touches audio or video. It only helps the two
browsers find each other. After that, video flows directly browser-to-browser.

---

## The 3 Problems WebRTC Solves (Mental Model)

Before any code, understand why each piece exists:

```
Problem 1 — Finding each other
  Browsers don't know each other's address.
  A server must introduce them by relaying small text messages.
  → Solved by: Your Go server (WebSocket)

Problem 2 — Sending audio/video
  Once browsers know each other, they send media directly.
  → Solved by: Browser's built-in WebRTC APIs (no Go needed)

Problem 3 — What if direct connection fails?
  → NOT in scope for Phase 1.
  → We use Google's free STUN only (just for IP discovery, not relay)
  → If two browsers can't connect directly, call won't work — accepted limitation
```



---

## Architecture

```
Browser A                  Go Server                 Browser B
    |                          |                         |
    |--- connect WebSocket ---> |                         |
    |                          | <-- connect WebSocket ---|
    |                          |                         |
    |--- send "offer" --------> |                         |
    |                          |--- forward "offer" ----> |
    |                          |                         |
    |                          | <-- send "answer" -------|
    |<-- forward "answer" ------|                         |
    |                          |                         |
    |<======= direct peer-to-peer video/audio ==========>|
    |         (Go server not involved from here)         |
```

The Go server role: WebSocket relay only. It reads a message from Browser A and
writes it to Browser B. It never parses the video data, never stores it, never
processes it.

---

## Technology Choices

| Layer | Technology | Why |
|---|---|---|
| Backend language | Go | Fast, simple concurrency, great networking stdlib |
| WebSocket library | gorilla/websocket | Most used Go WebSocket library |
| Frontend | Vanilla JS | No framework needed, keeps focus on WebRTC |
| WebRTC | Browser native API | Built into Chrome, Firefox, Safari — no install |
---

## Project File Structure

```
videochat/
  main.go              ← Go server: WebSocket signaling + HTTP file server
  go.mod               ← Go module definition
  go.sum               ← Dependency checksums
  static/
    index.html         ← UI: two video elements + room input + join button
    app.js             ← All WebRTC browser logic
  .gitignore           ← Go + IDE + secrets ignore rules
  LICENSE              ← MIT license (created on GitHub)
  README.md            ← Setup instructions + how it works
  PROJECT_CONTEXT.md   ← This file
```

---

## Go Server Responsibilities (main.go)

1. Serve static files from `/static` folder on `/`
2. Handle WebSocket connections on `/ws?room=ROOMNAME`
3. Group connections by room name
4. When a message arrives from peer A, forward it to peer B in the same room
5. Handle disconnect cleanly (remove peer from room)

**Data the Go server handles (text only):**
```json
{"type": "offer",     "sdp": "...long string..."}
{"type": "answer",    "sdp": "...long string..."}
{"type": "candidate", "candidate": {...}}
```

These are called **signaling messages**. They are just text. They contain
network address information so browsers can find each other. Not video.

---

## Browser JavaScript Responsibilities (app.js)

1. Get camera and microphone via `getUserMedia`
2. Connect to Go server via WebSocket
3. Create an `RTCPeerConnection`
4. First browser in room: create an "offer" and send to Go server
5. Second browser in room: receive offer, create "answer", send back
6. Both browsers exchange ICE candidates (network paths) via Go server
7. Once connected: video flows directly, WebSocket no longer needed for media

---

## Key Concepts Explained Simply

**SDP (Session Description Protocol)**
Just a text blob that says "I can send video in VP8 or H264 format, here are my
network addresses, here is my encryption key." Two browsers exchange these to
agree on how to talk.

**ICE Candidates**
Multiple possible network paths to reach a browser. Example: your local IP,
your router's IP, a relay server IP. Browsers try all of them and pick the best.

**STUN Server**
A free public server (Google runs one at stun.l.google.com:19302) that tells
your browser "your public IP address is X.X.X.X". Your browser includes this
in its ICE candidates so the other browser knows how to reach you over the internet.

**Offer/Answer**
Browser A creates an "offer" (I want to call you, here's what I support).
Browser B creates an "answer" (OK, here's what I support back). After this
exchange both browsers know enough to connect directly.

**Why goroutines matter here**
Each WebSocket connection runs in its own goroutine. Go handles thousands of
concurrent connections easily this way. This is why Go is good for this use case.

---

## What Pion WebRTC Is (For Later)

Pion is WebRTC implemented in Go. Right now we don't need it because the browsers
handle WebRTC themselves. Pion becomes necessary when your Go SERVER needs to join
the call — for example to record calls, forward to many people, or do transcription.

```
Without Pion (this project):
Browser ←——→ Go Server (text relay only) ←——→ Browser

With Pion (future projects):
Browser ←——→ Go Server (actually in the call) ←——→ Browser
              ↑ can record, process, forward audio/video
```

---

## What Is NOT In Scope (Intentionally)

```
→ Phase 1 limitation: We only use Google's free STUN server for IP 
  discovery. If browsers can't connect directly, call fails. 
  TURN relay is a Phase 2 concern.
```

- Authentication / login
- Database
- Multiple people in one room (only 2 peers for now)
- Recording
- TURN server (using Google's free STUN only)
- Mobile apps
- Deployment / Docker

These are all natural next steps but are excluded to keep focus on understanding
the core WebRTC flow.

---

## Success Criteria

The project works when:
1. `go run main.go` starts without errors
2. Opening `http://localhost:8080` in two browser tabs
3. Both tabs enter the same room name and click Join
4. Both tabs show local camera video
5. Both tabs show the other person's video and play their audio
6. Go server terminal shows "Peer 0 joined room X" and "Peer 1 joined room X"

---

## Open Source Setup

**GitHub Repository:** Create with these settings:
- Add README: yes
- .gitignore template: Go
- License: MIT

**After cloning, add to .gitignore:**
```
.env
.env.local
*.pem
*.key
.vscode/
.idea/
tmp/
/bin/
.DS_Store
```

**go.mod packages should look like:**
```
module github.com/YOURUSERNAME/videochat

require github.com/gorilla/websocket 
```

---

## Learning Goals Per Phase

**Phase 1 — This project**
- How WebSocket works in Go
- How signaling works in WebRTC
- How browsers negotiate a peer-to-peer connection
- Go concurrency basics (goroutines, mutexes)

**Phase 2 — Extensions to build after**
- Add room listing (learn Go maps, HTTP handlers)
- Add reconnection handling (learn WebRTC connection states)
- Add more than 2 people per room (learn fan-out patterns in Go)

**Phase 3 — Introduce Pion**
- Make the Go server join the call
- Record calls to disk (learn RTP, audio/video containers)
- Build a quality monitor using getStats()

---

## Commands Reference

```bash
# Clone and set up
git clone https://github.com/shubhamatkal/OpenMeet
cd videochat
go mod init github.com/shubhamatkal/OpenMeet
go get github.com/gorilla/websocket

# Run
go run main.go

# Visit
open http://localhost:8080
```

---

## Notes for Claude Code

- Keep all Go code in main.go for now — no need to split into packages yet
- Keep frontend in static/index.html and static/app.js — vanilla JS only
- No build step, no bundler, no framework
- The WebSocket handler is the most important function — understand it fully
- Comments in code should explain WHY not WHAT — the reader knows Go
- Error handling: log errors but don't crash the server on a single bad connection
- The project must run with just `go run main.go` — no setup scripts