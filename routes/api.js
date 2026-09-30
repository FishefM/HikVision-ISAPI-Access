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
router.get('/stats', settingsController.getAccessStats);
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
router.get('/logs-stream', accessController.handleDeviceLogsStream);

// Dedicated SSE stream for a specific MinMoe / Torniquete
router.get('/devices/:id/events-stream', accessController.handleDeviceEventsStream);
router.get('/device/:id/events-stream', accessController.handleDeviceEventsStream);
router.get('/devices/:id/logs-stream', accessController.handleDeviceLogsStream);
router.get('/device/:id/logs-stream', accessController.handleDeviceLogsStream);
router.get('/events-stream', accessController.handleDeviceEventsStream);
router.get('/devices/events-stream', accessController.handleDeviceEventsStream);

module.exports = router;
