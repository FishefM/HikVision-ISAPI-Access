const express = require('express');
const router = express.Router();
const accessController = require('../controllers/accessController');

// Map common check event paths Hikvision terminal uploads requests to
router.post('/', accessController.handleDevicePOST);
router.post('/event', accessController.handleDevicePOST);
router.post('/api/event', accessController.handleDevicePOST);
router.post('/ISAPI/AccessControl/remoteCheck', accessController.handleDevicePOST);
router.post('/remoteCheck', accessController.handleDevicePOST);

// Dedicated per-device event endpoints (singular /device/:id and plural /devices/:id)
router.post('/device/:id', accessController.handleDevicePOST);
router.post('/device/:id/event', accessController.handleDevicePOST);
router.post('/device/:id/remoteCheck', accessController.handleDevicePOST);
router.post('/device/:id/ISAPI/AccessControl/remoteCheck', accessController.handleDevicePOST);

router.post('/devices/:id', accessController.handleDevicePOST);
router.post('/devices/:id/event', accessController.handleDevicePOST);
router.post('/devices/:id/remoteCheck', accessController.handleDevicePOST);
router.post('/devices/:id/ISAPI/AccessControl/remoteCheck', accessController.handleDevicePOST);

// Also support /api/ prefixes
router.post('/api/device/:id', accessController.handleDevicePOST);
router.post('/api/device/:id/event', accessController.handleDevicePOST);
router.post('/api/devices/:id', accessController.handleDevicePOST);
router.post('/api/devices/:id/event', accessController.handleDevicePOST);

// Dedicated SSE streams accessible directly under root paths
router.get('/device/:id/events-stream', accessController.handleDeviceEventsStream);
router.get('/devices/:id/events-stream', accessController.handleDeviceEventsStream);
router.get('/device/:id/logs-stream', accessController.handleDeviceLogsStream);
router.get('/devices/:id/logs-stream', accessController.handleDeviceLogsStream);
router.get('/events-stream', accessController.handleDeviceEventsStream);
router.get('/devices/events-stream', accessController.handleDeviceEventsStream);

module.exports = router;
