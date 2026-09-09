const QRCode = require('qrcode');
const dbHelper = require('../config/database');
const { logEvent } = require('../utils/logger');
const deviceHelper = require('../utils/device');

//-----------------------------------
//----------CRUD Usuarios------------
//-----------------------------------

/**
 * Determina si un registro corresponde a un usuario de pruebas o a un alumno real
 */
function isTestUser(user) {
  if (!user) return false;
  const uid = String(user.user_id || '').trim();
  const url = String(user.api_url || '').toLowerCase();
  const name = String(user.name || '').toLowerCase();
  
  return /^100\d*$/.test(uid) || 
         url.includes('mock-external-api') || 
         url.includes('localhost:3000/api/mock') || 
         url.includes('127.0.0.1:3000/api/mock') ||
         name.includes('(permitido)') || 
         name.includes('(denegado)') || 
         name.includes('(error api)') ||
         name.includes('prueba');
}

/**
 * Obtiene usuarios registrados de la base de datos local SQLite,
 * con soporte para filtrar usuarios reales (producción) o de prueba.
 */
async function getUsers(req, res) {
  try {
    const users = await dbHelper.getUsers();
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
 * Crea un nuevo usuario en la base de datos SQLite y sincroniza con el MinMoe
 */
async function addUser(req, res) {
  let { user_id, name, api_url } = req.body;
  user_id = user_id ? String(user_id).trim() : '';
  name = name ? String(name).trim() : '';
  api_url = api_url ? String(api_url).trim() : '';

  // Asignar API URL por defecto si el usuario no ingresó una
  if (!api_url) {
    api_url = 'http://localhost:3000/api/mock-external-api/allow';
  }

  if (!user_id || !name) {
    logEvent('warning', '[REGISTRO] Solicitud rechazada: Faltan campos obligatorios (ID de usuario o Nombre).');
    return res.status(400).json({ error: 'Faltan campos obligatorios (ID de usuario y Nombre).' });
  }

  logEvent('info', `[DB] Intentando registrar alumno en SQLite: ID "${user_id}", Nombre: "${name}", API: "${api_url}"...`);

  let user = null;
  // Paso 1: Inserción en la base de datos local SQLite
  try {
    user = await dbHelper.addUser(user_id, name, api_url);
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

  // Paso 2: Sincronización con el hardware Hikvision MinMoe
  let deviceSyncResult = { synced: false, userSuccess: false, cardSuccess: false, diagnostics: [] };
  try {
    const settings = await dbHelper.getSettings();
    if (settings.device_ip && settings.device_user && settings.device_password) {
      logEvent('info', `[MinMoe] Iniciando sincronización de "${name}" (${user_id}) con biométrico en ${settings.device_ip}:${settings.device_port || 80}...`);
      
      deviceSyncResult = await deviceHelper.syncFullUserToDevice(settings, user);

      if (deviceSyncResult.synced) {
        logEvent('success', `[MinMoe OK] Alumno "${name}" sincronizado con éxito en el biométrico (Usuario y Tarjeta).`);
      } else {
        logEvent('warning', `[MinMoe ADVERTENCIA] Guardado en SQLite pero MinMoe reportó: ${deviceSyncResult.summary}`);
      }

      deviceSyncResult.diagnostics.forEach(diag => {
        logEvent(deviceSyncResult.synced ? 'info' : 'warning', `  └─ [MinMoe Detalle] ${diag}`);
      });
    } else {
      logEvent('info', '[MinMoe] Sincronización omitida: Faltan credenciales del lector en la configuración (IP, Usuario o Contraseña).');
      deviceSyncResult.diagnostics.push('Lector no configurado en ajustes del sistema.');
    }
  } catch (syncErr) {
    logEvent('error', `[MinMoe ERROR] Excepción durante la sincronización: ${syncErr.message}`);
    deviceSyncResult = {
      synced: false,
      userSuccess: false,
      cardSuccess: false,
      diagnostics: [`Excepción de red: ${syncErr.message}`],
      summary: syncErr.message
    };
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
 * Actualiza un usuario en la base de datos SQLite y sincroniza cambios con el MinMoe
 */
async function updateUser(req, res) {
  const id = req.params.id;
  let { user_id, name, api_url } = req.body;
  user_id = user_id ? String(user_id).trim() : '';
  name = name ? String(name).trim() : '';
  api_url = api_url ? String(api_url).trim() : '';

  if (!api_url) {
    api_url = 'http://localhost:3000/api/mock-external-api/allow';
  }

  if (!user_id || !name) {
    return res.status(400).json({ error: 'Faltan campos obligatorios (ID de usuario y Nombre).' });
  }

  logEvent('info', `[DB] Actualizando alumno en SQLite (ID registro ${id}): User ID: "${user_id}", Nombre: "${name}"...`);

  // Paso 1: Actualizar en SQLite
  try {
    await dbHelper.updateUser(id, user_id, name, api_url);
    logEvent('success', `[DB OK] Alumno actualizado en SQLite: ID "${user_id}", Nombre: "${name}".`);
  } catch (dbErr) {
    logEvent('error', `[DB ERROR] Error al actualizar en SQLite: ${dbErr.message}`);
    return res.status(500).json({ error: `Error de base de datos al actualizar: ${dbErr.message}` });
  }

  // Paso 2: Sincronizar con el hardware MinMoe
  let deviceSyncResult = { synced: false, userSuccess: false, cardSuccess: false, diagnostics: [] };
  try {
    const settings = await dbHelper.getSettings();
    if (settings.device_ip && settings.device_user && settings.device_password) {
      logEvent('info', `[MinMoe] Actualizando datos de "${name}" (${user_id}) en el biométrico...`);

      deviceSyncResult = await deviceHelper.syncFullUserToDevice(settings, { user_id, name });

      if (deviceSyncResult.synced) {
        logEvent('success', `[MinMoe OK] Alumno "${name}" actualizado con éxito en el biométrico (Usuario y Tarjeta).`);
      } else {
        logEvent('warning', `[MinMoe ADVERTENCIA] Actualizado en SQLite pero MinMoe reportó: ${deviceSyncResult.summary}`);
      }

      deviceSyncResult.diagnostics.forEach(diag => {
        logEvent(deviceSyncResult.synced ? 'info' : 'warning', `  └─ [MinMoe Detalle] ${diag}`);
      });
    }
  } catch (syncErr) {
    logEvent('error', `[MinMoe ERROR] Error al sincronizar actualización con biométrico: ${syncErr.message}`);
    deviceSyncResult = {
      synced: false,
      userSuccess: false,
      cardSuccess: false,
      diagnostics: [`Error de red: ${syncErr.message}`],
      summary: syncErr.message
    };
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
 * Eliminación de usuarios en el biométrico MinMoe, SQLite y archivos locales
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

    // Paso 1: Eliminar del hardware biométrico MinMoe
    let deviceResult = { success: false, diagnostics: [], summary: 'Biométrico no configurado' };
    try {
      const settings = await dbHelper.getSettings();
      if (settings.device_ip && settings.device_user && settings.device_password) {
        logEvent('info', `[MinMoe] Eliminando alumno "${targetUser.name}" (${targetUser.user_id}) en el biométrico ${settings.device_ip}:${settings.device_port || 80}...`);
        deviceResult = await deviceHelper.deleteUserFromDevice(
          settings.device_ip,
          settings.device_port || 80,
          settings.device_user,
          settings.device_password,
          targetUser.user_id
        );

        if (deviceResult.success) {
          logEvent('success', `[MinMoe OK] Alumno "${targetUser.name}" eliminado del biométrico exitosamente.`);
        } else {
          logEvent('warning', `[MinMoe ADVERTENCIA] Eliminado en SQLite local pero MinMoe reportó: ${deviceResult.summary}`);
        }

        deviceResult.diagnostics.forEach(diag => {
          logEvent(deviceResult.success ? 'info' : 'warning', `  └─ [MinMoe Detalle] ${diag}`);
        });
      } else {
        logEvent('info', '[MinMoe] Eliminación en biométrico omitida: Faltan credenciales del dispositivo en configuración.');
      }
    } catch (devErr) {
      logEvent('error', `[MinMoe ERROR] Error al comunicar con el biométrico durante eliminación: ${devErr.message}`);
      deviceResult = {
        success: false,
        diagnostics: [`Error de red: ${devErr.message}`],
        summary: devErr.message
      };
    }

    // Paso 2: Eliminar de la base de datos local SQLite
    await dbHelper.deleteUser(id);
    logEvent('info', `[DB OK] Alumno "${targetUser.name}" (ID registro: ${id}) eliminado de SQLite local.`);

    res.json({
      success: true,
      deviceDeleted: deviceResult.success,
      deviceSummary: deviceResult.summary,
      diagnostics: deviceResult.diagnostics
    });
  } catch (e) {
    logEvent('error', `[DB ERROR] Error al eliminar usuario: ${e.message}`);
    res.status(500).json({ error: `Error al eliminar usuario: ${e.message}` });
  }
}

/**
 * Sincroniza TODOS los alumnos existentes en la base de datos hacia el dispositivo MinMoe
 */
async function syncAllUsers(req, res) {
  logEvent('info', '=== INICIANDO SINCRONIZACIÓN DE TODOS LOS ALUMNOS AL MINMOE ===');

  try {
    const settings = await dbHelper.getSettings();
    if (!settings.device_ip || !settings.device_user || !settings.device_password) {
      const msg = 'No se puede sincronizar: IP, Usuario o Contraseña del MinMoe no están configurados.';
      logEvent('warning', `[MinMoe] ${msg}`);
      return res.status(400).json({ error: msg });
    }

    let users = await dbHelper.getUsers();
    if (req.query.includeTests !== 'true') {
      users = users.filter(u => !isTestUser(u));
    }
    if (users.length === 0) {
      logEvent('warning', '[MinMoe] No hay usuarios reales en la base de datos local para sincronizar.');
      return res.json({ total: 0, synced: 0, failed: 0, message: 'No hay usuarios de producción para sincronizar.' });
    }

    logEvent('info', `[MinMoe] Encontrados ${users.length} alumnos reales en SQLite. Sincronizando con ${settings.device_ip}:${settings.device_port || 80}...`);

    let syncedCount = 0;
    let failedCount = 0;
    const results = [];

    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      logEvent('info', `[${i + 1}/${users.length}] Sincronizando: ${u.name} (ID: ${u.user_id})...`);

      const syncRes = await deviceHelper.syncFullUserToDevice(settings, u);
      if (syncRes.synced) {
        syncedCount++;
        logEvent('success', `  [OK] ${u.name} sincronizado correctamente.`);
      } else {
        failedCount++;
        logEvent('warning', `  [ADVERTENCIA] ${u.name}: ${syncRes.summary}`);
      }

      results.push({
        user_id: u.user_id,
        name: u.name,
        synced: syncRes.synced,
        diagnostics: syncRes.diagnostics
      });
    }

    const summaryMsg = `Sincronización completada: ${syncedCount} exitosos, ${failedCount} con advertencias de un total de ${users.length}.`;
    logEvent('info', `=== ${summaryMsg.toUpperCase()} ===`);

    res.json({
      success: true,
      total: users.length,
      synced: syncedCount,
      failed: failedCount,
      message: summaryMsg,
      results
    });
  } catch (err) {
    logEvent('error', `[MinMoe ERROR CRÍTICO] Fallo en la sincronización global: ${err.message}`);
    res.status(500).json({ error: `Error durante la sincronización: ${err.message}` });
  }
}

/**
 * Sincroniza un único alumno existente hacia el dispositivo MinMoe
 */
async function syncSingleUser(req, res) {
  const id = req.params.id;
  try {
    const users = await dbHelper.getUsers();
    const user = users.find(u => String(u.id) === String(id));

    if (!user) {
      return res.status(404).json({ error: 'Alumno no encontrado en la base de datos.' });
    }

    const settings = await dbHelper.getSettings();
    if (!settings.device_ip || !settings.device_user || !settings.device_password) {
      return res.status(400).json({ error: 'Faltan parámetros del MinMoe en la configuración.' });
    }

    logEvent('info', `[MinMoe] Sincronizando alumno individual: ${user.name} (ID: ${user.user_id})...`);
    const syncRes = await deviceHelper.syncFullUserToDevice(settings, user);

    if (syncRes.synced) {
      logEvent('success', `[MinMoe OK] ${user.name} sincronizado con éxito (Usuario y Tarjeta).`);
    } else {
      logEvent('warning', `[MinMoe ADVERTENCIA] ${user.name}: ${syncRes.summary}`);
    }

    res.json({
      success: syncRes.synced,
      user,
      diagnostics: syncRes.diagnostics,
      summary: syncRes.summary
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
