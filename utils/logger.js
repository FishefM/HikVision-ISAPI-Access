// utils/logger.js
let sseClients = [];

/**
 * Logs events to console and broadcasts them to SSE dashboard clients.
 */
function logEvent(type, message) {
  const timestamp = new Date().toLocaleTimeString();
  const dateStr = new Date().toISOString().split('T')[0];
  const logObj = { type, message, timestamp: `${dateStr} ${timestamp}` };
  
  const prefix = {
    info: '\x1b[36m[INFO]\x1b[0m',     // Cyan
    success: '\x1b[32m[SUCCESS]\x1b[0m', // Green
    warning: '\x1b[33m[WARNING]\x1b[0m', // Yellow
    error: '\x1b[31m[ERROR]\x1b[0m'     // Red
  }[type] || '[LOG]';

  console.log(`${prefix} ${message}`);

  const data = JSON.stringify(logObj);
  sseClients.forEach(client => {
    client.write(`data: ${data}\n\n`);
  });
}

/**
 * Broadcasts a visual access feedback event to the dedicated feedback screens.
 */
function broadcastFeedback(authorized, name, userId, reason, deviceId = null, deviceName = null) {
  const feedbackObj = {
    type: 'access_feedback',
    status: authorized ? 'authorized' : 'denied',
    authorized,
    name,
    userId,
    reason,
    deviceId,
    deviceName,
    timestamp: new Date().toISOString()
  };
  const data = JSON.stringify(feedbackObj);
  sseClients.forEach(client => {
    client.write(`data: ${data}\n\n`);
  });
}

/**
 * Broadcasts a pending/verifying state to the dedicated feedback screens
 * when the credential has been read and user identified, waiting for external API.
 */
function broadcastVerifying(name, userId, eventType, deviceId = null, deviceName = null) {
  const verifyingObj = {
    type: 'access_feedback',
    status: 'verifying',
    name,
    userId,
    eventType,
    deviceId,
    deviceName,
    timestamp: new Date().toISOString()
  };
  const data = JSON.stringify(verifyingObj);
  sseClients.forEach(client => {
    client.write(`data: ${data}\n\n`);
  });
}

module.exports = {
  logEvent,
  broadcastFeedback,
  broadcastVerifying,
  sseClients
};

