// utils/security.js
const crypto = require('crypto');

/**
 * Genera un hash criptográfico seguro para contraseñas usando scrypt con salt aleatorio.
 * @param {string} password - Contraseña en texto plano.
 * @returns {string} - Formato: $scrypt$<salt>$<hash>
 */
function hashPassword(password) {
  if (!password || typeof password !== 'string') {
    throw new Error('La contraseña debe ser una cadena de texto válida.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `$scrypt$${salt}$${hash}`;
}

/**
 * Comprueba si una cadena ya tiene formato de hash scrypt.
 * @param {string} stored - Valor almacenado.
 * @returns {boolean}
 */
function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith('$scrypt$');
}

/**
 * Verifica si una contraseña coincide con la almacenada (soportando scrypt y texto plano legacy).
 * Utiliza comparación de tiempo constante para prevenir ataques de temporización (timing attacks).
 * @param {string} password - Contraseña candidata enviada por el usuario.
 * @param {string} stored - Contraseña almacenada en la base de datos (hash o texto plano).
 * @returns {boolean}
 */
function verifyPassword(password, stored) {
  if (!password || !stored) return false;

  try {
    if (isHashed(stored)) {
      const parts = stored.split('$');
      // parts: ['', 'scrypt', salt, hash]
      if (parts.length !== 4) return false;
      const salt = parts[2];
      const originalHash = parts[3];
      const candidateHash = crypto.scryptSync(password, salt, 64).toString('hex');

      const originalBuf = Buffer.from(originalHash, 'hex');
      const candidateBuf = Buffer.from(candidateHash, 'hex');

      if (originalBuf.length !== candidateBuf.length) return false;
      return crypto.timingSafeEqual(originalBuf, candidateBuf);
    }

    // Compatibilidad con contraseñas legadas en texto plano
    const passBuf = Buffer.from(String(password));
    const storedBuf = Buffer.from(String(stored));

    if (passBuf.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(passBuf, storedBuf);
  } catch (err) {
    return false;
  }
}

// --------------------------------------------------------------------------
// Rate Limiter en memoria para prevenir ataques de fuerza bruta en el Login
// --------------------------------------------------------------------------
const loginAttempts = new Map(); // ip -> { count, lockedUntil, firstAttempt }

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutos de bloqueo
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;   // Ventana de 15 minutos

/**
 * Verifica si una IP está actualmente bloqueada por demasiados intentos fallidos.
 * @param {string} ip - Dirección IP del cliente.
 * @returns {{ allowed: boolean, waitSeconds: number }}
 */
function checkLoginRateLimit(ip) {
  const cleanIp = String(ip || 'unknown').trim();
  const record = loginAttempts.get(cleanIp);

  if (!record) {
    return { allowed: true, waitSeconds: 0 };
  }

  const now = Date.now();

  // Si ya estaba bloqueado y no ha vencido el tiempo
  if (record.lockedUntil && now < record.lockedUntil) {
    const waitSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return { allowed: false, waitSeconds };
  }

  // Si la ventana de tiempo expiró, limpiar registro
  if (record.firstAttempt && (now - record.firstAttempt > ATTEMPT_WINDOW_MS)) {
    loginAttempts.delete(cleanIp);
    return { allowed: true, waitSeconds: 0 };
  }

  return { allowed: true, waitSeconds: 0 };
}

/**
 * Registra un intento fallido de login para una IP.
 * @param {string} ip - Dirección IP del cliente.
 * @returns {{ locked: boolean, remainingAttempts: number, waitSeconds: number }}
 */
function recordFailedLogin(ip) {
  const cleanIp = String(ip || 'unknown').trim();
  const now = Date.now();
  let record = loginAttempts.get(cleanIp);

  if (!record || (now - record.firstAttempt > ATTEMPT_WINDOW_MS)) {
    record = { count: 1, firstAttempt: now, lockedUntil: null };
  } else {
    record.count += 1;
  }

  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_DURATION_MS;
    loginAttempts.set(cleanIp, record);
    return {
      locked: true,
      remainingAttempts: 0,
      waitSeconds: Math.ceil(LOCKOUT_DURATION_MS / 1000)
    };
  }

  loginAttempts.set(cleanIp, record);
  return {
    locked: false,
    remainingAttempts: MAX_FAILED_ATTEMPTS - record.count,
    waitSeconds: 0
  };
}

/**
 * Limpia los intentos fallidos tras un login exitoso.
 * @param {string} ip - Dirección IP del cliente.
 */
function recordSuccessfulLogin(ip) {
  const cleanIp = String(ip || 'unknown').trim();
  loginAttempts.delete(cleanIp);
}

// Limpieza periódica cada 30 minutos de IPs en memoria
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts.entries()) {
    if (record.lockedUntil && now > record.lockedUntil) {
      loginAttempts.delete(ip);
    } else if (record.firstAttempt && (now - record.firstAttempt > ATTEMPT_WINDOW_MS)) {
      loginAttempts.delete(ip);
    }
  }
}, 30 * 60 * 1000).unref();

module.exports = {
  hashPassword,
  verifyPassword,
  isHashed,
  checkLoginRateLimit,
  recordFailedLogin,
  recordSuccessfulLogin
};
