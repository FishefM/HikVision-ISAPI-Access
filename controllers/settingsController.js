const dbHelper = require('../config/database');
const deviceHelper = require('../utils/device');
const { logEvent, broadcastFeedback } = require('../utils/logger');
const { hashPassword } = require('../utils/security');

// ==========================================================================
// CRUD DISPOSITIVOS (MinMoe)
// ==========================================================================

/**
 * Obtiene lista de dispositivos registrados (contraseñas enmascaradas)
 */
async function getDevices(req, res) {
  try {
    const devices = await dbHelper.getDevices();
    const sanitized = devices.map(d => ({
      ...d,
      has_password: Boolean(d.password && d.password.trim() !== ''),
      password: d.password ? '••••••••' : ''
    }));
    res.json(sanitized);
  } catch (e) {
    logEvent('error', `Error al consultar dispositivos: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}

/**
 * Obtiene un dispositivo específico
 */
async function getDevice(req, res) {
  try {
    const device = await dbHelper.getDeviceById(req.params.id);
    if (!device) {
      return res.status(404).json({ error: 'Dispositivo no encontrado.' });
    }
    const sanitized = {
      ...device,
      has_password: Boolean(device.password && device.password.trim() !== ''),
      password: ''
    };
    res.json(sanitized);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Agrega un nuevo dispositivo MinMoe
 */
async function addDevice(req, res) {
  try {
    const { name, ip, port, username, password, door_channel, enable_api_open, is_default } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'El nombre o ubicación del torniquete es obligatorio.' });
    }
    if (!ip || !String(ip).trim()) {
      return res.status(400).json({ error: 'La dirección IP del MinMoe es obligatoria.' });
    }

    const cleanIp = String(ip).trim();
    const existing = await dbHelper.getDeviceByIp(cleanIp);
    if (existing) {
      return res.status(400).json({ error: `Ya existe un dispositivo registrado con la IP ${cleanIp}.` });
    }

    const newDevice = await dbHelper.addDevice({
      name: String(name).trim(),
      ip: cleanIp,
      port: parseInt(port || 80, 10),
      username: String(username || 'admin').trim(),
      password: String(password || '').trim(),
      door_channel: parseInt(door_channel || 1, 10),
      enable_api_open: enable_api_open !== false && enable_api_open !== 'false',
      is_default: Boolean(is_default)
    });

    logEvent('success', `[MinMoe] Nuevo dispositivo registrado: "${name}" (${cleanIp}).`);
    res.json({ success: true, device: newDevice });
  } catch (e) {
    logEvent('error', `Error al registrar dispositivo: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}

/**
 * Actualiza un dispositivo MinMoe existente
 */
async function updateDevice(req, res) {
  try {
    const id = req.params.id;
    const existing = await dbHelper.getDeviceById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Dispositivo no encontrado.' });
    }

    const data = { ...req.body };
    if (!data.password || String(data.password).trim() === '' || data.password === '••••••••') {
      delete data.password;
    }

    await dbHelper.updateDevice(id, data);
    logEvent('info', `[MinMoe] Dispositivo "${existing.name}" (ID ${id}) actualizado.`);
    res.json({ success: true });
  } catch (e) {
    logEvent('error', `Error al actualizar dispositivo: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}

/**
 * Elimina un dispositivo MinMoe
 */
async function deleteDevice(req, res) {
  try {
    const id = req.params.id;
    const existing = await dbHelper.getDeviceById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Dispositivo no encontrado.' });
    }

    await dbHelper.deleteDevice(id);
    logEvent('warning', `[MinMoe] Dispositivo "${existing.name}" (${existing.ip}) eliminado.`);
    res.json({ success: true });
  } catch (e) {
    logEvent('error', `Error al eliminar dispositivo: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}

/**
 * Prueba de conexión ISAPI con un dispositivo específico
 */
async function testDevicePing(req, res) {
  try {
    const deviceId = req.params.id || req.body.deviceId;
    let device = null;
    if (deviceId) {
      device = await dbHelper.getDeviceById(deviceId);
    } else {
      device = await dbHelper.getDefaultDevice();
    }

    if (!device) {
      return res.status(404).json({ error: 'Dispositivo no encontrado para prueba de conexión.' });
    }

    logEvent('info', `Probando conexión ISAPI con ${device.name} (${device.ip}:${device.port})...`);
    
    // Probar obtención del estado de la puerta o device info
    const testResult = await deviceHelper.openDoor(
      device.ip,
      device.port,
      device.username,
      device.password,
      device.door_channel || 1
    );

    res.json({
      success: testResult.success,
      device: { id: device.id, name: device.name, ip: device.ip },
      message: testResult.success ? `Conexión exitosa con ${device.name}.` : `Fallo al comunicar con ${device.name}: ${testResult.error || 'Sin respuesta'}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Trigger para apertura manual desde el dashboard (admite deviceId)
 */
async function openDoor(req, res) {
  try {
    const targetDeviceId = req.params.id || req.body.deviceId;
    let device = null;

    if (targetDeviceId) {
      device = await dbHelper.getDeviceById(targetDeviceId);
    } else {
      device = await dbHelper.getDefaultDevice();
    }

    if (!device) {
      return res.status(404).json({ error: 'No hay ningún torniquete configurado para abrir.' });
    }
    
    logEvent('info', `Enviando comando manual de apertura a "${device.name}" (${device.ip}:${device.port})...`);
    
    const result = await deviceHelper.openDoor(
      device.ip,
      device.port,
      device.username,
      device.password,
      device.door_channel || 1
    );

    if (result.success) {
      logEvent('success', `Puerta abierta exitosamente en "${device.name}".`);
      await dbHelper.addLog(
        'REMOTO',
        'Comando Dashboard',
        'remote_open',
        `http://${device.ip}:${device.port}/ISAPI/AccessControl/RemoteControl/door/`,
        result.data,
        true,
        true,
        device.id,
        device.name,
        device.ip
      );
      broadcastFeedback(true, 'Apertura Remota', 'REMOTO', 'Apertura manual autorizada', device.id, device.name);
      res.json({ success: true, deviceName: device.name });
    } else {
      logEvent('error', `Fallo al abrir puerta en "${device.name}": ${result.error || 'Código estado ' + result.status}`);
      res.status(500).json({ error: result.error || `Error del lector "${device.name}". Estado: ${result.status}` });
    }
  } catch (e) {
    logEvent('error', `Excepción al enviar comando de apertura: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}

/**
 * Obtiene configuraciones globales sanitizadas
 */
async function getSettings(req, res) {
  try {
    const settings = await dbHelper.getSettings();
    const sanitized = { ...settings };
    delete sanitized.device_password;
    delete sanitized.admin_password;
    res.json(sanitized);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Actualiza configuraciones globales (contraseña admin, etc.)
 */
async function updateSettings(req, res) {
  try {
    const data = { ...req.body };

    if (data.admin_password && String(data.admin_password).trim() !== '') {
      data.admin_password = hashPassword(String(data.admin_password).trim());
    } else {
      delete data.admin_password;
    }

    await dbHelper.updateSettings(data);
    logEvent('info', 'Configuración administrativa actualizada.');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Vaciar historial de logs (soporta filtrar por deviceId)
 */
async function clearLogs(req, res) {
  try {
    const deviceId = req.query.deviceId || (req.body && req.body.deviceId);
    await dbHelper.clearLogs(deviceId);
    logEvent('info', `Historial de accesos vaciado ${deviceId ? `para el torniquete ID ${deviceId}` : 'completamente'}.`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Retorna los registros de logs de la BD con soporte para filtro por deviceId
 */
async function getLogs(req, res) {
  try {
    const deviceId = req.query.deviceId;
    const limit = req.query.limit;
    const logs = await dbHelper.getLogs({ deviceId, limit });
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  getDevices,
  getDevice,
  addDevice,
  updateDevice,
  deleteDevice,
  testDevicePing,
  openDoor,
  getSettings,
  updateSettings,
  clearLogs,
  getLogs
};
