const http = require('http');
const https = require('https');
const axios = require('axios');
const dbHelper = require('../config/database');
const deviceHelper = require('../utils/device');
const { logEvent, broadcastFeedback, broadcastVerifying } = require('../utils/logger');

// Agentes HTTP con IPv4 forzada y sin sockets persistentes colgados
const cleanHttpAgent = new http.Agent({ keepAlive: false, family: 4 });
const cleanHttpsAgent = new https.Agent({ keepAlive: false, family: 4, rejectUnauthorized: false });

// Control de concurrencia y rebotes múltiples del lector
const inFlightRequests = new Map();
const recentVerifications = new Map();

/**
 * Extrae el user ID y el número de serie de la solicitud del dispositivo.
 * Usa una combinación de análisis XML/JSON y búsqueda con expresiones regulares para manejar diferentes formatos de solicitud.
 * @param {Object} req - Objeto de solicitud Express.
 * @returns {Object} - Contiene userId, serialNo, eventType y isHeartbeat. 
 */
function extractDeviceRequestInfo(req) {
  let userId = null;
  let serialNo = '1';
  let eventType = 'unknown';
  let isHeartbeat = false;

  // Detecta si la solicitud es un latido (heartbeat)
  if (req.rawBody && /heartbeat/i.test(req.rawBody)) {
    isHeartbeat = true;
    eventType = 'heartBeat';
  }

  // XML/JSON Parsing: Intenta analizar la solicitud como JSON o XML para extraer userId y serialNo
  if (req.body) {
    const root = req.body.AccessControllerEvent || 
                 req.body.EventNotificationAlert || 
                 req.body.RemoteCheck || 
                 req.body.remoteCheck || 
                 req.body;
    
    if (root) {
      if (root.eventType === 'heartBeat' || root.eventDescription === 'heartBeat' || root.eventType === 'heartbeat') {
        isHeartbeat = true;
        eventType = 'heartBeat';
      }
      
      if (!isHeartbeat) {
        userId = root.employeeNoString || 
                 root.cardNo || 
                 root.QRCode || 
                 root.qrCode || 
                 root.qrCodeContent || 
                 root.barcode || 
                 root.barCode || 
                 root.codeContent || 
                 root.userId || 
                 root.userNo || 
                 root.employeeNo;
        if (root.serialNo) serialNo = String(root.serialNo);
        if (root.currentVerifyMode) eventType = root.currentVerifyMode;
        else if (root.eventType) eventType = root.eventType;
        if (!eventType || eventType === 'unknown') {
          if (root.QRCode || root.qrCode || root.qrCodeContent) eventType = 'qrCode';
          else if (root.barcode || root.barCode) eventType = 'barcode';
        }
      }
    }
  }

  // Fallback: Si no se encuentra userId, intenta extraerlo usando expresiones regulares desde el cuerpo sin procesar
  if (!isHeartbeat && req.rawBody) {
    // 1. Extraer employeeNoString o employeeNo o userNo
    if (!userId) {
      const employeeNoMatch = req.rawBody.match(/<employeeNoString[^>]*>([^<]+)<\/employeeNoString>/i) || 
                              req.rawBody.match(/"employeeNoString"\s*:\s*["']?([^"',\s}]+)["']?/i) ||
                              req.rawBody.match(/<employeeNo[^>]*>([^<]+)<\/employeeNo>/i) ||
                              req.rawBody.match(/"employeeNo"\s*:\s*["']?([^"',\s}]+)["']?/i) ||
                              req.rawBody.match(/<userNo[^>]*>([^<]+)<\/userNo>/i) ||
                              req.rawBody.match(/"userNo"\s*:\s*["']?([^"',\s}]+)["']?/i);
      if (employeeNoMatch && employeeNoMatch[1]) {
        userId = employeeNoMatch[1].trim();
      }
    }
    
    // 2. Extraer cardNo
    if (!userId) {
      const cardNoMatch = req.rawBody.match(/<cardNo[^>]*>([^<]+)<\/cardNo>/i) || 
                          req.rawBody.match(/"cardNo"\s*:\s*["']?([^"',\s}]+)["']?/i);
      if (cardNoMatch && cardNoMatch[1]) {
        userId = cardNoMatch[1].trim();
        if (eventType === 'unknown') eventType = 'card';
      }
    }

    // 3. Extraer campos de QR / Código de barras (QRCode, qrCode, barcode, etc.)
    if (!userId) {
      const qrMatch = req.rawBody.match(/<QRCode[^>]*>([^<]+)<\/QRCode>/i) ||
                      req.rawBody.match(/"QRCode"\s*:\s*["']?([^"',\s}]+)["']?/i) ||
                      req.rawBody.match(/<qrCode[^>]*>([^<]+)<\/qrCode>/i) ||
                      req.rawBody.match(/"qrCode"\s*:\s*["']?([^"',\s}]+)["']?/i) ||
                      req.rawBody.match(/<qrCodeContent[^>]*>([^<]+)<\/qrCodeContent>/i) ||
                      req.rawBody.match(/"qrCodeContent"\s*:\s*["']?([^"',\s}]+)["']?/i) ||
                      req.rawBody.match(/<codeContent[^>]*>([^<]+)<\/codeContent>/i) ||
                      req.rawBody.match(/"codeContent"\s*:\s*["']?([^"',\s}]+)["']?/i) ||
                      req.rawBody.match(/<barcode[^>]*>([^<]+)<\/barcode>/i) ||
                      req.rawBody.match(/"barcode"\s*:\s*["']?([^"',\s}]+)["']?/i) ||
                      req.rawBody.match(/<barCode[^>]*>([^<]+)<\/barCode>/i) ||
                      req.rawBody.match(/"barCode"\s*:\s*["']?([^"',\s}]+)["']?/i);
      if (qrMatch && qrMatch[1]) {
        userId = qrMatch[1].trim();
        if (eventType === 'unknown') eventType = 'qrCode';
      }
    }

    // 3. Extraer serialNo
    const serialMatch = req.rawBody.match(/<serialNo[^>]*>([^<]+)<\/serialNo>/i) || 
                        req.rawBody.match(/"serialNo"\s*:\s*["']?([^"',\s}]+)["']?/i);
    if (serialMatch && serialMatch[1]) {
      serialNo = serialMatch[1].trim();
    }

    // 4. Extraer currentVerifyMode
    if (eventType === 'unknown') {
      const modeMatch = req.rawBody.match(/<currentVerifyMode[^>]*>([^<]+)<\/currentVerifyMode>/i) ||
                        req.rawBody.match(/"currentVerifyMode"\s*:\s*["']?([^"',\s}]+)["']?/i);
      if (modeMatch && modeMatch[1]) {
        eventType = modeMatch[1].trim();
      }
    }
  }

  return { userId, serialNo, eventType, isHeartbeat };
}

/**
 * Controlador principal de verificacion
/**
 * Ejecuta la llamada a la base de datos, API externa y apertura de puerta
 */
async function executeAccessValidation(reqInfo, clientIp) {
  const { userId, serialNo, eventType } = reqInfo;

  // Checar la base de datos local para el usuario
  logEvent('info', `Consultando base de datos para el usuario ID: ${userId}...`);
  const user = await dbHelper.getUserById(userId);

  if (!user) {
    logEvent('warning', `Usuario con ID ${userId} no está registrado en la base de datos local.`);
    await dbHelper.addLog(userId, 'No registrado', eventType, 'N/A', { error: 'User not registered' }, false, false);
    broadcastFeedback(false, 'Desconocido', userId, 'ID de tarjeta no registrado');
    return { authorized: false, reason: 'User not registered', serialNo };
  }

  logEvent('success', `Usuario encontrado: "${user.name}". URL de validación: ${user.api_url}`);

  // Notificar a la pantalla de feedback que la credencial fue leída y el alumno identificado,
  // indicando que se está esperando la respuesta de la API externa
  broadcastVerifying(user.name, user.user_id, eventType);

  // Query para la API externa del usuario
  logEvent('info', `Llamando a la API externa de validación...`);
  let authorized = false;
  let apiResponse = null;

  try {
    if (!user.api_url) {
      throw new Error('El usuario no tiene configurada una URL de API externa');
    }
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
        'Connection': 'close'
      },
      httpAgent: cleanHttpAgent,
      httpsAgent: cleanHttpsAgent,
      timeout: 8000 // 8 segundos de timeout
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

  // Log
  if (authorized) {
    logEvent('success', `ACCESO AUTORIZADO para el usuario ${user.name} (ID: ${userId})`);
  } else {
    logEvent('warning', `ACCESO DENEGADO para el usuario ${user.name} (ID: ${userId})`);
  }

  // Trigger la puerta se abre si está autorizado y la configuración lo permite
  let doorOpened = false;
  const settings = await dbHelper.getSettings();
  
  // Notificar confirmación RemoteCheck al hardware Hikvision para que la pantalla del lector muestre "Verificado"
  if (serialNo && settings.device_ip && settings.device_user && settings.device_password) {
    deviceHelper.sendRemoteCheck(
      settings.device_ip,
      settings.device_port,
      settings.device_user,
      settings.device_password,
      serialNo,
      authorized
    ).catch(e => console.warn('[Device API] Error enviando confirmación RemoteCheck:', e.message));
  }
  
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

  // Log DB
  await dbHelper.addLog(userId, user.name, eventType, user.api_url, apiResponse, authorized, doorOpened);

  // Determinar la razon de denegacion y la retroalimentacion de la pantalla de feedback
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

  // Envia el Feedback
  broadcastFeedback(authorized, user.name, userId, denyReason);

  return { authorized, name: user.name, serialNo, doorOpened, reason: denyReason };
}

/**
 * Controlador principal de verificacion con proteccion contra rafagas concurrentes y rebotes
 * @param {Object} reqInfo - Información extraída de la solicitud del dispositivo (userId, serialNo, eventType).
 * @param {string} clientIp - Dirección IP del dispositivo que envió la solicitud.
 * @returns {Object} - Resultado de la verificación (authorized, name, serialNo, doorOpened, reason).
 */
async function processAccessRequest(reqInfo, clientIp) {
  const { userId, serialNo, eventType } = reqInfo;

  if (!userId) {
    return { authorized: false, reason: 'No User ID found', serialNo };
  }

  logEvent('info', `=== Solicitud de acceso: ID ${userId} (Serial: ${serialNo}, Modo: ${eventType}) ===`);

  const cleanUserId = String(userId).trim();

  // 1. Deduplicación concurrente: Si ya hay una validación ejecutándose en este mismo instante para este alumno,
  // reutilizamos la misma promesa para no saturar la API externa ni generar bloqueos de concurrencia
  if (inFlightRequests.has(cleanUserId)) {
    logEvent('info', `[Deduplicación] Solicitud concurrente en proceso para ${cleanUserId} (Serial: ${serialNo}). Reutilizando validación activa...`);
    try {
      const inFlightResult = await inFlightRequests.get(cleanUserId);
      const settings = await dbHelper.getSettings();
      if (serialNo && settings.device_ip && settings.device_user && settings.device_password) {
        deviceHelper.sendRemoteCheck(
          settings.device_ip,
          settings.device_port,
          settings.device_user,
          settings.device_password,
          serialNo,
          inFlightResult.authorized
        ).catch(() => {});
      }
      return { ...inFlightResult, serialNo };
    } catch (_) {}
  }

  // 2. Cooldown anti-rebote: Si ya se validó este alumno hace menos de 2.5 segundos,
  // devolvemos el mismo resultado sin volver a disparar la API externa ni cambiar el estado en el torniquete
  if (recentVerifications.has(cleanUserId)) {
    const recent = recentVerifications.get(cleanUserId);
    if (Date.now() - recent.timestamp < 2500) {
      logEvent('info', `[Cooldown] Detección repetida para ${cleanUserId} dentro de 2.5s (Serial: ${serialNo}). Manteniendo veredicto: ${recent.result.authorized ? 'Autorizado' : 'Denegado'}`);
      const settings = await dbHelper.getSettings();
      if (serialNo && settings.device_ip && settings.device_user && settings.device_password) {
        deviceHelper.sendRemoteCheck(
          settings.device_ip,
          settings.device_port,
          settings.device_user,
          settings.device_password,
          serialNo,
          recent.result.authorized
        ).catch(() => {});
      }
      return { ...recent.result, serialNo };
    }
  }

  // 3. Ejecutar validación y almacenar promesa en vuelo
  const validationPromise = executeAccessValidation(reqInfo, clientIp);
  inFlightRequests.set(cleanUserId, validationPromise);

  try {
    const result = await validationPromise;
    recentVerifications.set(cleanUserId, { result, timestamp: Date.now() });
    return result;
  } finally {
    inFlightRequests.delete(cleanUserId);
  }
}

/**
 * Handle en el dispositivo Hikvision
 */
const handleDevicePOST = async (req, res) => {
  const reqInfo = extractDeviceRequestInfo(req);
  const clientIp = req.ip || req.connection.remoteAddress;

  if (reqInfo.isHeartbeat) {
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

  // Si no contiene ID de usuario, es un evento de hardware auxiliar (puerta abierta, cerrada, etc.)
  if (!reqInfo.userId) {
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

    // Retorna la respuesta en el formato solicitado (JSON o XML)
    const isJsonRequested = req.url.includes('format=json') || 
                            (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) ||
                            (req.rawBody && req.rawBody.includes('application/json')) ||
                            (req.rawBody && req.rawBody.trim().startsWith('{'));

    if (isJsonRequested) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({
        RemoteCheck: {
          serialNo: parseInt(result.serialNo) || 1,
          checkResult: result.authorized ? "success" : "failed",
          name: result.name || undefined
        },
        ResponseStatus: {
          requestURL: req.url || '/',
          statusCode: 1,
          statusString: "OK",
          subStatusCode: "ok"
        }
      });
    } else {
      // XML Response
      res.setHeader('Content-Type', 'application/xml');
      const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<RemoteCheck version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <serialNo>${result.serialNo || 1}</serialNo>
    <checkResult>${result.authorized ? "success" : "failed"}</checkResult>
    <name>${result.name || ''}</name>
</RemoteCheck>`;
      return res.status(200).send(xmlResponse);
    }
  } catch (error) {
    logEvent('error', `Error procesando evento del dispositivo: ${error.message}`);
    return res.status(500).send('Internal Server Error');
  }
};

/**
 * Escaneos simulados
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

// Mocks de la API externa para pruebas

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
