const dbHelper = require('../config/database');
const deviceHelper = require('../utils/device');
const { logEvent } = require('../utils/logger');

/**
 * Obtiene configuraciones
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
 * Update configuraciones
 */
async function updateSettings(req, res) {
  try {
    const data = { ...req.body };
    // Prevent empty password inputs from wiping out existing passwords
    if (!data.device_password || String(data.device_password).trim() === '') {
      delete data.device_password;
    }
    if (!data.admin_password || String(data.admin_password).trim() === '') {
      delete data.admin_password;
    }
    await dbHelper.updateSettings(data);
    logEvent('info', 'Configuración de dispositivo y acceso actualizada.');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Trigger Para apertura manual
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
 * Boton Eliminar Logs
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
 * Retorna los ultimos logs de la BD
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
