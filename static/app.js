'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let ws          = null;
let pc          = null;
let localStream = null;
let micOn       = true;
let cameraOn    = true;

const meetID = new URLSearchParams(window.location.search).get('meetID');
const isHost = meetID
  ? sessionStorage.getItem(`host_${meetID}`) === 'true'
  : false;

// ─── Dark mode ────────────────────────────────────────────────────────────────
// Reads system preference on first visit; persists choice in localStorage.
function initDarkMode() {
  const stored      = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark        = stored !== null ? stored === 'dark' : prefersDark;
  document.documentElement.classList.toggle('dark', dark);
  updateThemeIcon(dark);
}

function toggleDarkMode() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  updateThemeIcon(isDark);
}

function updateThemeIcon(isDark) {
  const icon = document.querySelector('#darkModeBtn .material-symbols-outlined');
  if (icon) icon.textContent = isDark ? 'light_mode' : 'dark_mode';
}

initDarkMode();
document.getElementById('darkModeBtn')?.addEventListener('click', toggleDarkMode);

// ─── Screen router ────────────────────────────────────────────────────────────
const ALL_SCREENS = ['landing', 'knock', 'waiting', 'meeting', 'denied', 'full', 'ended'];

function showScreen(name) {
  ALL_SCREENS.forEach(s => {
    const el = document.getElementById(`screen-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  });
  const inMeeting = name === 'meeting';
  document.getElementById('mainHeader')?.classList.toggle('hidden', inMeeting);
  document.getElementById('mainFooter')?.classList.toggle('hidden', inMeeting);
}

// ─── Auto-redirect countdown ──────────────────────────────────────────────────
// Shows "Returning to home in Ns…" and redirects automatically.
function startRedirectCountdown(elementId, seconds = 5) {
  const el = document.getElementById(elementId);
  if (!el) return;
  let t = seconds;
  const tick = () => { el.textContent = `Returning to home in ${t}s…`; };
  tick();
  const iv = setInterval(() => {
    t--;
    if (t <= 0) { clearInterval(iv); window.location.href = '/'; }
    else tick();
  }, 1000);
}

// ─── Meet ID utilities ────────────────────────────────────────────────────────
function generateMeetID() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const seg = (n) =>
    Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${seg(3)}-${seg(4)}-${seg(3)}`;
}

function parseMeetID(input) {
  try { return new URL(input.trim()).searchParams.get('meetID') || input.trim(); }
  catch { return input.trim(); }
}

function goToMeet(id) {
  const url = new URL(window.location.href);
  url.searchParams.set('meetID', id);
  window.location.href = url.toString();
}

// ─── Clock ────────────────────────────────────────────────────────────────────
function updateClock() {
  const now     = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const clockEl        = document.getElementById('clock');
  const dateEl         = document.getElementById('date');
  const meetingClockEl = document.getElementById('meetingClock');
  if (clockEl)        clockEl.textContent        = timeStr;
  if (dateEl)         dateEl.textContent          = dateStr;
  if (meetingClockEl) meetingClockEl.textContent  = timeStr;
}
updateClock();
setInterval(updateClock, 1000);

// ─── Camera ───────────────────────────────────────────────────────────────────
async function startCamera() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const vid = document.getElementById('localVideo');
    if (vid) vid.srcObject = localStream;
  } catch (err) {
    console.error('Camera error:', err);
  }
}

function stopCamera() {
  if (!localStream) return;
  localStream.getTracks().forEach(t => t.stop());
  localStream = null;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

// CSS classes for local tile in solo (full-screen) vs PiP mode.
const LOCAL_SOLO = 'absolute inset-0';
const LOCAL_PIP  = 'absolute bottom-20 right-4 w-48 aspect-video rounded-2xl overflow-hidden z-10 shadow-2xl border border-white/10';

// Switch the local tile between full-screen (alone) and PiP (peer connected).
function setRemoteConnected(connected) {
  document.getElementById('inviteCard')?.classList.toggle('hidden',      connected);
  document.getElementById('remoteContainer')?.classList.toggle('hidden', !connected);

  const localContainer = document.getElementById('localContainer');
  if (localContainer) localContainer.className = connected ? LOCAL_PIP : LOCAL_SOLO;

  // Mic+name badge only shown in PiP mode
  document.getElementById('localMicIndicator')?.classList.toggle('hidden', !connected);

  // Scale avatar for the container size
  const circle = document.getElementById('localAvatarCircle');
  const icon   = document.getElementById('localAvatarIcon');
  if (circle) circle.className = `${connected ? 'w-14 h-14' : 'w-28 h-28'} rounded-full bg-blue-600 flex items-center justify-center shadow-2xl`;
  if (icon)   icon.style.fontSize = connected ? '28px' : '56px';

  updateParticipantCount(connected ? 2 : 1);
}

function updateParticipantCount(n) {
  const el = document.getElementById('participantCount');
  if (el) el.textContent = n;
}

// Toggle the mic icon on a video tile.
function updateMicIndicator(side, on) {
  const id        = side === 'local' ? 'localMicIndicator' : 'remoteMicIndicator';
  const indicator = document.getElementById(id);
  if (!indicator) return;
  const icon = indicator.querySelector('.material-symbols-outlined');
  if (icon) icon.textContent = on ? 'mic' : 'mic_off';
  // Red background when muted
  indicator.classList.toggle('bg-red-600/80', !on);
  indicator.classList.toggle('bg-black/50',    on);
}

// Show the avatar placeholder when camera is off, the video when on.
function updateCameraDisplay(side, on) {
  const videoId  = side === 'local' ? 'localVideo'  : 'remoteVideo';
  const avatarId = side === 'local' ? 'localAvatar' : 'remoteAvatar';
  document.getElementById(videoId)?.classList.toggle('hidden', !on);
  document.getElementById(avatarId)?.classList.toggle('hidden',  on);
}

// ─── WebRTC ───────────────────────────────────────────────────────────────────
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function createPeerConnection() {
  pc = new RTCPeerConnection(RTC_CONFIG);

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.ontrack = (event) => {
    const remoteVideo = document.getElementById('remoteVideo');
    if (remoteVideo && event.streams[0]) remoteVideo.srcObject = event.streams[0];
    setRemoteConnected(true);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) sendMsg({ type: 'ice-candidate', candidate: event.candidate });
  };

  pc.onconnectionstatechange = () => console.log('[WebRTC]', pc.connectionState);
}

function closePeerConnection() {
  if (pc) { pc.close(); pc = null; }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connectWebSocket() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${window.location.host}/ws?meetID=${meetID}`);

  ws.onopen  = () => { if (!isHost) ws.send(JSON.stringify({ type: 'knock' })); };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
  ws.onclose = () => console.log('[WS] closed');
  ws.onerror = (e) => console.error('[WS] error', e);
}

function sendMsg(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ─── Message handler ──────────────────────────────────────────────────────────
// Signaling flow:
//   1. Host clicks Admit  → sends {type:"admit"}
//   2. Guest receives admit → startCamera → createOffer → sends offer
//   3. Host receives offer → createAnswer → sends answer
//   4. Both sides trickle ICE candidates
async function onMessage(msg) {
  switch (msg.type) {

    case 'knock':
      document.getElementById('knockNotification')?.classList.remove('hidden');
      break;

    case 'admit': {
      showScreen('meeting');
      document.getElementById('meetIDBar').textContent = meetID;
      setupShareLink();
      await startCamera();
      createPeerConnection();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendMsg({ type: 'offer', sdp: pc.localDescription });
      break;
    }

    case 'deny':
      ws.close();
      showScreen('denied');
      startRedirectCountdown('deniedCountdown');
      break;

    case 'offer': {
      createPeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendMsg({ type: 'answer', sdp: pc.localDescription });
      break;
    }

    case 'answer':
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      break;

    case 'ice-candidate':
      if (pc && msg.candidate) await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      break;

    case 'mic-state':
      updateMicIndicator('remote', msg.on);
      break;

    case 'camera-state':
      updateCameraDisplay('remote', msg.on);
      break;

    // Guest left — host goes back to solo "waiting" state, ready for a new joiner
    case 'peer-left':
      closePeerConnection();
      const rv = document.getElementById('remoteVideo');
      if (rv) rv.srcObject = null;
      updateCameraDisplay('remote', true);  // reset for next joiner
      updateMicIndicator('remote', true);
      setRemoteConnected(false);
      break;

    case 'meet-full':
      showScreen('full');
      startRedirectCountdown('fullCountdown');
      break;

    case 'meet-ended':
      closePeerConnection();
      stopCamera();
      ws.close();
      showScreen('ended');
      startRedirectCountdown('endedCountdown');
      break;
  }
}

// ─── Meeting controls ─────────────────────────────────────────────────────────
function setupShareLink() {
  const el = document.getElementById('meetCodeDisplay');
  if (el) el.textContent = meetID;
}

function setupMeetingControls() {

  // Mic toggle
  document.getElementById('micBtn')?.addEventListener('click', () => {
    if (!localStream) return;
    micOn = !micOn;
    localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    const icon = document.querySelector('#micBtn .material-symbols-outlined');
    if (icon) icon.textContent = micOn ? 'mic' : 'mic_off';
    document.getElementById('micBtn')?.classList.toggle('bg-red-600',  !micOn);
    document.getElementById('micBtn')?.classList.toggle('bg-slate-700', micOn);
    updateMicIndicator('local', micOn);
    sendMsg({ type: 'mic-state', on: micOn });
  });

  // Camera toggle
  document.getElementById('cameraBtn')?.addEventListener('click', () => {
    if (!localStream) return;
    cameraOn = !cameraOn;
    localStream.getVideoTracks().forEach(t => t.enabled = cameraOn);
    const icon = document.querySelector('#cameraBtn .material-symbols-outlined');
    if (icon) icon.textContent = cameraOn ? 'videocam' : 'videocam_off';
    document.getElementById('cameraBtn')?.classList.toggle('bg-red-600',   !cameraOn);
    document.getElementById('cameraBtn')?.classList.toggle('bg-slate-700',  cameraOn);
    updateCameraDisplay('local', cameraOn);
    sendMsg({ type: 'camera-state', on: cameraOn });
  });

  // Leave
  document.getElementById('leaveBtn')?.addEventListener('click', () => {
    closePeerConnection();
    stopCamera();
    if (ws) ws.close();
    window.location.href = '/';
  });

  // Copy meetID from top bar
  document.getElementById('copyMeetIDBtn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(`${window.location.origin}/?meetID=${meetID}`).then(() => {
      const icon = document.querySelector('#copyMeetIDBtn .material-symbols-outlined');
      if (icon) { icon.textContent = 'check'; setTimeout(() => icon.textContent = 'content_copy', 2000); }
    });
  });

  // Copy meet link from waiting placeholder
  document.getElementById('shareLinkBtn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(`${window.location.origin}/?meetID=${meetID}`).then(() => {
      const icon = document.querySelector('#shareLinkBtn .material-symbols-outlined');
      if (icon) { icon.textContent = 'check'; setTimeout(() => icon.textContent = 'content_copy', 2000); }
    });
  });

  // Close invite card
  document.getElementById('inviteCardClose')?.addEventListener('click', () => {
    document.getElementById('inviteCard')?.classList.add('hidden');
  });

  // Admit
  document.getElementById('admitBtn')?.addEventListener('click', () => {
    sendMsg({ type: 'admit' });
    document.getElementById('knockNotification')?.classList.add('hidden');
  });

  // Deny
  document.getElementById('denyBtn')?.addEventListener('click', () => {
    sendMsg({ type: 'deny' });
    document.getElementById('knockNotification')?.classList.add('hidden');
  });
}

// ─── Page init ────────────────────────────────────────────────────────────────
(function init() {
  setupMeetingControls();

  if (!meetID) {
    showScreen('landing');

    document.getElementById('newMeetingBtn')?.addEventListener('click', () => {
      const id = generateMeetID();
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
    showScreen('meeting');
    document.getElementById('meetIDBar').textContent = meetID;
    setupShareLink();
    startCamera();
    connectWebSocket();

  } else {
    showScreen('knock');
    document.getElementById('knockMeetID').textContent = meetID;

    document.getElementById('askToJoinBtn')?.addEventListener('click', () => {
      showScreen('waiting');
      connectWebSocket();
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
