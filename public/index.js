// Zoom App UI + OS protocol wiring (Login / Signup split screens)
let isConfigured = false;
let socket = null;
let serverStatus = 'Disconnected'; // "Connected" | "Disconnected"
let currentMeetingId = null;
let currentUserName = null;
let originStoryUserId = null;
let isConnectedToRoom = false;

// Packet log helpers
const CMD = {
  0x00: 'TEST_CONNECTION',
  0x01: 'CONNECTION_ESTABLISHED',
  0x02: 'VALIDATE_USER',
  0x03: 'USER_VALID',
  0x04: 'USER_INVALID',
  0x08: 'DATA_TRANSMISSION',
  0x09: 'END_DATA',
  0x0D: 'MEETING_INFO',
  0x0E: 'REGISTER_LOCAL',
  0x10: 'CREATE_USER'
};

function logRecv(cmd, data) {
  console.log(`⬇️  os_packet RECV [${CMD[cmd] || cmd}]`, data ? JSON.stringify(data) : '');
}
function logSend(dest, cmd, data) {
  console.log(`⬆️  os_packet SEND → ${dest} [${CMD[cmd] || cmd}]`, data ? JSON.stringify(data) : '');
}

// Simple toast/dropdown notifications (no external CSS)
function showToast(type, message) {
  // type: 'success' | 'error' | 'info'
  const existing = document.getElementById('toast-container');
  const container = existing || (() => {
    const c = document.createElement('div');
    c.id = 'toast-container';
    c.style.position = 'fixed';
    c.style.top = '56px';
    c.style.right = '16px';
    c.style.zIndex = '9999';
    c.style.display = 'flex';
    c.style.flexDirection = 'column';
    c.style.gap = '8px';
    document.body.appendChild(c);
    return c;
  })();

  const bg = type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : '#334155';
  const el = document.createElement('div');
  el.textContent = message;
  el.style.padding = '10px 12px';
  el.style.borderRadius = '10px';
  el.style.color = '#fff';
  el.style.background = bg;
  el.style.boxShadow = '0 6px 24px rgba(0,0,0,.25)';
  el.style.fontWeight = '600';
  el.style.maxWidth = '320px';
  el.style.transition = 'transform .25s ease, opacity .25s ease';
  el.style.transform = 'translateY(-8px)';
  el.style.opacity = '0';

  container.appendChild(el);
  requestAnimationFrame(() => {
    el.style.transform = 'translateY(0)';
    el.style.opacity = '1';
  });

  setTimeout(() => {
    el.style.transform = 'translateY(-8px)';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }, 2800);
}


// Simple app state for participants & probabilities
let participantList = [];
let participantScores = new Map();

// ---------- DOM helpers ----------
function setHeaderConnection(status) {
  serverStatus = status;
  const el = document.getElementById('connection-status');
  if (!el) return;
  el.className = `status ${status === 'Connected' ? 'status--connected' : 'status--disconnected'}`;
  el.textContent = status === 'Connected' ? 'connected to server' : 'disconnected';
}

function mountRoot(html) {
  const root = document.getElementById('participant-list');
  if (root) root.innerHTML = html;
}

// ---------- Screens ----------
function renderLogin(disabled = false, msg = '') {
  // Update header badge
  setHeaderConnection(serverStatus);

  mountRoot(`
    <div class="glass login">
      <h2>Welcome back</h2>
      <p>Sign in with your OriginStory username.</p>

      <div class="field">
        <label class="label" for="os-username">Username</label>
        <input class="input" id="os-username" type="text" placeholder="yourusername" ${disabled ? 'disabled' : ''} />
      </div>
      <div class="field">
        <label class="label" for="os-password">Password</label>
        <input class="input" id="os-password" type="password" placeholder="••••••••" ${disabled ? 'disabled' : ''} />
      </div>

      <div class="row" style="margin-top:10px; gap:8px;">
        <button id="os-login-btn" class="btn" ${disabled ? 'disabled' : ''}>Sign In</button>
        <button id="os-go-signup" class="btn" style="background:#64748b;" ${disabled ? 'disabled' : ''}>Create account</button>
      </div>

      <div id="os-login-msg" style="min-height:20px;color:var(--muted);margin-top:8px;">${msg || ''}</div>
    </div>
  `);

  document.getElementById('os-login-btn')?.addEventListener('click', onLoginSubmit);
  document.getElementById('os-password')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') onLoginSubmit(); });
  document.getElementById('os-go-signup')?.addEventListener('click', () => renderSignup(false, ''));
}

function renderSignup(disabled = false) {
  setHeaderConnection(serverStatus);

  mountRoot(`
    <div class="glass login">
      <h2>Create account</h2>
      <p>Sign up to use OriginStory in your meetings.</p>

      <div class="field">
        <label class="label" for="os-su-username">Username</label>
        <input class="input" id="os-su-username" type="text" placeholder="newusername" ${disabled ? 'disabled' : ''} />
      </div>

      <div class="field">
        <label class="label" for="os-su-email">Email</label>
        <input class="input" id="os-su-email" type="email" placeholder="you@example.com" ${disabled ? 'disabled' : ''} />
      </div>

      <div class="field">
        <label class="label" for="os-su-email2">Confirm email</label>
        <input class="input" id="os-su-email2" type="email" placeholder="you@example.com" ${disabled ? 'disabled' : ''} />
        <div id="email-match-hint" style="font-size:12px;margin-top:6px;height:16px;"></div>
      </div>

      <div class="field">
        <label class="label" for="os-su-password">Password (min 8 chars)</label>
        <input class="input" id="os-su-password" type="password" placeholder="••••••••" ${disabled ? 'disabled' : ''} />
      </div>

      <div class="row" style="margin-top:10px; gap:8px;">
        <button id="os-create-btn" class="btn" ${disabled ? 'disabled' : ''}>Create</button>
        <button id="os-cancel" class="btn" style="background:#6b7280;" ${disabled ? 'disabled' : ''}>Back to sign in</button>
      </div>
    </div>
  `);

  const email1 = document.getElementById('os-su-email');
  const email2 = document.getElementById('os-su-email2');
  const hint = document.getElementById('email-match-hint');

  function updateEmailMatchHint() {
    const e1 = (email1?.value || '').trim().toLowerCase();
    const e2 = (email2?.value || '').trim().toLowerCase();
    if (!e1 && !e2) { if (hint) hint.textContent = ''; return; }
    if (e1 && e2 && e1 === e2) {
      if (hint) { hint.textContent = 'Emails match'; hint.style.color = '#16a34a'; }
      email2?.style && (email2.style.borderColor = '#16a34a');
    } else {
      if (hint) { hint.textContent = 'Emails do not match'; hint.style.color = '#dc2626'; }
      email2?.style && (email2.style.borderColor = '#dc2626');
    }
  }
  email1?.addEventListener('input', updateEmailMatchHint);
  email2?.addEventListener('input', updateEmailMatchHint);

  document.getElementById('os-create-btn')?.addEventListener('click', onCreateAccountSubmit);
  document.getElementById('os-su-password')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') onCreateAccountSubmit(); });
  document.getElementById('os-cancel')?.addEventListener('click', () => renderLogin(false, ''));
}


function renderParticipants() {
  setHeaderConnection(serverStatus);

  const items = participantList.map((p) => {
    const latest = participantScores.get(p.userId);
    let tier = 'low', val = '—';
    if (latest && typeof latest.authentication === 'number') {
      const a = latest.authentication;
      tier = a >= 0.67 ? 'high' : a >= 0.34 ? 'med' : 'low';
      val = `${Math.round(a * 100)}%`;
    }
    const you = (p.userId === originStoryUserId) ? `<span class="chip-you">You</span>` : '';
    return `
      <div class="participant-item" data-user-id="${p.userId}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
          <div><strong>${p.userName || p.userId}</strong> ${you}</div>
          <div class="participant-score"><span class="prob" data-v="${tier}"><span>${val}</span></span></div>
        </div>
      </div>`;
  }).join('');

  mountRoot(`
    <div class="glass panel" style="padding:18px 16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;">
        <h2 style="margin:0;">Meeting Participants (${participantList.length})</h2>
      </div>
      <div id="participants-container">
        ${items || '<div class="empty-state">Waiting for participants…</div>'}
      </div>
    </div>
  `);
}


// ---------- Auth actions ----------
function onLoginSubmit() {
  const u = (document.getElementById('os-username')?.value || '').trim();
  const p = (document.getElementById('os-password')?.value || '').trim();
  if (!u || !p) {
    showToast('error', 'Enter username and password.');
    return;
  }
  const pkt = { cmd: 0x02, data: { username: u, password: p } };
  logSend('server', pkt.cmd, { ...pkt.data, password: '***redacted***' });
  socket.emit('os_packet', pkt);
  window.__authFlow = 'login';
}


function onCreateAccountSubmit() {
  const u = (document.getElementById('os-su-username')?.value || '').trim();
  const e1 = (document.getElementById('os-su-email')?.value || '').trim();
  const e2 = (document.getElementById('os-su-email2')?.value || '').trim();
  const p = (document.getElementById('os-su-password')?.value || '').trim();

  if (!u || !e1 || !e2 || !p) {
    showToast('error', 'Please fill out all fields.');
    return;
  }
  if (e1.toLowerCase() !== e2.toLowerCase()) {
    showToast('error', 'Emails do not match.');
    return;
  }
  if (p.length < 8) {
    showToast('error', 'Password must be at least 8 characters.');
    return;
  }

  const pkt = { cmd: 0x10, data: { username: u, email: e1, password: p } };
  logSend('server', pkt.cmd, { ...pkt.data, password: '***redacted***' });
  socket.emit('os_packet', pkt);
  window.__authFlow = 'signup';
}


// ---------- Socket / Protocol ----------
function initializeWebSocket() {
  if (typeof io === 'undefined') {
    console.error('socket.io not loaded');
    return;
  }
  socket = io();

  socket.on('connect', () => {
    setHeaderConnection('Disconnected'); // until server replies 0x01
    // TEST_CONNECTION (0x00)
    const pkt = { cmd: 0x00 };
    logSend('server', pkt.cmd, pkt.data);
    socket.emit('os_packet', pkt);
  });

  socket.on('disconnect', () => {
    setHeaderConnection('Disconnected');
  });

  socket.on('os_packet', (packet = {}) => {
    const { cmd, data } = packet;
    logRecv(cmd, data);

    switch (cmd) {
      case 0x01: { // CONNECTION_ESTABLISHED
        setHeaderConnection('Connected');
        break;
      }
      case 0x03: { // USER_VALID
        if (window.__authFlow === 'signup') {
          showToast('success', 'Account created. Please sign in.');
          renderLogin(false, '');
          window.__authFlow = null;
        } else {
          showToast('success', 'Signed in successfully.');
          originStoryUserId = data?.userId;
          proceedToMeetingJoin();
        }
        break;
      }
      case 0x04: { // USER_INVALID
        const msg = (data && data.error) ? data.error : (window.__authFlow === 'signup' ? 'Sign-up failed.' : 'Invalid credentials.');
        showToast('error', msg);
        // Stay on the current screen
        break;
      }

      case 0x08: { // DATA_TRANSMISSION → update UI
        const sid = data?.userId;
        if (sid) {
          participantScores.set(sid, {
            authentication: data.authentication,
            userId: sid,
            userName: data.userName,
            timestamp: data.timestamp
          });
          // update single chip if present
          const el = document.querySelector(`[data-user-id="${sid}"] .participant-score span`);
          if (el && typeof data.authentication === 'number') {
            const a = data.authentication;
            el.setAttribute('data-v', a >= 0.67 ? 'high' : a >= 0.34 ? 'med' : 'low');
            const inner = el.querySelector('span');
            if (inner) inner.textContent = `${Math.round(a * 100)}%`;
          }
        }
        break;
      }
      default:
        // ignore others here
        break;
    }
  });

  // Room/participants events (unchanged)
  socket.on('current_participants', (payload) => {
    participantList = payload?.participants || [];
    participantScores.clear();
    const scoresObj = payload?.scores || {};
    Object.values(scoresObj).forEach((s) => participantScores.set(s.userId, s));
    renderParticipants();
  });
  socket.on('participant_joined', (p) => {
    if (!participantList.find(x => x.userId === p.userId)) {
      participantList.push({ userId: p.userId, userName: p.userName, joinedAt: new Date() });
      renderParticipants();
    }
  });
  socket.on('participant_left', (p) => {
    participantList = participantList.filter(x => x.userId !== p.userId);
    participantScores.delete(p.userId);
    renderParticipants();
  });
}

// After login success → get Zoom info, join meeting, send MEETING_INFO (0x0D)
function proceedToMeetingJoin() {
  if (!window.zoomSdk) {
    renderLogin(false, 'Zoom SDK not found.');
    return;
  }
  window.zoomSdk.getRunningContext()
    .then((ctx) => {
      if (!ctx || ctx.context !== 'inMeeting') {
        renderLogin(false, 'Open this app inside a Zoom meeting.');
        throw new Error('Not in meeting');
      }
      return Promise.all([ window.zoomSdk.getMeetingUUID(), window.zoomSdk.getUserContext() ]);
    })
    .then(([meetingResponse, userResponse]) => {
      currentMeetingId = meetingResponse.meetingUUID;
      currentUserName = userResponse.screenName || originStoryUserId || 'Unknown User';

      // Send MEETING_INFO (0x0D)
      const pkt = { cmd: 0x0D, data: { meetingId: currentMeetingId, originStoryUserId, userName: currentUserName } };
      logSend('server', pkt.cmd, pkt.data);
      socket.emit('os_packet', pkt);

      // Show participants panel
      renderParticipants();
    })
    .catch((err) => {
      console.error('Meeting join failed:', err);
      renderLogin(false, 'Could not get meeting info.');
    });
}

// ─────────────────────────────────────────────────────────────
// Emoji virtual foreground overlay (Zoom Apps SDK)
// ─────────────────────────────────────────────────────────────
let __emojiOverlayOn = false;
let __emojiApplying = false;

/**
 * Creates ImageData for a simple emoji drawn on a transparent canvas.
 * @param {string} emoji - e.g. '😀'
 * @param {number} size  - output canvas size (square), e.g. 256
 * @returns {ImageData}
 */
function makeEmojiImageData(emoji = '😀', size = 256) {
  const canvas = document.createElement('canvas');
  // Slightly larger backing store for sharper text
  const SCALE = 2;
  canvas.width = size * SCALE;
  canvas.height = size * SCALE;
  const ctx = canvas.getContext('2d');

  // transparent background
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // draw emoji centered
  const fontPx = Math.floor(size * 0.8) * SCALE; // big emoji
  ctx.font = `${fontPx}px system-ui, Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const margin = 15 * SCALE;
  ctx.fillText(emoji, canvas.width - 15, 60);


  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Applies the emoji overlay using Zoom SDK setVirtualForeground.
 */
async function applyEmojiOverlay() {
  if (!window.zoomSdk || __emojiApplying) return;
  __emojiApplying = true;
  try {
    const imageData = makeEmojiImageData('✅', 64);

    // persistence: 'meeting' means it remains for this meeting session
    await window.zoomSdk.setVirtualForeground({
      imageData,
      persistence: 'meeting'
    });
    __emojiOverlayOn = true;
    showToast && showToast('success', 'Emoji overlay enabled');
  } catch (e) {
    console.error('setVirtualForeground failed:', e);
    showToast && showToast('error', 'Could not enable overlay');
    __emojiOverlayOn = false;
  } finally {
    __emojiApplying = false;
  }
}

/**
 * Removes the emoji overlay.
 */
async function removeEmojiOverlay() {
  if (!window.zoomSdk || __emojiApplying) return;
  __emojiApplying = true;
  try {
    await window.zoomSdk.removeVirtualForeground();
    __emojiOverlayOn = false;
    showToast && showToast('success', 'Emoji overlay disabled');
  } catch (e) {
    console.error('removeVirtualForeground failed:', e);
    showToast && showToast('error', 'Could not disable overlay');
  } finally {
    __emojiApplying = false;
  }
}

/**
 * Creates a floating toggle button that works across screens.
 */
function setupEmojiOverlayToggle() {
  // Avoid duplicates
  if (document.getElementById('emoji-toggle-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'emoji-toggle-btn';
  btn.type = 'button';
  btn.textContent = '😀 Overlay: OFF';
  Object.assign(btn.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: 9998,
    padding: '10px 12px',
    borderRadius: '999px',
    border: 'none',
    fontWeight: '600',
    cursor: 'pointer',
    boxShadow: '0 8px 24px rgba(0,0,0,.2)',
    background: 'var(--brand, #6c5ce7)',
    color: '#fff'
  });

  btn.addEventListener('click', async () => {
    if (!window.zoomSdk) {
      showToast && showToast('error', 'Zoom SDK not available');
      return;
    }
    try {
      const ctx = await window.zoomSdk.getRunningContext();
      if (!ctx || ctx.context !== 'inMeeting') {
        showToast && showToast('error', 'Open inside a Zoom meeting to use overlay');
        return;
      }
    } catch {
      // best effort; continue
    }

    if (__emojiOverlayOn) {
      await removeEmojiOverlay();
      btn.textContent = '😀 Overlay: OFF';
    } else {
      await applyEmojiOverlay();
      btn.textContent = '😀 Overlay: ON';
    }
  });

  document.body.appendChild(btn);

  // Dark mode awareness (optional): invert the brand a bit for contrast
  const observer = new MutationObserver(() => {
    const isDark = document.documentElement.classList.contains('dark');
    btn.style.background = isDark ? '#7c3aed' : '#6c5ce7';
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}

// ---------- Init ----------
function initApp() {
  if (!window.zoomSdk) {
    mountRoot(`
      <div class="error">
        <h2>Zoom SDK Not Found</h2>
        <p>Make sure appssdk.zoom.us is in your allowed domains.</p>
      </div>
    `);
    return;
  }

  window.zoomSdk.config({
    version: "0.16",
    capabilities: [
      'getRunningContext',
      'getMeetingContext',
      'getUserContext',
      'getMeetingUUID',
      'showNotification',
      'setVirtualForeground',
      'removeVirtualForeground'
    ]
  })
  .then(() => {
    isConfigured = true;
    // Render login first (header badge will update as socket connects)
    renderLogin(false, '');
    initializeWebSocket();

    // Set up a global emoji overlay toggle
    setupEmojiOverlayToggle();
  })
  .catch((err) => {
    console.error('SDK config failed:', err);
    mountRoot(`<div class="error"><h2>Initialization Failed</h2><p>${err?.message || err}</p></div>`);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
