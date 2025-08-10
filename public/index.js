// public/index.js — Glass Panels UI + Dark toggle already in index.html
// Keeps your existing protocol + login flow + END_DATA on leave.

let socket = null;
let currentMeetingId = null;
let originStoryUserId = null;   // set after login
let currentUserName = null;
let isConnectedToRoom = false;

let participantList = [];
let participantScores = new Map();

const CMD = {
  0x00: 'TEST_CONNECTION',
  0x01: 'CONNECTION_ESTABLISHED',
  0x02: 'VALIDATE_USER',
  0x03: 'USER_VALID',
  0x04: 'USER_INVALID',
  0x05: 'UPDATE_USER',
  0x06: 'USER_UPDATED',
  0x07: 'BEGIN_DATA',
  0x08: 'DATA_TRANSMISSION',
  0x09: 'END_DATA',
  0x0A: 'END_CONNECTION',
  0x0B: 'BAD_COMMAND',
  0x0C: 'BAD_DATA',
  0x0D: 'MEETING_INFO',
  0x0E: 'REGISTER_LOCAL'
};
const logRecv = (cmd, data) =>
  console.log(`⬇️  os_packet RECV [${CMD[cmd] || cmd}]`, data ? JSON.stringify(data) : '');
const logSend = (dest, cmd, data) =>
  console.log(`⬆️  os_packet SEND → ${dest} [${CMD[cmd] || cmd}]`, data ? JSON.stringify(data) : '');

// ---------- UI (Glass) ----------

function renderLogin(disabled = true, serverStatus = 'Initializing…') {
  const root = document.getElementById('participant-list');
  root.innerHTML = `
    <div class="glass login">
      <h2>Welcome back</h2>
      <p>Sign in with your OriginStory account to join your meeting.</p>

      <div class="field">
        <label class="label" for="os-username">Email or Username</label>
        <input class="input" id="os-username" type="text" placeholder="you@example.com" ${disabled ? 'disabled' : ''} />
      </div>
      <div class="field">
        <label class="label" for="os-password">Password</label>
        <input class="input" id="os-password" type="password" placeholder="••••••••" ${disabled ? 'disabled' : ''} />
      </div>

      <div class="row" style="margin-top:10px;">
        <button id="os-login-btn" class="btn" ${disabled ? 'disabled' : ''}>Sign In</button>
        <div id="connection-status" class="status ${serverStatus === 'Connected' ? 'status--connected' : 'status--disconnected'}">
          ${serverStatus === 'Connected' ? 'Connected' : 'Disconnected'}
        </div>
      </div>

      <div id="os-login-msg" style="min-height:20px;color:var(--muted);margin-top:8px;"></div>
    </div>
  `;

  document.getElementById('os-login-btn')?.addEventListener('click', onLoginSubmit);
  document.getElementById('os-password')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onLoginSubmit();
  });
}

function renderParticipants() {
  const root = document.getElementById('participant-list');

  if (!participantList.length) {
    root.innerHTML = `
      <div class="glass panel">
        <div class="panel-header">
          <div class="panel-title">Participants (0)</div>
          <div class="meta">Waiting for participants…</div>
        </div>
        <div class="loading" style="padding:10px 0;">No participants connected yet.</div>
      </div>`;
    return;
  }

  root.innerHTML = `
    <div class="glass panel">
      <div class="panel-header">
        <div class="panel-title">Participants (${participantList.length})</div>
        <div class="meta">Connected • ${shortId(currentMeetingId)}</div>
      </div>
      <div id="participants-container" class="list"></div>
    </div>
  `;

  const container = document.getElementById('participants-container');
  participantList.forEach((p) => {
    const prob = participantScores.get(p.userId)?.authentication;
    const probText = (typeof prob === 'number') ? prob.toFixed(3) : '—';
    const tier = (typeof prob === 'number')
      ? (prob >= 0.7 ? 'high' : prob >= 0.3 ? 'med' : 'low')
      : 'med';

    const row = document.createElement('div');
    row.className = 'row-item';
    row.setAttribute('data-user-id', p.userId);
    row.innerHTML = `
      <div class="user">
        <div class="name">${escapeHtml(p.userName || 'Unknown')}</div>
        ${p.userId === originStoryUserId ? '<div class="you">You</div>' : ''}
        <div class="userid">${escapeHtml(p.userId)}</div>
      </div>
      <div class="prob" data-v="${tier}"><span>${probText}</span></div>
    `;
    container.appendChild(row);
  });
}

function updateParticipantProbability(userId, pd) {
  const el = document.querySelector(`[data-user-id="${CSS.escape(userId)}"] .prob span`);
  if (el) {
    const probText = (typeof pd.authentication === 'number') ? pd.authentication.toFixed(3) : '—';
    el.textContent = probText;
    const pill = el.closest('.prob');
    if (pill) {
      const v = pd.authentication;
      pill.setAttribute('data-v', (typeof v === 'number') ? (v >= 0.85 ? 'high' : v >= 0.5 ? 'med' : 'low') : 'med');
      // subtle pulse
      pill.classList.remove('prob--updated');
      // force reflow to restart animation if you later add it
      void pill.offsetWidth;
      pill.classList.add('prob--updated');
    }
  }
}

function displayError(message) {
  const root = document.getElementById('participant-list');
  root.innerHTML = `
    <div class="glass panel">
      <div class="panel-header"><div class="panel-title">Error</div></div>
      <div class="error">${message}</div>
    </div>`;
}

function shortId(id) {
  if (!id || typeof id !== 'string') return '';
  return id.length > 14 ? `${id.slice(0, 8)}…` : id;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Login submit ----------

function onLoginSubmit() {
  const username = (document.getElementById('os-username')?.value || '').trim();
  const password = (document.getElementById('os-password')?.value || '').trim();

  const msg = document.getElementById('os-login-msg');
  if (!username || !password) {
    msg.textContent = 'Please enter a username/email and password.';
    return;
  }

  const pkt = { cmd: 0x02, data: { username, password } }; // VALIDATE_USER
  logSend('server', pkt.cmd, pkt.data);
  socket.emit('os_packet', pkt);
  msg.textContent = 'Validating…';
}

// ---------- Socket / protocol ----------

function initializeWebSocket() {
  if (typeof io === 'undefined') {
    console.error('socket.io not loaded');
    renderLogin(true, 'Socket.IO not available');
    return;
  }
  socket = io();

  socket.on('connect', () => {
    // Show login immediately (disabled until TEST_CONNECTION returns)
    renderLogin(true, 'Disconnected');
    // TEST_CONNECTION (0x00)
    const pkt = { cmd: 0x00 };
    logSend('server', pkt.cmd, pkt.data);
    socket.emit('os_packet', pkt);
  });

  socket.on('disconnect', () => {
    renderLogin(true, 'Disconnected');
    document.getElementById('connection-status').style.color = '#dc2626'; // red
  });

  socket.on('current_participants', (data) => {
    participantList = data.participants || [];
    participantScores.clear();
    Object.entries(data.scores || {}).forEach(([userId, probData]) => {
      participantScores.set(userId, probData);
    });
    renderParticipants();
  });

  socket.on('os_packet', (packet) => {
    if (!packet || typeof packet.cmd === 'undefined') return;
    const cmd = Number(packet.cmd);
    const d = packet.data || {};
    logRecv(cmd, d);

    if (cmd === 0x01) { // CONNECTION_ESTABLISHED
      renderLogin(false, 'Connected');
      document.getElementById('connection-status').style.color = '#16a34a'; // green
      return;
    }
    if (cmd === 0x03) { // USER_VALID
      const username = (document.getElementById('os-username')?.value || '').trim();
      originStoryUserId = username; // For now, OS user id = username/email
      const hint = document.getElementById('os-login-msg');
      if (hint) hint.textContent = 'Login successful! Joining meeting…';
      sendMeetingInfo();
      return;
    }
    if (cmd === 0x04) { // USER_INVALID
      const hint = document.getElementById('os-login-msg');
      if (hint) hint.textContent = d?.error || 'Invalid credentials.';
      return;
    }
    if (cmd === 0x08) { // DATA_TRANSMISSION
      const userId = d.userId;
      const pd = { authentication: d.authentication, timestamp: d.timestamp, userId, userName: d.userName };
      participantScores.set(userId, pd);
      updateParticipantProbability(userId, pd);
      return;
    }
  });

  socket.on('participant_joined', (data) => {
    if (!participantList.find(p => p.userId === data.userId)) {
      participantList.push({ userId: data.userId, userName: data.userName, joinedAt: new Date() });
      renderParticipants();
    }
  });

  socket.on('participant_left', (data) => {
    participantList = participantList.filter(p => p.userId !== data.userId);
    participantScores.delete(data.userId);
    renderParticipants();
  });

  socket.on('connect_error', (err) => {
    console.error('websocket connection error:', err);
    renderLogin(true, 'Connection error');
  });
}

function sendMeetingInfo() {
  if (!socket || !currentMeetingId || !originStoryUserId) return;

  const pkt = {
    cmd: 0x0D, // MEETING_INFO
    data: {
      meetingId: currentMeetingId,
      originStoryUserId,
      userName: currentUserName || 'Unknown User'
    }
  };
  logSend('server', pkt.cmd, pkt.data);
  socket.emit('os_packet', pkt);
  isConnectedToRoom = true;
}

function sendEndData() {
  if (!socket || !originStoryUserId) return;
  const pkt = { cmd: 0x09, data: { meetingId: currentMeetingId || null, originStoryUserId } };
  logSend('server', pkt.cmd, pkt.data);
  try { socket.emit('os_packet', pkt); } catch(e) { /* ignore */ }
}

// Fire END DATA when the app is going away or becoming hidden
window.addEventListener('beforeunload', () => { sendEndData(); });
window.addEventListener('pagehide', () => { sendEndData(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sendEndData(); });

// ---------- Zoom SDK init ----------

function initApp() {
  if (!window.zoomSdk) {
    displayError('Zoom SDK Not Found. Make sure appssdk.zoom.us is in your allowed domains.');
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
      'onMeeting'
    ]
  })
  .then(() => window.zoomSdk.getRunningContext())
  .then((ctx) => {
    if (!ctx || ctx.context !== 'inMeeting') {
      displayError(`<strong>📵 Not in Meeting</strong><br>Current context: ${ctx ? ctx.context : 'unknown'}`);
      throw new Error('Not in meeting');
    }
    return Promise.all([ window.zoomSdk.getMeetingUUID(), window.zoomSdk.getUserContext() ]);
  })
  .then(([meetingResponse, userResponse]) => {
    currentMeetingId = meetingResponse.meetingUUID;
    currentUserName = userResponse.screenName || 'Unknown User';

    // Render login shell; socket will enable it after TEST_CONNECTION
    renderLogin(true, 'Initializing…');

    initializeWebSocket();

    // Optional: watch meeting end/leave to send END_DATA
    if (window.zoomSdk?.onMeeting) {
      window.zoomSdk.onMeeting((evt) => {
        const payload = evt || {};
        const state = payload.meetingState || payload.state || payload.action || payload.status || '';
        if (String(state).toLowerCase().includes('end') || String(state).toLowerCase().includes('leave')) {
          sendEndData();
        }
      });
    }
  })
  .catch((err) => {
    if (err && err.message === 'Not in meeting') return;
    displayError(`<strong>Initialization Failed:</strong> ${err.message || err}`);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
