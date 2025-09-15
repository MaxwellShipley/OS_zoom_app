// Zoom App UI + OS protocol wiring (compact light theme)
// - Auto overlay with 4 icons based on p1/p2
// - Chat message on login
// - No dark mode; no overlay toggle
// - Participant rows: icon + expandable left-justified probabilities
// - No flashing: we update <img src> only when needed

let isConfigured = false;
let socket = null;
let serverStatus = 'Disconnected';
let currentMeetingId = null;
let currentUserName = null;
let originStoryUserId = null;

// Packet names
const CMD = {
  0x00: 'TEST_CONNECTION',
  0x01: 'CONNECTION_ESTABLISHED',
  0x02: 'VALIDATE_USER',
  0x03: 'USER_VALID',
  0x04: 'USER_INVALID',
  0x07: 'BEGIN_DATA',
  0x08: 'DATA_TRANSMISSION',
  0x09: 'END_DATA',
  0x0D: 'MEETING_INFO',
  0x0E: 'REGISTER_LOCAL',
  0x10: 'CREATE_USER'
};

function logRecv(cmd, data) { console.log(`⬇️  os_packet RECV [${CMD[cmd] || cmd}]`, data ? JSON.stringify(data) : ''); }
function logSend(dest, cmd, data) { console.log(`⬆️  os_packet SEND → ${dest} [${CMD[cmd] || cmd}]`, data ? JSON.stringify(data) : ''); }

// Toasts
function showToast(type, message) {
  const existing = document.getElementById('toast-container');
  const container = existing || (() => {
    const c = document.createElement('div');
    c.id = 'toast-container';
    c.style.position = 'fixed'; c.style.top = '56px'; c.style.right = '16px';
    c.style.zIndex = '9999'; c.style.display = 'flex'; c.style.flexDirection = 'column'; c.style.gap = '8px';
    document.body.appendChild(c); return c;
  })();
  const bg = type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : '#334155';
  const el = document.createElement('div');
  el.textContent = message;
  Object.assign(el.style, {
    padding: '8px 10px', borderRadius: '8px', color:'#fff', background:bg, boxShadow:'0 6px 24px rgba(0,0,0,.18)',
    fontWeight:'600', maxWidth:'320px', transition:'transform .25s ease, opacity .25s ease', transform:'translateY(-8px)', opacity:'0',
    fontSize: '12px'
  });
  container.appendChild(el);
  requestAnimationFrame(() => { el.style.transform = 'translateY(0)'; el.style.opacity = '1'; });
  setTimeout(() => { el.style.transform = 'translateY(-8px)'; el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, 2400);
}

// App state
let participantList = [];                 // [{userId,userName}]
const participantScores = new Map();      // userId -> { prob_1, prob_2, timestamp }
const lastSeen = new Map();               // userId -> ms
const expanded = new Set();               // userIds expanded

// Overlay assets & logic
const ICONS = {
  humanSpeech:      'overlay/HumanSpeech.png',
  nonHumanSpeech:   'overlay/NonHumanSpeech.png',
  humanDetected:    'overlay/HumanDetected.png',
  noHumanDetected:  'overlay/NoHumanDetected.png',
};
const _preloaded = {};
function preloadIcons() {
  Object.entries(ICONS).forEach(([k, src]) => {
    const img = new Image(); img.src = src; _preloaded[k] = img;
  });
}
preloadIcons();

const OVERLAY_MIN_INTERVAL_MS = 700;
let __overlayOn = false;
let __overlayLastKind = null;
let __overlayLastAt = 0;

function pickKind(p1, p2) {
  const hasP1 = typeof p1 === 'number';
  const hasP2 = typeof p2 === 'number';
  const gt = (x) => (typeof x === 'number' && x > 0.5);

  if (!hasP1 && hasP2) return gt(p2) ? 'humanDetected' : 'noHumanDetected';
  if (hasP1 && hasP2)  return (gt(p1) && gt(p2)) ? 'humanSpeech' : 'nonHumanSpeech';
  // default when insufficient data
  return 'nonHumanSpeech';
}

function makeImageDataFromImg(img, size = 64) {
  const SCALE = 2;
  const canvas = document.createElement('canvas');
  canvas.width = size * SCALE; canvas.height = size * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const icon = Math.floor(size * 0.9) * SCALE;
  const margin = 8 * SCALE;
  const x = canvas.width - icon - margin; const y = margin;
  ctx.drawImage(img, x, y, icon, icon);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

async function setOverlayKind(kind) {
  if (!window.zoomSdk) return;
  try {
    const img = _preloaded[kind];
    if (!img) return;
    const imageData = makeImageDataFromImg(img, 64);
    await window.zoomSdk.setVirtualForeground({ imageData, persistence: 'meeting' });
    __overlayOn = true;
  } catch (e) {
    console.error('setVirtualForeground failed:', e);
  }
}
async function removeOverlay() {
  if (!window.zoomSdk) return;
  try {
    await window.zoomSdk.removeVirtualForeground();
  } catch (e) {
    console.error('removeVirtualForeground failed:', e);
  } finally {
    __overlayOn = false; __overlayLastKind = null; __overlayLastAt = 0;
  }
}
async function updateOverlayByProbs(p1, p2) {
  if (!__overlayOn) return;
  const kind = pickKind(p1, p2);
  const now = Date.now();
  if (kind === __overlayLastKind && (now - __overlayLastAt) < OVERLAY_MIN_INTERVAL_MS) return;
  await setOverlayKind(kind);
  __overlayLastKind = kind; __overlayLastAt = now;
}

// DOM helpers
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

// Screens
function renderLogin(disabled = false, msg = '') {
  setHeaderConnection(serverStatus);
  mountRoot(`
    <div class="glass login">
      <h2>Sign in</h2>
      <p>Use your OriginStory username.</p>

      <div class="field">
        <label class="label" for="os-username">Username</label>
        <input class="input" id="os-username" type="text" placeholder="yourusername" ${disabled ? 'disabled' : ''} />
      </div>
      <div class="field">
        <label class="label" for="os-password">Password</label>
        <input class="input" id="os-password" type="password" placeholder="••••••••" ${disabled ? 'disabled' : ''} />
      </div>

      <div class="row" style="margin-top:8px;">
        <button id="os-login-btn" class="btn" ${disabled ? 'disabled' : ''}>Sign In</button>
        <button id="os-go-signup" class="btn secondary" ${disabled ? 'disabled' : ''}>Create account</button>
      </div>

      <div id="os-login-msg" style="min-height:18px;color:var(--muted);margin-top:8px;">${msg || ''}</div>
    </div>
  `);
  document.getElementById('os-login-btn')?.addEventListener('click', onLoginSubmit);
  document.getElementById('os-password')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') onLoginSubmit(); });
  document.getElementById('os-go-signup')?.addEventListener('click', () => renderSignup(false));
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

      <div class="row" style="margin-top:8px;">
        <button id="os-create-btn" class="btn" ${disabled ? 'disabled' : ''}>Create</button>
        <button id="os-cancel" class="btn secondary" ${disabled ? 'disabled' : ''}>Back to sign in</button>
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
    if (e1 && e2 && e1 === e2) { if (hint) { hint.textContent = 'Emails match'; hint.style.color = '#16a34a'; } email2.style.borderColor = '#16a34a'; }
    else { if (hint) { hint.textContent = 'Emails do not match'; hint.style.color = '#dc2626'; } email2.style.borderColor = '#dc2626'; }
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
    const you = (p.userId === originStoryUserId) ? `<span class="you">You</span>` : '';
    const iconKind = pickKind(
      participantScores.get(p.userId)?.prob_1 ?? null,
      participantScores.get(p.userId)?.prob_2 ?? null
    );
    const iconSrc = ICONS[iconKind];

    const expandedCls = expanded.has(p.userId) ? 'open' : '';
    const chev = expandedCls ? '▾' : '▸';

    const s = participantScores.get(p.userId);
    const v1 = (s && typeof s.prob_1 === 'number') ? Math.round(s.prob_1 * 100) + '%' : '—';
    const v2 = (s && typeof s.prob_2 === 'number') ? Math.round(s.prob_2 * 100) + '%' : '—';

    return `
      <div class="row-item" data-user-id="${p.userId}">
        <div class="row-top">
          <div class="user">
            <div class="name">${p.userName || p.userId}</div> ${you}
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <img class="status-icon" data-icon-for="${p.userId}" src="${iconSrc}" alt="" />
            <button class="toggle" data-toggle="${p.userId}" aria-label="Toggle details"><span class="chev">${chev}</span></button>
          </div>
        </div>
        <div class="expand ${expandedCls}" data-expand="${p.userId}">
          <div class="prob-line"><span class="prob-label">p1</span><span class="prob-val" data-p1="${p.userId}">${v1}</span></div>
          <div class="prob-line"><span class="prob-label">p2</span><span class="prob-val" data-p2="${p.userId}">${v2}</span></div>
        </div>
      </div>
    `;
  }).join('');

  mountRoot(`
    <div class="glass panel">
      <div class="panel-header">
        <h2 class="panel-title" style="margin:0;">Meeting Participants (${participantList.length})</h2>
      </div>
      <div id="participants-container" class="list">
        ${items || '<div class="loading">Waiting for participants…</div>'}
      </div>
    </div>
  `);

  // Event delegation for expand/collapse (no rebuild flicker)
  const container = document.getElementById('participants-container');
  container?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-toggle]');
    if (!btn) return;
    const uid = btn.getAttribute('data-toggle');
    if (!uid) return;
    if (expanded.has(uid)) expanded.delete(uid); else expanded.add(uid);
    // just flip classes and chevron without re-rendering all
    const exp = container.querySelector(`[data-expand="${uid}"]`);
    const chev = btn.querySelector('.chev');
    if (exp) exp.classList.toggle('open');
    if (chev) chev.textContent = exp?.classList.contains('open') ? '▾' : '▸';
  });
}

// Inline updates (no flashing)
function updateParticipantRow(userId) {
  const s = participantScores.get(userId);
  // icon (only if changed)
  const iconEl = document.querySelector(`img[data-icon-for="${userId}"]`);
  if (iconEl) {
    const kind = pickKind(s?.prob_1 ?? null, s?.prob_2 ?? null);
    const newSrc = ICONS[kind];
    if (newSrc && iconEl.getAttribute('src') !== newSrc) {
      iconEl.setAttribute('src', newSrc);
    }
  }
  // percentages in dropdown (left-justified)
  const p1 = document.querySelector(`.prob-val[data-p1="${userId}"]`);
  const p2 = document.querySelector(`.prob-val[data-p2="${userId}"]`);
  if (p1) p1.textContent = (s && typeof s.prob_1 === 'number') ? `${Math.round(s.prob_1 * 100)}%` : '—';
  if (p2) p2.textContent = (s && typeof s.prob_2 === 'number') ? `${Math.round(s.prob_2 * 100)}%` : '—';
}

// Auth actions
function onLoginSubmit() {
  const u = (document.getElementById('os-username')?.value || '').trim();
  const p = (document.getElementById('os-password')?.value || '').trim();
  if (!u || !p) { showToast('error', 'Enter username and password.'); return; }
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
  if (!u || !e1 || !e2 || !p) return showToast('error', 'Please fill out all fields.');
  if (e1.toLowerCase() !== e2.toLowerCase()) return showToast('error', 'Emails do not match.');
  if (p.length < 8) return showToast('error', 'Password must be at least 8 characters.');
  const pkt = { cmd: 0x10, data: { username: u, email: e1, password: p } };
  logSend('server', pkt.cmd, { ...pkt.data, password: '***redacted***' });
  socket.emit('os_packet', pkt);
  window.__authFlow = 'signup';
}

// Socket / Protocol
function initializeWebSocket() {
  if (typeof io === 'undefined') { console.error('socket.io not loaded'); return; }
  socket = io();

  socket.on('connect', () => {
    setHeaderConnection('Disconnected');  // until 0x01
    const pkt = { cmd: 0x00 };
    logSend('server', pkt.cmd, pkt.data);
    socket.emit('os_packet', pkt);
  });

  socket.on('disconnect', () => { setHeaderConnection('Disconnected'); });

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
          renderLogin(false, ''); window.__authFlow = null;
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
        break;
      }

      case 0x08: { // DATA_TRANSMISSION (probability update)
        const uid = data?.userId || data?.originStoryUserId;
        if (!uid) break;

        // normalize, store + mark last seen
        const p1 = (typeof data.prob_1 === 'number') ? data.prob_1 : (typeof data.authentication === 'number' ? data.authentication : null);
        const p2 = (typeof data.prob_2 === 'number') ? data.prob_2 : null;

        const prev = participantScores.get(uid) || {};
        participantScores.set(uid, {
          prob_1: p1, prob_2: p2,
          userId: uid, userName: data.userName || prev.userName || uid,
          timestamp: data.timestamp || new Date().toISOString()
        });
        lastSeen.set(uid, Date.now());

        // Ensure the row exists
        if (!participantList.find(x => x.userId === uid)) {
          participantList.push({ userId: uid, userName: data.userName || uid });
          renderParticipants();
        }
        // Update row without flashing
        updateParticipantRow(uid);

        // Auto-overlay for me when data starts
        if (uid === originStoryUserId) {
          if (!__overlayOn) {
            setOverlayKind(pickKind(p1, p2)).then(() => { __overlayOn = true; __overlayLastKind = null; __overlayLastAt = 0; });
          } else {
            updateOverlayByProbs(p1, p2);
          }
        }
        break;
      }

      default:
        break;
    }
  });

  // Room events
  socket.on('current_participants', (payload) => {
    participantList = payload?.participants || [];
    participantScores.clear();
    const scoresObj = payload?.scores || {};
    Object.values(scoresObj).forEach((s) => {
      participantScores.set(s.userId, s);
      lastSeen.set(s.userId, Date.now());
    });
    renderParticipants();
  });
  socket.on('participant_joined', (p) => {
    if (!participantList.find(x => x.userId === p.userId)) {
      participantList.push({ userId: p.userId, userName: p.userName });
      renderParticipants();
    }
  });
  socket.on('participant_left', (p) => {
    // If they leave, wipe their latest numbers (UI shows —)
    participantScores.delete(p.userId);
    lastSeen.delete(p.userId);
    // Keep the person in the list only if still present from server state; otherwise remove row entirely
    participantList = participantList.filter(x => x.userId !== p.userId);
    renderParticipants();
  });

  // Staleness sweeper: if no update in 3s, show dashes (don’t change icon)
  setInterval(() => {
    const now = Date.now();
    for (const uid of Array.from(lastSeen.keys())) {
      const t = lastSeen.get(uid);
      if (t && now - t > 3000) {
        // mark stale
        const prev = participantScores.get(uid) || {};
        participantScores.set(uid, { ...prev, prob_1: null, prob_2: null });
        updateParticipantRow(uid);
      }
    }
  }, 1000);
}

// After login success → get Zoom info, join meeting, send MEETING_INFO (0x0D), send chat
function proceedToMeetingJoin() {
  if (!window.zoomSdk) { renderLogin(false, 'Zoom SDK not found.'); return; }
  window.zoomSdk.getRunningContext()
    .then((ctx) => {
      if (!ctx || ctx.context !== 'inMeeting') {
        renderLogin(false, 'Open this app inside a Zoom meeting.');
        throw new Error('Not in meeting');
      }
      return Promise.all([ window.zoomSdk.getMeetingUUID(), window.zoomSdk.getUserContext() ]);
    })
    .then(async ([meetingResponse, userResponse]) => {
      currentMeetingId = meetingResponse.meetingUUID;
      currentUserName = userResponse.screenName || originStoryUserId || 'Unknown User';

      // Send MEETING_INFO (0x0D)
      const pkt = { cmd: 0x0D, data: { meetingId: currentMeetingId, originStoryUserId, userName: currentUserName } };
      logSend('server', pkt.cmd, pkt.data);
      socket.emit('os_packet', pkt);

      // Announce in chat
      try {
        await window.zoomSdk.sendMessageToChat({
          message: `${currentUserName} is using OriginStory to verify their identity. Download: https://example.com/download`
        });
      } catch (e) {
        console.warn('sendMessageToChat failed (non-fatal):', e?.message || e);
      }

      renderParticipants();
    })
    .catch((err) => {
      console.error('Meeting join failed:', err);
      renderLogin(false, 'Could not get meeting info.');
    });
}

// Init
function initApp() {
  if (!window.zoomSdk) {
    mountRoot(`
      <div class="error">
        <h2 style="font-size:16px;margin:0 0 6px 0;">Zoom SDK Not Found</h2>
        <p style="margin:0;">Make sure appssdk.zoom.us is in your allowed domains.</p>
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
      'removeVirtualForeground',
      'sendMessageToChat'
    ]
  })
  .then(() => {
    isConfigured = true;
    renderLogin(false, '');
    initializeWebSocket();
  })
  .catch((err) => {
    console.error('SDK config failed:', err);
    mountRoot(`<div class="error"><h2 style="font-size:16px;margin:0 0 6px 0;">Initialization Failed</h2><p style="margin:0;">${err?.message || err}</p></div>`);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
else initApp();
