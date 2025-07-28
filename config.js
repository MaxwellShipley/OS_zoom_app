import 'dotenv/config';

// General App Info
export const appName = process.env.npm_package_name || 'zoom-app';
export const port = process.env.PORT || 3000;

// Zoom App Info
export const zoomApp = {
  host: 'https://zoom.us',
  clientId: process.env.ZOOM_APP_CLIENT_ID,
  clientSecret: process.env.ZOOM_APP_CLIENT_SECRET,
  redirectUrl: process.env.ZOOM_APP_REDIRECT_URL,
  
  // SDK Configuration
  sdkVersion: '0.16',
  
  // Required capabilities that match your manifest APIs
  capabilities: [
    'getMeetingParticipants',
    'getRunningContext', 
    'getMeetingContext',
    'getUserContext',
    'runRenderingContext',
    'openUrl',
    'drawWebView', 
    'getMeetingUUID',
    'postMessage',
    'onMeeting',
    'onMyUserContextChange',
    'onMessage',
    'showNotification'
  ],
  
  // Required scopes for API access
  requiredScopes: [
    'zoomapp:inmeeting',
    'meeting:read',
    'user:read'
  ],
  
  // Allowed domains for the embedded browser
  allowedDomains: [
    'appssdk.zoom.us',
    process.env.NGROK_DOMAIN || 'unduly-notable-llama.ngrok-free.app'
  ]
};

export const redirectUri = zoomApp.redirectUrl;

// Environment validation
export function validateConfig() {
  const required = ['ZOOM_APP_CLIENT_ID', 'ZOOM_APP_CLIENT_SECRET', 'ZOOM_APP_REDIRECT_URL'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  
  console.log('✅ Configuration validated successfully');
  return true;
}

// Development helpers
export const isDevelopment = process.env.NODE_ENV !== 'production';
export const isProduction = process.env.NODE_ENV === 'production';

if (isDevelopment) {
  console.log('🔧 Running in development mode');
  console.log('📍 Ngrok domain:', process.env.NGROK_DOMAIN || 'unduly-notable-llama.ngrok-free.app');
}