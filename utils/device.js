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
      numOfFace: 0
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
 * Unified helper to synchronize a complete user profile (UserInfo + CardInfo) to the Hikvision terminal.
 */
async function syncFullUserToDevice(settings, user) {
  const ip = settings.device_ip;
  const port = settings.device_port || 80;
  const userAuth = settings.device_user || 'admin';
  const pass = settings.device_password || '';

  if (!ip || !userAuth || !pass) {
    return {
      synced: false,
      userSuccess: false,
      cardSuccess: false,
      error: 'Parámetros de conexión del lector biométrico incompletos (IP, Usuario o Contraseña no configurados).',
      diagnostics: ['Biométrico no configurado']
    };
  }

  const diagnostics = [];
  let userSuccess = false;
  let cardSuccess = false;

  // 1. Sincronizar información básica de usuario (CREAR primero con Record POST)
  const userRes = await syncUserInfo(ip, port, userAuth, pass, user.user_id, user.name);
  diagnostics.push(`Usuario (${user.name}): ${userRes.diagnostic}`);
  userSuccess = userRes.success;

  // Si el usuario no existe en la base de datos del MinMoe, no tiene sentido intentar vincular tarjeta
  if (!userSuccess) {
    diagnostics.push('Tarjeta omitida: Se requiere que el usuario exista en el MinMoe primero.');
    return {
      synced: false,
      userSuccess: false,
      cardSuccess: false,
      diagnostics,
      summary: `Fallo al registrar usuario en MinMoe: ${userRes.diagnostic}`
    };
  }

  // 2. Sincronizar tarjeta (asociada al user_id)
  const cardRes = await syncCardInfo(ip, port, userAuth, pass, user.user_id, user.user_id);
  diagnostics.push(`Tarjeta (${user.user_id}): ${cardRes.diagnostic}`);
  cardSuccess = cardRes.success;

  const overallSuccess = userSuccess && cardSuccess;

  return {
    synced: overallSuccess,
    userSuccess,
    cardSuccess,
    diagnostics,
    summary: diagnostics.join(' - ')
  };
}

/**
 * Deletes a user and their cards from the Hikvision MinMoe terminal.
 */
async function deleteUserFromDevice(deviceIp, devicePort, username, password, userId) {
  const cleanUserId = String(userId).trim();
  const diagnostics = [];
  let isSuccess = false;

  // 1. Eliminar tarjeta vinculada
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

  // 2. Eliminar usuario del subsistema de Control de Acceso (UserInfo/Delete)
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
module.exports = {
  sendISAPICommand,
  openDoor,
  sendISAPIGenericRequest,
  syncUserInfo,
  syncCardInfo,
  syncFullUserToDevice,
  deleteUserFromDevice,
  sendRemoteCheck,
  isISAPISuccess,
  extractISAPIDiagnostic
};
