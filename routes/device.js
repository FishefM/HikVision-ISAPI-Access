const express = require('express');
const router = express.Router();
const accessController = require('../controllers/accessController');

// Map common check event paths Hikvision terminal uploads requests to
router.post('/', accessController.handleDevicePOST);
router.post('/event', accessController.handleDevicePOST);
router.post('/api/event', accessController.handleDevicePOST);
router.post('/ISAPI/AccessControl/remoteCheck', accessController.handleDevicePOST);
router.post('/remoteCheck', accessController.handleDevicePOST);

// Dedicated per-device event endpoints (e.g. /device/1/event, /device/2/remoteCheck)
router.post('/device/:id', accessController.handleDevicePOST);
router.post('/device/:id/event', accessController.handleDevicePOST);
router.post('/device/:id/remoteCheck', accessController.handleDevicePOST);
router.post('/device/:id/ISAPI/AccessControl/remoteCheck', accessController.handleDevicePOST);
router.post('/devices/:id/event', accessController.handleDevicePOST);
router.post('/devices/:id/remoteCheck', accessController.handleDevicePOST);

module.exports = router;
