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

**Phase 1 — This project (COMPLETE)**
- How WebSocket works in Go
- How signaling works in WebRTC
- How browsers negotiate a peer-to-peer connection
- Go concurrency basics (goroutines, mutexes)
- User auth: MongoDB Atlas, JWT, SMTP email verification, bcrypt
- Vue 3 CDN frontend with reactive state

**Phase 2 — SFU Group Meetings (NEXT)**
See full Phase 2 spec below.

**Phase 3 — Advanced (Future)**
- Call recording to disk (RTP → container)
- Quality monitor using getStats()
- TURN server for firewall traversal
- Mobile apps

---

---

---

# PHASE 2 — SFU Group Meetings

## What Changes in Phase 2

Phase 1 is a pure P2P architecture: the Go server only relays signaling text,
and media flows directly browser-to-browser. This works perfectly for 1-to-1 calls
but breaks down for group meetings because every participant would need a direct
connection to every other participant (mesh), which is bandwidth-expensive and
doesn't scale past ~4 people.

Phase 2 replaces the P2P model with an **SFU (Selective Forwarding Unit)** model.
The Go server — using **Pion WebRTC** — joins every call as a media participant.
Every browser sends its video/audio **once** to the server. The server then
selectively forwards each stream to all other participants. Browsers only upload
one stream regardless of how many people are in the meeting.

```
Phase 1 — P2P (current, 1-to-1 only):

  Browser A <——————————————————> Browser B
             direct media stream

Phase 2 — SFU (group meetings):

  Browser A ——upload——> Go SFU Server ——forward——> Browser B
  Browser B ——upload——> Go SFU Server ——forward——> Browser A
  Browser C ——upload——> Go SFU Server ——forward——> Browser A
                                       ——forward——> Browser B
```

The server never decodes the audio or video — it just reads RTP packets and
forwards them to the right subscribers. This is why it's called "selective
forwarding" rather than mixing or transcoding.

---

## Why Pion

**Pion** (`github.com/pion/webrtc`) is a pure-Go implementation of the WebRTC
specification. It allows a Go process to:

- Participate in a WebRTC session as a peer (not just relay signaling)
- Receive RTP media tracks from browsers
- Forward RTP packets to other browser connections
- Handle ICE negotiation, DTLS handshake, and SRTP decryption natively in Go
- No CGo, no external C libraries — pure Go, cross-platform

Pion is the standard choice for building WebRTC backends in Go. It is production-
used by Livekit, Jitsi components, and many others.

---

## SFU Architecture

```
                        ┌─────────────────────────────────┐
                        │          Go SFU Server           │
                        │                                 │
  Browser A ──WS──────> │ signaling handler               │
  (sends offer)         │      │                          │
                        │      ▼                          │
                        │ PeerConnection A                │
                        │  • receives A's video track     │
                        │  • receives A's audio track     │
                        │      │                          │
  Browser B ──WS──────> │ signaling handler               │
  (sends offer)         │      │                          │
                        │      ▼                          │
                        │ PeerConnection B                │
                        │  • receives B's video track     │
                        │  • receives B's audio track     │
                        │      │                          │
                        │ Room manager                    │
                        │  • when A's track arrives →     │
                        │    write RTP to B's sender      │
                        │  • when B's track arrives →     │
                        │    write RTP to A's sender      │
                        └─────────────────────────────────┘
```

Each browser opens **one** PeerConnection to the server.
The server creates **one** PeerConnection per browser.
Tracks received from browser X are forwarded as tracks sent to all other browsers.

---

## Phase 2 Key Concepts

### RTP (Real-time Transport Protocol)
The wire format for audio and video in WebRTC. Each RTP packet carries a small
chunk of encoded media with a sequence number and timestamp. The SFU reads these
packets and re-sends them without decoding — just routing.

### SRTP (Secure RTP)
RTP encrypted with DTLS keys negotiated during the WebRTC handshake. Pion
handles DTLS and SRTP transparently; you work with plain RTP in your Go code.

### Track
A single media source — one video stream or one audio stream. A browser with
camera + mic publishes 2 tracks. The server receives those 2 tracks and forwards
each to every other participant.

### PeerConnection (server-side)
In Phase 1, only browsers had PeerConnections. In Phase 2, the Go server creates
a `pion/webrtc.PeerConnection` for every browser that connects. Pion manages ICE,
DTLS, and SRTP internally.

### Selective Forwarding
The SFU does not mix or transcode streams. It reads RTP packets from one
`TrackRemote` and writes them to one or more `TrackLocalStaticRTP` objects. This
is CPU-cheap — just a buffer copy per packet.

---

## Room Model (Phase 2)

```go
// One room = one group meeting
type Room struct {
    ID      string
    mu      sync.RWMutex
    peers   map[string]*Peer   // peerID → Peer
}

// One peer = one browser connected to the SFU
type Peer struct {
    ID   string
    User *models.User
    PC   *webrtc.PeerConnection

    // Tracks this peer is sending to the server (we receive these)
    VideoTrack *webrtc.TrackRemote
    AudioTrack *webrtc.TrackRemote

    // Local tracks the server sends to this peer (forwarded from others)
    VideoSenders map[string]*webrtc.TrackLocalStaticRTP  // peerID → track
    AudioSenders map[string]*webrtc.TrackLocalStaticRTP
}
```

When a new peer joins:
1. Server creates a `PeerConnection` for them via Pion
2. Browser sends offer → server answers (Pion handles SDP)
3. Server calls `pc.AddTrack` for every existing peer's video and audio
   (so the new joiner sees everyone immediately)
4. Server signals all existing peers to renegotiate and add a new track
   (the newcomer's stream)
5. As RTP packets arrive on `TrackRemote`, goroutines forward them to all
   `TrackLocalStaticRTP` senders

---

## New Backend Packages (Phase 2)

```
handlers/
  sfu.go          ← HTTP + WS handler that drives the Pion PeerConnection lifecycle
sfu/
  room.go         ← Room struct, peer registry, join/leave logic
  peer.go         ← Peer struct, track management, RTP forwarding goroutines
  manager.go      ← Global room map, create/get/destroy rooms
```

Phase 1 packages (`handlers/ws.go`, `handlers/auth.go`, etc.) stay unchanged.
Group meetings are a separate code path.

---

## Signaling Protocol (Phase 2)

Unlike Phase 1 where the server blindly relayed messages, in Phase 2 the server
**participates** in signaling:

```
Browser                         Go SFU
   |                               |
   |── WS connect /sfu?meetID=X ──>|  (JWT auth via ?token=)
   |                               |
   |── {type:"offer", sdp:"..."}  →|  server calls pc.SetRemoteDescription
   |                               |  server calls pc.CreateAnswer
   |←─ {type:"answer", sdp:"..."} |  server sends its own SDP back
   |                               |
   |── {type:"ice-candidate",...} →|  server adds ICE candidate to its PC
   |←─ {type:"ice-candidate",...} |  server's ICE candidates trickle to browser
   |                               |
   |     [WebRTC connected]        |
   |                               |
   |── video/audio RTP ──────────>|  server receives on TrackRemote
   |                               |  server forwards to all other peers
   |←─ video/audio RTP ──────────|  other peers' streams arrive at browser
   |                               |
   |  (new peer joins)             |
   |←─ {type:"renegotiate"}       |  server triggers offer/answer cycle
   |── {type:"offer", sdp:"..."}  →|  browser re-offers with new transceiver
   |←─ {type:"answer", sdp:"..."} |
```

---

## Frontend Changes (Phase 2)

The Vue 3 app will detect meeting type from a `?type=group` param or the meeting
record in MongoDB.

For group meetings:
- One `RTCPeerConnection` to the **server** (not to another browser)
- Subscribe to `ontrack` events — each new remote track is a different participant
- Show a **grid layout** of video tiles instead of PiP
- Participant panel already works (from Phase 1), just with more entries

Key difference in `app.js`:
```js
// Phase 1 (P2P): connect to other browser
ws = new WebSocket(`/ws?meetID=${meetID}&token=${token}`)
pc = new RTCPeerConnection(RTC_CONFIG)  // connects to browser B

// Phase 2 (SFU): connect to server
ws = new WebSocket(`/sfu?meetID=${meetID}&token=${token}`)
pc = new RTCPeerConnection(RTC_CONFIG)  // connects to Go SFU
// server sends answer, ICE candidates
// ontrack fires once per participant
```

---

## MongoDB Changes (Phase 2)

Add a `type` field to the meeting document (created when host starts meeting):

```json
{
  "_id": "...",
  "meetID": "abc-d3fg-hij",
  "type": "group",
  "hostID": "...",
  "createdAt": "...",
  "maxParticipants": 20
}
```

Phase 1 meetings are `"type": "1to1"` and continue using the existing WS relay.
Phase 2 group meetings route to the SFU handler.

---

## New Go Dependencies (Phase 2)

```
github.com/pion/webrtc/v4        — core WebRTC (ICE, DTLS, SRTP, RTP)
github.com/pion/interceptor      — RTP interceptors (NACK, RTCP, bandwidth estimation)
github.com/pion/rtp              — RTP packet types
```

---

## Scalability Notes

A single Go SFU process on a modest server can handle:
- ~50 concurrent participants across all rooms
- CPU is the bottleneck (packet copying goroutines)
- Memory scales linearly with (participants × tracks)

For larger scale (Phase 3+):
- Distribute rooms across multiple SFU instances
- Use a mesh of SFU servers (cascade SFU)
- Or migrate to a managed SFU (LiveKit, mediasoup, Ion-SFU)

---

## What Phase 2 Does NOT Change

- Auth system (JWT, MongoDB, SMTP) — unchanged
- 1-to-1 meeting flow — unchanged, still uses Phase 1 WS relay
- Frontend auth screens — unchanged
- Avatar/profile system — unchanged
- "Coming soon" badge on Group Meeting removed when Phase 2 ships

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

## Phase 2 Optimizations:
- Performance Optimization: The SFU determines which streams are "most relevant" (e.g., active speaker, screen sharing) and forwards them, saving client-side processing power.