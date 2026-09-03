const dbHelper = require('../config/database');
const { logEvent } = require('../utils/logger');
const deviceHelper = require('../utils/device');

//-----------------------------------
//----------CRUD Usuarios------------
//-----------------------------------

/**
 * Obtiene usuarios registrados
 */
async function getUsers(req, res) {
  try {
    const users = await dbHelper.getUsers();
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Crea un nuevo usuario en la base de datos
 */
async function addUser(req, res) {
  const { user_id, name, api_url } = req.body;
  if (!user_id || !name || !api_url) {
    return res.status(400).json({ error: 'Faltan campos requeridos (user_id, name, api_url).' });
  }
  
  try {
    const user = await dbHelper.addUser(user_id, name, api_url);
    logEvent('success', `Usuario registrado en DB local: ID: ${user_id}, Nombre: ${name}`);

    let synced = false;
    let syncError = null;
    
    try {
      const settings = await dbHelper.getSettings();
      if (settings.device_ip && settings.device_user && settings.device_password) {
        logEvent('info', `Sincronizando usuario ${name} con el biométrico en ${settings.device_ip}...`);
        
        // User info
        const userSyncResult = await deviceHelper.syncUserInfo(
          settings.device_ip,
          settings.device_port || 80,
          settings.device_user,
          settings.device_password,
          user_id,
          name
        );
        
        if (userSyncResult.success) {
          synced = true;
          logEvent('success', `Usuario ${name} sincronizado con éxito en el biométrico.`);
          
          // Sincronizar tarjeta con el biométrico
          await deviceHelper.syncCardInfo(
            settings.device_ip,
            settings.device_port || 80,
            settings.device_user,
            settings.device_password,
            user_id,
            user_id
          ).catch(err => console.warn('Card sync error:', err.message));

          // Rostro
          if (req.file && req.file.buffer) {
            logEvent('info', `Subiendo imagen de rostro para ID: ${user_id} al biométrico...`);
            const faceSyncResult = await deviceHelper.syncUserFace(
              settings.device_ip,
              settings.device_port || 80,
              settings.device_user,
              settings.device_password,
              user_id,
              req.file.buffer
            );
            
            if (faceSyncResult.success) {
              logEvent('success', `Rostro de ${name} subido con éxito al biométrico.`);
            } else {
              logEvent('warning', `Usuario creado pero falló subir rostro: ${faceSyncResult.error || 'Error de procesamiento'}`);
              syncError = `Usuario creado en biométrico, pero falló subir rostro. Revise que la imagen tenga un rostro claro y fondo homogéneo.`;
            }
          }
        } else {
          logEvent('warning', `Fallo al sincronizar usuario en biométrico: ${JSON.stringify(userSyncResult.data || userSyncResult.error)}`);
          syncError = `Fallo al registrar usuario en biométrico.`;
        }
      }
    } catch (syncErr) {
      logEvent('error', `Error de red con biométrico durante registro: ${syncErr.message}`);
      syncError = `Error de conexión con el biométrico.`;
    }

    res.json({
      success: true,
      user,
      synced,
      syncError
    });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      res.status(400).json({ error: 'El ID de usuario ya se encuentra registrado.' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
}

/**
 * Update User Info
 */
async function updateUser(req, res) {
  const id = req.params.id;
  const { user_id, name, api_url } = req.body;
  if (!user_id || !name || !api_url) {
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  }

  try {
    await dbHelper.updateUser(id, user_id, name, api_url);
    logEvent('info', `Usuario actualizado en DB local: ID: ${user_id}, Nombre: ${name}`);

    let synced = false;
    let syncError = null;

    try {
      const settings = await dbHelper.getSettings();
      if (settings.device_ip && settings.device_user && settings.device_password) {
        logEvent('info', `Actualizando usuario ${name} en el biométrico...`);
        
        // Sync User Info 
        const userSyncResult = await deviceHelper.syncUserInfo(
          settings.device_ip,
          settings.device_port || 80,
          settings.device_user,
          settings.device_password,
          user_id,
          name
        );
        
        if (userSyncResult.success) {
          synced = true;
          logEvent('success', `Usuario ${name} actualizado con éxito en el biométrico.`);
          
          // Sincronizar tarjeta con el biométrico
          await deviceHelper.syncCardInfo(
            settings.device_ip,
            settings.device_port || 80,
            settings.device_user,
            settings.device_password,
            user_id,
            user_id
          ).catch(err => console.warn('Card sync error:', err.message));

          // Sincronizacion de imagen
          if (req.file && req.file.buffer) {
            logEvent('info', `Subiendo/Actualizando imagen de rostro para ID: ${user_id} al biométrico...`);
            const faceSyncResult = await deviceHelper.syncUserFace(
              settings.device_ip,
              settings.device_port || 80,
              settings.device_user,
              settings.device_password,
              user_id,
              req.file.buffer
            );
            
            if (faceSyncResult.success) {
              logEvent('success', `Rostro de ${name} actualizado con éxito en el biométrico.`);
            } else {
              logEvent('warning', `Usuario actualizado pero falló subir rostro: ${faceSyncResult.error || 'Error de procesamiento'}`);
              syncError = `Usuario actualizado en biométrico, pero falló subir rostro. Revise que la imagen tenga un rostro claro.`;
            }
          }
        } else {
          logEvent('warning', `Fallo al actualizar usuario en biométrico: ${JSON.stringify(userSyncResult.data || userSyncResult.error)}`);
          syncError = `Fallo al actualizar usuario en biométrico.`;
        }
      }
    } catch (syncErr) {
      logEvent('error', `Error de red con biométrico durante actualización: ${syncErr.message}`);
      syncError = `Error de conexión con el biométrico.`;
    }

    res.json({
      success: true,
      synced,
      syncError
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Eliminacion de usuarios
 */
async function deleteUser(req, res) {
  const id = req.params.id;
  try {
    await dbHelper.deleteUser(id);
    logEvent('info', `Usuario eliminado con ID interno: ${id}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  getUsers,
  addUser,
  updateUser,
  deleteUser
};
