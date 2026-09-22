// middleware/auth.js
const crypto = require('crypto');

// Almacén de sesiones activas en memoria: token -> { expiresAt: timestamp, user: { role, name, username, id } }
const activeSessions = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hora de validez

// Clave secreta configurable por variable de entorno o generada al arranque
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const defaultSessionToken = crypto.createHash('sha256').update(sessionSecret).digest('hex');

// Se registra la sesión base inicial
activeSessions.set(defaultSessionToken, {
  expiresAt: Date.now() + (24 * 60 * 60 * 1000),
  user: { role: 'admin', name: 'Administrador', username: 'admin' }
});

/**
 * Crea una nueva sesión única y segura.
 * @param {Object} userData - Datos del usuario autenticado ({ role, name, username, id }).
 * @returns {string} Token de sesión en formato hexadecimal.
 */
function createSession(userData = { role: 'admin', name: 'Administrador', username: 'admin' }) {
  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.set(token, {
    expiresAt: Date.now() + SESSION_TTL_MS,
    user: userData
  });
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
 * Obtiene y valida una sesión activa renovando su tiempo de vida.
 * @param {string} token
 * @returns {Object|null}
 */
function getSession(token) {
  if (!token) return null;
  const session = activeSessions.get(token);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return null;
  }

  // Sliding expiration
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

/**
 * Valida si un token de sesión es válido y no ha expirado.
 * @param {string} token
 * @returns {boolean}
 */
function isValidSession(token) {
  return getSession(token) !== null;
}

// Limpieza periódica de sesiones expiradas cada 15 minutos
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of activeSessions.entries()) {
    if (now > session.expiresAt) {
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
    '/login',
    '/login.html',
    '/feedback',
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

  // Verificar la cookie de sesión
  const cookies = parseCookies(req);
  const session = getSession(cookies.admin_session);
  if (session) {
    req.session = session;
    req.user = session.user;
    return next();
  }

  // Redirigir peticiones de páginas HTML o rutas del panel al login limpio
  if (req.path === '/' || req.path === '/pruebas' || req.path === '/index' || req.path.endsWith('.html')) {
    return res.redirect('/login');
  }

  // Denegar peticiones a endpoints de API no autorizados
  return res.status(401).json({ error: 'No autorizado. Por favor inicie sesión.' });
};

/**
 * Middleware para requerir privilegios de Administrador
 */
const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Acceso denegado. Se requieren permisos de Administrador.' });
};

module.exports = {
  authMiddleware,
  requireAdmin,
  createSession,
  destroySession,
  getSession,
  isValidSession,
  currentSessionToken: defaultSessionToken,
  parseCookies
};

