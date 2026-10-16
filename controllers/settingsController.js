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
    if (!password || !String(password).trim()) {
      return res.status(400).json({ error: 'La contraseña ISAPI del dispositivo MinMoe es obligatoria para nuevos registros.' });
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
      password: String(password).trim(),
      door_channel: parseInt(door_channel || 1, 10),
      enable_api_open: enable_api_open !== false && enable_api_open !== 'false',
      is_default: Boolean(is_default)
    });

    // Sincronizar con la tabla histórica settings si es el único o principal
    const allDevices = await dbHelper.getDevices().catch(() => []);
    if (is_default || allDevices.length <= 1) {
      await dbHelper.updateSettings({
        device_ip: cleanIp,
        device_port: parseInt(port || 80, 10),
        device_username: String(username || 'admin').trim(),
        device_password: String(password).trim()
      }).catch(err => console.warn('[Settings] Error sincronizando credenciales a settings:', err.message));
    }

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

    // Sincronizar con la tabla histórica settings si es el dispositivo principal o el único
    const allDevices = await dbHelper.getDevices().catch(() => []);
    const isDefaultOrOnly = Boolean(existing.is_default || data.is_default || allDevices.length <= 1);
    if (isDefaultOrOnly) {
      const settingsUpdate = {};
      if (data.ip) settingsUpdate.device_ip = String(data.ip).trim();
      if (data.port) settingsUpdate.device_port = parseInt(data.port, 10);
      if (data.username) settingsUpdate.device_username = String(data.username).trim();
      if (data.password) settingsUpdate.device_password = String(data.password).trim();
      if (Object.keys(settingsUpdate).length > 0) {
        await dbHelper.updateSettings(settingsUpdate).catch(err => console.warn('[Settings] Error sincronizando credenciales a settings:', err.message));
      }
    }

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
 * Prueba de conexión ISAPI segura con un dispositivo específico o credenciales temporales
 * (Sin abrir la puerta física accidentalmente)
 */
async function testDevicePing(req, res) {
  try {
    const deviceId = req.params.id || req.body.deviceId;
    let ip = req.body.ip;
    let port = req.body.port;
    let username = req.body.username;
    let password = req.body.password;
    let name = req.body.name || 'MinMoe';

    if (deviceId) {
      const dev = await dbHelper.getDeviceById(deviceId);
      if (dev) {
        ip = ip || dev.ip;
        port = port || dev.port;
        username = username || dev.username;
        if (!password || password === '••••••••') {
          password = dev.password;
        }
        name = dev.name;
      }
    } else if (!ip) {
      const defaultDev = await dbHelper.getDefaultDevice();
      if (defaultDev) {
        ip = defaultDev.ip;
        port = defaultDev.port;
        username = defaultDev.username;
        password = defaultDev.password;
        name = defaultDev.name;
      }
    }

    if (!ip) {
      return res.status(400).json({ error: 'Dirección IP requerida para prueba de conexión.' });
    }

    logEvent('info', `[Ping Test] Probando comunicación ISAPI con "${name}" (${ip}:${port || 80})...`);
    
    const testResult = await deviceHelper.checkDeviceConnection(
      ip,
      parseInt(port || 80, 10),
      username || 'admin',
      password || ''
    );

    res.json({
      success: testResult.success,
      device: { name, ip, port: port || 80 },
      message: testResult.success 
        ? `Conexión exitosa con ${name} (${ip}). Dispositivo responde correctamente.` 
        : `Fallo al comunicar con ${name} (${ip}): ${testResult.error || 'Credenciales no autorizadas o equipo inalcanzable'}`
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

/**
 * Retorna las estadísticas agregadas reales de accesos
 */
async function getAccessStats(req, res) {
  try {
    const deviceId = req.query.deviceId;
    const stats = await dbHelper.getAccessStats(deviceId);
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Retorna la lista de archivos mensuales de logs generados en disco
 */
async function getLogArchives(req, res) {
  try {
    const archives = dbHelper.getLogArchives();
    res.json(archives);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Descarga un archivo CSV de logs mensual específico
 */
async function downloadLogArchive(req, res) {
  try {
    const filename = req.params.filename;
    const filePath = dbHelper.getLogArchiveFilePath(filename);
    if (!filePath) {
      return res.status(404).json({ error: 'Archivo de log no encontrado.' });
    }
    res.download(filePath, filename);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Ejecuta manualmente el archivado de logs antiguos a CSV
 */
async function triggerLogArchive(req, res) {
  try {
    const days = parseInt(req.body?.days || 30, 10);
    const count = await dbHelper.cleanOldLogs(days);
    logEvent('info', `Archivado manual de logs ejecutado: ${count} registros exportados a CSV y depurados de la BD.`);
    res.json({ success: true, archived: count });
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
  getLogs,
  getAccessStats,
  getLogArchives,
  downloadLogArchive,
  triggerLogArchive
};
