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

  const subMatch = dataStr.match(/subStatusCode[">:\s]+["']?([^<"'\r\n,}]+)/i);
  if (subMatch) subStatusCode = subMatch[1].replace(/<.*$/, '').replace(/["'].*$/, '').trim();

  const statusMatch = dataStr.match(/statusString[">:\s]+["']?([^<"'\r\n]+)/i);
  if (statusMatch) statusString = statusMatch[1].replace(/<.*$/, '').replace(/["'].*$/, '').trim();

  const errorMatch = dataStr.match(/errorMsg[">:\s]+["']?([^<"'\r\n]+)/i);
  if (errorMatch) errorMsg = errorMatch[1].replace(/<.*$/, '').replace(/["'].*$/, '').trim();

  // Specific common Hikvision MinMoe diagnostic translations
  const translations = {
    'employeeNoNotExist': 'El ID de empleado no existe en la base de datos del MinMoe (el usuario debe crearse primero con Record POST)',
    'deviceUserAlreadyExist': 'El usuario ya existe en el biométrico',
    'deviceUserAlreadyExistFace': 'El alumno ya tiene una fotografía facial registrada en el MinMoe (actualizado)',
    'badParameters': 'Parámetros incompatibles o formato de datos no soportado por este firmware',
    'employeeNoInvalid': 'ID de empleado inválido (la serie MinMoe suele requerir IDs numéricos)',
    'noFaceDetected': 'No se detectó ningún rostro humano en la imagen (verifique que el alumno mire de frente)',
    'noFacePic': 'No se detectó la imagen en la petición (verifique multipart FaceImage)',
    'SubpicAnalysisModelingError': 'Error de modelado facial en la IA del MinMoe: El rostro no es claro, tiene iluminación insuficiente o no está mirando de frente',
    'faceQualityTooLow': 'Calidad de imagen insuficiente para el reconocimiento facial (verifique iluminación)',
    'faceDataFormatError': 'Formato de imagen no soportado (debe ser JPG estándar < 200KB)',
    'picResolutionOutRange': 'Resolución de la imagen fuera de rango (recomendado: 800x800 máx)',
    'picSizeOutRange': 'El peso de la imagen excede el límite permitido (< 200KB)',
    'invalidFaceLibType': 'Tipo de biblioteca de rostros no soportado por este modelo',
    'faceLibTypeNotExist': 'La biblioteca de rostros especificada no existe en el MinMoe',
    'FDIDNotExist': 'El ID de biblioteca de rostros (FDID) no existe',
    'FPIDNotExist': 'El ID de persona (FPID) no existe en la base de datos de rostros',
    'MessageParametersLack': 'Faltan parámetros en la estructura multipart enviada al lector biométrico',
    'faceLibFull': 'Capacidad máxima de rostros alcanzada en la memoria del MinMoe',
    'lackOfStorageSpace': 'Espacio de almacenamiento insuficiente en el MinMoe',
    'targetNotExist': 'El usuario o registro no existe previamente en la memoria del MinMoe',
    'cardNoAlreadyExist': 'El número de tarjeta ya está asignado a otro usuario',
    'deviceError': 'Error interno del lector biométrico',
    'ok': 'Operación exitosa'
  };

  const explanation = subStatusCode && translations[subStatusCode] ? ` (${translations[subStatusCode]})` : '';

  const parts = [];
  if (statusString) parts.push(`Estado: ${statusString}`);
  if (subStatusCode) parts.push(`SubCódigo: ${subStatusCode}${explanation}`);
  if (errorMsg && errorMsg !== subStatusCode) parts.push(`Detalle: ${errorMsg}`);

  if (parts.length > 0) return parts.join(' | ');

  if (fallbackError) return fallbackError;
  return dataStr.length > 200 ? dataStr.substring(0, 200) + '...' : dataStr;
}

/**
 * Sends a generic command to the Hikvision device using manual Digest Authentication and custom headers/body.
 */
async function sendISAPIGenericRequest(deviceIp, devicePort, username, password, method, path, headers = {}, data = null, extraConfig = {}) {
  const url = `http://${deviceIp}:${devicePort}${path}`;
  const mergedHeaders = {
    'Accept': 'application/json, application/xml, text/xml, */*',
    ...headers
  };

  // Calcular Content-Length explícito para evitar transferencias fragmentadas (chunked)
  if (data && Buffer.isBuffer(data)) {
    mergedHeaders['Content-Length'] = data.length;
  } else if (data && typeof data === 'string') {
    mergedHeaders['Content-Length'] = Buffer.byteLength(data, 'utf8');
  }

  const config = {
    method: method,
    url: url,
    headers: mergedHeaders,
    data: data,
    validateStatus: (status) => status >= 200 && status < 500, // Permit 401 response for digest challenge
    timeout: extraConfig.timeout || 15000, // 15 second timeout for image transfers
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    ...(extraConfig.responseType ? { responseType: extraConfig.responseType } : {})
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
 * Uploads a user face image to the Hikvision MinMoe terminal.
 * Follows official Hikvision ISAPI multipart specifications:
 * 1. Standard RFC 7578 multipart format with explicit Content-Length per part.
 * 2. Case-sensitive part names: 'FaceDataRecord' and 'FaceImage' (without filename attribute).
 * 3. Dual synchronization: AccessControl/FaceInfo/SetUp (user profile in web UI) and FDLib/FaceDataRecord (AI matching engine).
 * 4. Automatic handling of existing faces (PUT updates or DELETE+POST if already registered).
 */
async function syncUserFace(deviceIp, devicePort, username, password, userId, imageBuffer, userName = '') {
  const cleanUserId = String(userId).trim();

  if (!imageBuffer || imageBuffer.length === 0) {
    return {
      success: false,
      diagnostic: 'No se proporcionó imagen de rostro para subir.'
    };
  }

  // Validar cabecera JPEG (SOI marker 0xFF 0xD8)
  if (imageBuffer.length < 3 || imageBuffer[0] !== 0xFF || imageBuffer[1] !== 0xD8) {
    console.warn(`[Device API Face] Advertencia: El buffer no comienza con bytes JPEG (0xFF, 0xD8). Bytes: ${imageBuffer.slice(0, 4).toString('hex')}`);
  }

  // Extraer y validar dimensiones JPEG para asegurar formato cuadrado 1:1
  let dims = null;
  try {
    let offset = 2;
    while (offset < imageBuffer.length - 8) {
      if (imageBuffer[offset] !== 0xFF) { offset++; continue; }
      const marker = imageBuffer[offset + 1];
      if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
        dims = {
          height: imageBuffer.readUInt16BE(offset + 5),
          width: imageBuffer.readUInt16BE(offset + 7)
        };
        break;
      }
      const len = imageBuffer.readUInt16BE(offset + 2);
      offset += 2 + len;
    }
  } catch (_) {}

  if (dims) {
    console.log(`[Device API Face] Dimensiones de imagen: ${dims.width}x${dims.height} px (Ratio: ${(dims.width / dims.height).toFixed(2)})`);
    if (dims.width !== dims.height) {
      console.warn(`[Device API Face ADVERTENCIA] La imagen no es cuadrada (${dims.width}x${dims.height}). MinMoe requiere 1:1 (ej. 600x600 px) para mostrarla en la interfaz web.`);
    }
  }

  // Helper to build standard RFC 7578 multipart/form-data with filename and exact Content-Length
  function buildMultipart(boundary, jsonPartName, jsonPayload, imagePartName, imgBuf) {
    const jsonStr = typeof jsonPayload === 'string' ? jsonPayload : JSON.stringify(jsonPayload);
    const jsonBuf = Buffer.from(jsonStr, 'utf8');

    const part1Header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${jsonPartName}"\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${jsonBuf.length}\r\n\r\n`
    );

    // CRUCIAL: "filename="face.jpg"" es obligatorio en Hikvision MinMoe para que el sistema
    // reconozca el buffer binario como archivo de imagen y lo guarde en la ficha del usuario.
    const part2Header = Buffer.from(
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${imagePartName}"; filename="face.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n` +
      `Content-Length: ${imgBuf.length}\r\n\r\n`
    );

    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

    return Buffer.concat([part1Header, jsonBuf, part2Header, imgBuf, footer]);
  }

  let boundary = '----HikBoundary' + crypto.randomBytes(8).toString('hex');
  const payloadFD = {
    faceLibType: "blackFD",
    FDID: "1",
    FPID: cleanUserId
  };
  if (userName) {
    payloadFD.name = String(userName).trim();
  }

  let bodyFD = buildMultipart(boundary, "FaceDataRecord", payloadFD, "FaceImage", imageBuffer);

  try {
    // =========================================================================
    // PASO 1: Subir rostro al motor inteligente (FDLib/FaceDataRecord)
    // Este es el endpoint oficial de Hikvision para almacenar fotos de rostro
    // =========================================================================
    console.log(`[Device API Face] Subiendo rostro a FDLib/FaceDataRecord (POST, ID: ${cleanUserId}, ${Math.round(imageBuffer.length / 1024)} KB)...`);
    let lastResult = await sendISAPIGenericRequest(
      deviceIp,
      devicePort,
      username,
      password,
      'POST',
      `/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json`,
      { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      bodyFD
    );

    let isSuccess = isISAPISuccess(lastResult.status, lastResult.data);
    let dataStr = typeof lastResult.data === 'string' ? lastResult.data : JSON.stringify(lastResult.data || {});

    // PASO 2: Si el rostro ya existe en FDLib, actualizar con PUT
    if (!isSuccess && /alreadyExist|deviceUserAlreadyExistFace|deviceUserAlreadyExist/i.test(dataStr)) {
      console.log(`[Device API Face] Rostro ya existe en FDLib. Actualizando con PUT...`);
      lastResult = await sendISAPIGenericRequest(
        deviceIp,
        devicePort,
        username,
        password,
        'PUT',
        `/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json`,
        { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        bodyFD
      );
      isSuccess = isISAPISuccess(lastResult.status, lastResult.data);
      dataStr = typeof lastResult.data === 'string' ? lastResult.data : JSON.stringify(lastResult.data || {});
    }

    // PASO 3: Si PUT falló o sigue marcando duplicado bloqueado, eliminar registro y reintentar POST en limpio
    if (!isSuccess && /alreadyExist|deviceUserAlreadyExistFace|deviceUserAlreadyExist/i.test(dataStr)) {
      console.log(`[Device API Face] Limpiando registro anterior de rostro para ID: ${cleanUserId} antes de reintentar...`);
      await sendISAPIGenericRequest(
        deviceIp,
        devicePort,
        username,
        password,
        'PUT',
        `/ISAPI/AccessControl/FaceInfo/Delete?format=json`,
        { 'Content-Type': 'application/json' },
        { FaceInfoDelCond: { EmployeeNoList: [{ employeeNo: cleanUserId }] } }
      ).catch(() => {});

      boundary = '----HikBoundary' + crypto.randomBytes(8).toString('hex');
      bodyFD = buildMultipart(boundary, "FaceDataRecord", payloadFD, "FaceImage", imageBuffer);

      lastResult = await sendISAPIGenericRequest(
        deviceIp,
        devicePort,
        username,
        password,
        'POST',
        `/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json`,
        { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        bodyFD
      );
      isSuccess = isISAPISuccess(lastResult.status, lastResult.data);
      dataStr = typeof lastResult.data === 'string' ? lastResult.data : JSON.stringify(lastResult.data || {});
    }

    // PASO 4: Si falló por biblioteca no soportada, reintentar con staticFD
    if (!isSuccess && /invalidFaceLibType|faceLibTypeNotExist/i.test(dataStr)) {
      console.log(`[Device API Face] Reintentando con faceLibType: staticFD...`);
      payloadFD.faceLibType = "staticFD";
      boundary = '----HikBoundary' + crypto.randomBytes(8).toString('hex');
      bodyFD = buildMultipart(boundary, "FaceDataRecord", payloadFD, "FaceImage", imageBuffer);

      lastResult = await sendISAPIGenericRequest(
        deviceIp,
        devicePort,
        username,
        password,
        'POST',
        `/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json`,
        { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        bodyFD
      );
      isSuccess = isISAPISuccess(lastResult.status, lastResult.data);
      dataStr = typeof lastResult.data === 'string' ? lastResult.data : JSON.stringify(lastResult.data || {});
    }

    // PASO 5: Fallback con AccessControl/FaceInfo/Record si FDLib no estuviera habilitado en el modelo
    if (!isSuccess && !/SubpicAnalysisModelingError|noFaceDetected|faceQualityTooLow/i.test(dataStr)) {
      console.log(`[Device API Face] Intentando fallback con AccessControl/FaceInfo/Record...`);
      lastResult = await sendISAPIGenericRequest(
        deviceIp,
        devicePort,
        username,
        password,
        'POST',
        `/ISAPI/AccessControl/FaceInfo/Record?format=json`,
        { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        bodyFD
      );
      isSuccess = isISAPISuccess(lastResult.status, lastResult.data);
      dataStr = typeof lastResult.data === 'string' ? lastResult.data : JSON.stringify(lastResult.data || {});
    }

    const diagnostic = extractISAPIDiagnostic(lastResult ? lastResult.data : null);
    console.log(`[Device API Face Result] ID: ${cleanUserId} -> Exito: ${isSuccess} | ${diagnostic}`);

    if (!isSuccess && lastResult) {
      console.log(`[Device API Face DEBUG RAW ERROR]: Status: ${lastResult.status} | Data:`, lastResult.data);
    }

    return {
      success: isSuccess,
      status: lastResult ? lastResult.status : null,
      data: lastResult ? lastResult.data : null,
      diagnostic: isSuccess ? 'Fotografia facial sincronizada exitosamente en el MinMoe.' : diagnostic
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
      userSuccess: false,
      cardSuccess: false,
      faceSuccess: false,
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
  // porque el hardware responderá con employeeNoNotExist
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
    const faceRes = await syncUserFace(ip, port, userAuth, pass, user.user_id, imageBuffer, user.name);
    diagnostics.push(`Rostro: ${faceRes.diagnostic}`);
    faceSuccess = faceRes.success;
  }

  // overallSuccess es verdadero si el usuario se creó Y (si se adjuntó foto) la foto se subió exitosamente
  const overallSuccess = userSuccess && (imageBuffer ? faceSuccess === true : true);

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
 * Deletes a user, their face data, and their cards from the Hikvision MinMoe terminal.
 */
async function deleteUserFromDevice(deviceIp, devicePort, username, password, userId) {
  const cleanUserId = String(userId).trim();
  const diagnostics = [];
  let isSuccess = false;

  // 1. Eliminar rostro primero (para liberar la memoria de reconocimiento facial)
  try {
    console.log(`[Device API] Eliminando fotografía de rostro para ID "${cleanUserId}" en el MinMoe...`);
    // Intento FaceInfo/Delete
    await sendISAPIGenericRequest(
      deviceIp,
      devicePort,
      username,
      password,
      'PUT',
      '/ISAPI/AccessControl/FaceInfo/Delete?format=json',
      { 'Content-Type': 'application/json' },
      { FaceInfoDelCond: { EmployeeNoList: [{ employeeNo: cleanUserId }] } }
    ).catch(() => {});

    // Intento FDLib blackFD DELETE
    await sendISAPIGenericRequest(
      deviceIp,
      devicePort,
      username,
      password,
      'DELETE',
      `/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json&FDID=1&faceLibType=blackFD&FPID=${cleanUserId}`,
      { 'Content-Type': 'application/json' }
    ).catch(() => {});

    // Intento FDLib normalFD DELETE
    await sendISAPIGenericRequest(
      deviceIp,
      devicePort,
      username,
      password,
      'DELETE',
      `/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json&FDID=1&faceLibType=normalFD&FPID=${cleanUserId}`,
      { 'Content-Type': 'application/json' }
    ).catch(() => {});
  } catch (faceErr) {
    console.warn(`[Device API] Aviso al limpiar rostro: ${faceErr.message}`);
  }

  // 2. Eliminar tarjeta vinculada
  try {
    console.log(`[Device API] Desvinculando tarjeta para ID "${cleanUserId}" en el MinMoe...`);
    await sendISAPIGenericRequest(
      deviceIp,
      devicePort,
      username,
      password,
      'PUT',
      '/ISAPI/AccessControl/CardInfo/Delete?format=json',
      { 'Content-Type': 'application/json' },
      { CardInfoDelCond: { CardNoList: [{ cardNo: cleanUserId }] } }
    ).catch(() => {});
  } catch (cardErr) {
    console.warn(`[Device API] Aviso al limpiar tarjeta: ${cardErr.message}`);
  }

  // 3. Eliminar usuario del subsistema de Control de Acceso (UserInfo/Delete)
  try {
    console.log(`[Device API] Eliminando usuario "${cleanUserId}" de la base de datos del MinMoe...`);
    const primaryPayload = {
      UserInfoDelCond: {
        EmployeeNoList: [
          {
            employeeNo: cleanUserId
          }
        ]
      }
    };

    let result = await sendISAPIGenericRequest(
      deviceIp,
      devicePort,
      username,
      password,
      'PUT',
      '/ISAPI/AccessControl/UserInfo/Delete?format=json',
      { 'Content-Type': 'application/json' },
      primaryPayload
    );

    isSuccess = isISAPISuccess(result.status, result.data);
    let dataStr = typeof result.data === 'string' ? result.data : JSON.stringify(result.data || {});

    // Si el dispositivo responde que el usuario no existe, ya estaba ausente
    if (/employeeNoNotExist|targetNotExist/i.test(dataStr)) {
      isSuccess = true;
      diagnostics.push('El usuario ya no existía en el dispositivo biométrico.');
      return { success: true, diagnostics, summary: diagnostics.join(' - ') };
    }

    // Fallback 1: Formato simplificado sin EmployeeNoList
    if (!isSuccess) {
      console.log(`[Device API] Reintentando borrado de usuario con payload simplificado...`);
      const fallbackPayload = {
        UserInfoDelCond: {
          employeeNo: cleanUserId
        }
      };
      result = await sendISAPIGenericRequest(
        deviceIp,
        devicePort,
        username,
        password,
        'PUT',
        '/ISAPI/AccessControl/UserInfo/Delete?format=json',
        { 'Content-Type': 'application/json' },
        fallbackPayload
      );
      isSuccess = isISAPISuccess(result.status, result.data);
      dataStr = typeof result.data === 'string' ? result.data : JSON.stringify(result.data || {});

      if (/employeeNoNotExist|targetNotExist/i.test(dataStr)) {
        isSuccess = true;
        diagnostics.push('El usuario ya no existía en el dispositivo biométrico.');
        return { success: true, diagnostics, summary: diagnostics.join(' - ') };
      }
    }

    // Fallback 2: Método HTTP DELETE en Record
    if (!isSuccess) {
      console.log(`[Device API] Reintentando borrado con DELETE UserInfo/Record...`);
      result = await sendISAPIGenericRequest(
        deviceIp,
        devicePort,
        username,
        password,
        'DELETE',
        `/ISAPI/AccessControl/UserInfo/Record?format=json&employeeNo=${cleanUserId}`,
        { 'Content-Type': 'application/json' }
      );
      isSuccess = isISAPISuccess(result.status, result.data);
    }

    const diag = extractISAPIDiagnostic(result ? result.data : null);
    diagnostics.push(`Usuario: ${diag}`);

    return {
      success: isSuccess,
      diagnostics,
      summary: diagnostics.join(' - ')
    };
  } catch (err) {
    console.warn(`[Device API] Error al eliminar usuario en MinMoe: ${err.message}`);
    diagnostics.push(`Error de red al eliminar del biométrico: ${err.message}`);
    return {
      success: false,
      diagnostics,
      summary: diagnostics.join(' - ')
    };
  }
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

/**
 * Triggers remote face capture on the physical MinMoe device camera.
 * Prompts the user to stand in front of the terminal to capture face data.
 */
async function captureFaceFromDevice(settings, timeoutSeconds = 20) {
  const ip = settings.device_ip;
  const port = settings.device_port || 80;
  const user = settings.device_user || 'admin';
  const pass = settings.device_password || '';

  if (!ip || !user || !pass) {
    throw new Error('Parámetros de conexión del lector biométrico incompletos.');
  }

  console.log(`[Device API Capture] Iniciando captura facial remota en MinMoe (${ip})...`);

  const jsonCond = {
    CaptureFaceDataCond: {
      captureInfrared: false,
      dataType: "url"
    }
  };

  let initRes = await sendISAPIGenericRequest(
    ip, port, user, pass,
    'POST',
    `/ISAPI/AccessControl/CaptureFaceData?format=json`,
    { 'Content-Type': 'application/json' },
    JSON.stringify(jsonCond)
  ).catch(async () => {
    const xmlCond = `<CaptureFaceDataCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><captureInfrared>false</captureInfrared><dataType>url</dataType></CaptureFaceDataCond>`;
    return await sendISAPIGenericRequest(
      ip, port, user, pass,
      'POST',
      `/ISAPI/AccessControl/CaptureFaceData`,
      { 'Content-Type': 'application/xml' },
      xmlCond
    );
  });

  // Si el dispositivo responde 401, 403, 404 o 405 significa que el firmware no permite invocar la cámara por red
  if (!initRes || initRes.status === 401 || initRes.status === 403 || initRes.status === 404 || initRes.status === 405) {
    const code = initRes ? initRes.status : 'Timeout';
    throw new Error(`La captura remota por red no está habilitada en el firmware de este MinMoe (HTTP ${code}). Por favor tome la foto físicamente en la pantalla del lector y pulse "Importar Foto desde MinMoe".`);
  }

  const startTime = Date.now();
  const maxTimeMs = timeoutSeconds * 1000;
  let capturedUrl = null;

  if (initRes && initRes.data) {
    const dataStr = typeof initRes.data === 'string' ? initRes.data : JSON.stringify(initRes.data);
    const urlMatch = dataStr.match(/faceDataUrl[">:\s]+["']?([^<"'\r\n}]+)/i);
    if (urlMatch) capturedUrl = urlMatch[1].trim();
  }

  // Sondeo del estado de captura mientras el alumno se posiciona frente a la cámara
  while (!capturedUrl && (Date.now() - startTime) < maxTimeMs) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const progRes = await sendISAPIGenericRequest(
        ip, port, user, pass,
        'GET',
        `/ISAPI/AccessControl/CaptureFaceData/Progress?format=json`
      );
      if (progRes.status === 401 || progRes.status === 405) break;

      const dataStr = typeof progRes.data === 'string' ? progRes.data : JSON.stringify(progRes.data || {});
      const progMatch = dataStr.match(/captureProgress[">:\s]+["']?(\d+)/i);
      const progress = progMatch ? parseInt(progMatch[1], 10) : 0;

      const urlMatch = dataStr.match(/faceDataUrl[">:\s]+["']?([^<"'\r\n}]+)/i);
      if (urlMatch) {
        capturedUrl = urlMatch[1].trim();
        break;
      }
      if (progress === 100) {
        capturedUrl = `/ISAPI/AccessControl/CaptureFaceData/FaceData`;
        break;
      }
    } catch (_) {}
  }

  if (!capturedUrl) {
    throw new Error('La captura remota no fue completada por el biométrico. Por favor tome la foto directamente en la pantalla física del MinMoe y pulse "Importar Foto desde MinMoe".');
  }

  console.log(`[Device API Capture] Descargando imagen capturada desde ${capturedUrl}...`);
  const reqPath = capturedUrl.startsWith('http') ? capturedUrl.replace(/^http:\/\/[^/]+/, '') : capturedUrl;
  const imgRes = await sendISAPIGenericRequest(
    ip, port, user, pass,
    'GET',
    reqPath,
    {},
    null,
    { responseType: 'arraybuffer' }
  );

  return Buffer.isBuffer(imgRes.data) ? imgRes.data : Buffer.from(imgRes.data);
}

/**
 * Queries the MinMoe face library to retrieve and download a user's face photo already registered on the terminal.
 */
async function fetchFaceFromDevice(settings, userId) {
  const ip = settings.device_ip;
  const port = settings.device_port || 80;
  const user = settings.device_user || 'admin';
  const pass = settings.device_password || '';
  const cleanUserId = String(userId).trim();

  if (!ip || !user || !pass || !cleanUserId) {
    throw new Error('Parámetros de conexión o ID de usuario incompletos.');
  }

  console.log(`[Device API Face] Consultando fotografía en MinMoe para ID: ${cleanUserId}...`);
  const searchPayload = {
    searchResultPosition: 0,
    maxResults: 1,
    faceLibType: "blackFD",
    FDID: "1",
    FPID: cleanUserId
  };

  let res = await sendISAPIGenericRequest(
    ip, port, user, pass,
    'POST',
    `/ISAPI/Intelligent/FDLib/FDSearch?format=json`,
    { 'Content-Type': 'application/json' },
    searchPayload
  );

  let dataStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {});
  let picUrlMatch = dataStr.match(/picURL[">:\s]+["']?([^<"'\r\n}]+)/i) || dataStr.match(/faceURL[">:\s]+["']?([^<"'\r\n}]+)/i);

  // Si no se encontró en blackFD, reintentar con staticFD
  if (!picUrlMatch || !picUrlMatch[1]) {
    searchPayload.faceLibType = "staticFD";
    try {
      const resStatic = await sendISAPIGenericRequest(
        ip, port, user, pass,
        'POST',
        `/ISAPI/Intelligent/FDLib/FDSearch?format=json`,
        { 'Content-Type': 'application/json' },
        searchPayload
      );
      const dataStrStatic = typeof resStatic.data === 'string' ? resStatic.data : JSON.stringify(resStatic.data || {});
      const matchStatic = dataStrStatic.match(/picURL[">:\s]+["']?([^<"'\r\n}]+)/i) || dataStrStatic.match(/faceURL[">:\s]+["']?([^<"'\r\n}]+)/i);
      if (matchStatic && matchStatic[1]) {
        picUrlMatch = matchStatic;
      }
    } catch (_) {}
  }

  if (!picUrlMatch || !picUrlMatch[1]) {
    throw new Error(`El usuario "${cleanUserId}" no tiene fotografía registrada en el MinMoe.`);
  }

  const picPath = picUrlMatch[1].trim();
  const reqPath = picPath.startsWith('http') ? picPath.replace(/^http:\/\/[^/]+/, '') : picPath;

  console.log(`[Device API Face] Descargando fotografía de ${cleanUserId} desde ${reqPath}...`);
  const imgRes = await sendISAPIGenericRequest(
    ip, port, user, pass,
    'GET',
    reqPath,
    {},
    null,
    { responseType: 'arraybuffer' }
  );

  return Buffer.isBuffer(imgRes.data) ? imgRes.data : Buffer.from(imgRes.data);
}

module.exports = {
  sendISAPICommand,
  openDoor,
  sendISAPIGenericRequest,
  syncUserInfo,
  syncCardInfo,
  syncUserFace,
  syncFullUserToDevice,
  deleteUserFromDevice,
  sendRemoteCheck,
  isISAPISuccess,
  extractISAPIDiagnostic,
  captureFaceFromDevice,
  fetchFaceFromDevice
};
