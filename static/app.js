'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let ws          = null;   // WebSocket connection to the Go server
let pc          = null;   // RTCPeerConnection (WebRTC)
let localStream = null;   // Camera + mic stream (from getUserMedia)
let micOn       = true;
let cameraOn    = true;

// Read ?meetID= from the current URL once
const meetID = new URLSearchParams(window.location.search).get('meetID');

// A tab is the HOST if it called generateMeetID() for this specific meetID.
// We store a flag in sessionStorage (cleared when the tab closes) at the
// moment "New Meeting" is clicked, before the redirect happens.
const isHost = meetID
  ? sessionStorage.getItem(`host_${meetID}`) === 'true'
  : false;

// ─── Screen router ────────────────────────────────────────────────────────────
const ALL_SCREENS = ['landing', 'knock', 'waiting', 'meeting', 'denied', 'full', 'ended'];

function showScreen(name) {
  ALL_SCREENS.forEach(s => {
    const el = document.getElementById(`screen-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  });

  // The meeting screen is a fixed full-screen overlay — hide the
  // normal page header and footer so they don't show behind it.
  const inMeeting = name === 'meeting';
  document.getElementById('mainHeader')?.classList.toggle('hidden', inMeeting);
  document.getElementById('mainFooter')?.classList.toggle('hidden', inMeeting);
}

// ─── Meet ID utilities ────────────────────────────────────────────────────────

// Generates a random ID like "a3b-7cx2-mn9"  (3-4-3, lowercase letters + digits)
function generateMeetID() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const seg = (n) =>
    Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${seg(3)}-${seg(4)}-${seg(3)}`;
}

// Accepts either a raw code ("a3b-7cx2-mn9") or a full URL and returns just the code.
function parseMeetID(input) {
  try {
    return new URL(input.trim()).searchParams.get('meetID') || input.trim();
  } catch {
    return input.trim();
  }
}

// Redirects to the same page with ?meetID=<id> added to the URL.
function goToMeet(id) {
  const url = new URL(window.location.href);
  url.searchParams.set('meetID', id);
  window.location.href = url.toString();
}

// ─── Clock ────────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const clockEl = document.getElementById('clock');
  const dateEl  = document.getElementById('date');
  if (clockEl) clockEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (dateEl)  dateEl.textContent  = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
updateClock();
setInterval(updateClock, 1000);

// ─── Camera (getUserMedia) ────────────────────────────────────────────────────
async function startCamera() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const vid = document.getElementById('localVideo');
    if (vid) vid.srcObject = localStream;
  } catch (err) {
    console.error('Camera error:', err);
    const status = document.getElementById('meetingStatus');
    if (status) status.textContent = 'Camera access denied. Check browser permissions.';
  }
}

function stopCamera() {
  if (!localStream) return;
  localStream.getTracks().forEach(track => track.stop());
  localStream = null;
}

// ─── WebRTC peer connection ────────────────────────────────────────────────────
// Uses Google's public STUN server to help peers find each other across NAT.
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function createPeerConnection() {
  pc = new RTCPeerConnection(RTC_CONFIG);

  // Add our local camera/mic tracks so the remote peer receives them
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // When the remote peer's tracks arrive, show them in #remoteVideo
  pc.ontrack = (event) => {
    const remoteVideo = document.getElementById('remoteVideo');
    if (remoteVideo && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      // Hide the "Waiting..." status text once video is flowing
      const status = document.getElementById('meetingStatus');
      if (status) status.textContent = '';
    }
  };

  // ICE candidate found locally → send to the other peer via WebSocket relay
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendMsg({ type: 'ice-candidate', candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[WebRTC] Connection state:', pc.connectionState);
  };
}

function closePeerConnection() {
  if (pc) { pc.close(); pc = null; }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connectWebSocket() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${window.location.host}/ws?meetID=${meetID}`);

  ws.onopen = () => {
    console.log('[WS] Connected, meetID:', meetID, '| isHost:', isHost);
    // Guest announces arrival the moment the connection opens.
    if (!isHost) {
      ws.send(JSON.stringify({ type: 'knock' }));
    }
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { return; }
    onMessage(msg);
  };

  ws.onclose = () => console.log('[WS] Disconnected');
  ws.onerror = (err) => console.error('[WS] Error:', err);
}

// Safely send a JSON message (only if connection is open)
function sendMsg(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────
// Every WebSocket message arrives here.
// The Go server is a relay except for meet-full and meet-ended (sent by server).
//
// WebRTC signaling flow:
//   1. Host admits guest  →  sends {type:"admit"}
//   2. Guest starts camera, creates RTCPeerConnection, sends offer
//   3. Host receives offer, creates RTCPeerConnection (already has camera), sends answer
//   4. Both sides handle ICE candidates as they trickle in
async function onMessage(msg) {
  switch (msg.type) {

    // HOST receives this when the guest sends {type:"knock"}
    case 'knock':
      document.getElementById('knockNotification')?.classList.remove('hidden');
      const status = document.getElementById('meetingStatus');
      if (status) status.textContent = '';
      break;

    // GUEST receives this when host clicks "Admit"
    // Guest initiates the WebRTC offer after getting camera access.
    case 'admit': {
      showScreen('meeting');
      document.getElementById('meetIDBar').textContent = meetID;
      await startCamera();
      createPeerConnection();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendMsg({ type: 'offer', sdp: pc.localDescription });
      break;
    }

    // GUEST receives this when host clicks "Deny"
    case 'deny':
      ws.close();
      showScreen('denied');
      break;

    // HOST receives this — create PC (already has camera), send answer
    case 'offer': {
      createPeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendMsg({ type: 'answer', sdp: pc.localDescription });
      break;
    }

    // GUEST receives this — complete the handshake
    case 'answer':
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      break;

    // Both peers exchange ICE candidates as they're discovered
    case 'ice-candidate':
      if (pc && msg.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      }
      break;

    // Sent by the GO SERVER when a 3rd person tries to connect to a full meet
    case 'meet-full':
      showScreen('full');
      break;

    // Sent by the GO SERVER when the host's WebSocket closes (tab closed / Leave clicked)
    case 'meet-ended':
      closePeerConnection();
      stopCamera();
      ws.close();
      showScreen('ended');
      break;
  }
}

// ─── Meeting controls ─────────────────────────────────────────────────────────
function setupMeetingControls() {

  // Mic mute/unmute
  document.getElementById('micBtn')?.addEventListener('click', () => {
    if (!localStream) return;
    micOn = !micOn;
    localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    const icon = document.querySelector('#micBtn .material-symbols-outlined');
    if (icon) icon.textContent = micOn ? 'mic' : 'mic_off';
    document.getElementById('micBtn')?.classList.toggle('bg-red-600',  !micOn);
    document.getElementById('micBtn')?.classList.toggle('bg-slate-700', micOn);
  });

  // Camera on/off
  document.getElementById('cameraBtn')?.addEventListener('click', () => {
    if (!localStream) return;
    cameraOn = !cameraOn;
    localStream.getVideoTracks().forEach(t => t.enabled = cameraOn);
    const icon = document.querySelector('#cameraBtn .material-symbols-outlined');
    if (icon) icon.textContent = cameraOn ? 'videocam' : 'videocam_off';
    document.getElementById('cameraBtn')?.classList.toggle('bg-red-600',   !cameraOn);
    document.getElementById('cameraBtn')?.classList.toggle('bg-slate-700',  cameraOn);
  });

  // Leave meeting
  document.getElementById('leaveBtn')?.addEventListener('click', () => {
    closePeerConnection();
    stopCamera();
    if (ws) ws.close(); // closing WS triggers meet-ended for the other peer (if host)
    window.location.href = '/';
  });

  // Copy meeting link
  document.getElementById('copyMeetIDBtn')?.addEventListener('click', () => {
    const link = `${window.location.origin}/?meetID=${meetID}`;
    navigator.clipboard.writeText(link).then(() => {
      const icon = document.querySelector('#copyMeetIDBtn .material-symbols-outlined');
      if (icon) {
        icon.textContent = 'check';
        setTimeout(() => icon.textContent = 'content_copy', 2000);
      }
    });
  });

  // Admit — host sends {type:"admit"} to the guest (relayed by Go server)
  document.getElementById('admitBtn')?.addEventListener('click', () => {
    sendMsg({ type: 'admit' });
    document.getElementById('knockNotification')?.classList.add('hidden');
  });

  // Deny — host sends {type:"deny"} to the guest (relayed by Go server)
  document.getElementById('denyBtn')?.addEventListener('click', () => {
    sendMsg({ type: 'deny' });
    document.getElementById('knockNotification')?.classList.add('hidden');
    const status = document.getElementById('meetingStatus');
    if (status) status.textContent = 'Waiting for someone to join...';
  });
}

// ─── Page initializer ─────────────────────────────────────────────────────────
(function init() {
  setupMeetingControls();

  if (!meetID) {
    // ── No meetID → Landing page ───────────────────────────────────────────────
    showScreen('landing');

    document.getElementById('newMeetingBtn')?.addEventListener('click', () => {
      const id = generateMeetID();
      // Mark this tab as the host BEFORE redirecting so the meeting page
      // can read it from sessionStorage on load.
      sessionStorage.setItem(`host_${id}`, 'true');
      goToMeet(id);
    });

    document.getElementById('joinBtn')?.addEventListener('click', () => {
      const raw = document.getElementById('meetIDInput')?.value ?? '';
      const id  = parseMeetID(raw);
      if (id) goToMeet(id);
    });

    document.getElementById('meetIDInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('joinBtn')?.click();
    });

  } else if (isHost) {
    // ── Host → go straight into the meeting room ───────────────────────────────
    showScreen('meeting');
    document.getElementById('meetIDBar').textContent = meetID;
    const status = document.getElementById('meetingStatus');
    if (status) status.textContent = 'Waiting for someone to join...';
    startCamera();      // start camera immediately
    connectWebSocket(); // connect to Go server as peer 0 (host)

  } else {
    // ── Guest → show the knock screen first ────────────────────────────────────
    showScreen('knock');
    document.getElementById('knockMeetID').textContent = meetID;

    document.getElementById('askToJoinBtn')?.addEventListener('click', () => {
      showScreen('waiting');
      connectWebSocket(); // sends {type:"knock"} on open
    });

    document.getElementById('knockCancelBtn')?.addEventListener('click', () => {
      window.location.href = '/';
    });

    document.getElementById('waitingCancelBtn')?.addEventListener('click', () => {
      if (ws) ws.close();
      window.location.href = '/';
    });
  }

})();
