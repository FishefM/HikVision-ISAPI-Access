const dbHelper = require('../config/database');
const deviceHelper = require('../utils/device');
const { logEvent } = require('../utils/logger');

/**
 * Retrieves the current reader and administration settings.
 */
async function getSettings(req, res) {
  try {
    const settings = await dbHelper.getSettings();
    // Exclude security-sensitive passwords from standard get requests
    const sanitized = { ...settings };
    delete sanitized.device_password;
    delete sanitized.admin_password;
    res.json(sanitized);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Updates settings keys in the database.
 */
async function updateSettings(req, res) {
  try {
    await dbHelper.updateSettings(req.body);
    logEvent('info', 'Configuración de dispositivo y acceso actualizada.');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Triggers a manual door release command by sending an ISAPI request to the Hikvision terminal.
 */
async function openDoor(req, res) {
  try {
    const settings = await dbHelper.getSettings();
    
    logEvent('info', `Enviando comando manual de apertura de puerta a ${settings.device_ip}:${settings.device_port}...`);
    
    const result = await deviceHelper.openDoor(
      settings.device_ip,
      settings.device_port,
      settings.device_user,
      settings.device_password,
      settings.device_door_channel || 1
    );

    if (result.success) {
      logEvent('success', 'Puerta abierta exitosamente por comando remoto.');
      // Track this remote force open in database logs as authorized access
      await dbHelper.addLog(
        'REMOTO',
        'Comando Dashboard',
        'remote_open',
        `http://${settings.device_ip}:${settings.device_port}/ISAPI/AccessControl/RemoteControl/door/`,
        result.data,
        true,
        true
      );
      res.json({ success: true });
    } else {
      logEvent('error', `Fallo al abrir puerta por comando remoto: ${result.error || 'Código estado ' + result.status}`);
      res.status(500).json({ error: result.error || `Error del lector. Estado: ${result.status}` });
    }
  } catch (e) {
    logEvent('error', `Excepción al enviar comando de apertura de puerta: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}

/**
 * Clears all access logs from the database.
 */
async function clearLogs(req, res) {
  try {
    await dbHelper.clearLogs();
    logEvent('info', 'Historial de accesos vaciado por el administrador.');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Retrieves the 50 most recent access logs from the database.
 */
async function getLogs(req, res) {
  try {
    const logs = await dbHelper.getLogs();
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  getSettings,
  updateSettings,
  openDoor,
  clearLogs,
  getLogs
};
