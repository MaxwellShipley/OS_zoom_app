// Simple, robust initialization without complex state management
let isConfigured = false;
let socket = null;
let currentMeetingId = null;
let currentUserId = null;
let currentUserName = null;
let isConnectedToRoom = false;

// Store participant data from server
let participantList = []; // List of participants from server
let participantScores = new Map(); // userId -> latest score data

// Initialize WebSocket connection
function initializeWebSocket() {
  console.log('🔌 Initializing WebSocket connection...');
  
  // Check if Socket.IO is loaded
  if (typeof io === 'undefined') {
    console.error('❌ Socket.IO not loaded');
    updateConnectionStatus('Socket.IO not available');
    return;
  }
  
  connectWebSocket();
}

function connectWebSocket() {
  socket = io();
  
  socket.on('connect', function() {
    console.log('✅ Connected to WebSocket server');
    updateConnectionStatus('WebSocket Connected');
    
    // Join room if we have meeting info
    if (currentMeetingId && currentUserId && !isConnectedToRoom) {
      joinMeetingRoom();
    }
  });
  
  socket.on('disconnect', function() {
    console.log('❌ Disconnected from WebSocket server');
    updateConnectionStatus('WebSocket Disconnected');
    isConnectedToRoom = false;
  });
  
  // Handle initial participant list and scores from server
  socket.on('current_participants', function(data) {
    console.log('📋 Received current participants:', data);
    
    // Update participant list
    participantList = data.participants || [];
    
    // Update scores
    participantScores.clear();
    Object.entries(data.scores || {}).forEach(([userId, scoreData]) => {
      participantScores.set(userId, scoreData);
    });
    
    // Rebuild the UI with server data
    displayParticipantsFromServer();
    
    console.log(`✅ Loaded ${participantList.length} participants and ${participantScores.size} scores from server`);
  });
  
  // Handle score updates from other participants
  socket.on('score_received', function(scoreData) {
    console.log('📊 Received score update:', scoreData);
    // Update the participant scores map
    participantScores.set(scoreData.userId, scoreData);
    // Update the display
    updateParticipantScore(scoreData.userId, scoreData);
    displayScoreUpdate(scoreData);
  });
  
  // Handle new participant joining
  socket.on('participant_joined', function(data) {
    console.log('👤 Participant joined:', data.userName);
    showNotification(`${data.userName} joined the session`);
    
    // Add to local participant list if not already there
    if (!participantList.find(p => p.userId === data.userId)) {
      participantList.push({
        userId: data.userId,
        userName: data.userName,
        joinedAt: new Date()
      });
      
      // Refresh the display
      displayParticipantsFromServer();
    }
  });
  
  // Handle participant leaving
  socket.on('participant_left', function(data) {
    console.log('👋 Participant left:', data.userName);
    showNotification(`${data.userName} left the session`);
    
    // Remove from local participant list
    participantList = participantList.filter(p => p.userId !== data.userId);
    
    // Remove their score
    participantScores.delete(data.userId);
    
    // Refresh the display
    displayParticipantsFromServer();
  });
  
  socket.on('connect_error', function(error) {
    console.error('❌ WebSocket connection error:', error);
    updateConnectionStatus('Connection Error');
  });
}

function joinMeetingRoom() {
  if (!socket || !currentMeetingId || !currentUserId) {
    console.log('⚠️ Cannot join room - missing required data');
    return;
  }
  
  console.log(`🚪 Joining room: ${currentMeetingId}`);
  
  socket.emit('join_room', {
    roomId: currentMeetingId,
    userId: currentUserId,
    userName: currentUserName || 'Unknown User'
  });
  
  isConnectedToRoom = true;
  updateConnectionStatus(`Connected to Meeting Room`);
}

function sendScore(score) {
  if (!socket || !isConnectedToRoom || !currentMeetingId) {
    console.log('⚠️ Cannot send score - not connected to room');
    alert('Not connected to meeting room');
    return;
  }
  
  const scoreData = {
    roomId: currentMeetingId,
    score: score,
    userId: currentUserId,
    userName: currentUserName || 'Unknown User',
    timestamp: new Date().toISOString()
  };
  
  console.log('📤 Sending score:', scoreData);
  socket.emit('score_update', scoreData);
  
  // Store locally and update display immediately
  participantScores.set(currentUserId, scoreData);
  updateParticipantScore(currentUserId, scoreData);
  
  // Show success feedback
  showNotification(`Your score (${score}) has been shared!`);
}

function displayScoreUpdate(scoreData, isLocal = false) {
  // Just log - main display happens in updateParticipantScore
  console.log('📊 Score update processed');
}

function updateParticipantScore(userId, scoreData) {
  console.log(`Updating participant score for ${userId}:`, scoreData);
  
  const participantElement = document.querySelector(`[data-user-id="${userId}"]`);
  if (participantElement) {
    const scoreElement = participantElement.querySelector('.participant-score');
    if (scoreElement) {
      const isCurrentUser = userId === currentUserId;
      
      scoreElement.innerHTML = `
        <span class="score-display ${isCurrentUser ? 'current-user-score' : ''}">
          ${scoreData.score}
        </span>
      `;
      
      // Add a brief highlight animation
      scoreElement.style.animation = 'scoreUpdate 1s ease-out';
      setTimeout(() => {
        scoreElement.style.animation = '';
      }, 1000);
      
      console.log(`Updated score display for ${scoreData.userName}`);
    } else {
      console.log('Score element not found for participant');
    }
  } else {
    console.log(`Participant element not found for userId: ${userId}`);
  }
}

function updateConnectionStatus(status) {
  const statusElement = document.getElementById('connection-status');
  if (statusElement) {
    statusElement.textContent = status;
    
    // Update CSS class based on status
    statusElement.className = '';
    if (status.includes('Connected to Meeting') || status.includes('WebSocket Connected')) {
      statusElement.className = 'status-connected';
    } else if (status.includes('Connecting') || status.includes('Initializing')) {
      statusElement.className = 'status-connecting';
    } else {
      statusElement.className = 'status-disconnected';
    }
  }
}

function showNotification(message) {
  console.log(message);
  
  // Try to use Zoom's notification system first
  if (window.zoomSdk && isConfigured) {
    window.zoomSdk.showNotification({
      type: 'info',
      title: 'Score Update',
      message: message
    }).catch(() => {
      // Fallback - could add a visual notification here
      console.log('Zoom notification failed, using fallback');
    });
  }
}

function displayError(message) {
  const container = document.getElementById('participant-list');
  if (container) {
    container.innerHTML = `
      <div class="error">
        <h2>❌ Error</h2>
        <div>${message}</div>
      </div>
    `;
  }
}

// Display participants from server data (replaces getMeetingParticipants)
function displayParticipantsFromServer() {
  console.log('Displaying participants from server data...');
  
  const listContainer = document.getElementById('participant-list');
  
  if (participantList.length === 0) {
    listContainer.innerHTML = `
      <div class="loading">
        <h2>Waiting for Participants...</h2>
        <p>No participants connected yet.</p>
      </div>
    `;
    return;
  }
  
  // Create the main interface
  listContainer.innerHTML = `
    <h2>Meeting Participants (${participantList.length})</h2>
    <div id="connection-status" class="status-connected">Connected to Meeting Room</div>
    
    <div class="score-section">
      <div class="score-input-container">
        <label for="score-input">New Score:</label>
        <input type="number" id="score-input" placeholder="0" step="0.1">
        <button onclick="sendScoreFromInput()" class="btn">Share</button>
      </div>
      <div id="score-feedback" style="margin: 10px 0; min-height: 20px;"></div>
    </div>
    
    <div id="participants-container"></div>
  `;
  
  // Add participants to the container
  const participantsContainer = document.getElementById('participants-container');
  participantList.forEach(function(participant) {
    const div = document.createElement('div');
    div.className = 'participant-item';
    div.setAttribute('data-user-id', participant.userId);
    
    const isCurrentUser = (participant.userId === currentUserId);
    
    console.log(`Adding participant: ${participant.userName}, ID: ${participant.userId}, Current User: ${isCurrentUser}`);
    
    div.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <strong>${participant.userName || 'Unknown'}</strong> ${isCurrentUser ? '(You)' : ''}
        </div>
        <div class="participant-score">
          <span class="no-score-yet" style="color: #999;">No score</span>
        </div>
      </div>
    `;
    participantsContainer.appendChild(div);
  });
  
  // Apply existing scores to the participant list
  participantScores.forEach((scoreData, userId) => {
    updateParticipantScore(userId, scoreData);
  });
  
  // Focus the score input
  const scoreInput = document.getElementById('score-input');
  if (scoreInput) {
    scoreInput.focus();
  }
  
  console.log(`Displayed ${participantList.length} participants with ${participantScores.size} scores`);
}

// Debug function to help troubleshoot
function debugParticipantIds() {
  console.log('DEBUG: Current user info:');
  console.log('- currentUserId:', currentUserId);
  console.log('- currentUserName:', currentUserName);
  console.log('- currentMeetingId:', currentMeetingId);
  
  console.log('DEBUG: Participant list from server:');
  participantList.forEach(p => {
    console.log(`- ${p.userName} (ID: ${p.userId})`);
  });
  
  console.log('DEBUG: Participant scores:');
  participantScores.forEach((score, userId) => {
    console.log(`- ${userId}: ${score.userName} = ${score.score}`);
  });
  
  // Show in UI as well
  const feedback = document.getElementById('score-feedback');
  if (feedback) {
    feedback.innerHTML = `
      <div style="background: #f0f8ff; padding: 10px; border: 1px solid #0078d4; border-radius: 5px; font-size: 0.8em;">
        <strong>Debug Info:</strong><br>
        Your ID: ${currentUserId}<br>
        Meeting ID: ${currentMeetingId}<br>
        Participants: ${participantList.length}<br>
        Scores: ${participantScores.size}<br>
        Connected: ${isConnectedToRoom ? 'Yes' : 'No'}<br>
        Check console for details
      </div>
    `;
    setTimeout(() => feedback.innerHTML = '', 5000);
  }
}

// Initialize the app with getUserContext instead of getMeetingParticipants
function initApp() {
  console.log('🚀 Initializing Zoom App...');
  
  // Check if SDK is available
  if (!window.zoomSdk) {
    console.error('❌ Zoom SDK not found');
    displayError('Zoom SDK Not Found. Make sure appssdk.zoom.us is in your domain allowlist.');
    return;
  }
  
  console.log('✅ Zoom SDK found, configuring...');
  
  // Configure SDK with minimal options - removed getMeetingParticipants
  window.zoomSdk.config({
    version: "0.16",
    capabilities: [
      'getRunningContext',
      'getMeetingContext',
      'getUserContext',
      'getMeetingUUID',
      'showNotification'
    ]
  })
  .then(function(configResponse) {
    console.log('✅ SDK configured:', configResponse);
    isConfigured = true;
    
    // Get running context
    return window.zoomSdk.getRunningContext();
  })
  .then(function(contextResponse) {
    console.log('📍 Running context:', contextResponse);
    
    if (contextResponse && contextResponse.context === 'inMeeting') {
      console.log('👥 In meeting, getting meeting info...');
      
      // Get meeting UUID and user context
      return Promise.all([
        window.zoomSdk.getMeetingUUID(),
        window.zoomSdk.getUserContext()
      ]);
    } else {
      const container = document.getElementById('participant-list');
      container.innerHTML = `
        <div class="error">
          <h2>📵 Not in Meeting</h2>
          <p>This app must be opened during a Zoom meeting.</p>
          <p><strong>Current context:</strong> ${contextResponse ? contextResponse.context : 'unknown'}</p>
        </div>
      `;
      throw new Error('Not in meeting');
    }
  })
  .then(function([meetingResponse, userResponse]) {
    console.log('🆔 Meeting UUID:', meetingResponse);
    console.log('👤 User context:', userResponse);
    
    // Store meeting and user info
    currentMeetingId = meetingResponse.meetingUUID;
    currentUserId = userResponse.participantUUID || userResponse.participantId || userResponse.userUUID || 'unknown';
    currentUserName = userResponse.screenName || 'Unknown User';
    
    console.log(`📝 Stored info - Meeting: ${currentMeetingId}, User: ${currentUserId} (${currentUserName})`);
    
    // Show loading state while connecting to WebSocket
    const container = document.getElementById('participant-list');
    container.innerHTML = `
      <div class="loading">
        <h2>🔌 Connecting to Session...</h2>
        <p>Initializing participant sharing system...</p>
        <div id="connection-status" class="status-connecting">Connecting to WebSocket...</div>
      </div>
    `;
    
    // Initialize WebSocket connection
    initializeWebSocket();
  })
  .catch(function(error) {
    console.error('❌ Initialization failed:', error);
    
    if (error.message === 'Not in meeting') {
      return; // Already handled above
    }
    
    displayError(`
      <strong>Initialization Failed:</strong> ${error.message}
      <br><br>
      <strong>Make sure you have:</strong>
      <ul style="text-align: left; margin: 15px 0;">
        <li>Added appssdk.zoom.us to domain allowlist</li>
        <li>Added required APIs in Zoom Marketplace</li>
        <li>Opened this app from within a Zoom meeting</li>
      </ul>
    `);
  });
}

// Wait for page to load, then initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}