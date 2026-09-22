const crypto = require('crypto');
const QRCode = require('qrcode');
const dbHelper = require('../config/database');
const { logEvent } = require('../utils/logger');
const deviceHelper = require('../utils/device');

//-----------------------------------
//----------CRUD Usuarios------------
//-----------------------------------

/**
 * Extrae los primeros 8 caracteres del hash contenido en la URL de la API externa
 */
function extractIdFromApiUrl(apiUrl) {
  if (!apiUrl) return null;
  try {
    const parsed = new URL(apiUrl);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length > 0) {
      const lastSegment = segments[segments.length - 1];
      if (lastSegment && /^[a-zA-Z0-9_-]{8,}$/.test(lastSegment)) {
        return lastSegment.substring(0, 8).toLowerCase();
      }
    }
  } catch (_) {
    const match = String(apiUrl).match(/([a-zA-Z0-9]{8,})/);
    if (match && match[1]) {
      return match[1].substring(0, 8).toLowerCase();
    }
  }
  return null;
}

/**
 * Determina si un registro corresponde a un usuario de pruebas o a un alumno real
 */
function isTestUser(user) {
  if (!user) return false;
  const uid = String(user.user_id || '').trim();
  const url = String(user.api_url || '').toLowerCase();
  const name = String(user.name || '').toLowerCase();
  
  return /^100\d*$/.test(uid) || 
         url.includes('mock-external-api/deny') || 
         url.includes('mock-external-api/error') || 
         name.includes('(permitido)') || 
         name.includes('(denegado)') || 
         name.includes('(error api)') ||
         name.includes('demo') ||
         name.includes('prueba');
}

/**
 * Obtiene usuarios registrados de la base de datos local SQLite,
 * con soporte para filtrar usuarios reales (producción) o de prueba,
 * y filtro opcional por ID de torniquete/dispositivo.
 */
async function getUsers(req, res) {
  try {
    const deviceId = req.query.deviceId || req.query.device_id;
    const users = await dbHelper.getUsers(null, deviceId);
    const filter = req.query.filter;
    if (filter === 'test' || filter === 'pruebas') {
      return res.json(users.filter(u => isTestUser(u)));
    } else if (filter === 'production' || filter === 'main' || filter === 'real') {
      return res.json(users.filter(u => !isTestUser(u)));
    }
    res.json(users);
  } catch (e) {
    logEvent('error', `[DB ERROR] Error al consultar lista de alumnos en SQLite: ${e.message}`);
    res.status(500).json({ error: `Error de base de datos: ${e.message}` });
  }
}

/**
 * Crea un nuevo usuario en la base de datos SQLite y sincroniza con el(los) MinMoe asignado(s).
 * Por defecto asigna a un solo torniquete (el seleccionado o default), con opción de asignar a todos.
 */
async function addUser(req, res) {
  let { user_id, name, api_url, device_ids, assign_all, device_id } = req.body;
  user_id = user_id ? String(user_id).trim() : '';
  name = name ? String(name).trim() : '';
  api_url = api_url ? String(api_url).trim() : '';

  // Asignar API URL de validación permitida (allow) por defecto si no se ingresó una
  if (!api_url) {
    api_url = 'http://localhost:3000/api/mock-external-api/allow';
  }

  // Generación o extracción automática de user_id
  if (!user_id) {
    user_id = extractIdFromApiUrl(api_url);
    if (!user_id) {
      user_id = crypto.randomBytes(4).toString('hex');
    }
    logEvent('info', `[ID AUTOMÁTICO] ID generado/extraído para "${name}": "${user_id}"`);
  }

  if (!name) {
    logEvent('warning', '[REGISTRO] Solicitud rechazada: Falta el campo obligatorio Nombre.');
    return res.status(400).json({ error: 'Falta el campo obligatorio Nombre del alumno.' });
  }

  // Determinar dispositivos asignados (por defecto solo 1 torniquete, opcionalmente todos)
  let targetDeviceIds = [];
  const allDevices = await dbHelper.getDevices();

  if (assign_all === true || assign_all === 'true') {
    targetDeviceIds = allDevices.map(d => d.id);
  } else if (device_ids && Array.isArray(device_ids) && device_ids.length > 0) {
    targetDeviceIds = device_ids.map(Number).filter(Boolean);
  } else if (device_id) {
    targetDeviceIds = [Number(device_id)];
  } else {
    // Por defecto habitual: asignar al torniquete predeterminado (solo 1 dispositivo)
    const defaultDev = await dbHelper.getDefaultDevice();
    if (defaultDev) {
      targetDeviceIds = [defaultDev.id];
    } else if (allDevices.length > 0) {
      targetDeviceIds = [allDevices[0].id];
    }
  }

  logEvent('info', `[DB] Intentando registrar alumno en SQLite: ID "${user_id}", Nombre: "${name}", Torniquetes asignados: [${targetDeviceIds.join(', ')}]...`);

  let user = null;
  // Paso 1: Inserción en la base de datos local SQLite
  try {
    user = await dbHelper.addUser(user_id, name, api_url, targetDeviceIds);
    logEvent('success', `[DB OK] Alumno guardado exitosamente en SQLite local (Registro ID: ${user.id}, User ID: "${user_id}").`);
  } catch (dbErr) {
    if (dbErr.message && dbErr.message.includes('UNIQUE')) {
      const msg = `El ID de usuario "${user_id}" ya está registrado en la base de datos local (Conflicto de clave única SQLite).`;
      logEvent('error', `[DB ERROR] ${msg}`);
      return res.status(400).json({
        error: msg,
        dbError: dbErr.message,
        code: 'SQLITE_UNIQUE_CONSTRAINT'
      });
    } else {
      const msg = `Error al insertar en la base de datos SQLite: ${dbErr.message}`;
      logEvent('error', `[DB ERROR] ${msg}`);
      return res.status(500).json({
        error: msg,
        dbError: dbErr.message
      });
    }
  }

  // Paso 2: Sincronización con el hardware Hikvision MinMoe de cada torniquete asignado
  let deviceSyncResult = { synced: false, userSuccess: false, cardSuccess: false, diagnostics: [], summary: '' };
  const targetDevices = allDevices.filter(d => targetDeviceIds.includes(d.id));

  if (targetDevices.length > 0) {
    let syncedDevicesCount = 0;
    for (const dev of targetDevices) {
      if (dev.ip && dev.username && dev.password) {
        logEvent('info', `[MinMoe - ${dev.name}] Iniciando sincronización de "${name}" (${user_id}) en ${dev.ip}:${dev.port || 80}...`);
        
        const syncRes = await deviceHelper.syncFullUserToDevice({
          device_ip: dev.ip,
          device_port: dev.port || 80,
          device_user: dev.username,
          device_password: dev.password
        }, user);

        if (syncRes.synced) {
          syncedDevicesCount++;
          logEvent('success', `[MinMoe OK - ${dev.name}] Alumno "${name}" sincronizado con éxito (Usuario y Tarjeta).`);
        } else {
          logEvent('warning', `[MinMoe ADVERTENCIA - ${dev.name}] ${syncRes.summary}`);
        }

        syncRes.diagnostics.forEach(diag => {
          deviceSyncResult.diagnostics.push(`[${dev.name}] ${diag}`);
          logEvent(syncRes.synced ? 'info' : 'warning', `  └─ [${dev.name}] ${diag}`);
        });
      } else {
        deviceSyncResult.diagnostics.push(`[${dev.name}] Faltan credenciales o IP del lector.`);
      }
    }

    deviceSyncResult.synced = syncedDevicesCount === targetDevices.length;
    deviceSyncResult.userSuccess = syncedDevicesCount > 0;
    deviceSyncResult.cardSuccess = syncedDevicesCount > 0;
    deviceSyncResult.summary = `${syncedDevicesCount}/${targetDevices.length} torniquete(s) sincronizados`;
  } else {
    logEvent('info', '[MinMoe] Sincronización omitida: No hay torniquetes seleccionados.');
    deviceSyncResult.diagnostics.push('Sin torniquetes asignados.');
    deviceSyncResult.summary = 'Sin torniquetes asignados';
  }

  res.json({
    success: true,
    user,
    dbStatus: 'ok',
    synced: deviceSyncResult.synced,
    userSuccess: deviceSyncResult.userSuccess,
    cardSuccess: deviceSyncResult.cardSuccess,
    syncSummary: deviceSyncResult.summary,
    diagnostics: deviceSyncResult.diagnostics
  });
}

/**
 * Actualiza un usuario en la base de datos SQLite y sincroniza cambios con los torniquetes asignados
 */
async function updateUser(req, res) {
  const id = req.params.id;
  let { user_id, name, api_url, device_ids, assign_all, device_id } = req.body;
  user_id = user_id ? String(user_id).trim() : '';
  name = name ? String(name).trim() : '';
  api_url = api_url ? String(api_url).trim() : '';

  if (!name) {
    return res.status(400).json({ error: 'Falta el campo obligatorio Nombre del alumno.' });
  }

  // Si no se proporcionó user_id, conservar el existente o generarlo/extraerlo
  const existing = await dbHelper.getUserById(id);
  if (!user_id) {
    if (existing && existing.user_id) {
      user_id = existing.user_id;
    } else {
      user_id = extractIdFromApiUrl(api_url);
      if (!user_id) {
        user_id = crypto.randomBytes(4).toString('hex');
      }
    }
  }

  if (!api_url) {
    api_url = 'http://localhost:3000/api/mock-external-api/allow';
  }

  // Determinar dispositivos asignados
  const allDevices = await dbHelper.getDevices();
  let targetDeviceIds = null;

  if (assign_all === true || assign_all === 'true') {
    targetDeviceIds = allDevices.map(d => d.id);
  } else if (device_ids && Array.isArray(device_ids)) {
    targetDeviceIds = device_ids.map(Number).filter(Boolean);
  } else if (device_id) {
    targetDeviceIds = [Number(device_id)];
  }

  logEvent('info', `[DB] Actualizando alumno en SQLite (ID registro ${id}): User ID: "${user_id}", Nombre: "${name}"...`);

  // Paso 1: Actualizar en SQLite
  try {
    await dbHelper.updateUser(id, user_id, name, api_url, targetDeviceIds);
    logEvent('success', `[DB OK] Alumno actualizado en SQLite: ID "${user_id}", Nombre: "${name}".`);
  } catch (dbErr) {
    logEvent('error', `[DB ERROR] Error al actualizar en SQLite: ${dbErr.message}`);
    return res.status(500).json({ error: `Error de base de datos al actualizar: ${dbErr.message}` });
  }

  // Paso 2: Sincronizar con el hardware MinMoe de los torniquetes asignados
  const currentDeviceIds = targetDeviceIds !== null ? targetDeviceIds : (existing ? existing.device_ids : []);
  const targetDevices = allDevices.filter(d => currentDeviceIds.includes(d.id));
  
  let deviceSyncResult = { synced: false, userSuccess: false, cardSuccess: false, diagnostics: [], summary: '' };
  if (targetDevices.length > 0) {
    let syncedDevicesCount = 0;
    for (const dev of targetDevices) {
      if (dev.ip && dev.username && dev.password) {
        logEvent('info', `[MinMoe - ${dev.name}] Actualizando datos de "${name}" (${user_id}) en ${dev.ip}...`);
        const syncRes = await deviceHelper.syncFullUserToDevice({
          device_ip: dev.ip,
          device_port: dev.port || 80,
          device_user: dev.username,
          device_password: dev.password
        }, { user_id, name });

        if (syncRes.synced) {
          syncedDevicesCount++;
          logEvent('success', `[MinMoe OK - ${dev.name}] Alumno "${name}" actualizado con éxito.`);
        } else {
          logEvent('warning', `[MinMoe ADVERTENCIA - ${dev.name}] ${syncRes.summary}`);
        }

        syncRes.diagnostics.forEach(diag => {
          deviceSyncResult.diagnostics.push(`[${dev.name}] ${diag}`);
        });
      }
    }
    deviceSyncResult.synced = syncedDevicesCount === targetDevices.length;
    deviceSyncResult.userSuccess = syncedDevicesCount > 0;
    deviceSyncResult.cardSuccess = syncedDevicesCount > 0;
    deviceSyncResult.summary = `${syncedDevicesCount}/${targetDevices.length} torniquete(s) actualizados`;
  }

  res.json({
    success: true,
    dbStatus: 'ok',
    synced: deviceSyncResult.synced,
    userSuccess: deviceSyncResult.userSuccess,
    cardSuccess: deviceSyncResult.cardSuccess,
    syncSummary: deviceSyncResult.summary,
    diagnostics: deviceSyncResult.diagnostics
  });
}

/**
 * Eliminación de usuarios en los biométricos MinMoe asignados y en SQLite
 */
async function deleteUser(req, res) {
  const id = req.params.id;
  try {
    const users = await dbHelper.getUsers();
    const targetUser = users.find(u => String(u.id) === String(id));

    if (!targetUser) {
      await dbHelper.deleteUser(id);
      logEvent('warning', `[DB ADVERTENCIA] Usuario con ID registro ${id} no encontrado en memoria, pero se ejecutó borrado.`);
      return res.json({ success: true, message: 'Usuario no encontrado previamente.' });
    }

    // Paso 1: Eliminar del hardware biométrico MinMoe de todos los torniquetes donde esté asignado
    const allDevices = await dbHelper.getDevices();
    const userDeviceIds = targetUser.device_ids || [];
    const targetDevices = allDevices.filter(d => userDeviceIds.length === 0 || userDeviceIds.includes(d.id));

    let deletedCount = 0;
    const diagnostics = [];

    for (const dev of targetDevices) {
      if (dev.ip && dev.username && dev.password) {
        logEvent('info', `[MinMoe - ${dev.name}] Eliminando alumno "${targetUser.name}" (${targetUser.user_id}) en ${dev.ip}...`);
        const devRes = await deviceHelper.deleteUserFromDevice(
          dev.ip,
          dev.port || 80,
          dev.username,
          dev.password,
          targetUser.user_id
        );

        if (devRes.success) {
          deletedCount++;
          logEvent('success', `[MinMoe OK - ${dev.name}] Alumno "${targetUser.name}" eliminado del torniquete.`);
        } else {
          logEvent('warning', `[MinMoe ADVERTENCIA - ${dev.name}] ${devRes.summary}`);
        }

        devRes.diagnostics.forEach(diag => diagnostics.push(`[${dev.name}] ${diag}`));
      }
    }

    // Paso 2: Eliminar de la base de datos local SQLite
    await dbHelper.deleteUser(id);
    logEvent('info', `[DB OK] Alumno "${targetUser.name}" (ID registro: ${id}) eliminado de SQLite local.`);

    res.json({
      success: true,
      deviceDeleted: deletedCount > 0,
      deviceSummary: `${deletedCount}/${targetDevices.length} torniquete(s) procesados`,
      diagnostics
    });
  } catch (e) {
    logEvent('error', `[DB ERROR] Error al eliminar usuario: ${e.message}`);
    res.status(500).json({ error: `Error al eliminar usuario: ${e.message}` });
  }
}

// Control de concurrencia para evitar peticiones masivas duplicadas simultáneas
let isSyncInProgress = false;

/**
 * Sincroniza alumnos existentes hacia el/los dispositivos MinMoe
 * Admite filtrar por deviceId opcional
 */
async function syncAllUsers(req, res) {
  if (isSyncInProgress) {
    return res.status(409).json({
      error: 'Ya hay una sincronización masiva en proceso hacia el biométrico. Por favor espere a que termine.'
    });
  }

  isSyncInProgress = true;

  try {
    const targetDeviceId = req.query.deviceId || req.query.device_id;
    const allDevices = await dbHelper.getDevices();
    let devicesToSync = allDevices;

    if (targetDeviceId) {
      devicesToSync = allDevices.filter(d => String(d.id) === String(targetDeviceId));
    }

    if (devicesToSync.length === 0) {
      return res.status(400).json({ error: 'No hay torniquetes configurados para sincronizar.' });
    }

    logEvent('info', `=== INICIANDO SINCRONIZACIÓN DE ALUMNOS (${devicesToSync.length} torniquete(s)) ===`);

    let allUsers = await dbHelper.getUsers();
    if (req.query.includeTests !== 'true') {
      allUsers = allUsers.filter(u => !isTestUser(u));
    }

    let globalSyncedCount = 0;
    let globalFailedCount = 0;
    const results = [];

    for (const dev of devicesToSync) {
      if (!dev.ip || !dev.username || !dev.password) {
        logEvent('warning', `[MinMoe - ${dev.name}] Omitido: Faltan credenciales o IP.`);
        continue;
      }

      // Filtrar usuarios asignados a este dispositivo (o todos si no tienen restricción)
      const devUsers = allUsers.filter(u => u.device_ids.length === 0 || u.device_ids.includes(dev.id));
      logEvent('info', `[MinMoe - ${dev.name}] Sincronizando ${devUsers.length} alumnos asignados en ${dev.ip}:${dev.port || 80}...`);

      let devSynced = 0;
      let devFailed = 0;

      for (let i = 0; i < devUsers.length; i++) {
        const u = devUsers[i];
        const syncRes = await deviceHelper.syncFullUserToDevice({
          device_ip: dev.ip,
          device_port: dev.port || 80,
          device_user: dev.username,
          device_password: dev.password
        }, u);

        if (syncRes.synced) {
          devSynced++;
          globalSyncedCount++;
        } else {
          devFailed++;
          globalFailedCount++;
        }

        results.push({
          device: dev.name,
          user_id: u.user_id,
          name: u.name,
          synced: syncRes.synced,
          diagnostics: syncRes.diagnostics
        });

        if (i < devUsers.length - 1) {
          await new Promise(r => setTimeout(r, 20));
        }
      }

      logEvent('info', `[MinMoe - ${dev.name}] Finalizado: ${devSynced} exitosos, ${devFailed} fallidos.`);
    }

    const summaryMsg = `Sincronización finalizada: ${globalSyncedCount} exitosos, ${globalFailedCount} fallidos en ${devicesToSync.length} torniquete(s).`;
    logEvent('info', `=== ${summaryMsg.toUpperCase()} ===`);

    res.json({
      success: true,
      synced: globalSyncedCount,
      failed: globalFailedCount,
      message: summaryMsg,
      results
    });
  } catch (err) {
    logEvent('error', `[MinMoe ERROR CRÍTICO] Fallo en la sincronización global: ${err.message}`);
    res.status(500).json({ error: `Error durante la sincronización: ${err.message}` });
  } finally {
    isSyncInProgress = false;
  }
}

/**
 * Sincroniza un único alumno existente hacia sus dispositivos MinMoe asignados
 */
async function syncSingleUser(req, res) {
  const id = req.params.id;
  try {
    const users = await dbHelper.getUsers();
    const user = users.find(u => String(u.id) === String(id));

    if (!user) {
      return res.status(404).json({ error: 'Alumno no encontrado en la base de datos.' });
    }

    const allDevices = await dbHelper.getDevices();
    const userDeviceIds = user.device_ids || [];
    const targetDevices = allDevices.filter(d => userDeviceIds.length === 0 || userDeviceIds.includes(d.id));

    if (targetDevices.length === 0) {
      return res.status(400).json({ error: 'El usuario no tiene ningún torniquete asignado.' });
    }

    logEvent('info', `[MinMoe] Sincronizando alumno individual: ${user.name} (ID: ${user.user_id}) en ${targetDevices.length} torniquete(s)...`);
    
    let syncedCount = 0;
    const diagnostics = [];

    for (const dev of targetDevices) {
      if (dev.ip && dev.username && dev.password) {
        const syncRes = await deviceHelper.syncFullUserToDevice({
          device_ip: dev.ip,
          device_port: dev.port || 80,
          device_user: dev.username,
          device_password: dev.password
        }, user);

        if (syncRes.synced) {
          syncedCount++;
          logEvent('success', `[MinMoe OK - ${dev.name}] ${user.name} sincronizado con éxito.`);
        } else {
          logEvent('warning', `[MinMoe ADVERTENCIA - ${dev.name}] ${syncRes.summary}`);
        }

        syncRes.diagnostics.forEach(diag => diagnostics.push(`[${dev.name}] ${diag}`));
      }
    }

    res.json({
      success: syncedCount > 0,
      user,
      diagnostics,
      summary: `${syncedCount}/${targetDevices.length} torniquete(s) sincronizados`
    });
  } catch (e) {
    logEvent('error', `[MinMoe ERROR] Error al sincronizar alumno individual: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}

/**
 * Genera y sirve el código QR de acceso para un alumno en formato imagen PNG
 */
async function getUserQR(req, res) {
  const id = req.params.id;
  try {
    const users = await dbHelper.getUsers();
    const user = users.find(u => String(u.id) === String(id) || String(u.user_id) === String(id));
    if (!user) {
      return res.status(404).json({ error: 'Alumno no encontrado.' });
    }

    const qrBuffer = await QRCode.toBuffer(String(user.user_id), {
      type: 'png',
      width: 400,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    const safeName = user.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="qr_${safeName}_${user.user_id}.png"`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(qrBuffer);
  } catch (err) {
    logEvent('error', `[QR ERROR] Error al generar código QR: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getUsers,
  addUser,
  updateUser,
  deleteUser,
  syncAllUsers,
  syncSingleUser,
  getUserQR
};
