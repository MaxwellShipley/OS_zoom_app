import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
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

// Store room participants and latest probabilities only
// rooms: Map<meetingId, Array<{socketId, userId, userName, joinedAt}>>
// roomScores: Map<meetingId, Record<userId, {authentication, timestamp, userId, userName}>>
const rooms = new Map();
const roomScores = new Map();

// Set security headers required by Zoom (OWASP compliance)
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

// Enable JSON parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the 'public' directory
app.use(express.static(join(__dirname, 'public')));

// The root route serves your main app page
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Serve the manifest file - crucial for Zoom to recognize the app
app.get('/zoomapp.manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(join(__dirname, 'zoomapp.manifest.json'));
});

// OAuth callback endpoint for app installation
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    activeRooms: rooms.size,
    totalConnections: io.engine.clientsCount
  });
});

/**
 * Socket.IO connection handling with OriginStory protocol (os_packet)
 * Numeric command codes:
 * 0x00 TEST_CONNECTION             -> 0x01 CONNECTION_ESTABLISHED
 * 0x02 VALIDATE_USER               -> 0x03 USER_VALID | 0x04 USER_INVALID
 * 0x0E REGISTER_LOCAL  (local client registers originStoryUserId)
 * 0x0D MEETING_INFO    (zoom app sends meetingId + originStoryUserId)
 * 0x08 DATA_TRANSMISSION (local client sends probability)
 * 0x09 END_DATA        (zoom app requests local client to stop streaming)
 * 0x0B BAD_COMMAND
 * 0x0C BAD_DATA
 */
io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  // Global state
  if (!global.osUserToLocalSocket) global.osUserToLocalSocket = new Map(); // originStoryUserId -> socketId
  if (!global.authHistory) global.authHistory = new Map(); // meetingId -> Map<userId, Array<{authentication,timestamp}>>
  if (!global.userToMeeting) global.userToMeeting = new Map(); // originStoryUserId -> meetingId

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
    0x0E: 'REGISTER_LOCAL'
  };
  const logRecv = (cmd, data) =>
    console.log(`⬇️  os_packet RECV [${CMD[cmd] || cmd}]`, data ? JSON.stringify(data) : '');
  const logSend = (dest, cmd, data) =>
    console.log(`⬆️  os_packet SEND → ${dest} [${CMD[cmd] || cmd}]`, data ? JSON.stringify(data) : '');

  // Unified OS packet handler
  socket.on('os_packet', (packet) => {
    try {
      const cmd = Number(packet?.cmd);
      const data = packet?.data || {};
      if (Number.isNaN(cmd)) {
        const err = { cmd: 0x0C, data: { error: 'Missing cmd' } }; // BAD_DATA
        logSend(socket.id, err.cmd, err.data);
        socket.emit('os_packet', err);
        return;
      }

      logRecv(cmd, data);

      switch (cmd) {
        case 0x00: { // TEST_CONNECTION
          const reply = { cmd: 0x01 }; // CONNECTION_ESTABLISHED
          logSend(socket.id, reply.cmd, reply.data);
          socket.emit('os_packet', reply);
          break;
        }

        case 0x02: { // VALIDATE_USER
          // Accept any non-empty username and password for now
          const { username, email, password } = data || {};
          const idLike = (username || email || '').trim();
          const passOk = typeof password === 'string' && password.trim().length > 0;
          if (idLike && passOk) {
            const ok = { cmd: 0x03, data: { userId: idLike } }; // USER_VALID
            logSend(socket.id, ok.cmd, ok.data);
            socket.emit('os_packet', ok);
          } else {
            const no = { cmd: 0x04, data: { error: 'Invalid credentials (empty)' } }; // USER_INVALID
            logSend(socket.id, no.cmd, no.data);
            socket.emit('os_packet', no);
          }
          break;
        }

        case 0x0E: { // REGISTER_LOCAL (local client -> server)
          const { originStoryUserId } = data;
          if (!originStoryUserId) {
            const err = { cmd: 0x0C, data: { error: 'Missing originStoryUserId' } };
            logSend(socket.id, err.cmd, err.data);
            socket.emit('os_packet', err);
            return;
          }
          global.osUserToLocalSocket.set(originStoryUserId, socket.id);
          console.log(`🔗 Local client registered: ${originStoryUserId} -> ${socket.id}`);
          const ack = { cmd: 0x01, data: { message: 'local_registered' } };
          logSend(socket.id, ack.cmd, ack.data);
          socket.emit('os_packet', ack);
          break;
        }

        case 0x0D: { // MEETING_INFO (zoom app -> server)
          const { meetingId, originStoryUserId, userName } = data;
          if (!meetingId || !originStoryUserId) {
            const err = { cmd: 0x0C, data: { error: 'Missing meetingId/originStoryUserId' } };
            logSend(socket.id, err.cmd, err.data);
            socket.emit('os_packet', err);
            return;
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

          console.log(`✅ Room ${meetingId} now has ${participants.length} participants`);
          break;
        }

        case 0x08: { // DATA_TRANSMISSION (local client -> server)
          const { meetingId, originStoryUserId, authentication, timestamp } = data;
          if (!meetingId || !originStoryUserId || typeof authentication === 'undefined') {
            const err = { cmd: 0x0C, data: { error: 'Missing meetingId/originStoryUserId/authentication' } };
            logSend(socket.id, err.cmd, err.data);
            socket.emit('os_packet', err);
            return;
          }
          const prob = Number(authentication);
          if (isNaN(prob) || prob < 0 || prob > 1) {
            const err = { cmd: 0x0C, data: { error: 'authentication must be in [0,1]' } };
            logSend(socket.id, err.cmd, err.data);
            socket.emit('os_packet', err);
            return;
          }

          if (!rooms.has(meetingId)) {
            // Room gone — politely ask local client to stop
            const localSid = global.osUserToLocalSocket?.get(originStoryUserId);
            if (localSid) {
              const stop = { cmd: 0x09, data: { meetingId, originStoryUserId } }; // END_DATA
              logSend(`local:${localSid}`, stop.cmd, stop.data);
              io.to(localSid).emit('os_packet', stop);
            }
            const err = { cmd: 0x0C, data: { error: `Unknown meetingId ${meetingId}` } };
            logSend(socket.id, err.cmd, err.data);
            socket.emit('os_packet', err);
            return;
          }

          const participants = rooms.get(meetingId);
          const target = participants.find(u => u.userId === originStoryUserId);
          if (!target) {
            const err = { cmd: 0x0C, data: { error: `User ${originStoryUserId} not in meeting ${meetingId}` } };
            logSend(socket.id, err.cmd, err.data);
            socket.emit('os_packet', err);
            return;
          }

          const latest = roomScores.get(meetingId) || {};
          latest[originStoryUserId] = {
            authentication: prob,
            timestamp: timestamp || new Date().toISOString(),
            userId: originStoryUserId,
            userName: target.userName
          };
          roomScores.set(meetingId, latest);

          if (!global.authHistory.has(meetingId)) global.authHistory.set(meetingId, new Map());
          const histMap = global.authHistory.get(meetingId);
          if (!histMap.has(originStoryUserId)) histMap.set(originStoryUserId, []);
          const arr = histMap.get(originStoryUserId);
          arr.push({ authentication: prob, timestamp: timestamp || new Date().toISOString() });
          while (arr.length > 5) arr.shift();

          const out = {
            cmd: 0x08,
            data: {
              meetingId,
              userId: originStoryUserId,
              userName: target.userName,
              authentication: prob,
              timestamp: timestamp || new Date().toISOString()
            }
          };
          logSend(`room:${meetingId}`, out.cmd, out.data);
          io.to(meetingId).emit('os_packet', out);
          break;
        }

        case 0x09: { // END_DATA (Zoom app -> Server -> Local client)
          const { meetingId, originStoryUserId } = data || {};
          if (!originStoryUserId) {
            const err = { cmd: 0x0C, data: { error: 'Missing originStoryUserId' } };
            logSend(socket.id, err.cmd, err.data);
            socket.emit('os_packet', err);
            return;
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

        default: {
          const err = { cmd: 0x0B, data: { error: `Unknown command ${cmd}` } }; // BAD_COMMAND
          logSend(socket.id, err.cmd, err.data);
          socket.emit('os_packet', err);
        }
      }
    } catch (err) {
      console.error('Error handling os_packet:', err);
      const e = { cmd: 0x0C, data: { error: 'Server error processing packet' } }; // BAD_DATA
      logSend(socket.id, e.cmd, e.data);
      socket.emit('os_packet', e);
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start the server
server.listen(port, () => {
  console.log(`🚀 Zoom App server running on http://localhost:${port}`);
  console.log('🔌 Socket.IO server ready for WebSocket connections');
  console.log('📝 Make sure your ngrok URL matches the manifest domains');
  console.log('🔗 Ngrok URL should be: https://unduly-notable-llama.ngrok-free.app');
  console.log(`📋 Manifest available at: http://localhost:${port}/zoomapp.manifest.json`);
});

export default app;
