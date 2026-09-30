const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const userController = require('../controllers/userController');
const settingsController = require('../controllers/settingsController');
const accessController = require('../controllers/accessController');
const { requireAdmin } = require('../middleware/auth');
const { logEvent, sseClients } = require('../utils/logger');

// Authentication & Session routes
router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.get('/me', authController.getMe);

// Receptionists CRUD routes (Admin only)
router.get('/receptionists', requireAdmin, authController.getReceptionists);
router.post('/receptionists', requireAdmin, authController.addReceptionist);
router.put('/receptionists/:id', requireAdmin, authController.updateReceptionist);
router.delete('/receptionists/:id', requireAdmin, authController.deleteReceptionist);

// User DB routes (Accessible by both Admin and Receptionist)
router.get('/users', userController.getUsers);
router.get('/users/:id/qr', userController.getUserQR);
router.post('/users', userController.addUser);
router.put('/users/:id', userController.updateUser);
router.delete('/users/:id', userController.deleteUser);
router.post('/users/sync-all', userController.syncAllUsers);
router.post('/users/:id/sync-device', userController.syncSingleUser);
router.post('/users/sync-acuaticapp', userController.syncAcuaticAppUsers);

// MinMoe Devices routes (Read-only for receptionist dropdowns, modifications require Admin)
router.get('/devices', settingsController.getDevices);
router.post('/devices', requireAdmin, settingsController.addDevice);
router.get('/devices/:id', settingsController.getDevice);
router.put('/devices/:id', requireAdmin, settingsController.updateDevice);
router.delete('/devices/:id', requireAdmin, settingsController.deleteDevice);
router.post('/devices/:id/test-ping', settingsController.testDevicePing);
router.post('/devices/:id/open-door', settingsController.openDoor);

// Settings routes (Admin only for security modifications)
router.get('/settings', settingsController.getSettings);
router.post('/settings', requireAdmin, settingsController.updateSettings);

// Logs routes (Clear logs is Admin only, viewing logs is open to receptionists)
router.get('/logs', settingsController.getLogs);
router.post('/logs/clear', requireAdmin, settingsController.clearLogs);

// Door control routes
router.post('/test-open-door', settingsController.openDoor);

// Test simulation route
router.post('/test-scan', accessController.testScan);

// External Mock APIs (local validation testing)
router.get('/mock-external-api/allow', accessController.mockExternalApiAllow);
router.get('/mock-external-api/deny', accessController.mockExternalApiDeny);
router.get('/mock-external-api/error', accessController.mockExternalApiError);

// SSE Log stream connection (Global o filtrado por query ?device=1)
router.get('/logs-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const filterDevId = req.query.device || req.query.deviceId || null;
  res.targetDeviceId = filterDevId ? String(filterDevId) : null;

  sseClients.push(res);
  const streamDesc = res.targetDeviceId ? `filtrado para torniquete ID ${res.targetDeviceId}` : 'global';
  logEvent('info', `Cliente conectado al flujo de eventos (${streamDesc}).`);

  req.on('close', () => {
    const index = sseClients.indexOf(res);
    if (index !== -1) {
      sseClients.splice(index, 1);
    }
  });
});

// Dedicated SSE stream for a specific MinMoe / Torniquete
router.get('/devices/:id/events-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.targetDeviceId = String(req.params.id);
  sseClients.push(res);
  logEvent('info', `Pantalla conectada al flujo de eventos dedicado del torniquete ID ${req.params.id}.`, req.params.id);

  req.on('close', () => {
    const index = sseClients.indexOf(res);
    if (index !== -1) {
      sseClients.splice(index, 1);
    }
  });
});

router.get('/devices/:id/logs-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.targetDeviceId = String(req.params.id);
  sseClients.push(res);

  req.on('close', () => {
    const index = sseClients.indexOf(res);
    if (index !== -1) {
      sseClients.splice(index, 1);
    }
  });
});

module.exports = router;
