// middleware/auth.js
const crypto = require('crypto');

// Generate a unique session token for the lifetime of this server process
const currentSessionToken = crypto.randomBytes(32).toString('hex');

/**
 * Utility to parse cookies manually from raw request headers.
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
 * Authentication middleware that protects index.html and all administrative endpoints.
 * Exempts public pages, static assets, and Hikvision hardware requests.
 */
const authMiddleware = (req, res, next) => {
  // Define public static assets and public API endpoints
  const publicRoutes = [
    '/login.html',
    '/feedback.html',
    '/api/login',
    '/api/logs-stream'
  ];

  // Check if path is public, static assets, or Hikvision terminal POST events
  if (
    publicRoutes.includes(req.path) ||
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

  // Verify session cookie
  const cookies = parseCookies(req);
  if (cookies.admin_session === currentSessionToken) {
    return next();
  }

  // Redirect page requests to login.html
  if (req.path === '/' || req.path.endsWith('.html')) {
    return res.redirect('/login.html');
  }

  // Deny access to other API endpoints
  return res.status(401).json({ error: 'No autorizado. Por favor inicie sesión.' });
};

module.exports = {
  authMiddleware,
  currentSessionToken,
  parseCookies
};
