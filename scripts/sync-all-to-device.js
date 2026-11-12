#!/usr/bin/env node
/**
 * scripts/sync-all-to-device.js
 * 
 * Redirige a sync-controlled.js para asegurar sincronización controlada
 * sin saturar la API de Hikvision.
 */

require('./sync-controlled');
