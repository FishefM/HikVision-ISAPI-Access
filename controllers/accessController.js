const dbHelper = require('../config/database');
const deviceHelper = require('../utils/device');
const { logEvent, broadcastFeedback, broadcastVerifying, broadcastHeartbeat, sseClients } = require('../utils/logger');

// Control de concurrencia y rebotes múltiples del lector
const inFlightRequests = new Map();
const recentVerifications = new Map();

// Límite máximo de tiempo estricto para evitar timeout físico en terminal Hikvision (< 1500ms)
const DEFAULT_EXTERNAL_TIMEOUT_MS = parseInt(process.env.EXTERNAL_API_TIMEOUT_MS, 10) || 1100;
const MAX_TOTAL_BUDGET_MS = 1350;

/**
 * Consulta la API externa usando fetch nativo de Node.js
 * con presupuesto estricto de tiempo (< 1350ms) para garantizar respuesta dentro de los 1.5s de Hikvision.
 */
async function queryExternalApi(apiUrl, userId, name, eventType) {
  const isLocalMock = apiUrl.includes('localhost') || apiUrl.includes('127.0.0.1');
  let requestUrl = apiUrl;
  if (isLocalMock) {
    try {
      const parsedUrl = new URL(requestUrl);
      parsedUrl.searchParams.set('userId', userId);
      parsedUrl.searchParams.set('name', name);
      parsedUrl.searchParams.set('eventType', eventType);
      requestUrl = parsedUrl.toString();
    } catch (_) {}
  }

  const overallStart = Date.now();
  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const elapsed = Date.now() - overallStart;
    const remainingBudget = MAX_TOTAL_BUDGET_MS - elapsed;

    // Si quedan menos de 250ms, abortar para no exceder la ventana del hardware
    if (remainingBudget <= 250) {
      break;
    }

    const currentTimeout = Math.min(DEFAULT_EXTERNAL_TIMEOUT_MS, remainingBudget);
    const t0 = Date.now();

    try {
      const response = await fetch(requestUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(currentTimeout)
      });

      const contentType = response.headers.get('content-type') || '';
      let data = null;
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        const text = await response.text();
        try {
          data = JSON.parse(text);
        } catch (_) {
          if (text.includes('<html') || text.includes('<!DOCTYPE') || text.includes('<body')) {
            const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
            const title = titleMatch ? titleMatch[1].trim() : `Página no encontrada (HTTP ${response.status})`;
            data = { message: `[HTTP ${response.status}] ${title}` };
          } else {
            data = { message: text.slice(0, 200) };
          }
        }
      }

      return { status: response.status, data, duration: Date.now() - t0 };
    } catch (err) {
      const isTimeout = err.name === 'TimeoutError' || 
                        err.name === 'AbortError' || 
                        (err.message && err.message.toLowerCase().includes('timeout'));

      if (isTimeout) {
        lastError = new Error(`API_TIMEOUT: La API externa excedió el tiempo límite (${currentTimeout}ms) del torniquete`);
      } else {
        lastError = err;
      }

      // Solo reintentar si el tiempo restante total permite al menos un intento de 350ms
      const timeRemainingForRetry = MAX_TOTAL_BUDGET_MS - (Date.now() - overallStart);
      if (attempt < maxAttempts && timeRemainingForRetry > 400 && !isTimeout) {
        logEvent('info', `Reintentando consulta a API externa tras fallo transitorio (${err.message})...`);
        await new Promise(r => setTimeout(r, 60));
      } else {
        break;
      }
    }
  }

  throw lastError || new Error('No se pudo conectar con la API externa');
}

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
  let bodyDevice = null;

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

      bodyDevice = root.deviceId || root.device_id || root.device ||
                   root.deviceName || root.DeviceName || 
                   root.deviceNo || root.DeviceNo || 
                   root.devIndex || root.DevIndex || 
                   root.ipAddress || root.devIp || root.netId || root.subDevId;
    }
  }

  // Comprobar también en el objeto raíz req.body si no se encontró dentro de root
  if (!bodyDevice && req.body) {
    bodyDevice = req.body.deviceId || req.body.device_id || req.body.device ||
                 req.body.deviceName || req.body.DeviceName ||
                 req.body.deviceNo || req.body.DeviceNo ||
                 req.body.devIndex || req.body.DevIndex ||
                 req.body.ipAddress || req.body.devIp;
  }

  // Fallback: Si no se encuentra userId en credenciales, buscar en el cuerpo sin procesar
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

    // 3. Extraer campos de QR / Código de barras
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

    const serialMatch = req.rawBody.match(/<serialNo[^>]*>([^<]+)<\/serialNo>/i) || 
                        req.rawBody.match(/"serialNo"\s*:\s*["']?([^"',\s}]+)["']?/i);
    if (serialMatch && serialMatch[1]) {
      serialNo = serialMatch[1].trim();
    }

    if (eventType === 'unknown') {
      const modeMatch = req.rawBody.match(/<currentVerifyMode[^>]*>([^<]+)<\/currentVerifyMode>/i) ||
                        req.rawBody.match(/"currentVerifyMode"\s*:\s*["']?([^"',\s}]+)["']?/i);
      if (modeMatch && modeMatch[1]) {
        eventType = modeMatch[1].trim();
      }
    }
  }

  // Extraer pistas de torniquete del cuerpo sin procesar (incluso si es un latido heartbeat)
  if (!bodyDevice && req.rawBody) {
    const devIdMatch = req.rawBody.match(/<deviceId[^>]*>([^<]+)<\/deviceId>/i) ||
                       req.rawBody.match(/"deviceId"\s*:\s*["']?([^"',\s}]+)["']?/i) ||
                       req.rawBody.match(/<device_id[^>]*>([^<]+)<\/device_id>/i) ||
                       req.rawBody.match(/"device_id"\s*:\s*["']?([^"',\s}]+)["']?/i) ||
                       req.rawBody.match(/"device"\s*:\s*["']?([^"',\s}]+)["']?/i);
    if (devIdMatch && devIdMatch[1]) {
      bodyDevice = devIdMatch[1].trim();
    }
    if (!bodyDevice) {
      const devNameMatch = req.rawBody.match(/<deviceName[^>]*>([^<]+)<\/deviceName>/i) ||
                           req.rawBody.match(/"deviceName"\s*:\s*["']?([^"',\s}]+)["']?/i);
      if (devNameMatch && devNameMatch[1]) {
        bodyDevice = devNameMatch[1].trim();
      }
    }
    if (!bodyDevice) {
      const devNoMatch = req.rawBody.match(/<deviceNo[^>]*>([^<]+)<\/deviceNo>/i) ||
                         req.rawBody.match(/"deviceNo"\s*:\s*["']?([^"',\s}]+)["']?/i) ||
                         req.rawBody.match(/<devIndex[^>]*>([^<]+)<\/devIndex>/i) ||
                         req.rawBody.match(/"devIndex"\s*:\s*["']?([^"',\s}]+)["']?/i);
      if (devNoMatch && devNoMatch[1]) {
        bodyDevice = devNoMatch[1].trim();
      }
    }
    if (!bodyDevice) {
      const devIpMatch = req.rawBody.match(/<ipAddress[^>]*>([^<]+)<\/ipAddress>/i) ||
                         req.rawBody.match(/"ipAddress"\s*:\s*["']?([^"',\s}]+)["']?/i);
      if (devIpMatch && devIpMatch[1]) {
        bodyDevice = devIpMatch[1].trim();
      }
    }
  }

  // Mostrar la informacion del MinMoe en consola exclusivamente cuando esta leyendo credenciales/usuarios (omitiendo heartbeats)
  const isReading = !isHeartbeat && (userId || (eventType && eventType !== 'unknown' && eventType !== 'heartBeat'));
  if (isReading) {
    if (req.rawBody) {
      const boundaryMatch = req.rawBody.match(/--MIME_boundary[\s\S]*?--MIME_boundary/);
      const textToDisplay = (boundaryMatch && req.rawBody.length > 3000) ? boundaryMatch[0] + '--' : req.rawBody;
      console.log(`\n[DEBUG Request Hikvision (${req.headers['content-type'] || 'sin content-type'})]:\n${textToDisplay}`);
    }
    if (req.body) {
      console.log(`[DEBUG Parsed JSON/XML Body]:\n${JSON.stringify(req.body, null, 2)}\n`);
    }
  }

  // Pista de torniquete por parámetros, query, headers o URL
  const nonDeviceKeywords = ['event', 'events', 'isapi', 'remotecheck', 'events-stream', 'logs-stream'];
  let deviceId = (req.params && req.params.id) ? req.params.id : null;
  if (deviceId && nonDeviceKeywords.includes(String(deviceId).toLowerCase())) {
    deviceId = null;
  }
  if (!deviceId && req.query) {
    deviceId = req.query.deviceId || req.query.device || req.query.id || null;
  }
  if (deviceId && nonDeviceKeywords.includes(String(deviceId).toLowerCase())) {
    deviceId = null;
  }
  if (!deviceId && req.headers) {
    deviceId = req.headers['x-device-id'] || req.headers['x-device-name'] || req.headers['x-device'] || null;
  }
  if (!deviceId && (req.originalUrl || req.url)) {
    const urlMatch = (req.originalUrl || req.url).match(/\/(?:device|devices)\/([^\/?#]+)/i);
    if (urlMatch && urlMatch[1] && !nonDeviceKeywords.includes(urlMatch[1].toLowerCase())) {
      deviceId = decodeURIComponent(urlMatch[1]);
    }
  }

  return { userId, serialNo, eventType, isHeartbeat, deviceId, bodyDevice };
}

/**
 * Extrae una dirección IPv4 limpia omitiendo prefijos IPv6 y normalizando octetos
 */
function cleanIPv4(ip) {
  if (!ip) return '';
  let str = String(ip).trim();
  if (str === '::1' || str === '::') return '127.0.0.1';
  if (str.includes('::ffff:')) {
    str = str.replace('::ffff:', '');
  }
  if (str.includes('.') && str.includes(':')) {
    str = str.split(':')[0].trim();
  }
  const parts = str.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p.trim()))) {
    return parts.map(p => parseInt(p.trim(), 10)).join('.');
  }
  return str;
}

/**
 * Coincidencia flexible de nombres de torniquetes (insensible a mayúsculas y espacios)
 */
function matchDeviceName(devName, hint) {
  if (!devName || !hint) return false;
  const n1 = String(devName).trim().toLowerCase();
  const n2 = String(hint).trim().toLowerCase();
  if (n1 === n2) return true;
  if (n1.replace(/\s+/g, '') === n2.replace(/\s+/g, '')) return true;
  if (n1.length >= 3 && (n2.includes(n1) || n1.includes(n2))) return true;
  return false;
}

/**
 * Obtiene la dirección IP real del cliente considerando cabeceras de proxy inverso
 */
function getClientIp(req) {
  if (!req) return '127.0.0.1';
  const forwarded = req.headers && req.headers['x-forwarded-for'];
  if (forwarded) {
    const parts = String(forwarded).split(',').map(s => s.trim());
    if (parts.length > 0 && parts[0]) {
      return cleanIPv4(parts[0]);
    }
  }
  const realIp = req.headers && req.headers['x-real-ip'];
  if (realIp) {
    return cleanIPv4(realIp);
  }
  const ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress;
  return cleanIPv4(ip) || '127.0.0.1';
}

/**
 * Resuelve de forma exhaustiva qué torniquete/MinMoe realiza la solicitud.
 * Prioridad:
 * 1. Pista de ruta/query/header (ID numérico o nombre)
 * 2. Pista de payload MinMoe (deviceName, deviceNo, ipAddress)
 * 3. IP de origen del hardware contra el catálogo de devices
 * 4. Fallback al dispositivo por defecto
 */
async function resolveDevice(deviceIdHint, clientIp, bodyDeviceHint = null) {
  let allDevs = [];
  try {
    allDevs = await dbHelper.getDevices();
  } catch (err) {
    console.error('[ACCESS] Error consultando dispositivos en DB:', err.message);
  }

  if (!allDevs || allDevs.length === 0) return null;

  // 1. Pista por URL/Query/Header
  if (deviceIdHint) {
    const hint = String(deviceIdHint).trim();
    const numId = parseInt(hint, 10);
    if (!isNaN(numId)) {
      const match = allDevs.find(d => Number(d.id) === numId);
      if (match) {
        console.log(`[RESOLVER OK] Torniquete resuelto por URL/Query/Header ID: "${match.name}" (ID ${match.id})`);
        return match;
      }
    }
    const nameMatch = allDevs.find(d => matchDeviceName(d.name, hint));
    if (nameMatch) {
      console.log(`[RESOLVER OK] Torniquete resuelto por Nombre en URL/Query/Header: "${nameMatch.name}" (ID ${nameMatch.id})`);
      return nameMatch;
    }
    const ipMatch = allDevs.find(d => cleanIPv4(d.ip) === cleanIPv4(hint));
    if (ipMatch) {
      console.log(`[RESOLVER OK] Torniquete resuelto por IP en URL/Query/Header: "${ipMatch.name}" (ID ${ipMatch.id})`);
      return ipMatch;
    }
  }

  // 2. Pista en cuerpo de la notificación (deviceName, deviceNo, etc.)
  if (bodyDeviceHint) {
    const hint = String(bodyDeviceHint).trim();
    const numId = parseInt(hint, 10);
    if (!isNaN(numId)) {
      const match = allDevs.find(d => Number(d.id) === numId);
      if (match) {
        console.log(`[RESOLVER OK] Torniquete resuelto por ID en Payload: "${match.name}" (ID ${match.id})`);
        return match;
      }
    }
    const nameMatch = allDevs.find(d => matchDeviceName(d.name, hint));
    if (nameMatch) {
      console.log(`[RESOLVER OK] Torniquete resuelto por Nombre en Payload: "${nameMatch.name}" (ID ${nameMatch.id})`);
      return nameMatch;
    }
    const ipMatch = allDevs.find(d => cleanIPv4(d.ip) === cleanIPv4(hint));
    if (ipMatch) {
      console.log(`[RESOLVER OK] Torniquete resuelto por IP en Payload: "${ipMatch.name}" (ID ${ipMatch.id})`);
      return ipMatch;
    }
  }

  // 3. Pista por dirección IP del lector físico (coincidencia estricta limpia)
  if (clientIp) {
    const cleanClient = cleanIPv4(clientIp);
    if (cleanClient && cleanClient !== '127.0.0.1' && cleanClient !== 'localhost' && cleanClient !== '0.0.0.0') {
      const match = allDevs.find(d => {
        const devIp = cleanIPv4(d.ip);
        return devIp === cleanClient;
      });
      if (match) {
        console.log(`[RESOLVER OK] Torniquete resuelto por IP de origen (${cleanClient}): "${match.name}" (ID ${match.id})`);
        return match;
      }
    }
  }

  // 4. Dispositivo predeterminado (fallback)
  let def = null;
  try {
    def = await dbHelper.getDefaultDevice();
  } catch (_) {}

  const finalDevice = def || allDevs[0] || null;
  console.warn(`[RESOLVER WARN] Petición entrante desde IP "${clientIp}" no coincide con torniquetes registrados. Fallback a: "${finalDevice ? finalDevice.name : 'N/A'}" (ID ${finalDevice ? finalDevice.id : 'N/A'}). Pistas: hint="${deviceIdHint || ''}", body="${bodyDeviceHint || ''}".`);

  return finalDevice;
}

/**
 * Ejecuta la llamada a la base de datos, API externa y apertura de puerta
 */
async function executeAccessValidation(reqInfo, clientIp, device = null) {
  const { userId, serialNo, eventType } = reqInfo;

  // 1. Identificar el dispositivo MinMoe que origina la solicitud si no fue inyectado
  if (!device) {
    device = await resolveDevice(reqInfo.deviceId, clientIp, reqInfo.bodyDevice);
  }

  const deviceId = device ? device.id : null;
  const deviceName = device ? device.name : 'Torniquete';
  const deviceIp = device ? device.ip : clientIp;

  // 2. Checar la base de datos local para el usuario
  logEvent('info', `[${deviceName}] Consultando base de datos para el usuario ID: ${userId}...`, deviceId, deviceName);
  const user = await dbHelper.getUserById(userId);

  if (!user) {
    logEvent('warning', `[${deviceName}] Usuario con ID ${userId} no está registrado en la base de datos local.`, deviceId, deviceName);
    await dbHelper.addLog(userId, 'No registrado', eventType, 'N/A', { error: 'User not registered' }, false, false, deviceId, deviceName, deviceIp);
    broadcastFeedback(false, 'Desconocido', userId, 'ID de tarjeta no registrado', deviceId, deviceName);
    
    // Notificar rechazo al lector físico
    if (serialNo && device && device.ip && device.username && device.password) {
      deviceHelper.sendRemoteCheck(
        device.ip,
        device.port || 80,
        device.username,
        device.password,
        serialNo,
        false
      ).catch(() => {});
    }

    return { authorized: false, reason: 'User not registered', serialNo, deviceId, deviceName };
  }

  // 3. Verificar si el usuario está autorizado en ESTE torniquete específico
  const isAllowedOnDevice = await dbHelper.isUserAllowedOnDevice(user.user_id, deviceId);
  if (!isAllowedOnDevice) {
    const denyMsg = `No autorizado para ${deviceName}`;
    logEvent('warning', `[${deviceName}] ACCESO DENEGADO: El usuario "${user.name}" (${user.user_id}) no está asignado a este torniquete.`, deviceId, deviceName);
    await dbHelper.addLog(userId, user.name, eventType, user.api_url, { error: denyMsg }, false, false, deviceId, deviceName, deviceIp);
    broadcastFeedback(false, user.name, userId, denyMsg, deviceId, deviceName);

    if (serialNo && device && device.ip && device.username && device.password) {
      deviceHelper.sendRemoteCheck(
        device.ip,
        device.port || 80,
        device.username,
        device.password,
        serialNo,
        false
      ).catch(() => {});
    }

    return { authorized: false, name: user.name, serialNo, reason: denyMsg, deviceId, deviceName };
  }

  logEvent('success', `[${deviceName}] Usuario encontrado: "${user.name}". URL de validación: ${user.api_url}`, deviceId, deviceName);

  // Notificar a la pantalla de feedback que la credencial fue leída y el alumno identificado
  broadcastVerifying(user.name, user.user_id, eventType, deviceId, deviceName);

  // 4. Query para la API externa del usuario
  logEvent('info', `[${deviceName}] Llamando a la API externa de validación...`, deviceId, deviceName);
  let authorized = false;
  let apiResponse = null;

  try {
    if (!user.api_url) {
      throw new Error('El usuario no tiene configurada una URL de API externa');
    }
    const apiCallResult = await queryExternalApi(user.api_url, user.user_id, user.name, eventType);
    apiResponse = apiCallResult.data;
    logEvent('info', `[${deviceName}] API Respuesta (Status ${apiCallResult.status}, ${apiCallResult.duration}ms): ${JSON.stringify(apiResponse)}`, deviceId, deviceName);

    if (apiCallResult.status === 200 && apiResponse) {
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
    logEvent('error', `[${deviceName}] Error al consultar API externa: ${apiErr.message}`, deviceId, deviceName);
    apiResponse = { error: apiErr.message };
  }

  // 5. Log de Veredicto
  if (authorized) {
    logEvent('success', `[${deviceName}] ACCESO AUTORIZADO para ${user.name} (ID: ${userId})`, deviceId, deviceName);
  } else {
    logEvent('warning', `[${deviceName}] ACCESO DENEGADO para ${user.name} (ID: ${userId})`, deviceId, deviceName);
  }

  // 6. Enviar confirmación RemoteCheck al hardware específico Hikvision
  if (serialNo && device && device.ip && device.username && device.password) {
    deviceHelper.sendRemoteCheck(
      device.ip,
      device.port || 80,
      device.username,
      device.password,
      serialNo,
      authorized
    ).catch(e => console.warn(`[Device API - ${deviceName}] Error enviando confirmación RemoteCheck:`, e.message));
  }

  // 7. Apertura remota de puerta si está autorizado y habilitado en la configuración del torniquete
  let doorOpened = false;
  if (authorized && device && (device.enable_api_open === 1 || device.enable_api_open === true || String(device.enable_api_open) === 'true')) {
    logEvent('info', `[${deviceName}] Iniciando apertura remota de puerta...`, deviceId, deviceName);
    const openResult = await deviceHelper.openDoor(
      device.ip,
      device.port || 80,
      device.username,
      device.password,
      device.door_channel || 1
    );

    if (openResult.success) {
      logEvent('success', `[${deviceName}] Puerta abierta exitosamente por API.`, deviceId, deviceName);
      doorOpened = true;
    } else {
      logEvent('error', `[${deviceName}] Fallo al abrir la puerta por API: ${openResult.error || 'Respuesta inesperada'}`, deviceId, deviceName);
    }
  } else if (authorized) {
    logEvent('info', `[${deviceName}] Apertura por API de dispositivo omitida (está desactivada o requiere respuesta HTTP directa).`, deviceId, deviceName);
  }

  // 8. Guardar log en SQLite con los datos del torniquete
  await dbHelper.addLog(userId, user.name, eventType, user.api_url, apiResponse, authorized, doorOpened, deviceId, deviceName, deviceIp);

  // 9. Determinar razón y enviar feedback visual
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

  broadcastFeedback(authorized, user.name, userId, denyReason, deviceId, deviceName);

  return { authorized, name: user.name, serialNo, doorOpened, reason: denyReason, deviceId, deviceName };
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

  const device = await resolveDevice(reqInfo.deviceId, clientIp, reqInfo.bodyDevice);
  const deviceId = device ? device.id : null;
  const deviceName = device ? device.name : 'Torniquete';

  logEvent('info', `=== Solicitud de acceso [${deviceName}]: ID ${userId} (Serial: ${serialNo}, Modo: ${eventType}) ===`, deviceId, deviceName);

  const cleanUserId = String(userId).trim();

  // 1. Deduplicación concurrente
  if (inFlightRequests.has(cleanUserId)) {
    logEvent('info', `[Deduplicación] Solicitud concurrente en proceso para ${cleanUserId} (Serial: ${serialNo}). Reutilizando validación activa...`, deviceId, deviceName);
    try {
      const inFlightResult = await inFlightRequests.get(cleanUserId);
      if (serialNo && serialNo !== inFlightResult.serialNo) {
        if (device && device.ip && device.username && device.password) {
          deviceHelper.sendRemoteCheck(
            device.ip,
            device.port || 80,
            device.username,
            device.password,
            serialNo,
            inFlightResult.authorized
          ).catch(() => {});
        }
      }
      return { ...inFlightResult, serialNo };
    } catch (_) {}
  }

  // 2. Cooldown anti-rebote: Si ya se autorizó este alumno hace menos de 2.5 segundos
  if (recentVerifications.has(cleanUserId)) {
    const recent = recentVerifications.get(cleanUserId);
    if (recent.result && recent.result.authorized && (Date.now() - recent.timestamp < 2500)) {
      logEvent('info', `[Cooldown] Detección repetida para ${cleanUserId} dentro de 2.5s (Serial: ${serialNo}). Manteniendo veredicto: Autorizado`, deviceId, deviceName);
      if (serialNo && device && device.ip && device.username && device.password) {
        deviceHelper.sendRemoteCheck(
          device.ip,
          device.port || 80,
          device.username,
          device.password,
          serialNo,
          recent.result.authorized
        ).catch(() => {});
      }
      return { ...recent.result, serialNo };
    }
  }

  // 3. Ejecutar validación y almacenar promesa en vuelo
  const validationPromise = executeAccessValidation(reqInfo, clientIp, device);
  inFlightRequests.set(cleanUserId, validationPromise);

  try {
    const result = await validationPromise;
    if (result && result.authorized) {
      recentVerifications.set(cleanUserId, { result, timestamp: Date.now() });
    }
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
  const clientIp = getClientIp(req);

  if (reqInfo.isHeartbeat) {
    const device = await resolveDevice(reqInfo.deviceId, clientIp, reqInfo.bodyDevice);
    const deviceId = device ? device.id : null;
    const deviceName = device ? device.name : null;
    broadcastHeartbeat(deviceId, deviceName, clientIp);
    console.log(`[HEARTBEAT] Latido recibido de "${deviceName || 'Desconocido'}" (ID: ${deviceId || 'N/A'}, IP: ${clientIp})`);

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
  const { userId, eventType, deviceId } = req.body;
  let clientIp = '127.0.0.1';

  const dev = await resolveDevice(deviceId, clientIp);
  if (dev && dev.ip) {
    clientIp = dev.ip;
  }
  
  const targetId = dev ? dev.id : (deviceId || null);
  const targetName = dev ? dev.name : 'Torniquete';
  logEvent('info', `Simulando escaneo de usuario para ID: ${userId} en torniquete: "${targetName}" (ID ${targetId})`, targetId, targetName);
  
  try {
    const result = await processAccessRequest({
      userId,
      serialNo: String(Math.floor(Math.random() * 1000)),
      eventType: eventType || 'simulated_scan',
      isHeartbeat: false,
      deviceId: targetId
    }, clientIp);
    
    res.json(result);
  } catch (e) {
    logEvent('error', `Error en simulación: ${e.message}`, targetId, targetName);
    res.status(500).json({ error: e.message });
  }
}

/**
 * Endpoint SSE para visualización de eventos de un torniquete específico
 */
const handleDeviceEventsStream = async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Desactivar buffer de Nginx para streaming inmediato
  res.flushHeaders();

  const devIdOrName = req.params.id || req.query.device || req.query.deviceId;
  let resolvedId = String(devIdOrName || 'all');
  let resolvedName = null;

  if (devIdOrName && devIdOrName !== 'all') {
    try {
      const allDevs = await dbHelper.getDevices();
      const dev = allDevs.find(d => String(d.id) === String(devIdOrName) || matchDeviceName(d.name, devIdOrName));
      if (dev) {
        resolvedId = String(dev.id);
        resolvedName = dev.name;
      }
    } catch (_) {}
  }

  res.targetDeviceId = resolvedId;
  res.targetDeviceName = resolvedName;
  sseClients.push(res);

  // Enviar confirmación inmediata de enlace a la pantalla/cliente
  try {
    res.write(`data: ${JSON.stringify({
      type: 'connected',
      status: 'connected',
      deviceId: resolvedId,
      deviceName: resolvedName || 'Modo Global',
      timestamp: new Date().toISOString()
    })}\n\n`);
  } catch (_) {}

  const label = resolvedName ? `"${resolvedName}" (ID ${resolvedId})` : (resolvedId !== 'all' ? `ID ${resolvedId}` : 'modo global');
  logEvent('info', `Pantalla conectada al flujo de eventos dedicado del torniquete ${label}.`, resolvedId, resolvedName);

  // Intervalo de latidos (heartbeat/keep-alive) cada 15 segundos para evitar desconexiones de proxies
  const keepAlive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch (_) {}
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
};

/**
 * Endpoint SSE para visualización de logs de un torniquete específico
 */
const handleDeviceLogsStream = async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const devIdOrName = req.params.id || req.query.device || req.query.deviceId;
  let resolvedId = String(devIdOrName || 'all');
  let resolvedName = null;

  if (devIdOrName && devIdOrName !== 'all') {
    try {
      const allDevs = await dbHelper.getDevices();
      const dev = allDevs.find(d => String(d.id) === String(devIdOrName) || matchDeviceName(d.name, devIdOrName));
      if (dev) {
        resolvedId = String(dev.id);
        resolvedName = dev.name;
      }
    } catch (_) {}
  }

  res.targetDeviceId = resolvedId;
  res.targetDeviceName = resolvedName;
  sseClients.push(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch (_) {}
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
};

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
  handleDeviceEventsStream,
  handleDeviceLogsStream,
  resolveDevice,
  getClientIp,
  mockExternalApiAllow,
  mockExternalApiDeny,
  mockExternalApiError
};
