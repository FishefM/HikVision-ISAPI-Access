const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const userController = require('../controllers/userController');
const settingsController = require('../controllers/settingsController');
const accessController = require('../controllers/accessController');
const { logEvent, sseClients } = require('../utils/logger');

// Authentication routes
router.post('/login', authController.login);
router.post('/logout', authController.logout);

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// User DB routes
router.get('/users', userController.getUsers);
router.post('/users', upload.single('faceImage'), userController.addUser);
router.put('/users/:id', upload.single('faceImage'), userController.updateUser);
router.delete('/users/:id', userController.deleteUser);
router.post('/users/sync-all', userController.syncAllUsers);
router.post('/users/:id/sync-device', userController.syncSingleUser);

// Settings routes
router.get('/settings', settingsController.getSettings);
router.post('/settings', settingsController.updateSettings);

// Logs routes
router.get('/logs', settingsController.getLogs);
router.post('/logs/clear', settingsController.clearLogs);

// Door control routes
router.post('/test-open-door', settingsController.openDoor);

// Test simulation route
router.post('/test-scan', accessController.testScan);

// External Mock APIs (local validation testing)
router.get('/mock-external-api/allow', accessController.mockExternalApiAllow);
router.get('/mock-external-api/deny', accessController.mockExternalApiDeny);
router.get('/mock-external-api/error', accessController.mockExternalApiError);

// SSE Log stream connection
router.get('/logs-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);
  logEvent('info', 'Panel de control conectado al flujo de eventos.');

  req.on('close', () => {
    const index = sseClients.indexOf(res);
    if (index !== -1) {
      sseClients.splice(index, 1);
    }
    console.log('[INFO] Panel de control desconectado.');
  });
});

module.exports = router;
