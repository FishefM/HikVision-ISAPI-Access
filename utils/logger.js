// utils/logger.js
let sseClients = [];

/**
 * Determina si un cliente SSE filtrado debe recibir un evento según ID o Nombre del torniquete.
 */
function isClientEligibleForDevice(client, eventDeviceId, eventDeviceName) {
  if (!client.targetDeviceId || client.targetDeviceId === 'all') {
    return true;
  }

  const target = String(client.targetDeviceId).trim().toLowerCase();
  const targetName = client.targetDeviceName ? String(client.targetDeviceName).trim().toLowerCase() : '';
  const eventDevId = (eventDeviceId !== null && eventDeviceId !== undefined) ? String(eventDeviceId).trim().toLowerCase() : '';
  const eventDevName = eventDeviceName ? String(eventDeviceName).trim().toLowerCase() : '';

  // Si el evento no tiene ni ID ni Nombre, no puede adjudicarse a un torniquete específico
  if (!eventDevId && !eventDevName) {
    return false;
  }

  // Coincidencia exacta por ID numérico o de cadena
  if (eventDevId) {
    if (target === eventDevId || target.replace(/\s+/g, '') === eventDevId.replace(/\s+/g, '')) {
      return true;
    }
  }

  // Coincidencia por Nombre del torniquete (insensible a mayúsculas/minúsculas y espacios)
  if (eventDevName) {
    if (target === eventDevName || target.replace(/\s+/g, '') === eventDevName.replace(/\s+/g, '')) {
      return true;
    }
    if (targetName && (targetName === eventDevName || targetName.replace(/\s+/g, '') === eventDevName.replace(/\s+/g, ''))) {
      return true;
    }
  }

  return false;
}

/**
 * Logs events to console and broadcasts them to SSE dashboard clients.
 */
function logEvent(type, message, deviceId = null, deviceName = null) {
  const timestamp = new Date().toLocaleTimeString();
  const dateStr = new Date().toISOString().split('T')[0];
  const logObj = { type, message, deviceId, deviceName, timestamp: `${dateStr} ${timestamp}` };
  
  const prefix = {
    info: '\x1b[36m[INFO]\x1b[0m',     // Cyan
    success: '\x1b[32m[SUCCESS]\x1b[0m', // Green
    warning: '\x1b[33m[WARNING]\x1b[0m', // Yellow
    error: '\x1b[31m[ERROR]\x1b[0m'     // Red
  }[type] || '[LOG]';

  console.log(`${prefix} ${message}`);

  const data = JSON.stringify(logObj);
  sseClients.forEach(client => {
    // Si el cliente está suscrito a un torniquete específico, filtrar estrictamente
    if (client.targetDeviceId && client.targetDeviceId !== 'all') {
      if (!isClientEligibleForDevice(client, deviceId, deviceName)) {
        return;
      }
    }
    try {
      client.write(`data: ${data}\n\n`);
    } catch (_) {}
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
    // Filtrar estrictamente si el cliente está escuchando un torniquete específico
    if (!isClientEligibleForDevice(client, deviceId, deviceName)) {
      return;
    }
    try {
      client.write(`data: ${data}\n\n`);
    } catch (_) {}
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
    // Filtrar estrictamente si el cliente está escuchando un torniquete específico
    if (!isClientEligibleForDevice(client, deviceId, deviceName)) {
      return;
    }
    try {
      client.write(`data: ${data}\n\n`);
    } catch (_) {}
  });
}

module.exports = {
  logEvent,
  broadcastFeedback,
  broadcastVerifying,
  isClientEligibleForDevice,
  sseClients
};
