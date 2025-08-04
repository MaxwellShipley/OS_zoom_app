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

// Store room participants and latest scores only
const rooms = new Map(); // roomId -> [{socketId, userId, userName, joinedAt}]
const roomScores = new Map(); // roomId -> {userId: latestScoreData}

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
  const { code, state } = req.query;
  if (code) {
    // In a production app, you would exchange the code for tokens here
    console.log('✅ Authorization code received:', code);
    res.send(`
      <html>
        <head><title>Authorization Successful</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h2>✅ Authorization Successful!</h2>
          <p>Your Zoom app has been installed successfully.</p>
          <p>You can now close this window and use the app in Zoom meetings.</p>
          <script>
            // Auto-close after 3 seconds
            setTimeout(() => window.close(), 3000);
          </script>
        </body>
      </html>
    `);
  } else {
    res.status(400).send(`
      <html>
        <head><title>Authorization Failed</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h2>❌ Authorization Failed</h2>
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

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  // Handle joining a room (Zoom meeting)
  socket.on('join_room', (data) => {
    const { roomId, userId, userName } = data;
    
    console.log(`👤 User ${userName} (${userId}) joining room ${roomId}`);
    
    // Leave any previous room
    const previousRooms = Array.from(socket.rooms);
    previousRooms.forEach(room => {
      if (room !== socket.id) {
        socket.leave(room);
        // Remove from room tracking
        if (rooms.has(room)) {
          const roomParticipants = rooms.get(room);
          rooms.set(room, roomParticipants.filter(p => p.socketId !== socket.id));
        }
      }
    });
    
    // Join the new room
    socket.join(roomId);
    
    // Initialize room data structures if needed
    if (!rooms.has(roomId)) {
      rooms.set(roomId, []);
      roomScores.set(roomId, {});
    }
    
    const roomParticipants = rooms.get(roomId);
    const roomScoreData = roomScores.get(roomId);
    const existingParticipant = roomParticipants.find(p => p.userId === userId);
    
    if (!existingParticipant) {
      // Add new participant
      roomParticipants.push({
        socketId: socket.id,
        userId,
        userName,
        joinedAt: new Date()
      });
    } else {
      // Update socket ID for existing participant (reconnection)
      existingParticipant.socketId = socket.id;
    }
    
    // Send current room state to the new participant
    socket.emit('current_participants', {
      participants: roomParticipants.map(p => ({
        userId: p.userId,
        userName: p.userName,
        joinedAt: p.joinedAt
      })),
      scores: roomScoreData
    });
    
    // Notify others in room about new participant (unless it's a reconnection)
    if (!existingParticipant) {
      socket.to(roomId).emit('participant_joined', {
        userId,
        userName,
        participantCount: roomParticipants.length
      });
    }
    
    console.log(`✅ Room ${roomId} now has ${roomParticipants.length} participants`);
    console.log(`📊 Room ${roomId} has scores for ${Object.keys(roomScoreData).length} participants`);
  });

  // Handle score updates
  socket.on('score_update', (data) => {
    const { roomId, score, userId, userName, timestamp } = data;
    
    console.log(`📊 Score update from ${userName}: ${score}`);
    
    // Verify user is in the room
    const roomParticipants = rooms.get(roomId);
    if (!roomParticipants || !roomParticipants.find(p => p.socketId === socket.id)) {
      console.log('❌ Unauthorized score update attempt');
      return;
    }
    
    // Store the latest score for this user (overwrite previous)
    const scoreData = {
      score,
      userId,
      userName,
      timestamp: timestamp || new Date().toISOString(),
      id: `${userId}_${Date.now()}`
    };
    
    const roomScoreData = roomScores.get(roomId) || {};
    roomScoreData[userId] = scoreData; // Store only latest score per user
    roomScores.set(roomId, roomScoreData);
    
    // Broadcast to all participants in the room
    io.to(roomId).emit('score_received', scoreData);
    
    console.log(`📢 Score broadcasted to room ${roomId} (${Object.keys(roomScoreData).length} users have scores)`);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('🔌 User disconnected:', socket.id);
    
    // Remove from all rooms
    rooms.forEach((participants, roomId) => {
      const disconnectedParticipant = participants.find(p => p.socketId === socket.id);
      const updatedParticipants = participants.filter(p => p.socketId !== socket.id);
      
      if (disconnectedParticipant) {
        if (updatedParticipants.length === 0) {
          // Room is empty, clean up
          rooms.delete(roomId);
          roomScores.delete(roomId);
          console.log(`🧹 Cleaned up empty room: ${roomId}`);
        } else {
          rooms.set(roomId, updatedParticipants);
          
          // Notify remaining participants
          socket.to(roomId).emit('participant_left', {
            userId: disconnectedParticipant.userId,
            userName: disconnectedParticipant.userName,
            participantCount: updatedParticipants.length
          });
          
          console.log(`👋 User ${disconnectedParticipant.userName} left room ${roomId}, ${updatedParticipants.length} participants remaining`);
        }
      }
    });
  });

  // Handle manual leave room
  socket.on('leave_room', (data) => {
    const { roomId } = data;
    socket.leave(roomId);
    
    if (rooms.has(roomId)) {
      const participants = rooms.get(roomId);
      const leavingParticipant = participants.find(p => p.socketId === socket.id);
      const updatedParticipants = participants.filter(p => p.socketId !== socket.id);
      rooms.set(roomId, updatedParticipants);
      
      if (leavingParticipant) {
        socket.to(roomId).emit('participant_left', {
          userId: leavingParticipant.userId,
          userName: leavingParticipant.userName,
          participantCount: updatedParticipants.length
        });
      }
      
      console.log(`👋 User manually left room ${roomId}, ${updatedParticipants.length} participants remaining`);
    }
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