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
 * Maneja el inicio de sesión administrativo con control anti-fuerza bruta y hashing scrypt
 */
async function login(req, res) {
  const { password } = req.body;
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

  // 1. Verificar bloqueo por límite de intentos fallidos
  const rateLimit = checkLoginRateLimit(clientIp);
  if (!rateLimit.allowed) {
    logEvent('warning', `[LOGIN BLOQUEADO] IP ${clientIp} intentó acceder pero está bloqueada temporalmente (${rateLimit.waitSeconds}s restantes).`);
    return res.status(429).json({
      error: `Demasiados intentos fallidos. Su acceso está bloqueado temporalmente. Intente nuevamente en ${rateLimit.waitSeconds} segundos.`
    });
  }

  try {
    const settings = await dbHelper.getSettings();
    const storedPassword = settings.admin_password || 'admin123';

    // 2. Verificar contraseña de forma segura (soporta scrypt y texto plano inicial)
    const isMatch = verifyPassword(password, storedPassword);

    if (isMatch) {
      // Registrar login exitoso y limpiar historial de intentos fallidos
      recordSuccessfulLogin(clientIp);
      logEvent('success', `Inicio de sesión de administrador exitoso desde IP: ${clientIp}`);

      // 3. Migración transparente automática: Si la contraseña estaba en texto plano, hashearla ahora en SQLite
      if (!isHashed(storedPassword)) {
        try {
          const secureHash = hashPassword(password);
          await dbHelper.updateSettings({ admin_password: secureHash });
          logEvent('info', 'Contraseña administrativa migrada automáticamente a hash seguro scrypt en SQLite.');
        } catch (migErr) {
          console.warn('[AUTH] Aviso al auto-migrar contraseña:', migErr.message);
        }
      }

      // 4. Crear token de sesión criptográfico único
      const sessionToken = createSession();

      res.cookie('admin_session', sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 3600000 // 1 hora de validez
      });

      return res.json({ success: true });
    } else {
      // 5. Registrar fallo para control de fuerza bruta
      const failInfo = recordFailedLogin(clientIp);
      logEvent('warning', `Intento de inicio de sesión fallido desde IP ${clientIp}. Intentos restantes: ${failInfo.remainingAttempts}`);

      if (failInfo.locked) {
        return res.status(429).json({
          error: `Contraseña incorrecta. Ha excedido el límite de intentos permitidos. Su acceso ha sido bloqueado por ${Math.ceil(failInfo.waitSeconds / 60)} minutos.`
        });
      }

      return res.status(401).json({
        error: `Contraseña incorrecta. Intentos restantes antes de bloqueo: ${failInfo.remainingAttempts}`
      });
    }
  } catch (err) {
    console.error('Error during login verification:', err);
    return res.status(500).json({ error: 'Error del servidor al verificar contraseña.' });
  }
}

/**
 * Maneja el cierre de sesión invalidando el token activo en memoria
 */
function logout(req, res) {
  const cookies = parseCookies(req);
  if (cookies.admin_session) {
    destroySession(cookies.admin_session);
  }
  logEvent('info', 'Cierre de sesión de administrador completado.');
  res.clearCookie('admin_session');
  return res.json({ success: true });
}

module.exports = {
  login,
  logout
};
