'use strict';

const { createApp, reactive, computed, onMounted, onUnmounted, nextTick } = Vue;

// ─── Local avatars ────────────────────────────────────────────────────────────
const AVATARS = ['female1.png', 'female2.png', 'male1.png', 'male2.png'];

function avatarURL(filename) {
  return `/avatars/${filename}`;
}

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
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = stored !== null ? stored === 'dark' : prefersDark;
  document.documentElement.classList.toggle('dark', dark);
  return dark;
}

// ─── Vue App ──────────────────────────────────────────────────────────────────
createApp({
  setup() {
    // ── State ──
    const state = reactive({
      screen: 'auth-login',
      user: null,
      token: null,

      // Auth forms
      authForm: { name: '', email: '', password: '', avatar: '' },
      avatarOptions: AVATARS,
      authError: '',
      authSuccess: '',
      authLoading: false,
      showPassword: false,
      pendingResetToken: null,

      // Meeting
      meetID: null,
      isHost: false,
      meetIDInput: '',
      inviteCardDismissed: false,
      linkCopied: false,

      // WebRTC / media
      micOn: true,
      localCameraOn: true,
      remoteMicOn: true,
      remoteCameraOn: true,
      remoteConnected: false,
      remoteUser: null,
      knocker: null,

      // Countdown
      countdownText: '',

      // Clock
      timeStr: '',
      dateStr: '',

      // Theme
      isDark: initDark(),
    });

    // ── Refs for WebRTC ──
    let ws          = null;
    let pc          = null;
    let localStream = null;

    // ── Clock ──
    function updateClock() {
      const now = new Date();
      state.timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      state.dateStr = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    }
    updateClock();
    const clockInterval = setInterval(updateClock, 1000);

    // ── Dark mode ──
    function toggleDark() {
      state.isDark = !state.isDark;
      document.documentElement.classList.toggle('dark', state.isDark);
      localStorage.setItem('theme', state.isDark ? 'dark' : 'light');
    }

    // ── Auth API helpers ──
    async function apiPost(path, body, requiresAuth = false) {
      const headers = { 'Content-Type': 'application/json' };
      if (requiresAuth && state.token) headers['Authorization'] = `Bearer ${state.token}`;
      const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
      return res;
    }

    async function apiGet(path) {
      const res = await fetch(path, {
        headers: { 'Authorization': `Bearer ${state.token}` },
      });
      return res;
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
      state.authError   = '';
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
      state.authError   = '';
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
      state.authError   = '';
      state.authSuccess = '';
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
      state.authError   = '';
      state.authSuccess = '';
      state.authLoading = true;
      try {
        const res  = await apiPost('/api/auth/reset-password', {
          token: state.pendingResetToken, password: state.authForm.password,
        });
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
        if (!res.ok) {
          state.authError = data.error || 'Verification failed. The link may have expired.';
          state.screen    = 'auth-login';
          return;
        }
        saveSession(data.token, data.user);
        afterLogin();
      } catch {
        state.authError = 'Network error during verification.';
        state.screen    = 'auth-login';
      }
    }

    function logout() {
      closeWebSocket();
      closePeerConnection();
      stopCamera();
      clearSession();
      state.screen = 'auth-login';
      state.authForm = { name: '', email: '', password: '', avatar: '' };
      // Clear URL params
      window.history.replaceState({}, '', '/');
    }

    // ── After successful login: decide which screen to show ──
    function afterLogin() {
      const params = new URLSearchParams(window.location.search);
      const mid    = params.get('meetID');
      if (mid) {
        state.meetID = mid;
        state.isHost = sessionStorage.getItem(`host_${mid}`) === 'true';
        if (state.isHost) {
          enterMeetingAsHost();
        } else {
          state.screen = 'knock';
        }
      } else {
        state.screen = 'landing';
      }
    }

    // ── On mount: restore session / handle URL tokens ──
    onMounted(async () => {
      const params = new URLSearchParams(window.location.search);

      // Handle email verification link
      const verifyToken = params.get('verify_token');
      if (verifyToken) {
        window.history.replaceState({}, '', '/');
        await verifyEmailFromToken(verifyToken);
        return;
      }

      // Handle password reset link
      const resetToken = params.get('reset_token');
      if (resetToken) {
        window.history.replaceState({}, '', '/');
        state.pendingResetToken = resetToken;
        state.screen = 'auth-reset';
        return;
      }

      // Restore saved session
      const savedToken = localStorage.getItem('om_token');
      if (savedToken) {
        state.token = savedToken;
        try {
          const res = await apiGet('/api/auth/me');
          if (res.ok) {
            state.user = await res.json();
            afterLogin();
            return;
          }
        } catch {}
        clearSession();
      }

      state.screen = 'auth-login';
    });

    onUnmounted(() => clearInterval(clockInterval));

    // ── Meeting: new + join ──
    function newMeeting() {
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
      closeWebSocket();
      closePeerConnection();
      stopCamera();
      window.location.href = '/';
    }

    // ── Camera ──
    async function startCamera() {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        await nextTick();
        const vid = document.getElementById('localVideo');
        if (vid) vid.srcObject = localStream;
      } catch (err) { console.error('Camera error:', err); }
    }

    function stopCamera() {
      if (!localStream) return;
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
      const vid = document.getElementById('localVideo');
      if (vid) vid.srcObject = null;
    }

    // ── WebRTC ──
    function createPeerConnection() {
      pc = new RTCPeerConnection(RTC_CONFIG);
      if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

      pc.ontrack = (e) => {
        const rv = document.getElementById('remoteVideo');
        if (rv && e.streams[0]) rv.srcObject = e.streams[0];
        state.remoteConnected = true;
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) wsSend({ type: 'ice-candidate', candidate: e.candidate });
      };

      pc.onconnectionstatechange = () => console.log('[WebRTC]', pc.connectionState);
    }

    function closePeerConnection() {
      if (pc) { pc.close(); pc = null; }
    }

    // ── WebSocket ──
    function connectWebSocket() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws?meetID=${state.meetID}&token=${state.token}`);
      ws.onopen    = () => { if (!state.isHost) wsSend({ type: 'knock', name: state.user.name, avatar: state.user.avatar, id: state.user.id }); };
      ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
      ws.onclose   = () => console.log('[WS] closed');
      ws.onerror   = (e) => console.error('[WS] error', e);
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
        case 'knock':
          state.knocker = { name: msg.name, avatar: msg.avatar, id: msg.id };
          break;

        case 'admit':
          state.screen = 'meeting';
          await startCamera();
          createPeerConnection();
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          wsSend({ type: 'offer', sdp: pc.localDescription, user: { id: state.user.id, name: state.user.name, avatar: state.user.avatar } });
          break;

        case 'deny':
          closeWebSocket();
          state.screen = 'denied';
          startCountdown(5);
          break;

        case 'offer':
          createPeerConnection();
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          wsSend({ type: 'answer', sdp: pc.localDescription });
          state.remoteUser = msg.user || null;
          break;

        case 'answer':
          if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          break;

        case 'ice-candidate':
          if (pc && msg.candidate) await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          break;

        case 'mic-state':
          state.remoteMicOn = msg.on;
          break;

        case 'camera-state':
          state.remoteCameraOn = msg.on;
          break;

        case 'peer-left':
          closePeerConnection();
          const rv2 = document.getElementById('remoteVideo');
          if (rv2) rv2.srcObject = null;
          state.remoteConnected = false;
          state.remoteUser      = null;
          state.remoteMicOn     = true;
          state.remoteCameraOn  = true;
          state.knocker         = null;
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

    // ── Host enter meeting ──
    function enterMeetingAsHost() {
      state.screen = 'meeting';
      nextTick(async () => {
        await startCamera();
        connectWebSocket();
      });
    }

    // ── Guest knock ──
    function askToJoin() {
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
      wsSend({ type: 'mic-state', on: state.micOn });
    }

    function toggleCamera() {
      if (!localStream) return;
      state.localCameraOn = !state.localCameraOn;
      localStream.getVideoTracks().forEach(t => t.enabled = state.localCameraOn);
      wsSend({ type: 'camera-state', on: state.localCameraOn });
    }

    function leaveMeeting() {
      closePeerConnection();
      stopCamera();
      closeWebSocket();
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
      const link = `${location.origin}/?meetID=${state.meetID}`;
      navigator.clipboard.writeText(link).then(() => {
        state.linkCopied = true;
        setTimeout(() => state.linkCopied = false, 2000);
      });
    }

    // ── Redirect countdown ──
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

    return {
      ...state,
      // expose state properties reactively
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
      get inviteCardDismissed() { return state.inviteCardDismissed; },
      set inviteCardDismissed(v){ state.inviteCardDismissed = v; },
      get linkCopied()          { return state.linkCopied; },
      get countdownText()       { return state.countdownText; },

      avatarURL,
      toggleDark,
      login,
      register,
      forgotPassword,
      resetPassword,
      logout,
      newMeeting,
      joinMeet,
      goHome,
      askToJoin,
      cancelWaiting,
      toggleMic,
      toggleCamera,
      leaveMeeting,
      admitKnocker,
      denyKnocker,
      copyMeetLink,
    };
  },
}).mount('#app');
