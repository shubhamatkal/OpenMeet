'use strict';

const { createApp, reactive, nextTick, onMounted, onUnmounted, watch } = Vue;

// ─── Local avatars ────────────────────────────────────────────────────────────
const AVATARS = ['female1.png', 'female2.png', 'male1.png', 'male2.png'];
function avatarURL(filename) { return `/avatars/${filename}`; }

// ─── WebRTC config ────────────────────────────────────────────────────────────
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ─── Meet ID utils ────────────────────────────────────────────────────────────
function generateMeetID() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const seg = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${seg(3)}-${seg(4)}-${seg(3)}`;
}
function parseMeetID(input) {
  try { return new URL(input.trim()).searchParams.get('meetID') || input.trim(); }
  catch { return input.trim(); }
}

// ─── Dark mode ────────────────────────────────────────────────────────────────
function initDark() {
  const stored = localStorage.getItem('theme');
  const dark = stored !== null ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
  return dark;
}

// ─── Vue App ──────────────────────────────────────────────────────────────────
createApp({
  setup() {

    // ── Reactive state ──
    const state = reactive({
      screen: 'auth-login',
      user:   null,
      token:  null,

      // Auth
      authForm:    { name: '', email: '', password: '', avatar: '' },
      avatarOptions: AVATARS,
      authError:   '',
      authSuccess: '',
      authLoading: false,
      showPassword: false,
      pendingResetToken: null,

      // Meeting identity
      meetID:  null,
      isHost:  false,
      meetIDInput: '',

      // Meeting UI
      showMeetTypeModal:   false,
      inviteCardDismissed: false,
      linkCopied:          false,
      showParticipants:    false,

      // Meeting type (1to1 | group)
      meetType: '1to1',

      // SFU group meeting state
      sfuRoomPeers: [],   // [{id, name, avatar}] — from room-state messages
      sfuPeers:     [],   // [{id, name, avatar}] — peers with active media
      sfuSpeaking:  {},   // peerID → boolean (speaking indicator per remote peer)
      sfuKnocker:   null, // {id, name, avatar} — person knocking (shown to host)
      sfuPeerMedia: {}, // peerID → {micOn, cameraOn}

      // Duplicate session
      alreadyInMeet: false,
      forceJoining:  false,

      // Media state
      micOn:         true,
      localCameraOn: true,
      remoteMicOn:   true,
      remoteCameraOn: true,
      remoteConnected: false,
      remoteUser:    null,   // { id, name, avatar }
      knocker:       null,

      // Audio speaking detection
      localSpeaking:  false,
      remoteSpeaking: false,

      // Clock
      timeStr: '',
      dateStr: '',
      isDark:  initDark(),

      // Countdown
      countdownText: '',
    });

    // ── Non-reactive refs ──
    let ws             = null;
    let pc             = null;
    let localStream    = null;
    let localAudioCtx  = null;
    let remoteAudioCtx = null;

    // ── SFU non-reactive refs ──
    const sfuStreams   = new Map(); // peerID → MediaStream
    const sfuAudioCtxs = new Map(); // peerID → AudioContext
    // Serialises all SDP offer/answer operations on the SFU RTCPeerConnection.
    // ws.onmessage is not awaited, so without this queue concurrent setRemoteDescription
    // calls would race and corrupt the WebRTC state machine.
    let sfuSignalingQueue = Promise.resolve();

    // Re-assign srcObjects whenever sfuPeers list changes (e.g. after renegotiation re-render).
    watch(() => state.sfuPeers.length, async () => {
      await nextTick();
      for (const [peerID, stream] of sfuStreams) {
        const vid = document.getElementById(`sfuVideo-${peerID}`);
        if (vid && vid.srcObject !== stream) vid.srcObject = stream;
      }
    });

    // ── Clock ──
    function updateClock() {
      const now = new Date();
      state.timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      state.dateStr = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    }
    updateClock();
    const clockInterval = setInterval(updateClock, 1000);
    onUnmounted(() => clearInterval(clockInterval));

    // ── Dark mode ──
    function toggleDark() {
      state.isDark = !state.isDark;
      document.documentElement.classList.toggle('dark', state.isDark);
      localStorage.setItem('theme', state.isDark ? 'dark' : 'light');
    }

    // ── API helpers ──
    async function apiPost(path, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
      return fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    }
    async function apiGet(path) {
      return fetch(path, { headers: { 'Authorization': `Bearer ${state.token}` } });
    }

    function saveSession(token, user) {
      state.token = token;
      state.user  = user;
      localStorage.setItem('om_token', token);
    }
    function clearSession() {
      state.token = null;
      state.user  = null;
      localStorage.removeItem('om_token');
    }

    // ── Auth actions ──
    async function login() {
      state.authError = '';
      state.authLoading = true;
      try {
        const res  = await apiPost('/api/auth/login', { email: state.authForm.email, password: state.authForm.password });
        const data = await res.json();
        if (!res.ok) { state.authError = data.error; return; }
        saveSession(data.token, data.user);
        afterLogin();
      } catch { state.authError = 'Network error. Please try again.'; }
      finally   { state.authLoading = false; }
    }

    async function register() {
      state.authError = '';
      if (!state.authForm.avatar) { state.authError = 'Please choose a profile picture.'; return; }
      state.authLoading = true;
      try {
        const res  = await apiPost('/api/auth/register', {
          name: state.authForm.name, email: state.authForm.email,
          password: state.authForm.password, avatar: state.authForm.avatar,
        });
        const data = await res.json();
        if (!res.ok) { state.authError = data.error; return; }
        state.screen = 'auth-verify-sent';
      } catch { state.authError = 'Network error. Please try again.'; }
      finally   { state.authLoading = false; }
    }

    async function forgotPassword() {
      state.authError = ''; state.authSuccess = '';
      state.authLoading = true;
      try {
        const res  = await apiPost('/api/auth/forgot-password', { email: state.authForm.email });
        const data = await res.json();
        if (!res.ok) { state.authError = data.error; return; }
        state.authSuccess = data.message;
      } catch { state.authError = 'Network error. Please try again.'; }
      finally   { state.authLoading = false; }
    }

    async function resetPassword() {
      state.authError = ''; state.authSuccess = '';
      state.authLoading = true;
      try {
        const res  = await apiPost('/api/auth/reset-password', { token: state.pendingResetToken, password: state.authForm.password });
        const data = await res.json();
        if (!res.ok) { state.authError = data.error; return; }
        state.authSuccess = data.message + ' Redirecting to sign in…';
        setTimeout(() => { state.screen = 'auth-login'; state.authSuccess = ''; }, 2000);
      } catch { state.authError = 'Network error. Please try again.'; }
      finally   { state.authLoading = false; }
    }

    async function verifyEmailFromToken(token) {
      try {
        const res  = await apiPost('/api/auth/verify-email', { token });
        const data = await res.json();
        if (!res.ok) { state.authError = data.error || 'Verification failed. Link may have expired.'; state.screen = 'auth-login'; return; }
        saveSession(data.token, data.user);
        afterLogin();
      } catch { state.authError = 'Network error during verification.'; state.screen = 'auth-login'; }
    }

    function logout() {
      closeWebSocket(); closePeerConnection(); stopCamera();
      clearSession();
      state.screen = 'auth-login';
      state.authForm = { name: '', email: '', password: '', avatar: '' };
      window.history.replaceState({}, '', '/');
    }

    // ── After login: route to correct screen ──
    async function afterLogin() {
      const params = new URLSearchParams(window.location.search);
      const mid    = params.get('meetID');
      if (mid) {
        state.meetID = mid;
        state.isHost = sessionStorage.getItem(`host_${mid}`) === 'true';

        // Determine meeting type: sessionStorage (set when host created it) takes
        // precedence; otherwise ask the server (checks if an SFU room is active).
        let meetType = sessionStorage.getItem(`type_${mid}`);
        if (!meetType) {
          try {
            const res = await fetch(`/api/meet-info?meetID=${encodeURIComponent(mid)}`);
            if (res.ok) { meetType = (await res.json()).type; }
          } catch {}
          meetType = meetType || '1to1';
        }

        state.meetType = meetType;
        if (meetType === 'group') {
          enterGroupMeeting();
        } else if (state.isHost) {
          enterMeetingAsHost();
        } else {
          state.screen = 'knock';
        }
      } else {
        state.screen = 'landing';
      }
    }

    // ── On mount ──
    onMounted(async () => {
      const params = new URLSearchParams(window.location.search);

      const verifyToken = params.get('verify_token');
      if (verifyToken) { window.history.replaceState({}, '', '/'); await verifyEmailFromToken(verifyToken); return; }

      const resetToken = params.get('reset_token');
      if (resetToken) { window.history.replaceState({}, '', '/'); state.pendingResetToken = resetToken; state.screen = 'auth-reset'; return; }

      const savedToken = localStorage.getItem('om_token');
      if (savedToken) {
        state.token = savedToken;
        try {
          const res = await apiGet('/api/auth/me');
          if (res.ok) { state.user = await res.json(); await afterLogin(); return; }
        } catch {}
        clearSession();
      }
      state.screen = 'auth-login';
    });

    // ── Check if already in meet (REST) ──
    async function checkIfAlreadyInMeet() {
      try {
        const res  = await apiGet(`/api/meet/check?meetID=${state.meetID}`);
        const data = await res.json();
        return data.alreadyIn === true;
      } catch { return false; }
    }

    // ── Meeting navigation ──
    function newMeeting(type = '1to1') {
      state.showMeetTypeModal = false;
      const id = generateMeetID();
      sessionStorage.setItem(`host_${id}`, 'true');
      sessionStorage.setItem(`type_${id}`, type);
      const url = new URL(window.location.href);
      url.searchParams.set('meetID', id);
      window.location.href = url.toString();
    }
    function joinMeet() {
      const id = parseMeetID(state.meetIDInput);
      if (!id) return;
      const url = new URL(window.location.href);
      url.searchParams.set('meetID', id);
      window.location.href = url.toString();
    }
    function goHome() {
      closeWebSocket(); closePeerConnection(); stopCamera();
      window.location.href = '/';
    }

    // ── Camera ──
    async function startCamera() {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        await nextTick();
        // Assign to whichever local video element is currently in the DOM.
        const vid = document.getElementById('localVideo') || document.getElementById('localVideoGroup');
        if (vid) vid.srcObject = localStream;
        startLocalAudio();
      } catch (err) { console.error('Camera error:', err); }
    }

    function stopCamera() {
      if (!localStream) return;
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
      const vid = document.getElementById('localVideo');
      if (vid) vid.srcObject = null;
      if (localAudioCtx) { localAudioCtx.close(); localAudioCtx = null; }
      state.localSpeaking = false;
    }

    // ── Audio level detection ──
    function startLocalAudio() {
      if (!localStream) return;
      try {
        localAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src      = localAudioCtx.createMediaStreamSource(localStream);
        const analyser = localAudioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.5;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const ctx  = localAudioCtx;
        function tick() {
          if (!ctx || ctx.state === 'closed') return;
          analyser.getByteFrequencyData(data);
          const avg = data.slice(2, 20).reduce((a, b) => a + b, 0) / 18;
          state.localSpeaking = avg > 20 && state.micOn;
          requestAnimationFrame(tick);
        }
        tick();
      } catch (e) { console.warn('Audio analysis unavailable', e); }
    }

    function startRemoteAudio(stream) {
      if (remoteAudioCtx) { remoteAudioCtx.close(); remoteAudioCtx = null; }
      try {
        remoteAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src      = remoteAudioCtx.createMediaStreamSource(stream);
        const analyser = remoteAudioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.5;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const ctx  = remoteAudioCtx;
        function tick() {
          if (!ctx || ctx.state === 'closed') return;
          analyser.getByteFrequencyData(data);
          const avg = data.slice(2, 20).reduce((a, b) => a + b, 0) / 18;
          state.remoteSpeaking = avg > 20;
          requestAnimationFrame(tick);
        }
        tick();
      } catch (e) { console.warn('Remote audio analysis unavailable', e); }
    }

    function stopRemoteAudio() {
      if (remoteAudioCtx) { remoteAudioCtx.close(); remoteAudioCtx = null; }
      state.remoteSpeaking = false;
    }

    // Per-peer audio analysis for group meetings.
    function startSFURemoteAudio(peerID, stream) {
      // Stop any existing context for this peer first.
      const existing = sfuAudioCtxs.get(peerID);
      if (existing) { try { existing.close(); } catch {} sfuAudioCtxs.delete(peerID); }
      try {
        const ctx      = new (window.AudioContext || window.webkitAudioContext)();
        const src      = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.5;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        sfuAudioCtxs.set(peerID, ctx);
        function tick() {
          if (!ctx || ctx.state === 'closed') return;
          analyser.getByteFrequencyData(data);
          const avg = data.slice(2, 20).reduce((a, b) => a + b, 0) / 18;
          state.sfuSpeaking[peerID] = avg > 20;
          requestAnimationFrame(tick);
        }
        tick();
      } catch (e) { console.warn('SFU audio analysis unavailable', e); }
    }

    function stopSFURemoteAudio(peerID) {
      const ctx = sfuAudioCtxs.get(peerID);
      if (ctx) { try { ctx.close(); } catch {} sfuAudioCtxs.delete(peerID); }
      delete state.sfuSpeaking[peerID];
    }

    // ── WebRTC ──
    function createPeerConnection() {
      pc = new RTCPeerConnection(RTC_CONFIG);
      if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

      pc.ontrack = (e) => {
        const rv = document.getElementById('remoteVideo');
        if (rv && e.streams[0]) {
          rv.srcObject = e.streams[0];
          startRemoteAudio(e.streams[0]);
        }
        state.remoteConnected = true;
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) wsSend({ type: 'ice-candidate', candidate: e.candidate });
      };

      pc.onconnectionstatechange = () => console.log('[WebRTC]', pc.connectionState);
    }

    function closePeerConnection() {
      if (pc) { pc.close(); pc = null; }
      stopRemoteAudio();
    }

    // ── WebSocket ──
    function connectWebSocket() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws?meetID=${state.meetID}&token=${state.token}`);

      ws.onopen = () => {
        if (state.forceJoining) {
          // Send force-join first, then knock if guest
          wsSend({ type: 'force-join' });
          state.forceJoining = false;
          if (!state.isHost) {
            wsSend({ type: 'knock', name: state.user.name, avatar: state.user.avatar, id: state.user.id });
          }
        } else if (!state.isHost) {
          wsSend({ type: 'knock', name: state.user.name, avatar: state.user.avatar, id: state.user.id });
        }
      };

      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        onMessage(m);
      };

      ws.onclose = () => console.log('[WS] closed');
      ws.onerror = (e) => console.error('[WS] error', e);
    }

    function closeWebSocket() {
      if (ws) { ws.close(); ws = null; }
    }

    function wsSend(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }

    // ── Message handler ──
    async function onMessage(msg) {
      switch (msg.type) {

        case 'already-in-meet':
          // Only show warning if we didn't already know (e.g. received after force-join was sent)
          if (!state.forceJoining) state.alreadyInMeet = true;
          break;

        case 'session-replaced':
          closeWebSocket();
          closePeerConnection();
          stopCamera();
          state.screen = 'session-replaced';
          break;

        case 'knock':
          state.knocker = { name: msg.name, avatar: msg.avatar, id: msg.id };
          break;

        case 'admit':
          state.screen = 'meeting';
          await startCamera();
          createPeerConnection();
          {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            wsSend({ type: 'offer', sdp: pc.localDescription, user: { id: state.user.id, name: state.user.name, avatar: state.user.avatar } });
          }
          break;

        case 'deny':
          closeWebSocket();
          state.screen = 'denied';
          startCountdown(5);
          break;

        case 'offer':
          // Host receives offer from guest
          createPeerConnection();
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          state.remoteUser = msg.user || null;
          {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            wsSend({ type: 'answer', sdp: pc.localDescription, user: { id: state.user.id, name: state.user.name, avatar: state.user.avatar } });
          }
          break;

        case 'answer':
          // Guest receives answer from host
          if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          if (msg.user) state.remoteUser = msg.user;
          break;

        case 'ice-candidate':
          if (pc && msg.candidate) await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          break;

        case 'mic-state':
          state.remoteMicOn = msg.on;
          if (!msg.on) state.remoteSpeaking = false;
          break;

        case 'camera-state':
          state.remoteCameraOn = msg.on;
          break;

        case 'peer-left':
          closePeerConnection();
          const rv = document.getElementById('remoteVideo');
          if (rv) rv.srcObject = null;
          state.remoteConnected  = false;
          state.remoteUser       = null;
          state.remoteMicOn      = true;
          state.remoteCameraOn   = true;
          state.knocker          = null;
          break;

        case 'meet-full':
          state.screen = 'full';
          startCountdown(5);
          break;

        case 'meet-ended':
          closePeerConnection();
          stopCamera();
          closeWebSocket();
          state.screen = 'ended';
          startCountdown(5);
          break;
      }
    }

    // ── Group meeting (SFU) ──────────────────────────────────────────────────────

    async function enterGroupMeeting() {
      // Show waiting screen while the server decides (first = admitted instantly,
      // others = wait for host knock flow).
      state.screen = 'waiting';
      connectSFU();
    }

    function connectSFU() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/sfu?meetID=${state.meetID}&token=${state.token}`);

      ws.onopen = () => {
        // Server will respond with 'admitted' (first or host) or 'waiting' (knocker).
        // sfuCreateOffer() is called from onSFUMessage once admitted.
      };

      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        onSFUMessage(m);
      };

      ws.onclose = () => console.log('[SFU WS] closed');
      ws.onerror = (err) => console.error('[SFU WS] error', err);
    }

    async function sfuCreateOffer() {
      // Guard: don't create a second PeerConnection if one already exists.
      if (pc) return;

      const myPc = new RTCPeerConnection(RTC_CONFIG);
      pc = myPc;

      // Add local tracks.
      if (localStream) localStream.getTracks().forEach(t => myPc.addTrack(t, localStream));

      // ICE trickle to server.
      myPc.onicecandidate = (e) => {
        if (e.candidate) wsSend({ type: 'ice-candidate', candidate: e.candidate });
      };

      // Each ontrack event is a remote participant's track (fires once for audio, once for video).
      myPc.ontrack = async (e) => {
        console.log('[SFU ontrack]', e.track.kind, 'id:', e.track.id, 'streams:', e.streams.length, e.streams[0]?.id);
        const track = e.track;
        let stream = e.streams && e.streams[0];
        let peerID;

        if (stream && stream.id) {
          // Happy path: Pion included MSID in SDP so browser grouped the track into a stream.
          peerID = stream.id;
          // Make sure the stream in our map is the same object (handles audio + video arriving
          // separately but sharing one MediaStream).
          if (!sfuStreams.has(peerID)) sfuStreams.set(peerID, stream);
          else stream = sfuStreams.get(peerID); // reuse the existing stream object
        } else {
          // Fallback: some browsers/renegotiation paths give e.streams = [].
          // Track id format is "{peerID}-audio" or "{peerID}-video" (set by Pion AddSenderTrack).
          const sep = track.id.lastIndexOf('-');
          if (sep < 0) return;
          peerID = track.id.slice(0, sep);
          if (!peerID) return;
          // Build / reuse a MediaStream keyed by peerID.
          if (!sfuStreams.has(peerID)) sfuStreams.set(peerID, new MediaStream());
          stream = sfuStreams.get(peerID);
          if (!stream.getTrackById(track.id)) stream.addTrack(track);
        }

        if (!peerID || peerID === state.user?.id) return;

        // Start audio analysis only when the audio track arrives.
        if (track.kind === 'audio') startSFURemoteAudio(peerID, stream);

        // Add peer to display list if not already there.
        if (!state.sfuPeers.find(p => p.id === peerID)) {
          const info = state.sfuRoomPeers.find(p => p.id === peerID) || {};
          state.sfuPeers.push({ id: peerID, name: info.name || 'Guest', avatar: info.avatar || null });
        }

        // Assign srcObject (use the map value so video + audio share the same stream object).
        await nextTick();
        const vid = document.getElementById(`sfuVideo-${peerID}`);
        if (vid) vid.srcObject = sfuStreams.get(peerID);
      };

      myPc.onconnectionstatechange = () => {
        console.log('[SFU WebRTC]', myPc.connectionState);
        if (myPc.connectionState === 'disconnected' || myPc.connectionState === 'failed') {
          state.sfuPeers = [];
        }
      };

      // Use async/await so the local description is set before sending the offer,
      // and myPc is used throughout (not the outer `pc` which could be reassigned).
      const offer = await myPc.createOffer();
      await myPc.setLocalDescription(offer);
      wsSend({ type: 'offer', sdp: offer.sdp });
    }

    async function onSFUMessage(msg) {
      switch (msg.type) {

        case 'admitted':
          // Server admitted us — start camera then begin WebRTC handshake.
          state.screen = 'group-meeting';
          await nextTick();
          await startCamera();
          sfuCreateOffer();
          break;

        case 'waiting':
          // Already on waiting screen; nothing extra needed.
          break;

        case 'denied':
          closeWebSocket();
          state.screen = 'denied';
          startCountdown(5);
          break;

        case 'knock':
          // Someone is knocking — show the admit popup to the host.
          state.sfuKnocker = msg.user || null;
          break;

        case 'peer-mic-state':
          if (msg.userID) {
            state.sfuPeerMedia = {
              ...state.sfuPeerMedia,
              [msg.userID]: { ...state.sfuPeerMedia[msg.userID], micOn: msg.on },
            };
          }
          break;

        case 'peer-camera-state':
          if (msg.userID) {
            state.sfuPeerMedia = {
              ...state.sfuPeerMedia,
              [msg.userID]: { ...state.sfuPeerMedia[msg.userID], cameraOn: msg.on },
            };
          }
          break;

        case 'answer':
          console.log('[SFU] received answer, queuing setRemoteDescription');
          sfuSignalingQueue = sfuSignalingQueue.then(async () => {
            if (pc) await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
            console.log('[SFU] answer applied, signalingState:', pc?.signalingState);
          }).catch(e => console.error('[SFU signaling] answer:', e));
          break;

        case 'offer':
          // Server-initiated renegotiation (e.g. existing peer's tracks being added).
          console.log('[SFU] received renegotiation offer, queuing');
          sfuSignalingQueue = sfuSignalingQueue.then(async () => {
            if (!pc) return;
            console.log('[SFU] applying renegotiation offer, signalingState:', pc.signalingState);
            await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
            const ans = await pc.createAnswer();
            await pc.setLocalDescription(ans);
            wsSend({ type: 'answer', sdp: ans.sdp });
            console.log('[SFU] renegotiation done, signalingState:', pc.signalingState);
          }).catch(e => console.error('[SFU signaling] offer:', e));
          break;

        case 'ice-candidate':
          if (pc && msg.candidate) await pc.addIceCandidate(msg.candidate);
          break;

        case 'room-state': {
          state.sfuRoomPeers = msg.peers || [];
          const activeIDs = new Set(state.sfuRoomPeers.map(p => p.id));
          // Remove peers that have left (also clean up streams and audio).
          state.sfuPeers = state.sfuPeers.filter(sp => {
            if (!activeIDs.has(sp.id)) {
              sfuStreams.delete(sp.id);
              stopSFURemoteAudio(sp.id);
              return false;
            }
            return true;
          });
          // Update names/avatars for remaining peers.
          state.sfuPeers = state.sfuPeers.map(sp => {
            const info = state.sfuRoomPeers.find(p => p.id === sp.id);
            return info ? { ...sp, name: info.name, avatar: info.avatar } : sp;
          });
          break;
        }
      }
    }

    // ── Host enters meeting ──
    async function enterMeetingAsHost() {
      const alreadyIn = await checkIfAlreadyInMeet();
      if (alreadyIn) {
        state.alreadyInMeet = true;
        state.screen = 'meeting'; // show meeting screen behind the modal
        await nextTick();
        await startCamera();      // start camera so it's ready
        return;
      }
      state.screen = 'meeting';
      await nextTick();
      await startCamera();
      connectWebSocket();
    }

    // ── Duplicate session modal actions ──
    async function forceJoin() {
      state.alreadyInMeet = false;
      state.forceJoining  = true;
      if (state.isHost) {
        connectWebSocket(); // will send force-join in onopen
      } else {
        state.screen = 'waiting';
        connectWebSocket();
      }
    }

    function cancelForceJoin() {
      state.alreadyInMeet = false;
      state.forceJoining  = false;
      if (!state.isHost) state.screen = 'knock';
    }

    // ── Guest knock ──
    async function askToJoin() {
      const alreadyIn = await checkIfAlreadyInMeet();
      if (alreadyIn) { state.alreadyInMeet = true; return; }
      state.screen = 'waiting';
      connectWebSocket();
    }

    function cancelWaiting() {
      closeWebSocket();
      goHome();
    }

    // ── Meeting controls ──
    function toggleMic() {
      if (!localStream) return;
      state.micOn = !state.micOn;
      localStream.getAudioTracks().forEach(t => t.enabled = state.micOn);
      if (!state.micOn) state.localSpeaking = false;
      wsSend({ type: 'mic-state', on: state.micOn });
    }

    function toggleCamera() {
      if (!localStream) return;
      state.localCameraOn = !state.localCameraOn;
      localStream.getVideoTracks().forEach(t => t.enabled = state.localCameraOn);
      wsSend({ type: 'camera-state', on: state.localCameraOn });
    }

    function leaveMeeting() {
      // Notify server immediately so it can broadcast room-state to remaining
      // peers before the TCP connection closes (which can lag by seconds).
      wsSend({ type: 'leave' });
      closePeerConnection(); stopCamera(); closeWebSocket();
      sfuStreams.clear();
      for (const [, ctx] of sfuAudioCtxs) { try { ctx.close(); } catch {} }
      sfuAudioCtxs.clear();
      state.sfuPeers = [];
      state.sfuRoomPeers = [];
      state.sfuSpeaking = {};
      state.sfuPeerMedia = {};
      sfuSignalingQueue = Promise.resolve();
      window.location.href = '/';
    }

    function admitKnocker() {
      wsSend({ type: 'admit' });
      state.knocker = null;
    }
    function denyKnocker() {
      wsSend({ type: 'deny' });
      state.knocker = null;
    }

    // SFU group meeting admit / deny
    function sfuAdmitKnocker() {
      if (!state.sfuKnocker) return;
      wsSend({ type: 'admit', userID: state.sfuKnocker.id });
      state.sfuKnocker = null;
    }
    function sfuDenyKnocker() {
      if (!state.sfuKnocker) return;
      wsSend({ type: 'deny', userID: state.sfuKnocker.id });
      state.sfuKnocker = null;
    }

    function copyMeetLink() {
      navigator.clipboard.writeText(`${location.origin}/?meetID=${state.meetID}`).then(() => {
        state.linkCopied = true;
        setTimeout(() => state.linkCopied = false, 2000);
      });
    }

    function startCountdown(seconds) {
      let t = seconds;
      const tick = () => state.countdownText = `Returning to home in ${t}s…`;
      tick();
      const iv = setInterval(() => {
        t--;
        if (t <= 0) { clearInterval(iv); window.location.href = '/'; }
        else tick();
      }, 1000);
    }

    // ── Participants list (derived) ──
    function getParticipants() {
      const list = [];
      if (state.user) {
        list.push({ ...state.user, isMe: true, isHost: state.isHost, micOn: state.micOn, cameraOn: state.localCameraOn });
      }
      if (state.remoteUser) {
        list.push({ ...state.remoteUser, isMe: false, isHost: !state.isHost, micOn: state.remoteMicOn, cameraOn: state.remoteCameraOn });
      }
      return list;
    }

    // ── Expose to template ──
    return {
      // State (getters + setters for properties set directly in template)
      get screen()              { return state.screen; },
      set screen(v)             { state.screen = v; },
      get user()                { return state.user; },
      get authForm()            { return state.authForm; },
      get avatarOptions()       { return state.avatarOptions; },
      get authError()           { return state.authError; },
      set authError(v)          { state.authError = v; },
      get authSuccess()         { return state.authSuccess; },
      set authSuccess(v)        { state.authSuccess = v; },
      get authLoading()         { return state.authLoading; },
      get showPassword()        { return state.showPassword; },
      set showPassword(v)       { state.showPassword = v; },
      get isDark()              { return state.isDark; },
      get timeStr()             { return state.timeStr; },
      get dateStr()             { return state.dateStr; },
      get meetID()              { return state.meetID; },
      get isHost()              { return state.isHost; },
      get meetIDInput()         { return state.meetIDInput; },
      set meetIDInput(v)        { state.meetIDInput = v; },
      get micOn()               { return state.micOn; },
      get localCameraOn()       { return state.localCameraOn; },
      get remoteMicOn()         { return state.remoteMicOn; },
      get remoteCameraOn()      { return state.remoteCameraOn; },
      get remoteConnected()     { return state.remoteConnected; },
      get remoteUser()          { return state.remoteUser; },
      get knocker()             { return state.knocker; },
      get alreadyInMeet()       { return state.alreadyInMeet; },
      get inviteCardDismissed() { return state.inviteCardDismissed; },
      set inviteCardDismissed(v){ state.inviteCardDismissed = v; },
      get linkCopied()          { return state.linkCopied; },
      get showMeetTypeModal()    { return state.showMeetTypeModal; },
      set showMeetTypeModal(v)   { state.showMeetTypeModal = v; },
      get showParticipants()    { return state.showParticipants; },
      set showParticipants(v)   { state.showParticipants = v; },
      get localSpeaking()       { return state.localSpeaking; },
      get remoteSpeaking()      { return state.remoteSpeaking; },
      get countdownText()       { return state.countdownText; },
      get participants()        { return getParticipants(); },

      // Group meeting (SFU)
      get meetType()            { return state.meetType; },
      get sfuRoomPeers()        { return state.sfuRoomPeers; },
      get sfuPeers()            { return state.sfuPeers; },
      get sfuSpeaking()         { return state.sfuSpeaking; },
      get sfuKnocker()          { return state.sfuKnocker; },
      get sfuPeerMedia()        { return state.sfuPeerMedia; },
      get sfuParticipants() {
        return state.sfuRoomPeers.map(p => ({
          ...p, isMe: p.id === state.user?.id,
        }));
      },
      get sfuGridStyle() {
        // Total tiles = local + remotes. Use CSS grid-template to avoid Tailwind CDN scan issues.
        const total = 1 + state.sfuPeers.length;
        if (total === 1) return 'grid-template-columns: 1fr; grid-template-rows: 1fr;';
        if (total === 2) return 'grid-template-columns: 1fr 1fr; grid-template-rows: 1fr;';
        if (total <= 4) return 'grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;';
        if (total <= 6) return 'grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(2, 1fr);';
        return 'grid-template-columns: repeat(3, 1fr);';
      },

      // Functions
      avatarURL,
      toggleDark,
      login, register, forgotPassword, resetPassword, logout,
      newMeeting, joinMeet, goHome,
      askToJoin, cancelWaiting,
      forceJoin, cancelForceJoin,
      toggleMic, toggleCamera, leaveMeeting,
      admitKnocker, denyKnocker,
      sfuAdmitKnocker, sfuDenyKnocker,
      copyMeetLink,
    };
  },
}).mount('#app');
