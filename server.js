const express = require('express');
const cors = require('cors');
const axios = require('axios');
const xml2js = require('xml2js');
const path = require('path');
const dbHelper = require('./db');
const deviceHelper = require('./device');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and basic parsing
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static dashboard files
app.use(express.static(path.join(__dirname, 'public')));

// Server-Sent Events (SSE) clients for real-time logs
let sseClients = [];

/**
 * Sends a real-time event log to all connected dashboards.
 */
function logEvent(type, message) {
  const timestamp = new Date().toLocaleTimeString();
  const dateStr = new Date().toISOString().split('T')[0];
  const logObj = { type, message, timestamp: `${dateStr} ${timestamp}` };
  
  // Console logging with simple color representations
  const prefix = {
    info: '\x1b[36m[INFO]\x1b[0m',     // Cyan
    success: '\x1b[32m[SUCCESS]\x1b[0m', // Green
    warning: '\x1b[33m[WARNING]\x1b[0m', // Yellow
    error: '\x1b[31m[ERROR]\x1b[0m'     // Red
  }[type] || '[LOG]';

  console.log(`${prefix} ${message}`);

  // Broadcast to SSE clients
  const data = JSON.stringify(logObj);
  sseClients.forEach(client => {
    client.write(`data: ${data}\n\n`);
  });
}

// Middleware to capture raw body text (useful for fallback XML/JSON parsing and regex search)
app.use((req, res, next) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => {
    data += chunk;
  });
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
});

// Middleware to parse XML bodies
app.use((req, res, next) => {
  if (req.rawBody && req.headers['content-type'] && 
     (req.headers['content-type'].includes('/xml') || req.headers['content-type'].includes('+xml'))) {
    xml2js.parseString(req.rawBody, { explicitArray: false, mergeAttrs: true }, (err, result) => {
      if (err) {
        logEvent('warning', 'Failed to parse incoming XML body formally. Fallback parser will be used.');
      } else {
        req.body = result;
      }
      next();
    });
  } else if (req.rawBody && req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
    try {
      req.body = JSON.parse(req.rawBody);
    } catch (e) {
      // JSON parsing failed, let other handlers try
    }
    next();
  } else {
    next();
  }
});

/**
 * Extract User ID and Serial Number from the request.
 * Uses formal parsed body, but falls back to regex search over rawBody for high reliability.
 */
function extractDeviceRequestInfo(req) {
  let userId = null;
  let serialNo = '1';
  let eventType = 'unknown';

  // 1. Check formal parsed XML or JSON
  if (req.body) {
    const root = req.body.AccessControllerEvent || req.body.EventNotificationAlert || req.body;
    
    if (root) {
      userId = root.employeeNoString || root.cardNo || root.userId || root.userNo;
      if (root.serialNo) serialNo = String(root.serialNo);
      if (root.currentVerifyMode) eventType = root.currentVerifyMode;
      else if (root.eventType) eventType = root.eventType;
    }
  }

  // 2. Fallback to Regex search in case of multipart or parse issues
  if (!userId && req.rawBody) {
    // Try employeeNoString
    const employeeNoMatch = req.rawBody.match(/<employeeNoString[^>]*>([^<]+)<\/employeeNoString>/) || 
                            req.rawBody.match(/"employeeNoString"\s*:\s*["']?([^"',\s}]+)["']?/);
    if (employeeNoMatch && employeeNoMatch[1]) {
      userId = employeeNoMatch[1].trim();
    }
    
    // Try cardNo
    if (!userId) {
      const cardNoMatch = req.rawBody.match(/<cardNo[^>]*>([^<]+)<\/cardNo>/) || 
                          req.rawBody.match(/"cardNo"\s*:\s*["']?([^"',\s}]+)["']?/);
      if (cardNoMatch && cardNoMatch[1]) {
        userId = cardNoMatch[1].trim();
        eventType = 'card';
      }
    }

    // Try serialNo
    const serialMatch = req.rawBody.match(/<serialNo[^>]*>([^<]+)<\/serialNo>/) || 
                        req.rawBody.match(/"serialNo"\s*:\s*["']?([^"',\s}]+)["']?/);
    if (serialMatch && serialMatch[1]) {
      serialNo = serialMatch[1].trim();
    }
  }

  return { userId, serialNo, eventType };
}

/**
 * Main verification controller.
 * Processes the access request, checks DB, queries user's custom API, and triggers door.
 */
async function processAccessRequest(reqInfo, clientIp) {
  const { userId, serialNo, eventType } = reqInfo;

  logEvent('info', `=== Nueva solicitud de acceso ===`);
  logEvent('info', `Dispositivo IP: ${clientIp}`);
  logEvent('info', `ID de Usuario extraído: ${userId || 'No encontrado'}`);
  logEvent('info', `Event Serial No: ${serialNo}`);
  logEvent('info', `Tipo de verificación: ${eventType}`);

  if (!userId) {
    logEvent('error', 'Rechazado: ID de usuario no proporcionado en la solicitud.');
    await dbHelper.addLog(null, 'Desconocido', eventType, 'N/A', { error: 'No User ID found' }, false, false);
    return { authorized: false, reason: 'No User ID found', serialNo };
  }

  // 1. Check SQLite database for user
  logEvent('info', `Consultando base de datos para el usuario ID: ${userId}...`);
  const user = await dbHelper.getUserById(userId);

  if (!user) {
    logEvent('warning', `Usuario con ID ${userId} no está registrado en la base de datos local.`);
    await dbHelper.addLog(userId, 'No registrado', eventType, 'N/A', { error: 'User not registered' }, false, false);
    return { authorized: false, reason: 'User not registered', serialNo };
  }

  logEvent('success', `Usuario encontrado: "${user.name}". URL de validación: ${user.api_url}`);

  // 2. Query the user's custom API
  logEvent('info', `Llamando a la API externa de validación...`);
  let authorized = false;
  let apiResponse = null;

  try {
    const apiResponseCall = await axios.get(user.api_url, {
      params: {
        userId: user.user_id,
        name: user.name,
        eventType: eventType
      },
      timeout: 4000 // 4 seconds timeout
    });

    apiResponse = apiResponseCall.data;
    logEvent('info', `API Respuesta (Status ${apiResponseCall.status}): ${JSON.stringify(apiResponse)}`);

    if (apiResponseCall.status === 200 && apiResponse) {
      if (
        apiResponse.authorized === true ||
        apiResponse.allow === true ||
        apiResponse.status === 'allow' ||
        apiResponse.access === 'grant' ||
        apiResponse.access === true
      ) {
        authorized = true;
      }
    }
  } catch (apiErr) {
    logEvent('error', `Error al consultar API externa: ${apiErr.message}`);
    apiResponse = { error: apiErr.message };
  }

  // 3. Log the decision
  if (authorized) {
    logEvent('success', `ACCESO AUTORIZADO para el usuario ${user.name} (ID: ${userId})`);
  } else {
    logEvent('warning', `ACCESO DENEGADO para el usuario ${user.name} (ID: ${userId})`);
  }

  // 4. Trigger door release on the device (if enabled in settings)
  let doorOpened = false;
  const settings = await dbHelper.getSettings();
  
  if (authorized && settings.enable_device_api_open === 'true') {
    logEvent('info', `Iniciando apertura remota de puerta en el dispositivo...`);
    const openResult = await deviceHelper.openDoor(
      settings.device_ip,
      settings.device_port,
      settings.device_user,
      settings.device_password,
      settings.device_door_channel
    );

    if (openResult.success) {
      logEvent('success', `Puerta abierta exitosamente por API en dispositivo.`);
      doorOpened = true;
    } else {
      logEvent('error', `Fallo al abrir la puerta por API: ${openResult.error || 'Respuesta inesperada'}`);
    }
  } else if (authorized) {
    logEvent('info', `Apertura por API de dispositivo omitida (está desactivada o requiere respuesta HTTP directa).`);
  }

  // Write log to DB
  await dbHelper.addLog(userId, user.name, eventType, user.api_url, apiResponse, authorized, doorOpened);

  return { authorized, name: user.name, serialNo, doorOpened };
}

// ----------------------------------------------------
// Hikvision Device Integration Endpoints
// We catch events on multiple paths to ease user configuration
// ----------------------------------------------------
const handleDevicePOST = async (req, res) => {
  const reqInfo = extractDeviceRequestInfo(req);
  const clientIp = req.ip || req.connection.remoteAddress;

  try {
    const result = await processAccessRequest(reqInfo, clientIp);

    // Return the response in the format requested by the device (XML or JSON)
    const isJsonRequested = req.url.includes('format=json') || 
                            (req.headers['content-type'] && req.headers['content-type'].includes('application/json'));

    if (isJsonRequested) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({
        RemoteCheck: {
          serialNo: parseInt(result.serialNo) || 1,
          checkResult: result.authorized ? "success" : "failed"
        }
      });
    } else {
      // Default to XML
      res.setHeader('Content-Type', 'application/xml');
      const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<RemoteCheck version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <serialNo>${result.serialNo || 1}</serialNo>
    <checkResult>${result.authorized ? "success" : "failed"}</checkResult>
</RemoteCheck>`;
      return res.status(200).send(xmlResponse);
    }
  } catch (error) {
    logEvent('error', `Error procesando evento del dispositivo: ${error.message}`);
    return res.status(500).send('Internal Server Error');
  }
};

// Catch requests on common Hikvision upload/remoteCheck paths
app.post('/', handleDevicePOST);
app.post('/event', handleDevicePOST);
app.post('/api/event', handleDevicePOST);
app.post('/ISAPI/AccessControl/remoteCheck', handleDevicePOST);
app.post('/remoteCheck', handleDevicePOST);

// ----------------------------------------------------
// Dashboard SSE Log Stream
// ----------------------------------------------------
app.get('/api/logs-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);
  logEvent('info', `Panel de control conectado al flujo de eventos.`);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
    console.log('[INFO] Panel de control desconectado.');
  });
});

// ----------------------------------------------------
// Admin REST APIs
// ----------------------------------------------------

// Users Management
app.get('/api/users', async (req, res) => {
  try {
    const users = await dbHelper.getUsers();
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users', async (req, res) => {
  const { user_id, name, api_url } = req.body;
  if (!user_id || !name || !api_url) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }
  try {
    const newUser = await dbHelper.addUser(user_id, name, api_url);
    logEvent('info', `Usuario agregado: ${name} (ID: ${user_id})`);
    res.status(201).json(newUser);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/users/:id', async (req, res) => {
  const { user_id, name, api_url } = req.body;
  const { id } = req.params;
  if (!user_id || !name || !api_url) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }
  try {
    await dbHelper.updateUser(id, user_id, name, api_url);
    logEvent('info', `Usuario actualizado ID DB: ${id} -> ${name} (ID: ${user_id})`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await dbHelper.deleteUser(id);
    logEvent('info', `Usuario eliminado ID DB: ${id}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Logs Management
app.get('/api/logs', async (req, res) => {
  try {
    const logs = await dbHelper.getLogs();
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logs/clear', async (req, res) => {
  try {
    await dbHelper.clearLogs();
    logEvent('info', 'Historial de registros limpiado.');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Settings Management
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await dbHelper.getSettings();
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    await dbHelper.updateSettings(req.body);
    logEvent('info', 'Configuración de dispositivo actualizada.');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Test Simulation Endpoint
app.post('/api/test-scan', async (req, res) => {
  const { userId, eventType } = req.body;
  const clientIp = '127.0.0.1 (Simulado)';
  
  logEvent('info', `Simulando escaneo de usuario para ID: ${userId}`);
  
  try {
    const result = await processAccessRequest({
      userId,
      serialNo: String(Math.floor(Math.random() * 10000)),
      eventType: eventType || 'simulated'
    }, clientIp);
    
    res.json(result);
  } catch (error) {
    logEvent('error', `Error en simulación: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Device Open Door Test Endpoint
app.post('/api/test-open-door', async (req, res) => {
  logEvent('info', 'Ejecutando comando de prueba para abrir puerta en dispositivo...');
  try {
    const settings = await dbHelper.getSettings();
    const openResult = await deviceHelper.openDoor(
      settings.device_ip,
      settings.device_port,
      settings.device_user,
      settings.device_password,
      settings.device_door_channel
    );

    if (openResult.success) {
      logEvent('success', 'Comando de puerta exitoso. La puerta debería estar abierta.');
      res.json({ success: true, message: 'Puerta abierta con éxito.' });
    } else {
      logEvent('error', `Error al abrir la puerta: ${openResult.error || 'Respuesta de dispositivo incorrecta'}`);
      res.status(500).json({ success: false, error: openResult.error || 'Respuesta del dispositivo no válida', raw: openResult.data });
    }
  } catch (e) {
    logEvent('error', `Excepción al abrir puerta: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------
// Mock External APIs for local testing
// ----------------------------------------------------
app.get('/api/mock-external-api/allow', (req, res) => {
  const { userId } = req.query;
  res.json({
    authorized: true,
    userId: userId,
    status: 'allow',
    message: 'Validación exitosa, acceso concedido por la API de Recursos Humanos.'
  });
});

app.get('/api/mock-external-api/deny', (req, res) => {
  const { userId } = req.query;
  res.json({
    authorized: false,
    userId: userId,
    status: 'deny',
    message: 'Acceso denegado: Licencia vencida o fuera de horario.'
  });
});

app.get('/api/mock-external-api/error', (req, res) => {
  res.status(500).json({
    error: 'Internal Database Failure',
    code: 'DB_UNREACHABLE'
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  SERVIDOR DE CONTROL DE ACCESO INICIADO EN PUERTO ${PORT}`);
  console.log(`  Admin Dashboard: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
  logEvent('info', `Servidor iniciado en puerto ${PORT}`);
});
