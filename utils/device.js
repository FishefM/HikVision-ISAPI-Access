const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * Parses the WWW-Authenticate header to extract realm, nonce, qop, etc.
 */
function parseWWWAuthenticate(header) {
  if (!header) return {};
  const headerStr = Array.isArray(header)
    ? (header.find(h => String(h).toLowerCase().startsWith('digest')) || header[0])
    : String(header);

  const match = headerStr.match(/^digest\s+(.*)$/i);
  if (!match) return {};

  const cleanHeader = match[1];
  // Split on commas that are followed by a key= (avoids breaking qop="auth,auth-int")
  const parts = cleanHeader.split(/,\s*(?=[a-zA-Z0-9_-]+\s*=)/);
  const params = {};
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx !== -1) {
      const key = part.slice(0, eqIdx).trim();
      const val = part.slice(eqIdx + 1).replace(/^["']|["']$/g, '').trim();
      params[key] = val;
    }
  }
  return params;
}

/**
 * Calculates the Digest Authorization header.
 */
function calculateDigestHeader(method, uri, authParams, username, password) {
  const realm = authParams.realm;
  const nonce = authParams.nonce;
  const rawQop = authParams.qop;
  // If server offers auth,auth-int, choose 'auth'
  const qop = rawQop && rawQop.includes('auth') ? 'auth' : rawQop;
  const opaque = authParams.opaque;
  
  const HA1 = md5(`${username}:${realm}:${password}`);
  const HA2 = md5(`${method}:${uri}`);
  
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  
  let response;
  if (qop === 'auth' || qop === 'auth-int') {
    response = md5(`${HA1}:${nonce}:${nc}:${cnonce}:${qop}:${HA2}`);
  } else {
    response = md5(`${HA1}:${nonce}:${HA2}`);
  }
  
  let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop) {
    authHeader += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  }
  if (opaque) {
    authHeader += `, opaque="${opaque}"`;
  }
  if (authParams.algorithm) {
    authHeader += `, algorithm=${authParams.algorithm}`;
  }
  return authHeader;
}

/**
 * Sends a generic command to the Hikvision device using manual Digest Authentication.
 */
async function sendISAPICommand(deviceIp, devicePort, username, password, method, path, xmlBody = null) {
  const isHttps = String(devicePort) === '443';
  const protocol = isHttps ? 'https' : 'http';
  const url = `${protocol}://${deviceIp}:${devicePort}${path}`;
  const config = {
    method: method,
    url: url,
    httpsAgent: isHttps ? httpsAgent : undefined,
    headers: {
      'Content-Type': 'application/xml',
    },
    data: xmlBody,
    validateStatus: (status) => status >= 200 && status < 500, // Permit 401 response for digest challenge
    timeout: 5000, // 5 second timeout
  };

  try {
    // Step 1: Send request without authentication to get the 401 challenge
    console.log(`[Device API] Sending initial ${method} to ${url}...`);
    let response = await axios(config);
    
    if (response.status === 401) {
      console.log(`[Device API] Received 401 challenge. Calculating Digest...`);
      const authHeaderRaw = response.headers['www-authenticate'];
      if (!authHeaderRaw) {
        throw new Error('401 Unauthorized received, but WWW-Authenticate header was missing.');
      }
      
      const authParams = parseWWWAuthenticate(authHeaderRaw);
      const authHeader = calculateDigestHeader(method, path, authParams, username, password);
      
      // Step 2: Retry the request with the Authorization header
      config.headers['Authorization'] = authHeader;
      console.log(`[Device API] Retrying ${method} with Digest Authentication...`);
      response = await axios(config);
    }
    
    return {
      status: response.status,
      statusText: response.statusText,
      data: response.data
    };
  } catch (error) {
    console.error(`[Device API] Connection error: ${error.message}`);
    throw error;
  }
}

/**
 * Opens a door on the Hikvision device.
 */
async function openDoor(deviceIp, devicePort, username, password, doorChannel = 1) {
  const path = `/ISAPI/AccessControl/RemoteControl/door/${doorChannel}`;
  const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<RemoteControlDoor version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
    <cmd>open</cmd>
</RemoteControlDoor>`;

  try {
    const result = await sendISAPICommand(deviceIp, devicePort, username, password, 'PUT', path, xmlBody);
    console.log(`[Device API] Door open request response status: ${result.status}`);
    
    // Check if result contains success indicators
    const isSuccess = result.status === 200 && 
                     (result.data.includes('statusCode>1') || result.data.includes('OK') || result.data.includes('ok'));
                     
    return {
      success: isSuccess,
      status: result.status,
      data: result.data
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}
/**
 * Checks if the ISAPI response indicates success (works with both XML and JSON).
 */
function isISAPISuccess(status, data) {
  if (status !== 200) return false;
  if (!data) return false;
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);

  // XML / JSON success patterns
  const hasSuccessStatusCode = /statusCode[">:\s]+1\b/i.test(dataStr);
  const hasOkStatus = /statusString[">:\s]+["']?OK["']?/i.test(dataStr);
  const hasOkSubStatus = /subStatusCode[">:\s]+["']?ok["']?/i.test(dataStr);
  const hasSuccessCheck = /checkResult[">:\s]+["']?success["']?/i.test(dataStr);
  const hasOkWord = />ok<\/subStatusCode>/i.test(dataStr) || />OK<\/statusString>/i.test(dataStr);

  return hasSuccessStatusCode || hasOkStatus || hasOkSubStatus || hasSuccessCheck || hasOkWord;
}

/**
 * Extracts a human-readable diagnostic message from an ISAPI response.
 */
function extractISAPIDiagnostic(data, fallbackError = null) {
  if (!data) return fallbackError || 'Sin respuesta del dispositivo biométrico';
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);

  let statusString = null;
  let subStatusCode = null;
  let errorMsg = null;

  const subMatch = dataStr.match(/subStatusCode[">:\s]+["']?([^<"'\s,}]+)/i);
  if (subMatch) subStatusCode = subMatch[1];

  const statusMatch = dataStr.match(/statusString[">:\s]+["']?([^<"'\s,}]+)/i);
  if (statusMatch) statusString = statusMatch[1];

  const errorMatch = dataStr.match(/errorMsg[">:\s]+["']?([^<"'\r\n]+)/i);
  if (errorMatch) errorMsg = errorMatch[1];

  // Specific common Hikvision MinMoe diagnostic translations
  const translations = {
    'employeeNoNotExist': 'El ID de empleado no existe en la base de datos del MinMoe (el usuario debe crearse primero con Record POST)',
    'deviceUserAlreadyExist': 'El usuario ya existe en el biométrico (se actualizará)',
    'badParameters': 'Parámetros incompatibles o formato de datos no soportado por este firmware',
    'employeeNoInvalid': 'ID de empleado inválido (la serie MinMoe suele requerir IDs estrictamente numéricos)',
    'noFaceDetected': 'No se detectó ningún rostro humano en la imagen',
    'faceQualityTooLow': 'Calidad de rostro insuficiente (verifique iluminación y mirada frontal)',
    'faceDataFormatError': 'Formato de imagen inválido (debe ser JPG < 200KB)',
    'targetNotExist': 'El usuario no existe previamente en la memoria del MinMoe',
    'cardNoAlreadyExist': 'El número de tarjeta ya está asignado a otro usuario',
    'deviceError': 'Error interno del lector biométrico',
    'ok': 'Operación exitosa'
  };

  const explanation = subStatusCode && translations[subStatusCode] ? ` (${translations[subStatusCode]})` : '';

  const parts = [];
  if (statusString) parts.push(`Estado: ${statusString}`);
  if (subStatusCode) parts.push(`SubCódigo: ${subStatusCode}${explanation}`);
  if (errorMsg) parts.push(`Detalle: ${errorMsg}`);

  if (parts.length > 0) return parts.join(' | ');

  if (fallbackError) return fallbackError;
  return dataStr.length > 200 ? dataStr.substring(0, 200) + '...' : dataStr;
}

/**
 * Sends a generic command to the Hikvision device using manual Digest Authentication and custom headers/body.
 */
async function sendISAPIGenericRequest(deviceIp, devicePort, username, password, method, path, headers = {}, data = null) {
  const url = `http://${deviceIp}:${devicePort}${path}`;
  const mergedHeaders = {
    'Accept': 'application/json, application/xml, text/xml, */*',
    ...headers
  };

  const config = {
    method: method,
    url: url,
    headers: mergedHeaders,
    data: data,
    validateStatus: (status) => status >= 200 && status < 500, // Permit 401 response for digest challenge
    timeout: 10000, // 10 second timeout
  };

  try {
    console.log(`[Device API] Sending generic ${method} to ${url}...`);
    let response = await axios(config);
    
    if (response.status === 401) {
      console.log(`[Device API] Received 401 challenge. Calculating Digest...`);
      const authHeaderRaw = response.headers['www-authenticate'];
      if (!authHeaderRaw) {
        throw new Error('401 Unauthorized received, but WWW-Authenticate header was missing.');
      }
      
      const authParams = parseWWWAuthenticate(authHeaderRaw);
      const authHeader = calculateDigestHeader(method, path, authParams, username, password);
      
      config.headers['Authorization'] = authHeader;
      console.log(`[Device API] Retrying ${method} with Digest Authentication...`);
      response = await axios(config);
    }
    
    return {
      status: response.status,
      statusText: response.statusText,
      data: response.data
    };
  } catch (error) {
    console.error(`[Device API] Connection error to ${url}: ${error.message}`);
    throw error;
  }
}

/**
 * Adds or updates a user record on the Hikvision device.
 * Hikvision requires POST /ISAPI/AccessControl/UserInfo/Record to CREATE a new user.
 * If the user already exists, it uses PUT /ISAPI/AccessControl/UserInfo/SetUp to UPDATE.
 */
async function syncUserInfo(deviceIp, devicePort, username, password, userId, name) {
  const cleanUserId = String(userId).trim();

  // Payload 1: Complete standard MinMoe payload for creating/updating user
  const fullPayload = {
    UserInfo: {
      employeeNo: cleanUserId,
      name: name,
      userType: "normal",
      closeDelayEnabled: false,
      Valid: {
        enable: true,
        beginTime: "2024-01-01T00:00:00",
        endTime: "2036-12-31T23:59:59",
        timeType: "local"
      },
      belongGroup: "1",
      doorRight: "1",
      RightPlan: [
        {
          doorNo: 1,
          planTemplateNo: "1"
        }
      ],
      maxOpenDoorTime: 0,
      openDoorTime: 0,
      roomNumber: 0,
      floorNumber: 0,
      localUIRight: false,
      gender: "unknown",
      numOfCard: 1,
      numOfFace: 1
    }
  };

  // Payload 2: Simplified payload without schedule templates
  const simplifiedPayload = {
    UserInfo: {
      employeeNo: cleanUserId,
      name: name,
      userType: "normal",
      Valid: {
        enable: true,
        beginTime: "2024-01-01T00:00:00",
        endTime: "2036-12-31T23:59:59",
        timeType: "local"
      },
      belongGroup: "1",
      doorRight: "1"
    }
  };

  let lastResult = null;

  try {
    // PASO 1 (CREACIÓN): UserInfo/Record (POST) con fullPayload
    // ¡CRUCIAL! Este es el endpoint oficial de Hikvision para DAR DE ALTA un usuario nuevo.
    // Usar SetUp (PUT) en un usuario inexistente devuelve siempre "employeeNoNotExist".
    console.log(`[Device API] Registrando nuevo usuario "${name}" (ID: ${cleanUserId}) con UserInfo/Record (POST)...`);
    lastResult = await sendISAPIGenericRequest(
      deviceIp,
      devicePort,
      username,
      password,
      'POST',
      `/ISAPI/AccessControl/UserInfo/Record?format=json`,
      { 'Content-Type': 'application/json' },
      fullPayload
    );

    let isSuccess = isISAPISuccess(lastResult.status, lastResult.data);
    const dataStr = typeof lastResult.data === 'string' ? lastResult.data : JSON.stringify(lastResult.data || {});
    const alreadyExists = /deviceUserAlreadyExist|userAlreadyExist|alreadyExist/i.test(dataStr);

    // PASO 2: Si el usuario ya existe en el MinMoe, actualizamos su información con SetUp (PUT)
    if (alreadyExists) {
      console.log(`[Device API] Usuario "${cleanUserId}" ya existe en el MinMoe. Actualizando con UserInfo/SetUp (PUT)...`);
      lastResult = await sendISAPIGenericRequest(
        deviceIp,
        devicePort,
        username,
        password,
        'PUT',
        `/ISAPI/AccessControl/UserInfo/SetUp?format=json`,
        { 'Content-Type': 'application/json' },
        fullPayload
      );
      isSuccess = isISAPISuccess(lastResult.status, lastResult.data);

      if (!isSuccess) {
        console.log(`[Device API] Reintentando actualización con UserInfo/Modify (PUT)...`);
        lastResult = await sendISAPIGenericRequest(
          deviceIp,
          devicePort,
          username,
          password,
          'PUT',
          `/ISAPI/AccessControl/UserInfo/Modify?format=json`,
          { 'Content-Type': 'application/json' },
          fullPayload
        );
        isSuccess = isISAPISuccess(lastResult.status, lastResult.data);
      }
    }

    // PASO 3: Si Record (POST) falló con badParameters (plantillas de horario), reintentar con simplifiedPayload
    if (!isSuccess && !alreadyExists) {
      console.log(`[Device API] Reintentando alta de usuario con payload simplificado (POST Record)...`);
      lastResult = await sendISAPIGenericRequest(
        deviceIp,
        devicePort,
        username,
        password,
        'POST',
        `/ISAPI/AccessControl/UserInfo/Record?format=json`,
        { 'Content-Type': 'application/json' },
        simplifiedPayload
      );
      isSuccess = isISAPISuccess(lastResult.status, lastResult.data);
    }

    // PASO 4: Fallback para dispositivos que solo soporten SetUp (PUT)
    if (!isSuccess && !alreadyExists) {
      console.log(`[Device API] Intentando fallback con UserInfo/SetUp (PUT)...`);
      lastResult = await sendISAPIGenericRequest(
        deviceIp,
        devicePort,
        username,
        password,
        'PUT',
        `/ISAPI/AccessControl/UserInfo/SetUp?format=json`,
        { 'Content-Type': 'application/json' },
        simplifiedPayload
      );
      isSuccess = isISAPISuccess(lastResult.status, lastResult.data);
    }

    const diagnostic = extractISAPIDiagnostic(lastResult.data);
    console.log(`[Device API] User sync result for ${name} (${cleanUserId}): success=${isSuccess} | ${diagnostic}`);

    return {
      success: isSuccess,
      status: lastResult.status,
      data: lastResult.data,
      diagnostic: diagnostic
    };
  } catch (error) {
    console.warn(`[Device API] Error de conexión al sincronizar usuario: ${error.message}`);
    return {
      success: false,
      error: error.message,
      diagnostic: `Error de red: ${error.message}`
    };
  }
}

/**
 * Adds or updates a card record on the Hikvision device linked to the employeeNo.
 * Attempts CardInfo/Record (POST) first, and falls back to CardInfo/SetUp (PUT).
 */
async function syncCardInfo(deviceIp, devicePort, username, password, employeeNo, cardNo) {
  const cleanEmployeeNo = String(employeeNo).trim();
  const cleanCardNo = String(cardNo).trim();

  const payload = {
    CardInfo: {
      employeeNo: cleanEmployeeNo,
      cardNo: cleanCardNo,
      cardType: "normalCard"
    }
  };

  let lastResult = null;

  try {
    // Intento 1 (ALTA): CardInfo/Record (POST) para vincular la tarjeta al usuario
    console.log(`[Device API] Vinculando tarjeta ${cleanCardNo} al usuario ${cleanEmployeeNo} con CardInfo/Record (POST)...`);
    lastResult = await sendISAPIGenericRequest(
      deviceIp,
      devicePort,
      username,
      password,
      'POST',
      `/ISAPI/AccessControl/CardInfo/Record?format=json`,
      { 'Content-Type': 'application/json' },
      payload
    );

    let isSuccess = isISAPISuccess(lastResult.status, lastResult.data);
    const dataStr = typeof lastResult.data === 'string' ? lastResult.data : JSON.stringify(lastResult.data || {});
    const alreadyExists = /cardAlreadyExist|alreadyExist|cardNoAlreadyExist/i.test(dataStr);

    // Intento 2: Si la tarjeta ya existe o si SetUp (PUT) es requerido
    if (!isSuccess || alreadyExists) {
      console.log(`[Device API] Aplicando tarjeta con CardInfo/SetUp (PUT)...`);
      lastResult = await sendISAPIGenericRequest(
        deviceIp,
        devicePort,
        username,
        password,
        'PUT',
        `/ISAPI/AccessControl/CardInfo/SetUp?format=json`,
        { 'Content-Type': 'application/json' },
        payload
      );
      isSuccess = isISAPISuccess(lastResult.status, lastResult.data);
    }

    const diagnostic = extractISAPIDiagnostic(lastResult.data);
    console.log(`[Device API] Card sync result (${cleanCardNo} -> ${cleanEmployeeNo}): success=${isSuccess} | ${diagnostic}`);

    return {
      success: isSuccess,
      status: lastResult.status,
      data: lastResult.data,
      diagnostic: diagnostic
    };
  } catch (error) {
    console.warn(`[Device API] Failed to sync card: ${error.message}`);
    return {
      success: false,
      error: error.message,
      diagnostic: `Error de red al vincular tarjeta: ${error.message}`
    };
  }
}

/**
 * Uploads a user face image to the Hikvision device.
 * Tries the FDLib endpoint and falls back to the native AccessControl FaceInfo endpoint.
 */
async function syncUserFace(deviceIp, devicePort, username, password, userId, imageBuffer) {
  const cleanUserId = String(userId).trim();
  const boundary = '----Boundary' + crypto.randomBytes(8).toString('hex');

  // Payload para FDLib
  const jsonPartFDLib = JSON.stringify({
    faceLibType: "normalFD",
    FDID: "1",
    FPID: cleanUserId
  });

  const partsFDLib = [
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="FaceDataRecord"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${jsonPartFDLib}\r\n`
    ),
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="faceImage"; filename="${cleanUserId}.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`
    ),
    imageBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];
  const requestBodyFDLib = Buffer.concat(partsFDLib);

  let lastResult = null;

  try {
    // Intento 1: FDLib/FaceDataRecord (POST)
    console.log(`[Device API] Subiendo rostro vía FDLib/FaceDataRecord (ID: ${cleanUserId})...`);
    lastResult = await sendISAPIGenericRequest(
      deviceIp,
      devicePort,
      username,
      password,
      'POST',
      `/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json`,
      { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      requestBodyFDLib
    );

    let isSuccess = isISAPISuccess(lastResult.status, lastResult.data);

    // Intento 2: Si falló, intentar con AccessControl FaceInfo
    if (!isSuccess) {
      console.log(`[Device API] Reintentando rostro vía AccessControl/FaceInfo/Record (POST)...`);
      const jsonPartFaceInfo = JSON.stringify({
        faceLibType: "normalFD",
        FDID: "1",
        FPID: cleanUserId
      });
      const partsFaceInfo = [
        Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="FaceInfo"\r\n` +
          `Content-Type: application/json\r\n\r\n` +
          `${jsonPartFaceInfo}\r\n`
        ),
        Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="img"; filename="${cleanUserId}.jpg"\r\n` +
          `Content-Type: image/jpeg\r\n\r\n`
        ),
        imageBuffer,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ];
      const requestBodyFaceInfo = Buffer.concat(partsFaceInfo);

      lastResult = await sendISAPIGenericRequest(
        deviceIp,
        devicePort,
        username,
        password,
        'POST',
        `/ISAPI/AccessControl/FaceInfo/Record?format=json`,
        { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        requestBodyFaceInfo
      );
      isSuccess = isISAPISuccess(lastResult.status, lastResult.data);
    }

    const diagnostic = extractISAPIDiagnostic(lastResult.data);
    console.log(`[Device API] Face upload result (ID: ${cleanUserId}): success=${isSuccess} | ${diagnostic}`);

    return {
      success: isSuccess,
      status: lastResult.status,
      data: lastResult.data,
      diagnostic: diagnostic
    };
  } catch (error) {
    console.warn(`[Device API] Failed to upload face: ${error.message}`);
    return {
      success: false,
      error: error.message,
      diagnostic: `Error de red al subir rostro: ${error.message}`
    };
  }
}

/**
 * Unified helper to synchronize a complete user profile (UserInfo + CardInfo + FaceImage) to the Hikvision terminal.
 */
async function syncFullUserToDevice(settings, user, imageBuffer = null) {
  const ip = settings.device_ip;
  const port = settings.device_port || 80;
  const userAuth = settings.device_user || 'admin';
  const pass = settings.device_password || '';

  if (!ip || !userAuth || !pass) {
    return {
      synced: false,
      error: 'Parámetros de conexión del lector biométrico incompletos (IP, Usuario o Contraseña no configurados).',
      diagnostics: ['Biométrico no configurado']
    };
  }

  const diagnostics = [];
  let userSuccess = false;
  let cardSuccess = false;
  let faceSuccess = null;

  // 1. Sincronizar información básica de usuario (CREAR primero con Record POST)
  const userRes = await syncUserInfo(ip, port, userAuth, pass, user.user_id, user.name);
  diagnostics.push(`Usuario (${user.name}): ${userRes.diagnostic}`);
  userSuccess = userRes.success;

  // ¡CRUCIAL! Si el usuario no existe en la base de datos del MinMoe, no tiene sentido intentar vincular tarjeta o rostro
  // porque el hardware responderá inevitablemente con employeeNoNotExist!
  if (!userSuccess) {
    diagnostics.push(`Tarjeta y Rostro omitidos: Se requiere que el usuario exista en el MinMoe primero.`);
    return {
      synced: false,
      userSuccess: false,
      cardSuccess: false,
      faceSuccess: false,
      diagnostics,
      summary: `Fallo al registrar usuario en MinMoe: ${userRes.diagnostic}`
    };
  }

  // 2. Sincronizar tarjeta (asociada al user_id)
  const cardRes = await syncCardInfo(ip, port, userAuth, pass, user.user_id, user.user_id);
  diagnostics.push(`Tarjeta (${user.user_id}): ${cardRes.diagnostic}`);
  cardSuccess = cardRes.success;

  // 3. Sincronizar rostro si se proporcionó buffer de imagen
  if (imageBuffer && imageBuffer.length > 0) {
    const faceRes = await syncUserFace(ip, port, userAuth, pass, user.user_id, imageBuffer);
    diagnostics.push(`Rostro: ${faceRes.diagnostic}`);
    faceSuccess = faceRes.success;
  }

  const overallSuccess = userSuccess;
  return {
    synced: overallSuccess,
    userSuccess,
    cardSuccess,
    faceSuccess,
    diagnostics,
    summary: diagnostics.join(' — ')
  };
}

/**
 * Sends a RemoteCheck decision back to the Hikvision terminal (PUT /ISAPI/AccessControl/remoteCheck).
 * This tells the terminal's screen and voice synthesizer that the verification was successful,
 * displaying the green checkmark on the physical device and playing "Verificado" / "Acceso Concedido".
 */
async function sendRemoteCheck(deviceIp, devicePort, username, password, serialNo, authorized = true) {
  const path = `/ISAPI/AccessControl/remoteCheck?format=json`;
  const payload = {
    RemoteCheck: {
      serialNo: parseInt(serialNo) || 1,
      checkResult: authorized ? "success" : "failed"
    }
  };

  try {
    const result = await sendISAPIGenericRequest(
      deviceIp,
      devicePort,
      username,
      password,
      'PUT',
      path,
      { 'Content-Type': 'application/json' },
      payload
    );
    console.log(`[Device API] RemoteCheck result sent (Serial: ${serialNo}, Result: ${authorized ? 'success' : 'failed'}): Status ${result.status}`);
    return { success: result.status === 200, status: result.status, data: result.data };
  } catch (error) {
    console.warn(`[Device API] Failed to send PUT RemoteCheck: ${error.message}`);
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendISAPICommand,
  openDoor,
  sendISAPIGenericRequest,
  syncUserInfo,
  syncCardInfo,
  syncUserFace,
  syncFullUserToDevice,
  sendRemoteCheck,
  isISAPISuccess,
  extractISAPIDiagnostic
};
