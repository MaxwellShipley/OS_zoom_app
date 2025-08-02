// Simple, robust initialization without complex state management
let isConfigured = false;
let socket = null;
let currentMeetingId = null;
let currentUserId = null;
let currentUserName = null;
let isConnectedToRoom = false;

// Store participant scores
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
  
  // Handle score updates from other participants
  socket.on('score_received', function(scoreData) {
    console.log('📊 Received score update:', scoreData);
    // Update the participant scores map
    participantScores.set(scoreData.userId, scoreData);
    // Update the display
    updateParticipantScore(scoreData.userId, scoreData);
    displayScoreUpdate(scoreData);
  });
  
  // Handle score history when joining
  socket.on('score_history', function(data) {
    console.log('📚 Received score history:', data.scores.length, 'scores');
    displayScoreHistory(data.scores);
  });
  
  // Handle participant events
  socket.on('participant_joined', function(data) {
    console.log('👤 Participant joined:', data.userName);
    showNotification(`${data.userName} joined the session`);
    // Automatically refresh the participant list
    refreshParticipantList();
  });
  
  socket.on('participant_left', function(data) {
    console.log('👋 Participant left:', data.userName);
    showNotification(`${data.userName} left the session`);
    // Automatically refresh the participant list
    refreshParticipantList();
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
  
  // Also display in the score feed
  displayScoreUpdate(scoreData, true);
  
  // Show success feedback
  showNotification(`Your score (${score}) has been shared!`);
}

function displayScoreUpdate(scoreData, isLocal = false) {
  // Only update the participant list, no separate scores feed
  console.log('📊 Score update - updating participant list only');
}

function displayScoreHistory(scores) {
  // Clear existing scores and rebuild the map
  participantScores.clear();
  
  // Store the latest score for each participant
  scores.forEach(score => {
    const existingScore = participantScores.get(score.userId);
    if (!existingScore || new Date(score.timestamp) > new Date(existingScore.timestamp)) {
      participantScores.set(score.userId, score);
    }
  });
  
  // Refresh the participant display to show all scores
  refreshParticipantScores();
  
  console.log(`📚 Loaded ${participantScores.size} participant scores from history`);
}

function updateParticipantScore(userId, scoreData) {
  console.log(`🎯 Updating participant score for ${userId}:`, scoreData);
  
  const participantElement = document.querySelector(`[data-user-id="${userId}"]`);
  if (participantElement) {
    const scoreElement = participantElement.querySelector('.participant-score');
    if (scoreElement) {
      const timestamp = new Date(scoreData.timestamp).toLocaleTimeString();
      const isCurrentUser = userId === currentUserId;
      
      scoreElement.innerHTML = `
        <div class="score-display ${isCurrentUser ? 'current-user-score' : ''}">
          <strong>Latest Score: ${scoreData.score}</strong>
          <div style="font-size: 0.8em; color: #666;">Updated: ${timestamp}</div>
        </div>
      `;
      
      // Add a brief highlight animation
      scoreElement.style.animation = 'scoreUpdate 1s ease-out';
      setTimeout(() => {
        scoreElement.style.animation = '';
      }, 1000);
      
      console.log(`✅ Updated score display for ${scoreData.userName}`);
    } else {
      console.log('⚠️ Score element not found for participant');
    }
  } else {
    console.log(`⚠️ Participant element not found for userId: ${userId}`);
    // Try to find by alternative ID matching
    const allParticipants = document.querySelectorAll('.participant-item');
    console.log(`🔍 Available participants:`, Array.from(allParticipants).map(p => p.getAttribute('data-user-id')));
  }
}

function refreshParticipantScores() {
  console.log('🔄 Refreshing all participant scores...');
  // Update all participants with their latest scores
  participantScores.forEach((scoreData, userId) => {
    updateParticipantScore(userId, scoreData);
  });
}

// New function to refresh just the participant list without reinitializing everything
function refreshParticipantList() {
  if (!isConfigured) {
    console.log('⚠️ Cannot refresh - SDK not configured');
    return;
  }
  
  console.log('🔄 Refreshing participant list...');
  
  window.zoomSdk.getMeetingParticipants()
    .then(function(result) {
      if (!result || !result.participants) {
        console.log('⚠️ No participants found during refresh');
        return;
      }
      
      const participants = result.participants;
      const participantsContainer = document.getElementById('participants-container');
      
      if (!participantsContainer) {
        console.log('⚠️ Participants container not found, doing full refresh');
        displayParticipants();
        return;
      }
      
      // Update the participant count in the header
      const header = document.querySelector('h2');
      if (header) {
        header.textContent = `Meeting Participants & Scores (${participants.length})`;
      }
      
      // Clear and rebuild the participants container
      participantsContainer.innerHTML = '';
      
      participants.forEach(function(p) {
        const div = document.createElement('div');
        div.className = 'participant-item';
        
        // Use the actual participant ID from the participant list
        const participantId = p.participantId || p.participantUUID || p.userUUID || 'unknown';
        div.setAttribute('data-user-id', participantId);
        
        const isCurrentUser = (p.screenName === currentUserName);
        
        div.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong>${p.screenName || 'Unknown'}</strong> ${isCurrentUser ? '(You)' : ''}
              <br>
              <small style="color: #666;">ID: ${participantId}</small>
            </div>
            <div class="participant-score">
              <div class="no-score-yet" style="color: #999; font-style: italic;">
                No score yet
              </div>
            </div>
          </div>
        `;
        participantsContainer.appendChild(div);
      });
      
      // Reapply existing scores to the refreshed participant list
      refreshParticipantScores();
      
      console.log(`✅ Refreshed participant list with ${participants.length} participants`);
    })
    .catch(function(error) {
      console.error('❌ Error refreshing participants:', error);
    });
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
  console.log('📢 ' + message);
  
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

// Basic participant display function
function displayParticipants() {
  if (!isConfigured) {
    console.error('❌ SDK not configured yet');
    return;
  }
  
  window.zoomSdk.getMeetingParticipants()
    .then(function(result) {
      console.log('📊 Participant data:', result);
      const listContainer = document.getElementById('participant-list');
      
      if (!result || !result.participants) {
        listContainer.innerHTML = '<div class="error">No participants found</div>';
        return;
      }
      
      const participants = result.participants;
      
      // Find current user by matching screen name
      const currentUserParticipant = participants.find(p => p.screenName === currentUserName);
      if (currentUserParticipant) {
        currentUserId = currentUserParticipant.participantId || 
                        currentUserParticipant.participantUUID || 
                        currentUserParticipant.userUUID;
        console.log(`✅ Found current user ID: ${currentUserId} for ${currentUserName}`);
      } else {
        console.warn('⚠️ Could not find current user in participant list');
        currentUserId = 'unknown';
      }
      
      // Create the main interface
      listContainer.innerHTML = `
        <h2>Meeting Participants & Scores (${participants.length})</h2>
        <div id="connection-status" class="status-connecting">Initializing...</div>
        
        <div class="score-section">
          <h3>📊 Share Your Score</h3>
          <div class="score-input-container">
            <input type="number" id="score-input" placeholder="Enter your score" step="0.1">
            <button onclick="sendScoreFromInput()" class="btn">Share Score</button>
          </div>
          <div id="score-feedback" style="margin: 10px 0; min-height: 20px;"></div>
          <p style="margin: 10px 0; color: #666; font-size: 0.9em;">
            Your score will appear next to your name below
          </p>
        </div>
        
        <h3>👥 Participants & Their Latest Scores:</h3>
        <div id="participants-container"></div>
        
        <button onclick="refreshParticipantList()" class="btn" style="margin-top: 15px;">
          🔄 Refresh Participants
        </button>
        
        <button onclick="debugParticipantIds()" class="btn" style="margin-top: 15px; margin-left: 10px; background: #666;">
          🔍 Debug IDs
        </button>
      `;
      
      // Add participants to the container
      const participantsContainer = document.getElementById('participants-container');
      participants.forEach(function(p) {
        const div = document.createElement('div');
        div.className = 'participant-item';
        
        // Use the actual participant ID from the participant list
        const participantId = p.participantId || p.participantUUID || p.userUUID || 'unknown';
        div.setAttribute('data-user-id', participantId);
        
        const isCurrentUser = (p.screenName === currentUserName);
        
        console.log(`👤 Adding participant: ${p.screenName}, ID: ${participantId}, Current User: ${isCurrentUser}`);
        
        div.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong>${p.screenName || 'Unknown'}</strong> ${isCurrentUser ? '(You)' : ''}
              <br>
              <small style="color: #666;">ID: ${participantId}</small>
            </div>
            <div class="participant-score">
              <div class="no-score-yet" style="color: #999; font-style: italic;">
                No score yet
              </div>
            </div>
          </div>
        `;
        participantsContainer.appendChild(div);
      });
      
      // Apply existing scores to the participant list
      refreshParticipantScores();
      
      // Focus the score input
      const scoreInput = document.getElementById('score-input');
      if (scoreInput) {
        scoreInput.focus();
      }
      
      console.log('✅ Displayed ' + participants.length + ' participants');
      console.log('🆔 Current user ID:', currentUserId);
      
      // Initialize WebSocket after UI is ready
      if (!socket) {
        initializeWebSocket();
      }
    })
    .catch(function(error) {
      console.error('❌ Error getting participants:', error);
      displayError('Error loading participants: ' + error.message);
    });
}

// Debug function to help troubleshoot ID matching issues
function debugParticipantIds() {
  console.log('🔍 DEBUG: Current user info:');
  console.log('- currentUserId:', currentUserId);
  console.log('- currentUserName:', currentUserName);
  
  console.log('🔍 DEBUG: Participant scores map:');
  participantScores.forEach((score, userId) => {
    console.log(`- ${userId}: ${score.userName} = ${score.score}`);
  });
  
  console.log('🔍 DEBUG: DOM participant elements:');
  const participants = document.querySelectorAll('.participant-item');
  participants.forEach(p => {
    const userId = p.getAttribute('data-user-id');
    const name = p.querySelector('strong').textContent;
    console.log(`- DOM element: ${name} (ID: ${userId})`);
  });
  
  // Show in UI as well
  const feedback = document.getElementById('score-feedback');
  if (feedback) {
    feedback.innerHTML = `
      <div style="background: #f0f8ff; padding: 10px; border: 1px solid #0078d4; border-radius: 5px; font-size: 0.8em;">
        <strong>Debug Info:</strong><br>
        Your ID: ${currentUserId}<br>
        Scores stored: ${participantScores.size}<br>
        Check console for details
      </div>
    `;
    setTimeout(() => feedback.innerHTML = '', 5000);
  }
}

// Initialize the app with basic error handling
function initApp() {
  console.log('🚀 Initializing Zoom App...');
  
  // Check if SDK is available
  if (!window.zoomSdk) {
    console.error('❌ Zoom SDK not found');
    displayError('Zoom SDK Not Found. Make sure appssdk.zoom.us is in your domain allowlist.');
    return;
  }
  
  console.log('✅ Zoom SDK found, configuring...');
  
  // Configure SDK with minimal options
  window.zoomSdk.config({
    version: "0.16",
    capabilities: [
      'getMeetingParticipants',
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
      
      // Get meeting UUID for room identification
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
    
    // Store meeting and user info - try multiple ID fields
    currentMeetingId = meetingResponse.meetingUUID;
    currentUserId = userResponse.participantUUID || userResponse.participantId || userResponse.userUUID || 'unknown';
    currentUserName = userResponse.screenName || 'Unknown User';
    
    console.log(`📝 Stored info - Meeting: ${currentMeetingId}, User: ${currentUserId} (${currentUserName})`);
    
    // Display participants
    displayParticipants();
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