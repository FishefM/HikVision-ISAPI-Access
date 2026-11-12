const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const http = require('http');
const axios = require('axios');
const QRCode = require('qrcode');
const dbHelper = require('../config/database');
const { logEvent } = require('../utils/logger');
const deviceHelper = require('../utils/device');

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

// Resolver DNS rápido con respaldo público (1.1.1.1 / 8.8.8.8) para evitar bloqueos de MagicDNS/IPv6
const fastResolver = new dns. promises.Resolver();
fastResolver.setServers(['1.1.1.1', '8.8.8.8', '100.100.100.100']);
const dnsCache = new Map();

function fastDnsLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const wantAll = Boolean(options && options.all);
  const reply = (ip) => {
    if (wantAll) {
      return callback(null, [{ address: ip, family: 4 }]);
    }
    return callback(null, ip, 4);
  };

  if ( netIsIPv4(hostname) ) {
    return reply(hostname);
  }

  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    return reply(cached.ip);
  }

  fastResolver.resolve4(hostname)
    .then((addresses) => {
      if (addresses && addresses.length > 0) {
        const ip = addresses[0];
        dnsCache.set(hostname, { ip, expiresAt: Date.now() + 300000 }); // 5 min cache
        return reply(ip);
      }
      dns.lookup(hostname, { family: 4, all: wantAll }, callback);
    })
    .catch(() => {
      dns.lookup(hostname, { family: 4, all: wantAll }, callback);
    });
}

function netIsIPv4(host) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

const ipv4HttpAgent = new http.Agent({ keepAlive: true, family: 4, lookup: fastDnsLookup });
const ipv4HttpsAgent = new https.Agent({ keepAlive: true, family: 4, lookup: fastDnsLookup });

//-----------------------------------
//----------CRUD Usuarios------------
//-----------------------------------

/**
 * Extrae los primeros 8 caracteres del hash contenido en la URL de la API externa
 */
function extractIdFromApiUrl(apiUrl) {
  if (!apiUrl) return null;
  try {
    const parsed = new URL(apiUrl);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length > 0) {
      const lastSegment = segments[segments.length - 1];
      if (lastSegment && /^[a-zA-Z0-9_-]{8,}$/.test(lastSegment)) {
        return lastSegment.substring(0, 8).toLowerCase();
      }
    }
  } catch (_) {
    const match = String(apiUrl).match(/([a-zA-Z0-9]{8,})/);
    if (match && match[1]) {
      return match[1].substring(0, 8).toLowerCase();
    }
  }
  return null;
}

/**
 * Determina si un registro corresponde a un usuario de pruebas o a un alumno real
 */
function isTestUser(user) {
  if (!user) return false;
  const uid = String(user.user_id || '').trim();
  const url = String(user.api_url || '').toLowerCase();
  const name = String(user.name || '').toLowerCase();
  
  return /^100\d*$/.test(uid) || 
         url.includes('mock-external-api/deny') || 
         url.includes('mock-external-api/error') || 
         name.includes('(permitido)') || 
         name.includes('(denegado)') || 
         name.includes('(error api)') ||
         name.includes('demo') ||
         name.includes('prueba');
}

/**
 * Obtiene usuarios registrados de la base de datos local SQLite,
 * con soporte para filtrar usuarios reales (producción) o de prueba,
 * filtro por texto/búsqueda y filtro opcional por ID de torniquete/dispositivo.
 */
async function getUsers(req, res) {
  try {
    const deviceId = req.query.deviceId || req.query.device_id;
    const search = req.query.search || req.query.q || req.query.busqueda || '';
    const status = req.query.status || 'active';
    let users = await dbHelper.getUsers(null, deviceId, search);
    const filter = req.query.filter;
    if (filter === 'test' || filter === 'pruebas') {
      users = users.filter(u => isTestUser(u));
    } else if (filter === 'production' || filter === 'main' || filter === 'real') {
      users = users.filter(u => !isTestUser(u));
    }

    if (status === 'active') {
      users = users.filter(u => !u.is_archived);
    } else if (status === 'archived') {
      users = users.filter(u => Boolean(u.is_archived));
    } else if (status === 'with_token') {
      users = users.filter(u => !u.is_archived && Boolean(u.attendance_token));
    } else if (status === 'without_token') {
      users = users.filter(u => !u.is_archived && !u.attendance_token);
    }
    // Si status === 'all', se incluyen todos los registros

    // Ordenar alumnos: los que tienen token primero, y dentro de cada grupo por ID descendente
    users.sort((a, b) => {
      const aHas = Boolean(a.attendance_token);
      const bHas = Boolean(b.attendance_token);
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      return (b.id || 0) - (a.id || 0);
    });

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.json(users);
  } catch (e) {
    logEvent('error', `[DB ERROR] Error al consultar lista de alumnos en SQLite: ${e.message}`);
    res.status(500).json({ error: `Error de base de datos: ${e.message}` });
  }
}

/**
 * Crea o actualiza un usuario en la base de datos SQLite y sincroniza con el(los) MinMoe asignado(s).
 */
async function addUser(req, res) {
  let { user_id, name, api_url, device_ids, assign_all, device_id, matricula, first_name, second_name, last_name, phone, image_file, acuaticapp_id, attendance_token } = req.body;
  user_id = user_id ? String(user_id).trim() : '';
  name = name ? String(name).trim() : '';
  api_url = api_url ? String(api_url).trim() : '';
  matricula = matricula ? String(matricula).trim() : '';
  first_name = first_name ? String(first_name).trim() : '';
  second_name = second_name ? String(second_name).trim() : '';
  last_name = last_name ? String(last_name).trim() : '';
  phone = phone ? String(phone).trim() : '';
  image_file = image_file ? String(image_file).trim() : '';
  attendance_token = attendance_token ? String(attendance_token).trim() : '';

  // Asignar API URL con attendance_token si está disponible, o mock allow por defecto
  if (attendance_token && (!api_url || api_url.includes('mock-external-api'))) {
    const defaultBaseUrl = process.env.ACUATICAPP_BASE_URL || 'https://multihivesoft.com';
    api_url = `${defaultBaseUrl}/api/attendance/scan/${attendance_token}`;
  } else if (!api_url) {
    api_url = 'http://localhost:3000/api/mock-external-api/allow';
  }

  // Si no se proporcionó nombre completo pero sí nombres/apellidos
  if (!name && (first_name || second_name || last_name)) {
    name = [first_name, second_name, last_name].filter(Boolean).join(' ').trim();
  }

  // Generación o extracción automática de user_id
  if (!user_id) {
    if (matricula) {
      user_id = matricula;
    } else {
      user_id = extractIdFromApiUrl(api_url);
      if (!user_id) {
        user_id = crypto.randomBytes(4).toString('hex');
      }
    }
    logEvent('info', `[ID AUTOMÁTICO] ID generado/extraído para "${name}": "${user_id}"`);
  }

  if (!name) {
    logEvent('warning', '[REGISTRO] Solicitud rechazada: Falta el campo obligatorio Nombre.');
    return res.status(400).json({ error: 'Falta el campo obligatorio Nombre del alumno.' });
  }

  // Determinar dispositivos asignados
  let targetDeviceIds = [];
  const allDevices = await dbHelper.getDevices();

  if (assign_all === true || assign_all === 'true' || assign_all === undefined) {
    targetDeviceIds = allDevices.map(d => d.id);
  } else if (device_ids && Array.isArray(device_ids) && device_ids.length > 0) {
    targetDeviceIds = device_ids.map(Number).filter(Boolean);
  } else if (device_id) {
    targetDeviceIds = [Number(device_id)];
  } else {
    const defaultDev = await dbHelper.getDefaultDevice();
    if (defaultDev) {
      targetDeviceIds = [defaultDev.id];
    } else if (allDevices.length > 0) {
      targetDeviceIds = [allDevices[0].id];
    }
  }

  logEvent('info', `[DB] Guardando alumno en SQLite: ID "${user_id}", Nombre: "${name}", Torniquetes asignados: [${targetDeviceIds.join(', ')}]...`);

  let user = null;
  // Paso 1: Inserción / Upsert en la base de datos local SQLite (evitando duplicados)
  try {
    user = await dbHelper.addUser({
      user_id,
      name,
      api_url,
      matricula,
      first_name,
      second_name,
      last_name,
      phone,
      image_file,
      acuaticapp_id,
      attendance_token: attendance_token || null,
      device_ids: targetDeviceIds
    });
    logEvent('success', `[DB OK] Alumno guardado exitosamente en SQLite local (Registro ID: ${user.id}, User ID: "${user.user_id}").`);
  } catch (dbErr) {
    const msg = `Error al insertar en la base de datos SQLite: ${dbErr.message}`;
    logEvent('error', `[DB ERROR] ${msg}`);
    return res.status(500).json({
      error: msg,
      dbError: dbErr.message
    });
  }

  // Paso 2: Sincronización con el hardware Hikvision MinMoe de cada torniquete asignado en paralelo
  let deviceSyncResult = { synced: false, userSuccess: false, cardSuccess: false, diagnostics: [], summary: '' };
  const targetDevices = allDevices.filter(d => targetDeviceIds.includes(d.id));

  if (targetDevices.length > 0) {
    const syncPromises = targetDevices.map(async (dev) => {
      if (dev.ip && dev.username && dev.password) {
        logEvent('info', `[MinMoe - ${dev.name}] Iniciando sincronización de "${name}" (${user_id}) en ${dev.ip}:${dev.port || 80}...`);
        try {
          const syncRes = await deviceHelper.syncFullUserToDevice({
            device_ip: dev.ip,
            device_port: dev.port || 80,
            device_user: dev.username,
            device_password: dev.password
          }, user);
          return { dev, syncRes };
        } catch (e) {
          return { dev, syncRes: { synced: false, summary: e.message, diagnostics: [e.message] } };
        }
      }
      return { dev, syncRes: { synced: false, summary: 'Credenciales incompletas', diagnostics: ['Faltan credenciales o IP del lector.'] } };
    });

    const settled = await Promise.allSettled(syncPromises);
    let syncedDevicesCount = 0;
    for (const item of settled) {
      if (item.status === 'fulfilled' && item.value) {
        const { dev, syncRes } = item.value;
        if (syncRes.synced) {
          syncedDevicesCount++;
          logEvent('success', `[MinMoe OK - ${dev.name}] Alumno "${name}" sincronizado con éxito (Usuario y Tarjeta).`);
        } else {
          logEvent('warning', `[MinMoe ADVERTENCIA - ${dev.name}] ${syncRes.summary}`);
        }
        if (syncRes.diagnostics) {
          syncRes.diagnostics.forEach(diag => {
            deviceSyncResult.diagnostics.push(`[${dev.name}] ${diag}`);
            logEvent(syncRes.synced ? 'info' : 'warning', `  └─ [${dev.name}] ${diag}`);
          });
        }
      }
    }

    deviceSyncResult.synced = syncedDevicesCount === targetDevices.length;
    deviceSyncResult.userSuccess = syncedDevicesCount > 0;
    deviceSyncResult.cardSuccess = syncedDevicesCount > 0;
    deviceSyncResult.summary = `${syncedDevicesCount}/${targetDevices.length} torniquete(s) sincronizados`;
  } else {
    logEvent('info', '[MinMoe] Sincronización omitida: No hay torniquetes seleccionados.');
    deviceSyncResult.diagnostics.push('Sin torniquetes asignados.');
    deviceSyncResult.summary = 'Sin torniquetes asignados';
  }

  res.json({
    success: true,
    user,
    dbStatus: 'ok',
    synced: deviceSyncResult.synced,
    userSuccess: deviceSyncResult.userSuccess,
    cardSuccess: deviceSyncResult.cardSuccess,
    syncSummary: deviceSyncResult.summary,
    diagnostics: deviceSyncResult.diagnostics
  });
}

/**
 * Actualiza un usuario en la base de datos SQLite y sincroniza cambios con los torniquetes asignados
 */
async function updateUser(req, res) {
  const id = req.params.id;
  let { user_id, name, api_url, device_ids, assign_all, device_id, matricula, first_name, second_name, last_name, phone, image_file, acuaticapp_id, attendance_token } = req.body;
  user_id = user_id ? String(user_id).trim() : '';
  name = name ? String(name).trim() : '';
  api_url = api_url ? String(api_url).trim() : '';
  matricula = matricula ? String(matricula).trim() : '';
  first_name = first_name ? String(first_name).trim() : '';
  second_name = second_name ? String(second_name).trim() : '';
  last_name = last_name ? String(last_name).trim() : '';
  phone = phone ? String(phone).trim() : '';
  image_file = image_file ? String(image_file).trim() : '';
  attendance_token = attendance_token !== undefined ? String(attendance_token).trim() : undefined;

  if (!name && (first_name || second_name || last_name)) {
    name = [first_name, second_name, last_name].filter(Boolean).join(' ').trim();
  }

  if (!name) {
    return res.status(400).json({ error: 'Falta el campo obligatorio Nombre del alumno.' });
  }

  // Si no se proporcionó user_id, conservar el existente o generarlo/extraerlo
  const existing = (await dbHelper.getUserByPk(id)) || (await dbHelper.getUserById(id));
  if (!user_id) {
    if (existing && existing.user_id) {
      user_id = existing.user_id;
    } else if (matricula) {
      user_id = matricula;
    } else {
      user_id = extractIdFromApiUrl(api_url);
      if (!user_id) {
        user_id = crypto.randomBytes(4).toString('hex');
      }
    }
  }

  if (attendance_token && (!api_url || api_url.includes('mock-external-api'))) {
    const defaultBaseUrl = process.env.ACUATICAPP_BASE_URL || 'https://multihivesoft.com';
    api_url = `${defaultBaseUrl}/api/attendance/scan/${attendance_token}`;
  } else if (!api_url) {
    api_url = 'http://localhost:3000/api/mock-external-api/allow';
  }

  // Determinar dispositivos asignados
  const allDevices = await dbHelper.getDevices();
  let targetDeviceIds = null;

  if (assign_all === true || assign_all === 'true') {
    targetDeviceIds = allDevices.map(d => d.id);
  } else if (device_ids && Array.isArray(device_ids)) {
    targetDeviceIds = device_ids.map(Number).filter(Boolean);
  } else if (device_id) {
    targetDeviceIds = [Number(device_id)];
  }

  logEvent('info', `[DB] Actualizando alumno en SQLite (ID registro ${id}): User ID: "${user_id}", Nombre: "${name}"...`);

  // Paso 1: Actualizar en SQLite
  try {
    await dbHelper.updateUser(id, {
      user_id,
      name,
      api_url,
      matricula,
      first_name,
      second_name,
      last_name,
      phone,
      image_file,
      acuaticapp_id,
      attendance_token: attendance_token !== undefined ? attendance_token : undefined,
      device_ids: targetDeviceIds
    });
    logEvent('success', `[DB OK] Alumno actualizado en SQLite: ID "${user_id}", Nombre: "${name}".`);
  } catch (dbErr) {
    logEvent('error', `[DB ERROR] Error al actualizar en SQLite: ${dbErr.message}`);
    return res.status(500).json({ error: `Error de base de datos al actualizar: ${dbErr.message}` });
  }

  // Paso 2: Sincronizar con el hardware MinMoe de los torniquetes asignados en paralelo
  const currentDeviceIds = targetDeviceIds !== null ? targetDeviceIds : (existing ? existing.device_ids : []);
  const targetDevices = allDevices.filter(d => currentDeviceIds.includes(d.id));
  
  let deviceSyncResult = { synced: false, userSuccess: false, cardSuccess: false, diagnostics: [], summary: '' };
  if (targetDevices.length > 0) {
    // Si la matrícula, user_id o token cambió, remover el ID anterior del hardware MinMoe para no dejar huérfanos
    const oldMinMoeId = (existing && existing.attendance_token && String(existing.attendance_token).trim().length >= 8)
      ? String(existing.attendance_token).trim().substring(0, 8)
      : (existing && existing.user_id ? String(existing.user_id).trim() : null);

    const newMinMoeId = (attendance_token && String(attendance_token).trim().length >= 8)
      ? String(attendance_token).trim().substring(0, 8)
      : String(user_id).trim();

    if (oldMinMoeId && oldMinMoeId !== newMinMoeId) {
      logEvent('info', `[MinMoe] Identificador en MinMoe modificado de "${oldMinMoeId}" a "${newMinMoeId}". Removiendo registro antiguo en torniquetes...`);
      allDevices.forEach(dev => {
        if (dev.ip && dev.username && dev.password) {
          deviceHelper.deleteUserFromDevice(
            dev.ip,
            dev.port || 80,
            dev.username,
            dev.password,
            oldMinMoeId
          ).catch(() => {});
        }
      });
    }

    const syncPromises = targetDevices.map(async (dev) => {
      if (dev.ip && dev.username && dev.password) {
        logEvent('info', `[MinMoe - ${dev.name}] Actualizando datos de "${name}" (${newMinMoeId}) en ${dev.ip}...`);
        try {
          const syncRes = await deviceHelper.syncFullUserToDevice({
            device_ip: dev.ip,
            device_port: dev.port || 80,
            device_user: dev.username,
            device_password: dev.password
          }, {
            user_id,
            name,
            image_file,
            attendance_token: attendance_token !== undefined ? attendance_token : (existing ? existing.attendance_token : null)
          });
          return { dev, syncRes };
        } catch (e) {
          return { dev, syncRes: { synced: false, summary: e.message, diagnostics: [e.message] } };
        }
      }
      return { dev, syncRes: { synced: false, summary: 'Credenciales incompletas', diagnostics: ['Faltan datos de conexión'] } };
    });

    const settled = await Promise.allSettled(syncPromises);
    let syncedDevicesCount = 0;
    for (const item of settled) {
      if (item.status === 'fulfilled' && item.value) {
        const { dev, syncRes } = item.value;
        if (syncRes.synced) {
          syncedDevicesCount++;
          logEvent('success', `[MinMoe OK - ${dev.name}] Alumno "${name}" actualizado con éxito.`);
        } else {
          logEvent('warning', `[MinMoe ADVERTENCIA - ${dev.name}] ${syncRes.summary}`);
        }
        if (syncRes.diagnostics) {
          syncRes.diagnostics.forEach(diag => {
            deviceSyncResult.diagnostics.push(`[${dev.name}] ${diag}`);
          });
        }
      }
    }
    deviceSyncResult.synced = syncedDevicesCount === targetDevices.length;
    deviceSyncResult.userSuccess = syncedDevicesCount > 0;
    deviceSyncResult.cardSuccess = syncedDevicesCount > 0;
    deviceSyncResult.summary = `${syncedDevicesCount}/${targetDevices.length} torniquete(s) actualizados`;
  }

  res.json({
    success: true,
    dbStatus: 'ok',
    synced: deviceSyncResult.synced,
    userSuccess: deviceSyncResult.userSuccess,
    cardSuccess: deviceSyncResult.cardSuccess,
    syncSummary: deviceSyncResult.summary,
    diagnostics: deviceSyncResult.diagnostics
  });
}

/**
 * Ejecuta petición HTTP con IPv4 forzado, DNS rápido, timeout y reintentos automáticos
 */
async function fetchWithRetry(url, options = {}, { maxRetries = 3, timeoutMs = 20000, label = 'API AcuaticApp' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let dataPayload = options.body;
      if (typeof dataPayload === 'string') {
        try { dataPayload = JSON.parse(dataPayload); } catch (_) {}
      }

      const response = await axios({
        url,
        method: options.method || 'GET',
        headers: options.headers || {},
        data: dataPayload,
        timeout: timeoutMs,
        httpAgent: ipv4HttpAgent,
        httpsAgent: ipv4HttpsAgent,
        validateStatus: () => true
      });

      if (response.status >= 500 && attempt < maxRetries) {
        throw new Error(`Servidor respondió HTTP ${response.status}`);
      }

      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.data
      };
    } catch (err) {
      lastError = err;
      const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(err.message);
      const reason = isTimeout ? `tiempo de espera agotado (${timeoutMs / 1000}s)` : err.message;

      if (attempt < maxRetries) {
        const delayMs = attempt * 1500;
        logEvent('warning', `[AcuaticApp] Intento ${attempt}/${maxRetries} falló en ${label} (${reason}). Reintentando en ${delayMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Lógica central para importar y sincronizar alumnos desde la API v2 de AcuaticApp
 * Reutilizable tanto por la ruta HTTP como por la sincronización automática programada (15:00 y 23:00 hrs).
 */
async function performAcuaticAppSync({ user, password, baseUrl, clearFirst = false, trigger = 'manual' } = {}) {
  const schoolUser = user || process.env.ACUATICAPP_USER || '';
  const schoolPass = password || process.env.ACUATICAPP_PASSWORD || '';
  const apiBaseUrl = baseUrl || process.env.ACUATICAPP_BASE_URL || 'https://multihivesoft.com';

  logEvent('info', `=== INICIANDO SINCRONIZACIÓN ${trigger === 'auto' ? 'AUTOMÁTICA PROGRAMADA' : 'DESDE ACUATICAPP'} (${apiBaseUrl}) ===`);
  logEvent('info', `Autenticando escuela "${schoolUser}"...`);

  // 1. Login en AcuaticApp (con reintento automático)
  const loginRes = await fetchWithRetry(
    `${apiBaseUrl}/api/school/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: schoolUser, password: schoolPass })
    },
    { maxRetries: 3, timeoutMs: 20000, label: `login de "${schoolUser}"` }
  );

  const loginData = await loginRes.json();
  if (!loginRes.ok || !loginData.token) {
    throw new Error(loginData.message || `Fallo de autenticación en AcuaticApp (HTTP ${loginRes.status})`);
  }

  const token = loginData.token;
  const schoolInfo = loginData.school || {};
  logEvent('success', `[AcuaticApp OK] Escuela autenticada exitosamente (ID: ${schoolInfo.id || 'N/A'}). Extrayendo lista de alumnos...`);

  // 2. Extraer todas las páginas de alumnos en memoria antes de modificar o limpiar la BD local
  let currentPage = 1;
  let lastPage = 1;
  const extractedStudents = [];

  while (currentPage <= lastPage) {
    logEvent('info', `Consultando página ${currentPage}${lastPage > 1 ? `/${lastPage}` : ''} de alumnos en AcuaticApp...`);
    const studentsRes = await fetchWithRetry(
      `${apiBaseUrl}/api/v2/administration/student/getStudents?page=${currentPage}&per_page=50`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      },
      { maxRetries: 3, timeoutMs: 20000, label: `consulta de alumnos (página ${currentPage})` }
    );

    if (!studentsRes.ok) {
      throw new Error(`Error al consultar alumnos en página ${currentPage} (HTTP ${studentsRes.status})`);
    }

    const studentsData = await studentsRes.json();
    const studentsList = studentsData.data || [];
    lastPage = parseInt(studentsData.last_page || 1, 10);

    extractedStudents.push(...studentsList);
    currentPage++;
  }

  logEvent('info', `[AcuaticApp] Extracción exitosa: ${extractedStudents.length} alumnos descargados. Guardando en base de datos local...`);

  // 3. Limpiar usuarios previos SOLO si fue solicitado explícitamente y tras descargar exitosamente
  if (clearFirst) {
    logEvent('info', 'Limpiando usuarios previos en base de datos local SQLite antes de insertar los nuevos...');
    try {
      await dbHelper.clearUsers();
      logEvent('success', 'Base de datos de alumnos limpiada correctamente para importación limpia.');
    } catch (clearErr) {
      logEvent('warning', `No se pudo limpiar la base de datos: ${clearErr.message}`);
    }
  }

  // 4. Guardar los alumnos extraídos en SQLite
  let totalProcessed = 0;
  let createdCount = 0;
  let updatedCount = 0;
  const allDevices = await dbHelper.getDevices();
  const allDeviceIds = allDevices.map(d => d.id);

  for (const st of extractedStudents) {
    const fullName = [st.name, st.second_name, st.last_name].filter(Boolean).join(' ').trim() || `Alumno ${st.id}`;
    const matriculaStr = st.matricula ? String(st.matricula).trim() : '';
    const userId = matriculaStr || String(st.id);
    const attendanceToken = st.attendance_token ? String(st.attendance_token).trim() : null;

    const studentApiUrl = attendanceToken 
      ? `${apiBaseUrl}/api/attendance/scan/${attendanceToken}`
      : 'http://localhost:3000/api/mock-external-api/allow';

    try {
      const userResult = await dbHelper.addUser({
        user_id: userId,
        name: fullName,
        api_url: studentApiUrl,
        matricula: matriculaStr || null,
        first_name: st.name || null,
        second_name: st.second_name || null,
        last_name: st.last_name || null,
        phone: st.phone || null,
        image_file: st.image_file || null,
        acuaticapp_id: st.id,
        attendance_token: attendanceToken,
        device_ids: allDeviceIds
      });

      if (userResult.is_created) {
        createdCount++;
      } else {
        updatedCount++;
      }
      totalProcessed++;
    } catch (uErr) {
      logEvent('warning', `No se pudo procesar alumno ID ${st.id} (${fullName}): ${uErr.message}`);
    }
  }

  const summary = `Sincronización completada: ${totalProcessed} alumnos procesados (${createdCount} nuevos, ${updatedCount} actualizados).`;
  logEvent('success', `=== ${summary.toUpperCase()} ===`);

  return {
    success: true,
    total: totalProcessed,
    created: createdCount,
    updated: updatedCount,
    school: schoolInfo,
    message: summary
  };
}

/**
 * Importa y sincroniza todos los alumnos desde la API v2 de AcuaticApp (manualmente vía REST)
 */
async function syncAcuaticAppUsers(req, res) {
  try {
    const result = await performAcuaticAppSync({
      user: req.body && req.body.user,
      password: req.body && req.body.password,
      baseUrl: req.body && req.body.baseUrl,
      clearFirst: req.body && (req.body.clear_first === true || req.body.clear_first === 'true'),
      trigger: 'manual'
    });
    res.json(result);
  } catch (err) {
    logEvent('error', `[AcuaticApp ERROR] Fallo durante la importación: ${err.message}`);
    res.status(500).json({ error: `Fallo al sincronizar con AcuaticApp: ${err.message}` });
  }
}

/**
 * Obtiene las horas configuradas para la sincronización automática diaria.
 * Por defecto se ejecuta a las 15:00 hrs y a las 23:00 hrs todos los días.
 */
function getScheduledSyncHours() {
  if (process.env.ACUATICAPP_SYNC_HOURS) {
    const parsed = process.env.ACUATICAPP_SYNC_HOURS.split(',')
      .map(h => parseInt(h.trim(), 10))
      .filter(h => !isNaN(h) && h >= 0 && h <= 23);
    if (parsed.length > 0) {
      return [...new Set(parsed)].sort((a, b) => a - b);
    }
  }
  return [15, 23];
}

/**
 * Calcula la fecha y hora de la próxima sincronización programada.
 */
function getNextSyncDate(targetHours = [15, 23], fromDate = new Date()) {
  const now = fromDate;
  const candidates = targetHours.map(hour => {
    const candidate = new Date(now);
    candidate.setHours(hour, 0, 0, 0);
    // Si la hora ya pasó hoy (es menor o igual al momento actual), programar para el día siguiente
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  });

  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0];
}

let autoSyncTimeout = null;

/**
 * Programa la siguiente ejecución de sincronización automática según los horarios fijados (15:00 y 23:00 hrs).
 */
function scheduleNextAcuaticAppSync() {
  if (autoSyncTimeout) {
    clearTimeout(autoSyncTimeout);
    autoSyncTimeout = null;
  }

  const hours = getScheduledSyncHours();
  const nextRun = getNextSyncDate(hours);
  const now = new Date();
  const delayMs = Math.max(1000, nextRun.getTime() - now.getTime());

  const formattedHours = hours.map(h => `${String(h).padStart(2, '0')}:00`).join(' y ');
  const nextTimeStr = nextRun.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  const nextDateStr = nextRun.toLocaleDateString('es-MX');
  const diffHours = (delayMs / (1000 * 60 * 60)).toFixed(2);

  logEvent('info', `[Auto-Sync] Sincronización automática de AcuaticApp configurada a las ${formattedHours} hrs diarias. Próxima ejecución: ${nextDateStr} a las ${nextTimeStr} hrs (en ~${diffHours}h).`);

  autoSyncTimeout = setTimeout(async () => {
    // Si el temporizador despertó unos milisegundos antes del horario exacto, esperar el remanente
    const remaining = nextRun.getTime() - Date.now();
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining));
    }

    logEvent('info', `[Auto-Sync] Iniciando ciclo programado de sincronización automática de alumnos (${nextTimeStr} hrs)...`);
    try {
      const res = await performAcuaticAppSync({ clearFirst: false, trigger: 'auto' });
      logEvent('success', `[Auto-Sync OK] ${res.message}`);
    } catch (err) {
      logEvent('warning', `[Auto-Sync AVISO] No se pudo completar la sincronización automática: ${err.message}`);
    } finally {
      // Reprogramar recursivamente para el siguiente horario fijado
      scheduleNextAcuaticAppSync();
    }
  }, delayMs);

  if (typeof autoSyncTimeout.unref === 'function') {
    autoSyncTimeout.unref();
  }
}

/**
 * Inicia la sincronización automática recurrente de AcuaticApp (a las 15:00 hrs y 23:00 hrs periódicamente todos los días)
 */
function initAcuaticAppAutoSync() {
  scheduleNextAcuaticAppSync();
}

/**
 * Eliminación de usuarios en los biométricos MinMoe asignados y en SQLite
 */
async function deleteUser(req, res) {
  const id = req.params.id;
  try {
    const targetUser = (await dbHelper.getUserByPk(id)) || (await dbHelper.getUserById(id));

    if (!targetUser) {
      await dbHelper.deleteUser(id);
      logEvent('warning', `[DB ADVERTENCIA] Usuario con ID registro ${id} no encontrado en memoria, pero se ejecutó borrado.`);
      return res.json({ success: true, message: 'Usuario no encontrado previamente.' });
    }

    // Paso 1: Eliminar del hardware biométrico MinMoe de todos los torniquetes registrados
    const allDevices = await dbHelper.getDevices();
    const activeDevices = allDevices.filter(d => d.ip && d.username && d.password);

    let deletedCount = 0;
    const diagnostics = [];

    // Recolectar todos los identificadores posibles con los que pudo haber sido enrolado en MinMoe
    const idsToClean = new Set();
    if (targetUser.attendance_token && String(targetUser.attendance_token).trim().length >= 8) {
      idsToClean.add(String(targetUser.attendance_token).trim().substring(0, 8));
    }
    if (targetUser.user_id) idsToClean.add(String(targetUser.user_id).trim());
    if (targetUser.matricula) idsToClean.add(String(targetUser.matricula).trim());

    for (const dev of activeDevices) {
      logEvent('info', `[MinMoe - ${dev.name}] Eliminando alumno "${targetUser.name}" (${Array.from(idsToClean).join(', ')}) en ${dev.ip}...`);
      let devDeleted = false;
      for (const cleanId of idsToClean) {
        const devRes = await deviceHelper.deleteUserFromDevice(
          dev.ip,
          dev.port || 80,
          dev.username,
          dev.password,
          cleanId
        ).catch(() => ({ success: false }));

        if (devRes && devRes.success) devDeleted = true;
        if (devRes && devRes.diagnostics) {
          devRes.diagnostics.forEach(diag => diagnostics.push(`[${dev.name}] ${diag}`));
        }
      }

      if (devDeleted) {
        deletedCount++;
        logEvent('success', `[MinMoe OK - ${dev.name}] Alumno "${targetUser.name}" eliminado del torniquete.`);
      } else {
        logEvent('warning', `[MinMoe AVISO - ${dev.name}] Finalizó intento de borrado para "${targetUser.name}".`);
      }
    }

    // Paso 2: Marcar en SQLite como eliminado (is_deleted = 1) para que ya no aparezca en la web
    await dbHelper.deleteUser(id);
    logEvent('info', `[DB OK] Alumno "${targetUser.name}" (ID registro: ${id}) marcado como eliminado (oculto en la web, conservado en BD).`);

    res.json({
      success: true,
      message: `Alumno "${targetUser.name}" eliminado de la web y de los torniquetes MinMoe.`,
      deviceDeleted: deletedCount > 0,
      deviceSummary: `${deletedCount}/${activeDevices.length} torniquete(s) procesados`,
      diagnostics
    });
  } catch (e) {
    logEvent('error', `[DB ERROR] Error al eliminar usuario: ${e.message}`);
    res.status(500).json({ error: `Error al eliminar usuario: ${e.message}` });
  }
}

// Control de concurrencia para evitar peticiones masivas duplicadas simultáneas
let isSyncInProgress = false;

/**
 * Sincroniza alumnos existentes hacia el/los dispositivos MinMoe
 * Admite filtrar por deviceId opcional
 */
async function syncAllUsers(req, res) {
  if (isSyncInProgress) {
    return res.status(409).json({
      error: 'Ya hay una sincronización masiva en proceso hacia el biométrico. Por favor espere a que termine.'
    });
  }

  isSyncInProgress = true;

  try {
    const targetDeviceId = req.query.deviceId || req.query.device_id;
    const allDevices = await dbHelper.getDevices();
    let devicesToSync = allDevices;

    if (targetDeviceId) {
      devicesToSync = allDevices.filter(d => String(d.id) === String(targetDeviceId));
    }

    if (devicesToSync.length === 0) {
      return res.status(400).json({ error: 'No hay torniquetes configurados para sincronizar.' });
    }

    logEvent('info', `=== INICIANDO SINCRONIZACIÓN DE ALUMNOS (${devicesToSync.length} torniquete(s)) ===`);

    let allUsers = await dbHelper.getUsers();
    if (req.query.includeTests !== 'true') {
      allUsers = allUsers.filter(u => !isTestUser(u));
    }
    allUsers = allUsers.filter(u => !u.is_archived);

    let globalSyncedCount = 0;
    let globalFailedCount = 0;
    const results = [];

    for (const dev of devicesToSync) {
      if (!dev.ip || !dev.username || !dev.password) {
        logEvent('warning', `[MinMoe - ${dev.name}] Omitido: Faltan credenciales o IP.`);
        continue;
      }

      // Filtrar usuarios asignados a este dispositivo (o todos si no tienen restricción)
      const devUsers = allUsers.filter(u => u.device_ids.length === 0 || u.device_ids.includes(dev.id));
      logEvent('info', `[MinMoe - ${dev.name}] Sincronizando ${devUsers.length} alumnos asignados en ${dev.ip}:${dev.port || 80}...`);

      let devSynced = 0;
      let devFailed = 0;

      for (let i = 0; i < devUsers.length; i++) {
        const u = devUsers[i];
        const syncRes = await deviceHelper.syncFullUserToDevice({
          device_ip: dev.ip,
          device_port: dev.port || 80,
          device_user: dev.username,
          device_password: dev.password
        }, u);

        if (syncRes.synced) {
          devSynced++;
          globalSyncedCount++;
        } else {
          devFailed++;
          globalFailedCount++;
        }

        results.push({
          device: dev.name,
          user_id: u.user_id,
          name: u.name,
          synced: syncRes.synced,
          diagnostics: syncRes.diagnostics
        });

        if (i < devUsers.length - 1) {
          // Pausa controlada configurable (por defecto 250ms) para no saturar el CPU del Hikvision MinMoe
          const syncDelay = parseInt(process.env.HIKVISION_SYNC_DELAY_MS, 10) || 250;
          await new Promise(r => setTimeout(r, syncDelay));
          // Cada 25 alumnos, respiro de 1.5s al procesador embebido del lector
          if ((i + 1) % 25 === 0) {
            await new Promise(r => setTimeout(r, 1500));
          }
        }
      }

      logEvent('info', `[MinMoe - ${dev.name}] Finalizado: ${devSynced} exitosos, ${devFailed} fallidos.`);
    }

    const summaryMsg = `Sincronización finalizada: ${globalSyncedCount} exitosos, ${globalFailedCount} fallidos en ${devicesToSync.length} torniquete(s).`;
    logEvent('info', `=== ${summaryMsg.toUpperCase()} ===`);

    res.json({
      success: true,
      synced: globalSyncedCount,
      failed: globalFailedCount,
      message: summaryMsg,
      results
    });
  } catch (err) {
    logEvent('error', `[MinMoe ERROR CRÍTICO] Fallo en la sincronización global: ${err.message}`);
    res.status(500).json({ error: `Error durante la sincronización: ${err.message}` });
  } finally {
    isSyncInProgress = false;
  }
}

/**
 * Sincroniza un único alumno existente hacia sus dispositivos MinMoe asignados
 */
async function syncSingleUser(req, res) {
  const id = req.params.id;
  try {
    const users = await dbHelper.getUsers();
    let user = users.find(u => String(u.id) === String(id));

    if (!user) {
      return res.status(404).json({ error: 'Alumno no encontrado en la base de datos.' });
    }

    // Si se enviaron device_ids en el body (ej. seleccionados en el formulario antes de guardar), usarlos
    let requestedDeviceIds = null;
    if (req.body && Array.isArray(req.body.device_ids)) {
      requestedDeviceIds = req.body.device_ids.map(Number).filter(Boolean);
      // Guardar la actualización de torniquetes asignados en SQLite si se especificó
      await dbHelper.updateUser(user.id, { device_ids: requestedDeviceIds });
      user.device_ids = requestedDeviceIds;
    }

    const allDevices = await dbHelper.getDevices();
    const userDeviceIds = requestedDeviceIds || user.device_ids || [];
    const targetDevices = allDevices.filter(d => userDeviceIds.length === 0 || userDeviceIds.includes(d.id));

    if (targetDevices.length === 0) {
      return res.status(400).json({ error: 'El alumno no tiene ningún torniquete permitido seleccionado.' });
    }

    logEvent('info', `[MinMoe] Sincronizando alumno individual: ${user.name} (ID: ${user.user_id}) en ${targetDevices.length} torniquete(s)...`);
    
    let syncedCount = 0;
    const diagnostics = [];

    for (const dev of targetDevices) {
      if (dev.ip && dev.username && dev.password) {
        const syncRes = await deviceHelper.syncFullUserToDevice({
          device_ip: dev.ip,
          device_port: dev.port || 80,
          device_user: dev.username,
          device_password: dev.password
        }, user);

        if (syncRes.synced) {
          syncedCount++;
          logEvent('success', `[MinMoe OK - ${dev.name}] ${user.name} sincronizado con éxito.`);
        } else {
          logEvent('warning', `[MinMoe ADVERTENCIA - ${dev.name}] ${syncRes.summary}`);
        }

        syncRes.diagnostics.forEach(diag => diagnostics.push(`[${dev.name}] ${diag}`));
      }
    }

    res.json({
      success: syncedCount > 0,
      user,
      diagnostics,
      summary: `${syncedCount}/${targetDevices.length} torniquete(s) sincronizados`
    });
  } catch (e) {
    logEvent('error', `[MinMoe ERROR] Error al sincronizar alumno individual: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}

/**
 * Genera y sirve el código QR de acceso para un alumno en formato imagen PNG
 */
async function getUserQR(req, res) {
  const id = req.params.id;
  try {
    const users = await dbHelper.getUsers();
    const user = users.find(u => String(u.id) === String(id) || String(u.user_id) === String(id) || (u.attendance_token && String(u.attendance_token) === String(id)));
    if (!user) {
      return res.status(404).json({ error: 'Alumno no encontrado.' });
    }

    // Si el usuario tiene attendance_token, reducir el contenido del QR a solo los primeros 8 caracteres
    let qrContent = String(user.user_id);
    if (user.attendance_token && String(user.attendance_token).trim().length >= 8) {
      qrContent = String(user.attendance_token).trim().substring(0, 8);
    }

    const qrBuffer = await QRCode.toBuffer(qrContent, {
      type: 'png',
      width: 400,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    const safeName = user.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="qr_${safeName}_${user.user_id}.png"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.send(qrBuffer);
  } catch (err) {
    logEvent('error', `[QR ERROR] Error al generar código QR: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * Archiva o reactiva a un alumno.
 * Al archivar:
 *  - Se marca is_archived = 1 en SQLite (sin borrar sus datos ni su historial).
 *  - Se retira del hardware biométrico MinMoe asignado para evitar aperturas offline.
 *  - Todo escaneo futuro es rechazado con motivo "Alumno archivado".
 * Al reactivar:
 *  - Se marca is_archived = 0 en SQLite.
 *  - Se re-sincroniza automáticamente a sus torniquetes asignados.
 */
async function toggleArchiveUser(req, res) {
  const id = req.params.id;
  const isArchived = req.body && req.body.is_archived !== undefined ? Boolean(req.body.is_archived) : true;

  try {
    const user = (await dbHelper.getUserByPk(id)) || (await dbHelper.getUserById(id));
    if (!user) {
      return res.status(404).json({ error: 'Alumno no encontrado en la base de datos.' });
    }

    await dbHelper.setUserArchived(user.id, isArchived);
    const actionWord = isArchived ? 'archivado' : 'reactivado';

    // Manejo de sincronización con el hardware MinMoe
    const allDevices = await dbHelper.getDevices();
    const activeDevices = allDevices.filter(d => d.ip && d.username && d.password);
    const userDeviceIds = user.device_ids || [];
    const targetDevices = allDevices.filter(d => userDeviceIds.length === 0 || userDeviceIds.includes(d.id));

    let deviceSummary = '';
    if (isArchived) {
      let deletedCount = 0;
      const idsToClean = new Set();
      if (user.attendance_token && String(user.attendance_token).trim().length >= 8) {
        idsToClean.add(String(user.attendance_token).trim().substring(0, 8));
      }
      if (user.user_id) idsToClean.add(String(user.user_id).trim());
      if (user.matricula) idsToClean.add(String(user.matricula).trim());

      for (const dev of activeDevices) {
        let devDeleted = false;
        for (const cleanId of idsToClean) {
          const devRes = await deviceHelper.deleteUserFromDevice(
            dev.ip,
            dev.port || 80,
            dev.username,
            dev.password,
            cleanId
          ).catch(() => ({ success: false }));
          if (devRes && devRes.success) devDeleted = true;
        }
        if (devDeleted) deletedCount++;
      }
      deviceSummary = `${deletedCount}/${activeDevices.length} torniquete(s) actualizados`;
      logEvent('info', `[ARCHIVO] Alumno "${user.name}" (${user.user_id}) archivado. Acceso revocado y eliminado de los torniquetes MinMoe.`);
    } else {
      let syncedCount = 0;
      for (const dev of targetDevices) {
        if (dev.ip && dev.username && dev.password) {
          const syncRes = await deviceHelper.syncFullUserToDevice({
            device_ip: dev.ip,
            device_port: dev.port || 80,
            device_user: dev.username,
            device_password: dev.password
          }, user).catch(() => ({ synced: false }));
          if (syncRes && syncRes.synced) syncedCount++;
        }
      }
      deviceSummary = `${syncedCount}/${targetDevices.length} torniquete(s) sincronizados`;
      logEvent('success', `[REACTIVACIÓN] Alumno "${user.name}" (${user.user_id}) reactivado. Acceso restaurado en torniquetes.`);
    }

    res.json({
      success: true,
      is_archived: isArchived,
      message: `Alumno "${user.name}" ${actionWord} con éxito.`,
      deviceSummary
    });
  } catch (err) {
    logEvent('error', `[ARCHIVO ERROR] Error al archivar/reactivar alumno: ${err.message}`);
    res.status(500).json({ error: `Error en la operación: ${err.message}` });
  }
}

module.exports = {
  getUsers,
  addUser,
  updateUser,
  deleteUser,
  toggleArchiveUser,
  syncAllUsers,
  syncSingleUser,
  syncAcuaticAppUsers,
  performAcuaticAppSync,
  initAcuaticAppAutoSync,
  getUserQR
};
