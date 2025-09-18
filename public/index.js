// Zoom App UI + OS protocol wiring (Login / Signup split screens)
let isConfigured = false;
let socket = null;
let serverStatus = 'Disconnected';
let currentMeetingId = null;
let currentUserName = null;
let originStoryUserId = null;

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

const logRecv = (cmd, data) => console.log(`⬇️  os_packet RECV [${CMD[cmd] || cmd}]`, data ? JSON.stringify(data) : '');
const logSend = (dest, cmd, data) => console.log(`⬆️  os_packet SEND → ${dest} [${CMD[cmd] || cmd}]`, data ? JSON.stringify(data) : '');

// Toast
function showToast(type, message) {
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
  el.style.borderRadius = '8px';
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

// App state
let participantList = [];
// Map<userId, { prob_1: number|null, prob_2: number|null, userId, userName, timestamp }>
let participantScores = new Map();

// Helpers
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
function formatPercentMaybe(x) {
  return (typeof x === 'number' && isFinite(x)) ? `${Math.round(x * 100)}%` : '—';
}

// ─── Icon classification (returns a key) ───────────────────────────────────────
const ICON_KEY = {
  HUMAN_SPEECH: 'HUMAN_SPEECH',
  HUMAN_DETECTED: 'HUMAN_DETECTED',
  NO_HUMAN: 'NO_HUMAN',
  NON_HUMAN: 'NON_HUMAN',
};

/**
 * Rules:
 * - HumanSpeech:    p1 > 0.5 and p2 > 0.5
 * - HumanDetected:  p1 == None and p2 > 0.5
 * - NoHumanDetected:p1 == None and p2 < 0.5
 * - NonHumanSpeech: (p1 > 0.5 && p2 < 0.5) || (p1 < 0.5 && p2 > 0.5) || (p1 < 0.5 && p2 < 0.5)
 * On boundary (== 0.5) or insufficient data → null.
 */
function classifyIconKey(p1, p2) {
  // normalize inputs: number in [0,1] or null
  const toNum = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === '' || s === 'none') return null;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
    }
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) return v;
    return null;
  };

  const n1 = toNum(p1);
  const n2 = toNum(p2);
  const hasP1 = n1 !== null;
  const hasP2 = n2 !== null;
  const HI = 0.5; // inclusive threshold

  if (hasP1 && hasP2) {
    if (n1 >= HI && n2 >= HI) return ICON_KEY.HUMAN_SPEECH;
    // all other combos with both present are NonHuman
    return ICON_KEY.NON_HUMAN;
  }

  if (!hasP1 && hasP2) {
    return n2 >= HI ? ICON_KEY.HUMAN_DETECTED : ICON_KEY.NO_HUMAN;
  }

  // no usable data
  return null;
}

// Separate images: overlay vs participant list
const ICONS_OVERLAY = {
  [ICON_KEY.HUMAN_SPEECH]: 'overlay/HumanSpeech.png',
  [ICON_KEY.HUMAN_DETECTED]: 'overlay/HumanDetected.png',
  [ICON_KEY.NO_HUMAN]: 'overlay/NoHumanDetected.png',
  [ICON_KEY.NON_HUMAN]: 'overlay/NonHumanSpeech.png',
};
const ICONS_LIST = {
  [ICON_KEY.HUMAN_SPEECH]: 'list_icons/HumanSpeech.png',
  [ICON_KEY.HUMAN_DETECTED]: 'list_icons/HumanDetected.png',
  [ICON_KEY.NO_HUMAN]: 'list_icons/NoHumanDetected.png',
  [ICON_KEY.NON_HUMAN]: 'list_icons/NonHumanSpeech.png',
};
function getIconSrc(map, key) { return key ? map[key] : null; }

// ─── Participants UI (old layout restored) ────────────────────────────────────
function renderParticipants() {
  setHeaderConnection(serverStatus);

  const items = participantList.map((p) => {
    const s = participantScores.get(p.userId) || {};
    const p1 = (typeof s.prob_1 === 'number' && isFinite(s.prob_1)) ? s.prob_1 : null;
    const p2 = (typeof s.prob_2 === 'number' && isFinite(s.prob_2)) ? s.prob_2 : null;
    const key = classifyIconKey(p1, p2);
    const icon = getIconSrc(ICONS_LIST, key);

    const you = (p.userId === originStoryUserId) ? `<span class="you">You</span>` : '';
    return `
      <div class="row-item" data-user-id="${p.userId}">
        <div class="row-main">
          <div class="user"><div class="name name--shadow">${p.userName || p.userId}</div> ${you}</div>
          <div class="participant-right">
            <img class="status-icon" alt="" src="${icon || ''}" style="${icon ? '' : 'display:none'}" />
            <button class="chev" aria-label="Toggle details" data-open="false">⌄</button>
          </div>
        </div>
        <div class="details" style="display:none;">
          <div class="details-sep"></div>
          <div class="detail-row">
            <div class="detail-label">Human Speaking</div>
            <div class="detail-value">${formatPercentMaybe(p1)}</div>
          </div>
          <div class="detail-row">
            <div class="detail-label">Human Detected</div>
            <div class="detail-value">${formatPercentMaybe(p2)}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  mountRoot(`
    <div class="glass panel">
      <div class="panel-header">
        <h2 class="panel-title">Meeting Participants (${participantList.length})</h2>
      </div>
      <div id="participants-container">${items || '<div class="empty-state">Waiting for participants…</div>'}</div>
    </div>
  `);

  // Chevrons
  document.querySelectorAll('.row-item .chev').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.row-item');
      const details = row.querySelector('.details');
      const isOpen = btn.getAttribute('data-open') === 'true';
      if (isOpen) {
        details.style.display = 'none';
        btn.setAttribute('data-open', 'false');
        btn.textContent = '⌄';
      } else {
        details.style.display = 'block';
        btn.setAttribute('data-open', 'true');
        btn.textContent = '˄';
      }
    });
  });
}

// Update one row in-place (no flashing)
function updateParticipantRow(userId) {
  const row = document.querySelector(`.row-item[data-user-id="${userId}"]`);
  if (!row) return;

  const s = participantScores.get(userId) || {};
  const p1 = (typeof s.prob_1 === 'number' && isFinite(s.prob_1)) ? s.prob_1 : null;
  const p2 = (typeof s.prob_2 === 'number' && isFinite(s.prob_2)) ? s.prob_2 : null;
  const key = classifyIconKey(p1, p2);
  const nextIcon = getIconSrc(ICONS_LIST, key);

  const iconEl = row.querySelector('.status-icon');
  const currentSrc = iconEl.getAttribute('src') || '';
  if (nextIcon) {
    if (currentSrc !== nextIcon) iconEl.setAttribute('src', nextIcon);
    iconEl.style.display = '';
  } else {
    iconEl.style.display = 'none';
    iconEl.removeAttribute('src');
  }

  const [v1, v2] = row.querySelectorAll('.details .detail-row .detail-value');
  if (v1) v1.textContent = formatPercentMaybe(p1);
  if (v2) v2.textContent = formatPercentMaybe(p2);
}

// ─── Auth actions ─────────────────────────────────────────────────────────────
function onLoginSubmit() {
  const u = (document.getElementById('os-username')?.value || '').trim();
  const p = (document.getElementById('os-password')?.value || '').trim();
  if (!u || !p) return showToast('error', 'Enter username and password.');
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

// ─── Socket / Protocol ───────────────────────────────────────────────────────
function initializeWebSocket() {
  if (typeof io === 'undefined') return console.error('socket.io not loaded');
  socket = io();

  socket.on('connect', () => {
    setHeaderConnection('Disconnected');
    const pkt = { cmd: 0x00 }; // TEST_CONNECTION
    logSend('server', pkt.cmd, pkt.data);
    socket.emit('os_packet', pkt);
  });

  socket.on('disconnect', () => setHeaderConnection('Disconnected'));

  socket.on('os_packet', (packet = {}) => {
    const { cmd, data } = packet;
    logRecv(cmd, data);

    switch (cmd) {
      case 0x01: setHeaderConnection('Connected'); break;

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

      case 0x08: { // DATA_TRANSMISSION
        const sid = data?.userId;
        if (sid) {
          const p1 = (typeof data.prob_1 === 'number' && isFinite(data.prob_1)) ? data.prob_1 : null;
          const p2 = (typeof data.prob_2 === 'number' && isFinite(data.prob_2)) ? data.prob_2 : null;
          participantScores.set(sid, {
            prob_1: p1, prob_2: p2, userId: sid, userName: data.userName, timestamp: data.timestamp
          });
          updateParticipantRow(sid);

          if (sid === originStoryUserId) updateOverlayByProbs(p1, p2);
        }
        break;
      }

      case 0x09: { // END_DATA
        // Clear icons for everyone and remove overlay
        document.querySelectorAll('.row-item .status-icon').forEach(img => {
          img.style.display = 'none';
          img.removeAttribute('src');
        });
        removeOverlay();
        break;
      }

      default: break;
    }
  });

  socket.on('current_participants', (payload) => {
    participantList = payload?.participants || [];
    participantScores.clear();
    const scoresObj = payload?.scores || {};
    Object.values(scoresObj).forEach(s => {
      participantScores.set(s.userId, {
        prob_1: (typeof s.prob_1 === 'number' && isFinite(s.prob_1)) ? s.prob_1 : null,
        prob_2: (typeof s.prob_2 === 'number' && isFinite(s.prob_2)) ? s.prob_2 : null,
        userId: s.userId, userName: s.userName, timestamp: s.timestamp
      });
    });
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

// After login → get Zoom info, send MEETING_INFO
function proceedToMeetingJoin() {
  if (!window.zoomSdk) { renderLogin(false, 'Zoom SDK not found.'); return; }
  window.zoomSdk.getRunningContext()
    .then((ctx) => {
      if (!ctx || ctx.context !== 'inMeeting') { renderLogin(false, 'Open this app inside a Zoom meeting.'); throw new Error('Not in meeting'); }
      return Promise.all([ window.zoomSdk.getMeetingUUID(), window.zoomSdk.getUserContext() ]);
    })
    .then(([meetingResponse, userResponse]) => {
      currentMeetingId = meetingResponse.meetingUUID;
      currentUserName = userResponse.screenName || originStoryUserId || 'Unknown User';

      const pkt = { cmd: 0x0D, data: { meetingId: currentMeetingId, originStoryUserId, userName: currentUserName } };
      logSend('server', pkt.cmd, pkt.data);
      socket.emit('os_packet', pkt);

      renderParticipants();
    })
    .catch((err) => {
      console.error('Meeting join failed:', err);
      renderLogin(false, 'Could not get meeting info.');
    });
}

// ─── Overlay (images) ─────────────────────────────────────────────────────────
let __overlayOn = false;
let __overlayApplying = false;
let __overlayLastSrc = null;
let __overlayLastAt = 0;
const OVERLAY_MIN_INTERVAL_MS = 700;

function makeImageDataFromUrl(url, size = 64) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const SCALE = 2;
      const canvas = document.createElement('canvas');
      canvas.width = size * SCALE;
      canvas.height = size * SCALE;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const icon = Math.floor(size * 0.9) * SCALE;
      const margin = 8 * SCALE;
      const x = canvas.width - icon - margin;
      const y = margin;
      ctx.drawImage(img, x, y, icon, icon);

      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = reject;
    img.src = url;
  });
}

async function setOverlayIcon(url) {
  if (!window.zoomSdk || __overlayApplying) return;
  __overlayApplying = true;
  try {
    const imageData = await makeImageDataFromUrl(url, 64);
    await window.zoomSdk.setVirtualForeground({ imageData, persistence: 'meeting' });
    __overlayOn = true;
    __overlayLastSrc = url;
    __overlayLastAt = Date.now();
  } catch (e) {
    console.error('setVirtualForeground failed:', e);
  } finally {
    __overlayApplying = false;
  }
}

async function removeOverlay() {
  if (!window.zoomSdk || __overlayApplying) return;
  __overlayApplying = true;
  try {
    await window.zoomSdk.removeVirtualForeground();
    __overlayOn = false;
    __overlayLastSrc = null;
  } catch (e) {
    console.error('removeVirtualForeground failed:', e);
  } finally {
    __overlayApplying = false;
  }
}

async function updateOverlayByProbs(p1, p2) {
  const key = classifyIconKey(p1, p2);
  const src = getIconSrc(ICONS_OVERLAY, key);
  const now = Date.now();

  if (!src) {
    if (__overlayOn) await removeOverlay();
    return;
  }
  if (__overlayLastSrc === src && (now - __overlayLastAt) < OVERLAY_MIN_INTERVAL_MS) return;
  await setOverlayIcon(src);
}

// ─── Screens (Login/Signup minimal) ───────────────────────────────────────────
function renderLogin(disabled = false, msg = '') {
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

      <div class="row" style="margin-top:8px; gap:8px;">
        <button id="os-login-btn" class="btn" ${disabled ? 'disabled' : ''}>Sign In</button>
        <button id="os-go-signup" class="btn" style="background:#64748b;" ${disabled ? 'disabled' : ''}>Create account</button>
      </div>

      <div id="os-login-msg" style="min-height:18px;color:#475569;margin-top:8px;">${msg || ''}</div>
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
      </div>
      <div class="field">
        <label class="label" for="os-su-password">Password (min 8 chars)</label>
        <input class="input" id="os-su-password" type="password" placeholder="••••••••" ${disabled ? 'disabled' : ''} />
      </div>

      <div class="row" style="margin-top:8px; gap:8px;">
        <button id="os-create-btn" class="btn" ${disabled ? 'disabled' : ''}>Create</button>
        <button id="os-cancel" class="btn" style="background:#6b7280;" ${disabled ? 'disabled' : ''}>Back to sign in</button>
      </div>
    </div>
  `);

  document.getElementById('os-create-btn')?.addEventListener('click', onCreateAccountSubmit);
  document.getElementById('os-su-password')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') onCreateAccountSubmit(); });
  document.getElementById('os-cancel')?.addEventListener('click', () => renderLogin(false, ''));
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function initApp() {
  if (!window.zoomSdk) {
    mountRoot(`<div class="error"><h2 style="font-size:16px;">Zoom SDK Not Found</h2><p>Make sure appssdk.zoom.us is in your allowed domains.</p></div>`);
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
    renderLogin(false, '');
    initializeWebSocket();
  })
  .catch((err) => {
    console.error('SDK config failed:', err);
    mountRoot(`<div class="error"><h2 style="font-size:16px;">Initialization Failed</h2><p>${err?.message || err}</p></div>`);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
else initApp();
