import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const port = process.env.PORT || 3000;
const __dirname = dirname(fileURLToPath(import.meta.url));

/** ──────────────────────────────────────────────────────────────
 *  AWS / DynamoDB
 *  ────────────────────────────────────────────────────────────── */
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const OS_USERS_TABLE = process.env.OS_USERS_TABLE;

const ddb = new DynamoDBClient({ region: AWS_REGION });
const doc = DynamoDBDocumentClient.from(ddb);

// normalize username (case-insensitive login)
const norm = (s) => (s || '').trim().toLowerCase();

/** ──────────────────────────────────────────────────────────────
 *  In-memory state for meetings and probabilities
 *  ────────────────────────────────────────────────────────────── */
// rooms: Map<meetingId, Array<{socketId, userId, userName, joinedAt}>>
// roomScores: Map<meetingId, Record<userId, {authentication, timestamp, userId, userName}>>
const rooms = new Map();
const roomScores = new Map();

/** ──────────────────────────────────────────────────────────────
 *  Security headers (Zoom requirements)
 *  ────────────────────────────────────────────────────────────── */
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.zoom.us https://*.zoomgov.com;");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Enable JSON parsing & static files
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.get('/zoomapp.manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(join(__dirname, 'zoomapp.manifest.json'));
});

app.get('/auth', (req, res) => {
  const { code } = req.query;
  if (code) {
    console.log('✅ Authorization code received:', code);
    res.send(`
      <html>
        <head><title>Authorization Successful</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h2>Authorization Successful!</h2>
          <p>Your Zoom app has been installed successfully.</p>
          <p>You can now close this window and use the app in Zoom meetings.</p>
          <script>setTimeout(() => window.close(), 3000);</script>
        </body>
      </html>
    `);
  } else {
    res.status(400).send(`
      <html>
        <head><title>Authorization Failed</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h2>Authorization Failed</h2>
          <p>No authorization code received.</p>
          <p>Please try installing the app again.</p>
        </body>
      </html>
    `);
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    activeRooms: rooms.size,
    totalConnections: io.engine.clientsCount
  });
});

/** ──────────────────────────────────────────────────────────────
 *  Socket.IO: OriginStory os_packet protocol
 *  Commands:
 *   0x00 TEST_CONNECTION     -> 0x01 CONNECTION_ESTABLISHED
 *   0x02 VALIDATE_USER       -> 0x03 USER_VALID | 0x04 USER_INVALID
 *   0x10 CREATE_USER         -> 0x03 USER_VALID | 0x04 USER_INVALID
 *   0x0E REGISTER_LOCAL      (local client registers originStoryUserId)
 *   0x0D MEETING_INFO        (zoom app sends meetingId + originStoryUserId)
 *   0x08 DATA_TRANSMISSION   (local client sends probability)
 *   0x09 END_DATA            (zoom app -> server -> local client)
 *   0x0B BAD_COMMAND
 *   0x0C BAD_DATA
 *  ────────────────────────────────────────────────────────────── */
io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  // Global maps
  if (!global.osUserToLocalSocket) global.osUserToLocalSocket = new Map(); // originStoryUserId -> socketId
  if (!global.authHistory) global.authHistory = new Map(); // meetingId -> Map<userId, Array<{authentication,timestamp}>>
  if (!global.userToMeeting) global.userToMeeting = new Map(); // originStoryUserId -> meetingId

  // Bad-login throttle (per-socket)
  if (!global.badLoginMap) global.badLoginMap = new Map();
  const BAD_LOGIN_WINDOW_MS = 60_000;
  const BAD_LOGIN_LIMIT = 5;
  const canAttemptLogin = (sid) => {
    const now = Date.now();
    const rec = global.badLoginMap.get(sid);
    if (!rec) return true;
    if (now - rec.firstAt > BAD_LOGIN_WINDOW_MS) { global.badLoginMap.delete(sid); return true; }
    return rec.count < BAD_LOGIN_LIMIT;
  };
  const noteBadLogin = (sid) => {
    const now = Date.now();
    const rec = global.badLoginMap.get(sid);
    if (!rec) global.badLoginMap.set(sid, { count: 1, firstAt: now });
    else rec.count++;
  };

  // Pretty names for logs
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
    0x0E: 'REGISTER_LOCAL',
    0x0F: 'UNREGISTER_LOCAL',  
    0x10: 'CREATE_USER'
  };

  const logRecv = (cmd, data) =>
    console.log(`⬇️  os_packet RECV [${CMD[cmd] || cmd}]`, data
      ? JSON.stringify({ ...data, password: data.password ? '***redacted***' : undefined })
      : '');
  const logSend = (dest, cmd, data) =>
    console.log(`⬆️  os_packet SEND → ${dest} [${CMD[cmd] || cmd}]`, data ? JSON.stringify(data) : '');

  function sendPacket(sock, cmd, data) {
    logSend(sock.id, cmd, data);
    sock.emit('os_packet', { cmd, data });
  }

  function maybeBeginIfReady(originStoryUserId) {
    const localSid = global.osUserToLocalSocket?.get(originStoryUserId);
    const meetingId = global.userToMeeting?.get(originStoryUserId);
    if (localSid && meetingId) {
      const participants = rooms.get(meetingId) || [];
      const p = participants.find(u => u.userId === originStoryUserId);
      const userName = p?.userName || originStoryUserId;

      // Push MEETING_INFO then BEGIN_DATA
      const info = { cmd: 0x0D, data: { meetingId, originStoryUserId, userName } };
      io.to(localSid).emit('os_packet', info);

      const begin = { cmd: 0x07, data: { meetingId, originStoryUserId } };
      io.to(localSid).emit('os_packet', begin);
    }
  }


  // Unified os_packet handler
  socket.on('os_packet', async (packet = {}) => {
    try {
      const cmd = Number(packet?.cmd);
      const data = packet?.data || {};
      if (Number.isNaN(cmd)) {
        const err = { cmd: 0x0C, data: { error: 'Missing cmd' } }; // BAD_DATA
        sendPacket(socket, err.cmd, err.data);
        return;
      }

      logRecv(cmd, data);

      switch (cmd) {
        /** TEST_CONNECTION -> CONNECTION_ESTABLISHED */
        case 0x00: {
          sendPacket(socket, 0x01); // CONNECTION_ESTABLISHED
          break;
        }

        /** VALIDATE_USER (username only) */
        case 0x02: {
          try {
            if (!canAttemptLogin(socket.id)) {
              return sendPacket(socket, 0x04, { error: 'Invalid credentials' });
            }

            const usernameIn = (data?.username || '').trim();
            const password = (data?.password || '').trim();
            if (!usernameIn || !password) {
              return sendPacket(socket, 0x04, { error: 'Invalid credentials' });
            }

            if (!OS_USERS_TABLE) {
              console.error('❌ OS_USERS_TABLE not set; refusing login.');
              return sendPacket(socket, 0x04, { error: 'Invalid credentials' });
            }

            const username = norm(usernameIn);
            const getRes = await doc.send(new GetCommand({
              TableName: OS_USERS_TABLE,
              Key: { username }
            }));
            const user = getRes.Item;
            if (!user || !user.passwordHash) {
              noteBadLogin(socket.id);
              return sendPacket(socket, 0x04, { error: 'Invalid credentials' });
            }

            const ok = await bcrypt.compare(password, user.passwordHash);
            if (!ok) {
              noteBadLogin(socket.id);
              return sendPacket(socket, 0x04, { error: 'Invalid credentials' });
            }

            // Success
            sendPacket(socket, 0x03, { userId: user.username, displayName: user.displayName || user.username });
          } catch (err) {
            console.error('Login error:', err);
            sendPacket(socket, 0x04, { error: 'Invalid credentials' });
          }
          break;
        }

        /** CREATE_USER (sign-up) -> USER_VALID on success */
        case 0x10: {
          try {
            if (!OS_USERS_TABLE) {
              console.error('❌ OS_USERS_TABLE not set; refusing sign-up.');
              return sendPacket(socket, 0x04, { error: 'Sign-up unavailable' });
            }

            const usernameIn = (data?.username || '').trim();
            const emailIn = (data?.email || '').trim();
            const password = (data?.password || '').trim();
            const deviceId = (data?.deviceId || '').trim(); // optional
            const nowIso = new Date().toISOString();

            if (!usernameIn || !emailIn || password.length < 8) {
              return sendPacket(socket, 0x04, { error: 'Invalid sign-up data' });
            }

            const username = norm(usernameIn);
            const email = norm(emailIn);

            // Ensure username not taken
            const existing = await doc.send(new GetCommand({
              TableName: OS_USERS_TABLE,
              Key: { username }
            }));
            if (existing.Item) {
              return sendPacket(socket, 0x04, { error: 'Username already exists' });
            }

            const passwordHash = await bcrypt.hash(password, 10);
            const item = {
              username,
              passwordHash,
              email,
              deviceId,
              createdAt: nowIso,
              lastUpdatedAt: nowIso
            };

            await doc.send(new PutCommand({
              TableName: OS_USERS_TABLE,
              Item: item,
              ConditionExpression: 'attribute_not_exists(username)'
            }));

            // Auto-login UX after creation
            sendPacket(socket, 0x03, { userId: username, displayName: username });
          } catch (err) {
            console.error('Sign-up error:', err);
            sendPacket(socket, 0x04, { error: 'Sign-up failed' });
          }
          break;
        }

        /** REGISTER_LOCAL: local client introduces itself */
        case 0x0E: {
          const { originStoryUserId } = data || {};
          if (!originStoryUserId) {
            return sendPacket(socket, 0x0C, { error: 'Missing originStoryUserId' }); // BAD_DATA
          }
          global.osUserToLocalSocket.set(originStoryUserId, socket.id);
          console.log(`🔗 Local client registered: ${originStoryUserId} -> ${socket.id}`);

          sendPacket(socket, 0x01, { message: 'local_registered' });
          maybeBeginIfReady(originStoryUserId);

          break;
        }

        /** MEETING_INFO: zoom app joins meeting room */
        case 0x0D: {
          const { meetingId, originStoryUserId, userName } = data || {};
          if (!meetingId || !originStoryUserId) {
            return sendPacket(socket, 0x0C, { error: 'Missing meetingId/originStoryUserId' });
          }

          console.log(`📌 [OS] MEETING_INFO: ${originStoryUserId} joined ${meetingId}`);

          if (!rooms.has(meetingId)) {
            rooms.set(meetingId, []);
            roomScores.set(meetingId, {});
          }

          const participants = rooms.get(meetingId);
          let p = participants.find(u => u.userId === originStoryUserId);
          if (!p) {
            p = { socketId: socket.id, userId: originStoryUserId, userName: userName || 'Unknown', joinedAt: new Date() };
            participants.push(p);
            io.to(meetingId).except(socket.id).emit('participant_joined', {
              userId: p.userId,
              userName: p.userName,
              participantCount: participants.length
            });
          } else {
            p.socketId = socket.id;
            p.userName = userName || p.userName;
          }

          socket.join(meetingId);
          global.userToMeeting.set(originStoryUserId, meetingId);
          
          const latest = roomScores.get(meetingId) || {};
          const statePkt = {
            participants: participants.map(u => ({ userId: u.userId, userName: u.userName, joinedAt: u.joinedAt })),
            scores: latest
          };
          socket.emit('current_participants', statePkt);

          const localSid = global.osUserToLocalSocket.get(originStoryUserId);
          if (localSid) {
            const fwd = { cmd: 0x0D, data: { meetingId, originStoryUserId, userName: p.userName } };
            logSend(`local:${localSid}`, fwd.cmd, fwd.data);
            io.to(localSid).emit('os_packet', fwd);
          }
          
          maybeBeginIfReady(originStoryUserId);

          console.log(`✅ Room ${meetingId} now has ${participants.length} participants`);
          break;
        }

        /** DATA_TRANSMISSION: local client -> server -> room */
        case 0x08: {
          const { meetingId, originStoryUserId } = data || {};
          let { prob_1, prob_2 } = data || {};

          if (!meetingId || !originStoryUserId || typeof prob_1 === 'undefined' || typeof prob_2 === 'undefined') {
            return sendPacket(socket, 0x0C, { error: 'Missing meetingId/originStoryUserId/prob_1/prob_2' });
          }

          prob_1 = Number(prob_1);
          prob_2 = Number(prob_2);
          const inRange = (n) => Number.isFinite(n) && n >= 0 && n <= 1;
          if (!inRange(prob_1) || !inRange(prob_2)) {
            return sendPacket(socket, 0x0C, { error: 'prob_1 and prob_2 must be in [0,1]' });
          }

          // Round to 2 decimals for transport/consistency
          const r2 = (x) => Math.round(x * 100) / 100;
          prob_1 = r2(prob_1);
          prob_2 = r2(prob_2);

          if (!rooms.has(meetingId)) {
            // Room gone — politely ask local to stop
            const localSid = global.osUserToLocalSocket?.get(originStoryUserId);
            if (localSid) {
              const stop = { cmd: 0x09, data: { meetingId, originStoryUserId } };
              logSend(`local:${localSid}`, stop.cmd, stop.data);
              io.to(localSid).emit('os_packet', stop);
            }
            return sendPacket(socket, 0x0C, { error: `Unknown meetingId ${meetingId}` });
          }

          // (Optional spoof guard) Ensure this socket is the registered local for this user
          // See explanation below (§ Why helpful). If you want it, uncomment:
          /*
          const expectedLocalSid = global.osUserToLocalSocket?.get(originStoryUserId);
          if (expectedLocalSid && expectedLocalSid !== socket.id) {
            return sendPacket(socket, 0x0C, { error: 'Sender is not the registered local for this userId' });
          }
          */

          const participants = rooms.get(meetingId);
          const target = participants.find(u => u.userId === originStoryUserId);
          if (!target) {
            return sendPacket(socket, 0x0C, { error: `User ${originStoryUserId} not in meeting ${meetingId}` });
          }

          const nowIso = new Date().toISOString();

          // Store latest per user
          const latest = roomScores.get(meetingId) || {};
          latest[originStoryUserId] = {
            // Keep `authentication` for today's UI (map to prob_1)
            authentication: prob_1,
            prob_1,
            prob_2,
            timestamp: nowIso,
            userId: originStoryUserId,
            userName: target.userName
          };
          roomScores.set(meetingId, latest);

          // Small rolling history (unchanged logic)
          if (!global.authHistory.has(meetingId)) global.authHistory.set(meetingId, new Map());
          const histMap = global.authHistory.get(meetingId);
          if (!histMap.has(originStoryUserId)) histMap.set(originStoryUserId, []);
          const arr = histMap.get(originStoryUserId);
          arr.push({ prob_1, prob_2, timestamp: nowIso });
          while (arr.length > 5) arr.shift();

          // Broadcast to the room (keep `authentication` for current Zoom UI)
          const out = {
            cmd: 0x08,
            data: {
              meetingId,
              userId: originStoryUserId,
              userName: target.userName,
              authentication: prob_1, 
              prob_1,
              prob_2,
              timestamp: nowIso
            }
          };
          logSend(`room:${meetingId}`, out.cmd, out.data);
          io.to(meetingId).emit('os_packet', out);
          break;
        }


        /** END_DATA: Zoom app asks local client to stop */
        case 0x09: {
          const { meetingId, originStoryUserId } = data || {};
          if (!originStoryUserId) {
            return sendPacket(socket, 0x0C, { error: 'Missing originStoryUserId' });
          }
          const localSid = global.osUserToLocalSocket?.get(originStoryUserId);
          if (localSid) {
            const fwd = { cmd: 0x09, data: { meetingId: meetingId || global.userToMeeting.get(originStoryUserId) || null, originStoryUserId } };
            logSend(`local:${localSid}`, fwd.cmd, fwd.data);
            io.to(localSid).emit('os_packet', fwd);
          } else {
            console.log(`ℹ️ No local client registered for ${originStoryUserId}; END_DATA not forwarded`);
          }
          break;
        }

        case 0x0F: {
          const { originStoryUserId } = data || {};
          if (!originStoryUserId) {
            return sendPacket(socket, 0x0C, { error: 'Missing originStoryUserId' }); // BAD_DATA
          }
          const sid = global.osUserToLocalSocket?.get(originStoryUserId);
          if (sid && sid === socket.id) {
            global.osUserToLocalSocket.delete(originStoryUserId);
            sendPacket(socket, 0x01, { message: 'local_unregistered' }); // CONNECTION_ESTABLISHED as ack
          } else {
            // Either not registered, or another socket is registered
            sendPacket(socket, 0x0C, { error: 'Not registered as local for this userId' }); // BAD_DATA
          }
          break;
        }

        default: {
          const err = { cmd: 0x0B, data: { error: `Unknown command ${cmd}` } }; // BAD_COMMAND
          sendPacket(socket, err.cmd, err.data);
        }
      }
    } catch (err) {
      console.error('Error handling os_packet:', err);
      sendPacket(socket, 0x0C, { error: 'Server error processing packet' }); // BAD_DATA
    }
  });

  // Failsafe: forward END_DATA to local client when Zoom socket is disconnecting
  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      const participants = rooms.get(roomId);
      if (!participants) continue;
      const disc = participants.find(p => p.socketId === socket.id);
      if (disc) {
        const localSid = global.osUserToLocalSocket?.get(disc.userId);
        if (localSid) {
          const pkt = { cmd: 0x09, data: { meetingId: roomId, originStoryUserId: disc.userId } }; // END_DATA
          logSend(`local:${localSid}`, pkt.cmd, pkt.data);
          io.to(localSid).emit('os_packet', pkt);
        }
      }
    }
  });

  // Disconnection: cleanup
  socket.on('disconnect', () => {
    console.log('🔌 User disconnected:', socket.id);

    // Cleanup local-client registry if any
    for (const [uid, sid] of global.osUserToLocalSocket) {
      if (sid === socket.id) {
        global.osUserToLocalSocket.delete(uid);
        console.log(`🔗 Removed local registration for ${uid}`);
      }
    }

    // Remove from all rooms and notify remaining
    rooms.forEach((participants, roomId) => {
      const disconnectedParticipant = participants.find(p => p.socketId === socket.id);
      const updatedParticipants = participants.filter(p => p.socketId !== socket.id);

      if (disconnectedParticipant) {
        global.userToMeeting.delete(disconnectedParticipant.userId);

        if (updatedParticipants.length === 0) {
          rooms.delete(roomId);
          roomScores.delete(roomId);
          console.log(`🧹 Cleaned up empty room: ${roomId}`);
        } else {
          rooms.set(roomId, updatedParticipants);
          io.to(roomId).emit('participant_left', {
            userId: disconnectedParticipant.userId,
            userName: disconnectedParticipant.userName,
            participantCount: updatedParticipants.length
          });
          console.log(`👋 ${disconnectedParticipant.userName} left room ${roomId}, ${updatedParticipants.length} participants remaining`);
        }
      }
    });
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
server.listen(port, () => {
  console.log(`🚀 Zoom App server running on http://localhost:${port}`);
  console.log('🔌 Socket.IO server ready for WebSocket connections');
  console.log('📝 Make sure your ngrok URL matches the manifest domains');
  console.log('🔗 Ngrok URL should be: https://unduly-notable-llama.ngrok-free.app');
  console.log(`📋 Manifest available at: http://localhost:${port}/zoomapp.manifest.json`);
});

export default app;
