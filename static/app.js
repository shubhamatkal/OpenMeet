'use strict';

const { createApp, reactive, nextTick, onMounted, onUnmounted } = Vue;

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
    function afterLogin() {
      const params = new URLSearchParams(window.location.search);
      const mid    = params.get('meetID');
      if (mid) {
        state.meetID = mid;
        state.isHost = sessionStorage.getItem(`host_${mid}`) === 'true';
        if (state.isHost) enterMeetingAsHost();
        else state.screen = 'knock';
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
          if (res.ok) { state.user = await res.json(); afterLogin(); return; }
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
    function newMeeting() {
      state.showMeetTypeModal = false;
      const id = generateMeetID();
      sessionStorage.setItem(`host_${id}`, 'true');
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
        const vid = document.getElementById('localVideo');
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
      closePeerConnection(); stopCamera(); closeWebSocket();
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

      // Functions
      avatarURL,
      toggleDark,
      login, register, forgotPassword, resetPassword, logout,
      newMeeting, joinMeet, goHome,
      askToJoin, cancelWaiting,
      forceJoin, cancelForceJoin,
      toggleMic, toggleCamera, leaveMeeting,
      admitKnocker, denyKnocker,
      copyMeetLink,
    };
  },
}).mount('#app');
