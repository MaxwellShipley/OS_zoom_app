// Simple, robust initialization without complex state management
let isConfigured = false;

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
        listContainer.innerHTML = '<h2>No participants found</h2>';
        return;
      }
      
      const participants = result.participants;
      listContainer.innerHTML = '<h2>Meeting Participants (' + participants.length + '):</h2>';
      
      participants.forEach(function(p) {
        const div = document.createElement('div');
        div.style.cssText = 'border: 1px solid #ccc; padding: 10px; margin: 5px 0; border-radius: 5px;';
        div.innerHTML = 
          '<strong>Name:</strong> ' + (p.screenName || 'Unknown') + '<br>' +
          '<strong>ID:</strong> ' + (p.participantId || 'N/A') + '<br>'
        listContainer.appendChild(div);
      });
      
      // Add refresh button
      const refreshBtn = document.createElement('button');
      refreshBtn.textContent = 'Refresh';
      refreshBtn.style.cssText = 'margin: 10px; padding: 10px 20px; background: #0078d4; color: white; border: none; border-radius: 5px; cursor: pointer;';
      refreshBtn.onclick = displayParticipants;
      listContainer.appendChild(refreshBtn);
      
      console.log('✅ Displayed ' + participants.length + ' participants');
    })
    .catch(function(error) {
      console.error('❌ Error getting participants:', error);
      document.getElementById('participant-list').innerHTML = 
        '<h2>Error loading participants</h2><p>' + error.message + '</p>';
    });
}

// Initialize the app with basic error handling
function initApp() {
  console.log('🚀 Initializing Zoom App...');
  
  // Check if SDK is available
  if (!window.zoomSdk) {
    console.error('❌ Zoom SDK not found');
    document.getElementById('participant-list').innerHTML = 
      '<h2>Zoom SDK Not Found</h2><p>Make sure appssdk.zoom.us is in your domain allowlist.</p>';
    return;
  }
  
  console.log('✅ Zoom SDK found, configuring...');
  
  // Configure SDK with minimal options
  window.zoomSdk.config({
    version: "0.16",
    capabilities: [
      'getMeetingParticipants',
      'getRunningContext'
    ]
  })
  .then(function(configResponse) {
    console.log('✅ SDK configured:', configResponse);
    isConfigured = true;
    
    // Now get running context
    return window.zoomSdk.getRunningContext();
  })
  .then(function(contextResponse) {
    console.log('📍 Running context:', contextResponse);
    
    if (contextResponse && contextResponse.context === 'inMeeting') {
      console.log('👥 In meeting, getting participants...');
      displayParticipants();
    } else {
      document.getElementById('participant-list').innerHTML = 
        '<h2>Not in Meeting</h2>' +
        '<p>This app must be opened during a Zoom meeting.</p>' +
        '<p>Current context: ' + (contextResponse ? contextResponse.context : 'unknown') + '</p>';
    }
  })
  .catch(function(error) {
    console.error('❌ Initialization failed:', error);
    document.getElementById('participant-list').innerHTML = 
      '<h2>Initialization Failed</h2>' +
      '<p>Error: ' + error.message + '</p>' +
      '<p>Make sure you have:</p>' +
      '<ul>' +
      '<li>Added appssdk.zoom.us to domain allowlist</li>' +
      '<li>Added getMeetingParticipants API in Marketplace</li>' +
      '<li>Opened this app from within a Zoom meeting</li>' +
      '</ul>';
  });
}

// Wait for page to load, then initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}