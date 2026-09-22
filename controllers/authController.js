const dbHelper = require('../config/database');
const { createSession, destroySession, parseCookies } = require('../middleware/auth');
const { logEvent } = require('../utils/logger');
const {
  verifyPassword,
  hashPassword,
  isHashed,
  checkLoginRateLimit,
  recordFailedLogin,
  recordSuccessfulLogin
} = require('../utils/security');

/**
 * Maneja el inicio de sesión (Administrador o Recepcionista) con control anti-fuerza bruta y hashing scrypt
 */
async function login(req, res) {
  const { username, password } = req.body;
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

  // 1. Verificar bloqueo por límite de intentos fallidos
  const rateLimit = checkLoginRateLimit(clientIp);
  if (!rateLimit.allowed) {
    logEvent('warning', `[LOGIN BLOQUEADO] IP ${clientIp} intentó acceder pero está bloqueada temporalmente (${rateLimit.waitSeconds}s restantes).`);
    return res.status(429).json({
      error: `Demasiados intentos fallidos. Su acceso está bloqueado temporalmente. Intente nuevamente en ${rateLimit.waitSeconds} segundos.`
    });
  }

  const cleanUser = username ? String(username).trim() : '';
  const cleanPass = password ? String(password) : '';

  if (!cleanPass) {
    return res.status(400).json({ error: 'Por favor ingrese su contraseña.' });
  }

  try {
    // Si no se proporcionó usuario o es explícitamente "admin", validar contra credenciales de Administrador
    if (!cleanUser || cleanUser.toLowerCase() === 'admin') {
      const settings = await dbHelper.getSettings();
      const storedPassword = settings.admin_password || 'admin123';

      const isMatch = verifyPassword(cleanPass, storedPassword);

      if (isMatch) {
        recordSuccessfulLogin(clientIp);
        logEvent('success', `Inicio de sesión de administrador exitoso desde IP: ${clientIp}`);

        // Migración transparente automática a scrypt si la contraseña era texto plano
        if (!isHashed(storedPassword)) {
          try {
            const secureHash = hashPassword(cleanPass);
            await dbHelper.updateSettings({ admin_password: secureHash });
            logEvent('info', 'Contraseña administrativa migrada automáticamente a hash seguro scrypt en SQLite.');
          } catch (migErr) {
            console.warn('[AUTH] Aviso al auto-migrar contraseña:', migErr.message);
          }
        }

        const userData = { role: 'admin', name: 'Administrador', username: 'admin' };
        const sessionToken = createSession(userData);

        res.cookie('admin_session', sessionToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          maxAge: 3600000 // 1 hora de validez
        });

        return res.json({ success: true, user: userData });
      } else {
        const failInfo = recordFailedLogin(clientIp);
        logEvent('warning', `Intento de login admin fallido desde IP ${clientIp}. Intentos restantes: ${failInfo.remainingAttempts}`);

        if (failInfo.locked) {
          return res.status(429).json({
            error: `Contraseña incorrecta. Ha excedido el límite de intentos permitidos. Acceso bloqueado por ${Math.ceil(failInfo.waitSeconds / 60)} minutos.`
          });
        }

        return res.status(401).json({
          error: `Contraseña de administrador incorrecta. Intentos restantes: ${failInfo.remainingAttempts}`
        });
      }
    }

    // Si se especificó un usuario que no es admin, buscar en la tabla de recepcionistas
    const receptionist = await dbHelper.getReceptionistByUsername(cleanUser);

    if (!receptionist) {
      const failInfo = recordFailedLogin(clientIp);
      logEvent('warning', `Intento de login con usuario no encontrado "${cleanUser}" desde IP ${clientIp}.`);
      return res.status(401).json({
        error: `Usuario o contraseña incorrectos. Intentos restantes: ${failInfo.remainingAttempts}`
      });
    }

    const isMatch = verifyPassword(cleanPass, receptionist.password);

    if (isMatch) {
      recordSuccessfulLogin(clientIp);
      logEvent('success', `Inicio de sesión exitoso de recepcionista: ${receptionist.name} (${receptionist.username}) desde IP: ${clientIp}`);

      // Auto-migrar a scrypt si estaba en texto plano
      if (!isHashed(receptionist.password)) {
        try {
          const secureHash = hashPassword(cleanPass);
          await dbHelper.updateReceptionist(receptionist.id, { password: secureHash });
        } catch (_) {}
      }

      const userData = {
        role: 'receptionist',
        name: receptionist.name,
        username: receptionist.username,
        id: receptionist.id
      };
      const sessionToken = createSession(userData);

      res.cookie('admin_session', sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 3600000
      });

      return res.json({ success: true, user: userData });
    } else {
      const failInfo = recordFailedLogin(clientIp);
      logEvent('warning', `Contraseña incorrecta para recepcionista "${cleanUser}" desde IP ${clientIp}.`);

      if (failInfo.locked) {
        return res.status(429).json({
          error: `Contraseña incorrecta. Límite de intentos excedido. Acceso bloqueado temporalmente.`
        });
      }

      return res.status(401).json({
        error: `Contraseña incorrecta. Intentos restantes: ${failInfo.remainingAttempts}`
      });
    }
  } catch (err) {
    console.error('Error during login verification:', err);
    return res.status(500).json({ error: 'Error del servidor al verificar credenciales.' });
  }
}

/**
 * Obtiene los datos del usuario autenticado actualmente
 */
function getMe(req, res) {
  if (req.user) {
    return res.json({ user: req.user });
  }
  return res.status(401).json({ error: 'No autenticado.' });
}

/**
 * Maneja el cierre de sesión invalidando el token activo en memoria
 */
function logout(req, res) {
  const cookies = parseCookies(req);
  if (cookies.admin_session) {
    destroySession(cookies.admin_session);
  }
  logEvent('info', 'Cierre de sesión completado.');
  res.clearCookie('admin_session');
  return res.json({ success: true });
}

// ==========================================================================
// CONTROLADOR DE RECEPCIONISTAS (Solo Administrador)
// ==========================================================================

/**
 * Obtiene la lista de todos los recepcionistas registrados
 */
async function getReceptionists(req, res) {
  try {
    const list = await dbHelper.getReceptionists();
    // Excluir contraseñas por seguridad
    const safeList = list.map(r => ({
      id: r.id,
      name: r.name,
      username: r.username,
      created_at: r.created_at
    }));
    return res.json(safeList);
  } catch (err) {
    console.error('Error fetching receptionists:', err);
    return res.status(500).json({ error: 'Error al obtener recepcionistas.' });
  }
}

/**
 * Registra un nuevo recepcionista validando nombre, contraseña y confirmación
 */
async function addReceptionist(req, res) {
  const { name, username, password, confirm_password } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'El nombre del recepcionista es obligatorio.' });
  }

  if (!password || String(password).trim().length < 4) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres.' });
  }

  if (confirm_password !== undefined && password !== confirm_password) {
    return res.status(400).json({ error: 'La contraseña y la confirmación no coinciden.' });
  }

  const cleanName = String(name).trim();
  const cleanUsername = (username ? String(username).trim() : cleanName.toLowerCase().replace(/\s+/g, '.')).toLowerCase();

  if (cleanUsername === 'admin') {
    return res.status(400).json({ error: 'El nombre de usuario "admin" está reservado para el Administrador.' });
  }

  try {
    const existing = await dbHelper.getReceptionistByUsername(cleanUsername);
    if (existing) {
      return res.status(400).json({ error: `El usuario o nombre "${cleanUsername}" ya se encuentra registrado.` });
    }

    const hashedPassword = hashPassword(password);
    const newReceptionist = await dbHelper.addReceptionist({
      name: cleanName,
      username: cleanUsername,
      password: hashedPassword
    });

    logEvent('info', `[RECEPCIONISTA] Nuevo recepcionista dado de alta: "${cleanName}" (@${cleanUsername}).`);
    return res.json({ success: true, receptionist: newReceptionist });
  } catch (err) {
    console.error('Error adding receptionist:', err);
    return res.status(500).json({ error: 'Error al registrar recepcionista.' });
  }
}

/**
 * Actualiza un recepcionista existente
 */
async function updateReceptionist(req, res) {
  const { id } = req.params;
  const { name, username, password, confirm_password } = req.body;

  try {
    const existing = await dbHelper.getReceptionistById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Recepcionista no encontrado.' });
    }

    const updateData = {};
    if (name) updateData.name = String(name).trim();
    if (username) {
      const cleanUsername = String(username).trim().toLowerCase();
      if (cleanUsername === 'admin') {
        return res.status(400).json({ error: 'El usuario "admin" está reservado.' });
      }
      updateData.username = cleanUsername;
    }

    if (password && String(password).trim() !== '') {
      if (confirm_password !== undefined && password !== confirm_password) {
        return res.status(400).json({ error: 'La contraseña y la confirmación no coinciden.' });
      }
      updateData.password = hashPassword(password);
    }

    await dbHelper.updateReceptionist(id, updateData);
    logEvent('info', `[RECEPCIONISTA] Recepcionista "${existing.name}" (ID: ${id}) actualizado.`);
    return res.json({ success: true });
  } catch (err) {
    console.error('Error updating receptionist:', err);
    return res.status(500).json({ error: 'Error al actualizar recepcionista.' });
  }
}

/**
 * Elimina un recepcionista
 */
async function deleteReceptionist(req, res) {
  const { id } = req.params;
  try {
    const existing = await dbHelper.getReceptionistById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Recepcionista no encontrado.' });
    }

    await dbHelper.deleteReceptionist(id);
    logEvent('info', `[RECEPCIONISTA] Recepcionista "${existing.name}" (ID: ${id}) eliminado.`);
    return res.json({ success: true });
  } catch (err) {
    console.error('Error deleting receptionist:', err);
    return res.status(500).json({ error: 'Error al eliminar recepcionista.' });
  }
}

module.exports = {
  login,
  getMe,
  logout,
  getReceptionists,
  addReceptionist,
  updateReceptionist,
  deleteReceptionist
};
