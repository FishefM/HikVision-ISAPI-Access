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
// Rate Limiter deshabilitado por solicitud: Sin límite de intentos ni bloqueos
// --------------------------------------------------------------------------
function checkLoginRateLimit(ip) {
  return { allowed: true, waitSeconds: 0 };
}

function recordFailedLogin(ip) {
  return {
    locked: false,
    remainingAttempts: Infinity,
    waitSeconds: 0
  };
}

function recordSuccessfulLogin(ip) {
  // No-op
}

module.exports = {
  hashPassword,
  verifyPassword,
  isHashed,
  checkLoginRateLimit,
  recordFailedLogin,
  recordSuccessfulLogin
};
