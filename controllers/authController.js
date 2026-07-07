const dbHelper = require('../config/database');
const { currentSessionToken } = require('../middleware/auth');
const { logEvent } = require('../utils/logger');

/**
 * Handles administrator dashboard login requests.
 */
async function login(req, res) {
  const { password } = req.body;
  
  try {
    const settings = await dbHelper.getSettings();
    const correctPassword = settings.admin_password || 'admin123';
    
    if (password === correctPassword) {
      logEvent('info', 'Inicio de sesión de administrador exitoso.');
      
      // Issue HttpOnly secure session cookie
      res.cookie('admin_session', currentSessionToken, {
        httpOnly: true,
        secure: false, // Set to true if running over HTTPS
        sameSite: 'strict',
        maxAge: 3600000 // 1 hour session duration
      });
      
      return res.json({ success: true });
    } else {
      logEvent('warning', 'Intento de inicio de sesión fallido: Contraseña incorrecta.');
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
  } catch (err) {
    console.error('Error during login verification:', err);
    return res.status(500).json({ error: 'Error del servidor al verificar contraseña.' });
  }
}

/**
 * Handles administrator dashboard logout requests.
 */
function logout(req, res) {
  logEvent('info', 'Cierre de sesión de administrador solicitado.');
  res.clearCookie('admin_session');
  return res.json({ success: true });
}

module.exports = {
  login,
  logout
};
