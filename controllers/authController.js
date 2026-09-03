const dbHelper = require('../config/database');
const { currentSessionToken } = require('../middleware/auth');
const { logEvent } = require('../utils/logger');

/**
 * Handle Dashboard de Administracion
 */
async function login(req, res) {
  const { password } = req.body;
  
  try {
    const settings = await dbHelper.getSettings();
    const correctPassword = settings.admin_password || 'admin123';
    
    if (password === correctPassword) {
      logEvent('info', 'Inicio de sesión de administrador exitoso.');
      
      res.cookie('admin_session', currentSessionToken, {
        httpOnly: true,
        secure: false, 
        sameSite: 'strict',
        maxAge: 3600000 // 1 hora de sesion
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
 * Handle logout request
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
