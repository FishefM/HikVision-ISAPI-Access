const express = require('express');
const cors = require('cors');
const axios = require('axios');
const xml2js = require('xml2js');
const path = require('path');
const dbHelper = require('./db');
const deviceHelper = require('./device');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and basic parsing with rawBody capture
app.use(cors());

// 1. JSON body parser with raw body verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// 2. URL-encoded body parser with raw body verification
app.use(express.urlencoded({
  extended: true,
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// 3. Text/XML body parser to capture raw XML/plain text without consuming streams twice
app.use(express.text({
  type: ['*/xml', 'application/xml', 'text/xml', 'text/plain'],
  limit: '10mb'
}));

// 4. Middleware to process text bodies and parse XML
app.use((req, res, next) => {
  // If the body is still a raw text string (from express.text), copy to rawBody and parse if XML
  if (typeof req.body === 'string') {
    req.rawBody = req.body;
    
    const isXml = req.headers['content-type'] && 
                 (req.headers['content-type'].includes('/xml') || req.headers['content-type'].includes('+xml'));
                 
    if (isXml) {
      xml2js.parseString(req.rawBody, { explicitArray: false, mergeAttrs: true }, (err, result) => {
        if (err) {
          logEvent('warning', 'Failed to parse incoming XML body formally. Fallback parser will be used.');
        } else {
          req.body = result;
        }
        next();
      });
      return;
    }
  }
  next();
});

const crypto = require('crypto');
// Generate a session token that lasts as long as the server is running
const currentSessionToken = crypto.randomBytes(32).toString('hex');

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

const authMiddleware = (req, res, next) => {
  // Define public static assets and public API endpoints
  const publicRoutes = [
    '/login.html',
    '/feedback.html',
    '/api/login',
    '/api/logs-stream'
  ];

  // Check if path is public, static assets, or Hikvision terminal POST events
  if (
    publicRoutes.includes(req.path) ||
    req.path.startsWith('/css/') ||
    req.path.startsWith('/js/') ||
    req.path.startsWith('/favicon.ico') ||
    (req.method === 'POST' && (
      req.path === '/' || 
      req.path === '/event' || 
      req.path === '/api/event' || 
      req.path.startsWith('/ISAPI/') || 
      req.path === '/remoteCheck'
    ))
  ) {
    return next();
  }

  // Verify session cookie
  const cookies = parseCookies(req);
  if (cookies.admin_session === currentSessionToken) {
    return next();
  }

  // Redirect page requests to login.html
  if (req.path === '/' || req.path.endsWith('.html')) {
    return res.redirect('/login.html');
  }

  // Deny access to other API endpoints
  return res.status(401).json({ error: 'No autorizado. Por favor inicie sesión.' });
};

// Protect all admin routes and APIs
app.use(authMiddleware);

// Serve static dashboard files with cache disabled for instant UI updates
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

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

/**
 * Sends real-time visual feedback details to dedicated feedback screens.
 */
function sendFeedbackToScreen(authorized, name, userId, reason) {
  const feedbackObj = {
    type: 'access_feedback',
    authorized,
    name,
    userId,
    reason
  };
  const data = JSON.stringify(feedbackObj);
  sseClients.forEach(client => {
    client.write(`data: ${data}\n\n`);
  });
}

/**
 * Extract User ID and Serial Number from the request.
 * Uses formal parsed body, but falls back to regex search over rawBody for high reliability.
 */
function extractDeviceRequestInfo(req) {
  let userId = null;
  let serialNo = '1';
  let eventType = 'unknown';
  let isHeartbeat = false;

  // Detect heartbeat from rawBody or parsed body
  if (req.rawBody && (req.rawBody.includes('"heartBeat"') || req.rawBody.includes('"heartbeat"') || req.rawBody.includes('heartBeat') || req.rawBody.includes('heartbeat') || req.rawBody.includes('HEARTBEAT'))) {
    isHeartbeat = true;
    eventType = 'heartBeat';
  }

  // 1. Check formal parsed XML or JSON
  if (req.body) {
    const root = req.body.AccessControllerEvent || req.body.EventNotificationAlert || req.body;
    
    if (root) {
      if (root.eventType === 'heartBeat' || root.eventDescription === 'heartBeat' || root.eventType === 'heartbeat') {
        isHeartbeat = true;
        eventType = 'heartBeat';
      }
      
      if (!isHeartbeat) {
        userId = root.employeeNoString || root.cardNo || root.userId || root.userNo;
        if (root.serialNo) serialNo = String(root.serialNo);
        if (root.currentVerifyMode) eventType = root.currentVerifyMode;
        else if (root.eventType) eventType = root.eventType;
      }
    }
  }

  // 2. Fallback to Regex search in case of multipart or parse issues (only if not a heartbeat)
  if (!isHeartbeat && !userId && req.rawBody) {
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

  return { userId, serialNo, eventType, isHeartbeat };
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
    sendFeedbackToScreen(false, 'Desconocido', null, 'ID de usuario no proporcionado');
    return { authorized: false, reason: 'No User ID found', serialNo };
  }

  // 1. Check SQLite database for user
  logEvent('info', `Consultando base de datos para el usuario ID: ${userId}...`);
  const user = await dbHelper.getUserById(userId);

  if (!user) {
    logEvent('warning', `Usuario con ID ${userId} no está registrado en la base de datos local.`);
    await dbHelper.addLog(userId, 'No registrado', eventType, 'N/A', { error: 'User not registered' }, false, false);
    sendFeedbackToScreen(false, 'Desconocido', userId, 'ID de tarjeta no registrado');
    return { authorized: false, reason: 'User not registered', serialNo };
  }

  logEvent('success', `Usuario encontrado: "${user.name}". URL de validación: ${user.api_url}`);

  // 2. Query the user's custom API
  logEvent('info', `Llamando a la API externa de validación...`);
  let authorized = false;
  let apiResponse = null;

  try {
    const isLocalMock = user.api_url.includes('localhost') || user.api_url.includes('127.0.0.1');
    const apiParams = isLocalMock ? {
      userId: user.user_id,
      name: user.name,
      eventType: eventType
    } : {};

    const apiResponseCall = await axios.get(user.api_url, {
      params: apiParams,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      },
      timeout: 10000 // 10 seconds timeout
    });

    apiResponse = apiResponseCall.data;
    logEvent('info', `API Respuesta (Status ${apiResponseCall.status}): ${JSON.stringify(apiResponse)}`);

    if (apiResponseCall.status === 200 && apiResponse) {
      if (apiResponse.student) {
        authorized = true;
        // Dynamically update the user's name with the one returned by the API
        user.name = apiResponse.student;
      } else if (
        apiResponse.authorized === true ||
        apiResponse.allow === true ||
        apiResponse.status === 'allow' ||
        apiResponse.access === 'grant' ||
        apiResponse.access === true
      ) {
        authorized = true;
      } else if (apiResponse.message && 
                (apiResponse.message.toLowerCase().includes('asistencia') || 
                 apiResponse.message.toLowerCase().includes('registrada') || 
                 apiResponse.message.toLowerCase().includes('éxito') ||
                 apiResponse.message.toLowerCase().includes('exito'))) {
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

  // Determine deny reason if any
  let denyReason = 'Acceso Autorizado';
  if (!authorized) {
    if (apiResponse && apiResponse.message) {
      denyReason = apiResponse.message;
    } else if (apiResponse && apiResponse.error) {
      denyReason = `Error: ${apiResponse.error}`;
    } else {
      denyReason = 'Rechazado por API de Asistencia';
    }
  }

  // Send feedback event to dedicated screen
  sendFeedbackToScreen(authorized, user.name, userId, denyReason);

  return { authorized, name: user.name, serialNo, doorOpened };
}

// ----------------------------------------------------
// Hikvision Device Integration Endpoints
// We catch events on multiple paths to ease user configuration
// ----------------------------------------------------
const handleDevicePOST = async (req, res) => {
  const reqInfo = extractDeviceRequestInfo(req);
  const clientIp = req.ip || req.connection.remoteAddress;

  // Handle Heartbeat silently to avoid cluttering logs and DB
  if (reqInfo.isHeartbeat) {
    console.log(`[DEBUG] Heartbeat recibido del dispositivo IP: ${clientIp}`);
    
    // Check if JSON or XML response format is expected
    const isJsonRequested = req.url.includes('format=json') || 
                            (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) ||
                            (req.rawBody && req.rawBody.includes('application/json'));

    if (isJsonRequested) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({
        ResponseStatus: {
          requestURL: req.url || '/',
          statusCode: 1,
          statusString: "OK",
          subStatusCode: "ok"
        }
      });
    } else {
      res.setHeader('Content-Type', 'application/xml');
      const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<ResponseStatus version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <requestURL>${req.url || '/'}</requestURL>
    <statusCode>1</statusCode>
    <statusString>OK</statusString>
    <subStatusCode>ok</subStatusCode>
</ResponseStatus>`;
      return res.status(200).send(xmlResponse);
    }
  }

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
// Authentication Endpoints
// ----------------------------------------------------

app.post('/api/login', async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Contraseña requerida.' });
  }

  try {
    const settings = await dbHelper.getSettings();
    const storedPassword = settings.admin_password || 'admin123';
    
    if (password === storedPassword) {
      res.setHeader('Set-Cookie', `admin_session=${currentSessionToken}; Path=/; HttpOnly; SameSite=Strict`);
      return res.json({ success: true, message: 'Sesión iniciada correctamente.' });
    } else {
      return res.status(401).json({ error: 'Contraseña incorrecta.' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Error del servidor al iniciar sesión.' });
  }
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  return res.json({ success: true, message: 'Sesión cerrada.' });
});

app.get('/api/auth-check', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.admin_session === currentSessionToken) {
    return res.json({ authenticated: true });
  }
  return res.json({ authenticated: false });
});

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
