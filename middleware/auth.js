// middleware/auth.js
const crypto = require('crypto');

// Almacén de sesiones activas en memoria: token -> expiresAt (timestamp)
const activeSessions = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hora de validez

// Clave secreta configurable por variable de entorno o generada al arranque
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const defaultSessionToken = crypto.createHash('sha256').update(sessionSecret).digest('hex');

// Se registra la sesión base inicial
activeSessions.set(defaultSessionToken, Date.now() + (24 * 60 * 60 * 1000));

/**
 * Crea una nueva sesión única y segura para el administrador.
 * @returns {string} Token de sesión en formato hexadecimal.
 */
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

/**
 * Destruye una sesión activa existente.
 * @param {string} token
 */
function destroySession(token) {
  if (token) {
    activeSessions.delete(token);
  }
}

/**
 * Valida si un token de sesión es válido y no ha expirado.
 * @param {string} token
 * @returns {boolean}
 */
function isValidSession(token) {
  if (!token) return false;
  const expiresAt = activeSessions.get(token);
  if (!expiresAt) return false;

  if (Date.now() > expiresAt) {
    activeSessions.delete(token);
    return false;
  }

  // Renovar ventana de expiración si está activa (sliding expiration)
  activeSessions.set(token, Date.now() + SESSION_TTL_MS);
  return true;
}

// Limpieza periódica de sesiones expiradas cada 15 minutos
setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of activeSessions.entries()) {
    if (now > expiresAt) {
      activeSessions.delete(token);
    }
  }
}, 15 * 60 * 1000).unref();

/**
 * Utilidad para extraer cookies desde los headers HTTP sin dependencias externas.
 */
function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

/**
 * Middleware de autenticación que protege el Dashboard y los endpoints administrativos.
 * Exenta vistas públicas, recursos estáticos, simulaciones y webhooks del hardware Hikvision.
 */
const authMiddleware = (req, res, next) => {
  // Rutas públicas y endpoints del monitor / webhooks
  const publicRoutes = [
    '/login.html',
    '/feedback.html',
    '/api/login',
    '/api/logs-stream'
  ];

  // Comprobar si la ruta es pública o es una notificación del hardware
  if (
    publicRoutes.includes(req.path) ||
    req.path.startsWith('/api/mock-external-api') ||
    req.path.startsWith('/css/') ||
    req.path.startsWith('/js/') ||
    req.path.startsWith('/favicon.ico') ||
    (req.method === 'POST' && (
      req.path === '/' || 
      req.path === '/event' || 
      req.path === '/api/event' || 
      req.path.startsWith('/ISAPI/') || 
      req.path === '/remoteCheck'
    ))
  ) {
    return next();
  }

  // Verificar la cookie de sesión del administrador
  const cookies = parseCookies(req);
  if (isValidSession(cookies.admin_session)) {
    return next();
  }

  // Redirigir peticiones de páginas HTML al login
  if (req.path === '/' || req.path === '/pruebas' || req.path.endsWith('.html')) {
    return res.redirect('/login.html');
  }

  // Denegar peticiones a endpoints de API no autorizados
  return res.status(401).json({ error: 'No autorizado. Por favor inicie sesión.' });
};

module.exports = {
  authMiddleware,
  createSession,
  destroySession,
  isValidSession,
  currentSessionToken: defaultSessionToken,
  parseCookies
};
