const dbHelper = require('../config/database');
const { logEvent } = require('../utils/logger');

/**
 * Lists all registered users.
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
 * Creates a new user in the database.
 */
async function addUser(req, res) {
  const { user_id, name, api_url } = req.body;
  if (!user_id || !name || !api_url) {
    return res.status(400).json({ error: 'Faltan campos requeridos (user_id, name, api_url).' });
  }
  
  try {
    const user = await dbHelper.addUser(user_id, name, api_url);
    logEvent('success', `Usuario registrado: ID: ${user_id}, Nombre: ${name}`);
    res.json(user);
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      res.status(400).json({ error: 'El ID de usuario ya se encuentra registrado.' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
}

/**
 * Updates an existing user details.
 */
async function updateUser(req, res) {
  const id = req.params.id;
  const { user_id, name, api_url } = req.body;
  if (!user_id || !name || !api_url) {
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  }

  try {
    await dbHelper.updateUser(id, user_id, name, api_url);
    logEvent('info', `Usuario actualizado: ID: ${user_id}, Nombre: ${name}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Deletes a user from the database.
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
