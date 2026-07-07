const axios = require('axios');
const dbHelper = require('../config/database');
const deviceHelper = require('../utils/device');
const { logEvent, broadcastFeedback } = require('../utils/logger');

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
    broadcastFeedback(false, 'Desconocido', null, 'ID de usuario no proporcionado');
    return { authorized: false, reason: 'No User ID found', serialNo };
  }

  // 1. Check SQLite database for user
  logEvent('info', `Consultando base de datos para el usuario ID: ${userId}...`);
  const user = await dbHelper.getUserById(userId);

  if (!user) {
    logEvent('warning', `Usuario con ID ${userId} no está registrado en la base de datos local.`);
    await dbHelper.addLog(userId, 'No registrado', eventType, 'N/A', { error: 'User not registered' }, false, false);
    broadcastFeedback(false, 'Desconocido', userId, 'ID de tarjeta no registrado');
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
    if (apiErr.response && apiErr.response.data) {
      apiResponse = apiErr.response.data;
      if (typeof apiResponse === 'string') {
        apiResponse = { error: apiResponse };
      }
      logEvent('info', `API Respuesta de Error (Status ${apiErr.response.status}): ${JSON.stringify(apiResponse)}`);
    } else {
      apiResponse = { error: apiErr.message };
    }
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
      denyReason = apiResponse.error;
    } else {
      denyReason = 'Rechazado por API de Asistencia';
    }
  }

  // Send feedback event to dedicated screen
  broadcastFeedback(authorized, user.name, userId, denyReason);

  return { authorized, name: user.name, serialNo, doorOpened, reason: denyReason };
}

/**
 * Handle incoming Hikvision device POST event packets
 */
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

/**
 * Handles test scans sent from the simulator dashboard.
 */
async function testScan(req, res) {
  const { userId, eventType } = req.body;
  const clientIp = '127.0.0.1 (Simulado)';
  
  logEvent('info', `Simulando escaneo de usuario para ID: ${userId}`);
  
  try {
    const result = await processAccessRequest({
      userId,
      serialNo: String(Math.floor(Math.random() * 1000)),
      eventType: eventType || 'simulated_scan',
      isHeartbeat: false
    }, clientIp);
    
    res.json(result);
  } catch (e) {
    logEvent('error', `Error en simulación: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}

// ----------------------------------------------------
// Mock External APIs for local testing
// ----------------------------------------------------
function mockExternalApiAllow(req, res) {
  const { userId } = req.query;
  res.json({
    authorized: true,
    userId: userId,
    status: 'allow',
    message: 'Validación exitosa, acceso concedido por la API de Recursos Humanos.'
  });
}

function mockExternalApiDeny(req, res) {
  const { userId } = req.query;
  res.json({
    authorized: false,
    userId: userId,
    status: 'deny',
    message: 'Acceso denegado: Licencia vencida o fuera de horario.'
  });
}

function mockExternalApiError(req, res) {
  res.status(500).json({
    error: 'Internal Database Failure',
    code: 'DB_UNREACHABLE'
  });
}

module.exports = {
  handleDevicePOST,
  testScan,
  mockExternalApiAllow,
  mockExternalApiDeny,
  mockExternalApiError
};
