const express = require('express');
const router = express.Router();
const accessController = require('../controllers/accessController');

// Map common check event paths Hikvision terminal uploads requests to
router.post('/', accessController.handleDevicePOST);
router.post('/event', accessController.handleDevicePOST);
router.post('/api/event', accessController.handleDevicePOST);
router.post('/ISAPI/AccessControl/remoteCheck', accessController.handleDevicePOST);
router.post('/remoteCheck', accessController.handleDevicePOST);

module.exports = router;
