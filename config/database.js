const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, '..', 'database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
  }
});

function initializeDatabase() {
  db.serialize(() => {
    // 1. Tabla de Usuarios
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        api_url TEXT NOT NULL,
        matricula TEXT,
        first_name TEXT,
        second_name TEXT,
        last_name TEXT,
        phone TEXT,
        image_file TEXT,
        acuaticapp_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migración de columnas a users si ya existía la tabla previa
    db.all("PRAGMA table_info(users)", [], (err, columns) => {
      if (!err && columns) {
        const colNames = columns.map(c => c.name);
        if (!colNames.includes('matricula')) db.run("ALTER TABLE users ADD COLUMN matricula TEXT");
        if (!colNames.includes('first_name')) db.run("ALTER TABLE users ADD COLUMN first_name TEXT");
        if (!colNames.includes('second_name')) db.run("ALTER TABLE users ADD COLUMN second_name TEXT");
        if (!colNames.includes('last_name')) db.run("ALTER TABLE users ADD COLUMN last_name TEXT");
        if (!colNames.includes('phone')) db.run("ALTER TABLE users ADD COLUMN phone TEXT");
        if (!colNames.includes('image_file')) db.run("ALTER TABLE users ADD COLUMN image_file TEXT");
        if (!colNames.includes('acuaticapp_id')) db.run("ALTER TABLE users ADD COLUMN acuaticapp_id INTEGER");
      }
    });

    // 2. Tabla de Dispositivos (Múltiples MinMoe)
    db.run(`
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        ip TEXT NOT NULL UNIQUE,
        port INTEGER DEFAULT 80,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        door_channel INTEGER DEFAULT 1,
        enable_api_open INTEGER DEFAULT 1,
        is_active INTEGER DEFAULT 1,
        is_default INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 3. Tabla de Relación Usuario <-> Dispositivos (Asignación por torniquete)
    db.run(`
      CREATE TABLE IF NOT EXISTS user_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        device_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, device_id)
      )
    `);

    // 4. Tabla de logs de acceso
    db.run(`
      CREATE TABLE IF NOT EXISTS access_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        user_id TEXT,
        name TEXT,
        event_type TEXT,
        api_url TEXT,
        api_response TEXT,
        authorized INTEGER,
        door_opened INTEGER,
        device_id INTEGER,
        device_name TEXT,
        device_ip TEXT
      )
    `);

    // 5. Migración de columnas a access_logs si ya existía la tabla previa
    db.all("PRAGMA table_info(access_logs)", [], (err, columns) => {
      if (!err && columns) {
        const colNames = columns.map(c => c.name);
        if (!colNames.includes('device_id')) {
          db.run("ALTER TABLE access_logs ADD COLUMN device_id INTEGER", () => {
            db.run("CREATE INDEX IF NOT EXISTS idx_access_logs_device_id ON access_logs (device_id)");
          });
        } else {
          db.run("CREATE INDEX IF NOT EXISTS idx_access_logs_device_id ON access_logs (device_id)");
        }
        if (!colNames.includes('device_name')) {
          db.run("ALTER TABLE access_logs ADD COLUMN device_name TEXT");
        }
        if (!colNames.includes('device_ip')) {
          db.run("ALTER TABLE access_logs ADD COLUMN device_ip TEXT");
        }
      }
    });

    // 6. Tabla de configuración del sistema (contraseña admin, variables globales)
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    // 7. Tabla de Recepcionistas
    db.run(`
      CREATE TABLE IF NOT EXISTS receptionists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear índices para optimizar consultas frecuentes
    db.run(`CREATE INDEX IF NOT EXISTS idx_access_logs_timestamp ON access_logs (timestamp)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_user_id ON users (user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_user_devices_uid ON user_devices (user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_user_devices_did ON user_devices (device_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_receptionists_username ON receptionists (username)`);


    // 7. Migrar o crear el dispositivo inicial predeterminado si la tabla devices está vacía
    db.all("SELECT COUNT(*) as count FROM devices", [], (err, rows) => {
      if (!err && rows[0].count === 0) {
        db.all("SELECT * FROM settings", [], (sErr, sRows) => {
          const settingsObj = {};
          if (!sErr && sRows) {
            sRows.forEach(r => settingsObj[r.key] = r.value);
          }

          const defaultIp = settingsObj.device_ip || "192.168.100.8";
          const defaultPort = parseInt(settingsObj.device_port || "80", 10);
          const defaultUser = settingsObj.device_user || "admin";
          const defaultPass = settingsObj.device_password || "CON150602CJ1*";
          const defaultDoor = parseInt(settingsObj.device_door_channel || "1", 10);
          const defaultApiOpen = settingsObj.enable_device_api_open === 'false' ? 0 : 1;

          const stmt = db.prepare(`
            INSERT INTO devices (name, ip, port, username, password, door_channel, enable_api_open, is_active, is_default)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)
          `);
          stmt.run("Torniquete 1", defaultIp, defaultPort, defaultUser, defaultPass, defaultDoor, defaultApiOpen, function(insErr) {
            if (!insErr) {
              const devId = this.lastID;
              console.log(`[DB] Dispositivo inicial creado (ID: ${devId}, ${defaultIp}).`);
              
              // Vincular usuarios existentes al dispositivo inicial
              db.all("SELECT user_id FROM users", [], (uErr, uRows) => {
                if (!uErr && uRows && uRows.length > 0) {
                  const uStmt = db.prepare("INSERT OR IGNORE INTO user_devices (user_id, device_id) VALUES (?, ?)");
                  uRows.forEach(u => uStmt.run(u.user_id, devId));
                  uStmt.finalize();
                }
              });
            }
          });
          stmt.finalize();
        });
      }
    });

    // 8. Insertar datos de ejemplo en la tabla de usuarios si está vacía
    db.all("SELECT COUNT(*) as count FROM users", [], (err, rows) => {
      if (!err && rows[0].count === 0) {
        console.log('Inserting seed data into users table...');
        const stmt = db.prepare("INSERT INTO users (user_id, name, api_url) VALUES (?, ?, ?)");
        stmt.run("1001", "Juan Pérez (Permitido)", "http://localhost:3000/api/mock-external-api/allow");
        stmt.run("1002", "María Gómez (Denegado)", "http://localhost:3000/api/mock-external-api/deny");
        stmt.run("1003", "Carlos Ruíz (Error API)", "http://localhost:3000/api/mock-external-api/error");
        stmt.finalize();
      }
    });

    // 9. Insertar contraseña admin por defecto si settings no la tiene
    db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_password', 'admin123')");

    // Ejecutar mantenimiento inicial de purga de logs antiguos
    cleanOldLogs().catch(() => {});
  });
}

// ==========================================================================
// MÉTODOS DE DISPOSITIVOS (MinMoe)
// ==========================================================================
const getDevices = () => new Promise((res, rej) => {
  db.all("SELECT * FROM devices ORDER BY id ASC", [], (err, rows) => err ? rej(err) : res(rows));
});

const getDeviceById = (id) => new Promise((res, rej) => {
  db.get("SELECT * FROM devices WHERE id = ?", [id], (err, row) => err ? rej(err) : res(row));
});

const getDeviceByIp = (ip) => new Promise((res, rej) => {
  if (!ip) return res(null);
  const cleanIp = String(ip).replace('::ffff:', '').trim();
  const normalized = cleanIp.includes('.')
    ? cleanIp.split('.').map(o => isNaN(parseInt(o, 10)) ? o : String(parseInt(o, 10))).join('.')
    : cleanIp;

  db.all("SELECT * FROM devices", [], (err, rows) => {
    if (err) return rej(err);
    if (!rows || rows.length === 0) return res(null);

    const match = rows.find(d => {
      const devCleanIp = String(d.ip || '').replace('::ffff:', '').trim();
      const devNormalized = devCleanIp.includes('.')
        ? devCleanIp.split('.').map(o => isNaN(parseInt(o, 10)) ? o : String(parseInt(o, 10))).join('.')
        : devCleanIp;
      return devCleanIp === cleanIp || devNormalized === normalized || devCleanIp.includes(cleanIp) || cleanIp.includes(devCleanIp);
    });

    res(match || null);
  });
});

const getDefaultDevice = () => new Promise((res, rej) => {
  db.get("SELECT * FROM devices WHERE is_default = 1 LIMIT 1", [], (err, row) => {
    if (err) return rej(err);
    if (row) return res(row);
    // Si no hay default marcado, retornar el primer dispositivo activo
    db.get("SELECT * FROM devices WHERE is_active = 1 ORDER BY id ASC LIMIT 1", [], (err2, row2) => {
      if (err2) return rej(err2);
      res(row2 || null);
    });
  });
});

const addDevice = (device) => new Promise((res, rej) => {
  const { name, ip, port, username, password, door_channel, enable_api_open, is_default } = device;
  db.serialize(() => {
    if (is_default) {
      db.run("UPDATE devices SET is_default = 0");
    }
    db.run(
      `INSERT INTO devices (name, ip, port, username, password, door_channel, enable_api_open, is_active, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        name,
        ip,
        parseInt(port || 80, 10),
        username || 'admin',
        password,
        parseInt(door_channel || 1, 10),
        enable_api_open ? 1 : 0,
        is_default ? 1 : 0
      ],
      function(err) {
        if (err) rej(err);
        else res({ id: this.lastID, ...device });
      }
    );
  });
});

const updateDevice = (id, device) => new Promise((res, rej) => {
  const fields = [];
  const values = [];

  if (device.name !== undefined) { fields.push("name = ?"); values.push(device.name); }
  if (device.ip !== undefined) { fields.push("ip = ?"); values.push(device.ip); }
  if (device.port !== undefined) { fields.push("port = ?"); values.push(parseInt(device.port, 10)); }
  if (device.username !== undefined) { fields.push("username = ?"); values.push(device.username); }
  if (device.password !== undefined && String(device.password).trim() !== '') {
    fields.push("password = ?"); values.push(device.password);
  }
  if (device.door_channel !== undefined) { fields.push("door_channel = ?"); values.push(parseInt(device.door_channel, 10)); }
  if (device.enable_api_open !== undefined) { fields.push("enable_api_open = ?"); values.push(device.enable_api_open ? 1 : 0); }
  if (device.is_active !== undefined) { fields.push("is_active = ?"); values.push(device.is_active ? 1 : 0); }
  if (device.is_default !== undefined) {
    if (device.is_default) {
      db.run("UPDATE devices SET is_default = 0");
    }
    fields.push("is_default = ?"); values.push(device.is_default ? 1 : 0);
  }

  if (fields.length === 0) return res(0);

  values.push(id);
  const query = `UPDATE devices SET ${fields.join(', ')} WHERE id = ?`;
  db.run(query, values, function(err) {
    if (err) rej(err);
    else res(this.changes);
  });
});

const deleteDevice = (id) => new Promise((res, rej) => {
  db.serialize(() => {
    db.run("DELETE FROM user_devices WHERE device_id = ?", [id]);
    db.run("DELETE FROM devices WHERE id = ?", [id], function(err) {
      if (err) rej(err);
      else res(this.changes);
    });
  });
});

// ==========================================================================
// MÉTODOS DE ASIGNACIÓN USUARIO <-> DISPOSITIVO
// ==========================================================================
const getUserDeviceIds = (userId) => new Promise((res, rej) => {
  if (!userId) return res([]);
  db.all("SELECT device_id FROM user_devices WHERE user_id = ?", [String(userId).trim()], (err, rows) => {
    if (err) return rej(err);
    res(rows.map(r => r.device_id));
  });
});

const setUserDevices = (userId, deviceIds) => new Promise((res, rej) => {
  if (!userId) return res(false);
  const cleanUid = String(userId).trim();
  const ids = Array.isArray(deviceIds) ? deviceIds.map(Number).filter(Boolean) : [];

  db.serialize(() => {
    db.run("DELETE FROM user_devices WHERE user_id = ?", [cleanUid], (delErr) => {
      if (delErr) return rej(delErr);
      if (ids.length === 0) return res(true);

      const stmt = db.prepare("INSERT OR IGNORE INTO user_devices (user_id, device_id) VALUES (?, ?)");
      ids.forEach(did => stmt.run(cleanUid, did));
      stmt.finalize((finErr) => {
        if (finErr) rej(finErr);
        else res(true);
      });
    });
  });
});

const isUserAllowedOnDevice = (userId, deviceId) => new Promise((res, rej) => {
  if (!userId || !deviceId) return res(false);
  const cleanUid = String(userId).trim();

  // Si es un usuario de prueba demo (1001, 1002, etc.), permitir en cualquier torniquete
  if (/^100\d*$/.test(cleanUid)) {
    return res(true);
  }

  db.get(
    "SELECT id FROM user_devices WHERE user_id = ? AND device_id = ? LIMIT 1",
    [cleanUid, Number(deviceId)],
    (err, row) => {
      if (err) return rej(err);
      // Si el usuario tiene asignación explícita a este torniquete
      if (row) return res(true);

      // Si no tiene registros en user_devices, permitir por defecto si solo hay 1 dispositivo o fallback
      db.all("SELECT device_id FROM user_devices WHERE user_id = ?", [cleanUid], (err2, rows) => {
        if (err2) return rej(err2);
        if (!rows || rows.length === 0) {
          // Si no tiene asignación guardada, permitir en el dispositivo por defecto
          return res(true);
        }
        res(false);
      });
    }
  );
});

// ==========================================================================
// MÉTODOS DE USUARIOS
// ==========================================================================
const getUsers = (filter, deviceId, search = '') => new Promise((res, rej) => {
  let query = `
    SELECT u.*, 
           GROUP_CONCAT(d.id) as device_ids_str,
           GROUP_CONCAT(d.name) as device_names_str
    FROM users u
    LEFT JOIN user_devices ud ON u.user_id = ud.user_id
    LEFT JOIN devices d ON ud.device_id = d.id
  `;
  const conditions = [];
  const params = [];

  if (deviceId) {
    conditions.push(`ud.device_id = ?`);
    params.push(Number(deviceId));
  }

  if (search && String(search).trim() !== '') {
    const term = `%${String(search).trim()}%`;
    conditions.push(`(
      u.name LIKE ? OR 
      u.user_id LIKE ? OR 
      u.matricula LIKE ? OR 
      u.first_name LIKE ? OR 
      u.second_name LIKE ? OR 
      u.last_name LIKE ? OR 
      u.phone LIKE ?
    )`);
    params.push(term, term, term, term, term, term, term);
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')} `;
  }

  query += ` GROUP BY u.id ORDER BY u.id DESC `;

  db.all(query, params, (err, rows) => {
    if (err) return rej(err);
    const users = (rows || []).map(r => {
      const device_ids = r.device_ids_str ? r.device_ids_str.split(',').map(Number) : [];
      const device_names = r.device_names_str ? r.device_names_str.split(',') : [];
      return {
        id: r.id,
        user_id: r.user_id,
        name: r.name,
        api_url: r.api_url,
        matricula: r.matricula,
        first_name: r.first_name,
        second_name: r.second_name,
        last_name: r.last_name,
        phone: r.phone,
        image_file: r.image_file,
        acuaticapp_id: r.acuaticapp_id,
        created_at: r.created_at,
        device_ids,
        device_names
      };
    });
    res(users);
  });
});

const getUserByPk = (id) => new Promise((res, rej) => {
  if (!id) return res(null);
  const numId = Number(id);
  db.get("SELECT * FROM users WHERE id = ?", [numId], async (err, row) => {
    if (err) return rej(err);
    if (row) {
      const device_ids = await getUserDeviceIds(row.user_id).catch(() => []);
      return res({ ...row, device_ids });
    }
    res(null);
  });
});

const getUserById = (userId) => new Promise((res, rej) => {
  if (!userId) return res(null);
  const cleanId = String(userId).trim();
  
  db.get("SELECT * FROM users WHERE user_id = ? OR matricula = ? OR id = ? OR acuaticapp_id = ?", [cleanId, cleanId, cleanId, cleanId], async (err, row) => {
    if (err) return rej(err);
    if (row) {
      const device_ids = await getUserDeviceIds(row.user_id).catch(() => []);
      return res({ ...row, device_ids });
    }

    // Fallback: Si el QR contiene el identificador o la URL
    db.all("SELECT * FROM users", [], async (allErr, rows) => {
      if (allErr) return rej(allErr);
      const match = rows.find(u => 
        cleanId === u.user_id || 
        (u.matricula && cleanId === u.matricula) ||
        cleanId.includes(u.user_id) || 
        (u.matricula && cleanId.includes(u.matricula)) ||
        (u.api_url && cleanId.includes(u.api_url)) ||
        (u.api_url && u.api_url.includes(cleanId))
      );
      if (match) {
        const device_ids = await getUserDeviceIds(match.user_id).catch(() => []);
        return res({ ...match, device_ids });
      }
      res(null);
    });
  });
});

const addUser = (userData, legacyName, legacyApiUrl, legacyDeviceIds = null) => new Promise(async (res, rej) => {
  let userId, name, apiUrl, matricula, firstName, secondName, lastName, phone, imageFile, acuaticappId, targetDeviceIds;

  if (typeof userData === 'object' && userData !== null) {
    userId = userData.user_id;
    name = userData.name;
    apiUrl = userData.api_url;
    matricula = userData.matricula || null;
    firstName = userData.first_name || null;
    secondName = userData.second_name || null;
    lastName = userData.last_name || null;
    phone = userData.phone || null;
    imageFile = userData.image_file || null;
    acuaticappId = userData.acuaticapp_id || null;
    targetDeviceIds = userData.device_ids || legacyName; // In case passed as (obj, deviceIds)
  } else {
    userId = userData;
    name = legacyName;
    apiUrl = legacyApiUrl;
    targetDeviceIds = legacyDeviceIds;
  }

  if (!apiUrl) {
    apiUrl = 'http://localhost:3000/api/mock-external-api/allow';
  }

  if (!name && (firstName || secondName || lastName)) {
    name = [firstName, secondName, lastName].filter(Boolean).join(' ').trim();
  }

  if (!userId) {
    userId = matricula || (acuaticappId ? String(acuaticappId) : null);
  }

  // Prevenir duplicados (buscar por user_id, matricula o acuaticapp_id existente)
  const lookupUserId = userId ? String(userId).trim() : '___NULL___';
  const lookupMatricula = matricula ? String(matricula).trim() : '___NULL___';
  const lookupAcuaticId = acuaticappId ? Number(acuaticappId) : -1;

  db.get(
    "SELECT id, user_id FROM users WHERE user_id = ? OR (matricula IS NOT NULL AND matricula = ?) OR (acuaticapp_id IS NOT NULL AND acuaticapp_id = ?) LIMIT 1",
    [lookupUserId, lookupMatricula, lookupAcuaticId],
    async (err, existing) => {
      if (err) return rej(err);

      if (existing) {
        // Actualizar usuario existente sin duplicar
        try {
          await updateUser(existing.id, {
            user_id: userId || existing.user_id,
            name: name || undefined,
            api_url: apiUrl,
            matricula: matricula || undefined,
            first_name: firstName || undefined,
            second_name: secondName || undefined,
            last_name: lastName || undefined,
            phone: phone || undefined,
            image_file: imageFile || undefined,
            acuaticapp_id: acuaticappId || undefined,
            device_ids: targetDeviceIds
          });
          return res({
            id: existing.id,
            user_id: userId || existing.user_id,
            name,
            api_url: apiUrl,
            matricula,
            first_name: firstName,
            second_name: secondName,
            last_name: lastName,
            phone,
            image_file: imageFile,
            acuaticapp_id: acuaticappId,
            is_updated: true
          });
        } catch (updErr) {
          return rej(updErr);
        }
      }

      // Si no existe, insertar nuevo
      db.run(
        `INSERT INTO users (user_id, name, api_url, matricula, first_name, second_name, last_name, phone, image_file, acuaticapp_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, name, apiUrl, matricula, firstName, secondName, lastName, phone, imageFile, acuaticappId],
        async function(insErr) {
          if (insErr) return rej(insErr);
          const lastId = this.lastID;
          
          let devicesToAssign = targetDeviceIds;
          if (!devicesToAssign || (Array.isArray(devicesToAssign) && devicesToAssign.length === 0)) {
            const allDevs = await getDevices().catch(() => []);
            devicesToAssign = allDevs.map(d => d.id);
          }

          await setUserDevices(userId, devicesToAssign).catch(() => {});
          res({
            id: lastId,
            user_id: userId,
            name,
            api_url: apiUrl,
            matricula,
            first_name: firstName,
            second_name: secondName,
            last_name: lastName,
            phone,
            image_file: imageFile,
            acuaticapp_id: acuaticappId,
            device_ids: devicesToAssign,
            is_created: true
          });
        }
      );
    }
  );
});

const updateUser = (id, userData, legacyName, legacyApiUrl, legacyDeviceIds = null) => new Promise((res, rej) => {
  let userId, name, apiUrl, matricula, firstName, secondName, lastName, phone, imageFile, acuaticappId, targetDeviceIds;

  if (typeof userData === 'object' && userData !== null) {
    userId = userData.user_id;
    name = userData.name;
    apiUrl = userData.api_url;
    matricula = userData.matricula;
    firstName = userData.first_name;
    secondName = userData.second_name;
    lastName = userData.last_name;
    phone = userData.phone;
    imageFile = userData.image_file;
    acuaticappId = userData.acuaticapp_id;
    targetDeviceIds = userData.device_ids !== undefined ? userData.device_ids : legacyName;
  } else {
    userId = userData;
    name = legacyName;
    apiUrl = legacyApiUrl;
    targetDeviceIds = legacyDeviceIds;
  }

  if (!name && (firstName || secondName || lastName)) {
    name = [firstName, secondName, lastName].filter(Boolean).join(' ').trim();
  }

  const fields = [];
  const values = [];

  if (userId !== undefined) { fields.push("user_id = ?"); values.push(userId); }
  if (name !== undefined) { fields.push("name = ?"); values.push(name); }
  if (apiUrl !== undefined) { fields.push("api_url = ?"); values.push(apiUrl); }
  if (matricula !== undefined) { fields.push("matricula = ?"); values.push(matricula); }
  if (firstName !== undefined) { fields.push("first_name = ?"); values.push(firstName); }
  if (secondName !== undefined) { fields.push("second_name = ?"); values.push(secondName); }
  if (lastName !== undefined) { fields.push("last_name = ?"); values.push(lastName); }
  if (phone !== undefined) { fields.push("phone = ?"); values.push(phone); }
  if (imageFile !== undefined) { fields.push("image_file = ?"); values.push(imageFile); }
  if (acuaticappId !== undefined) { fields.push("acuaticapp_id = ?"); values.push(acuaticappId); }

  if (fields.length === 0) return res(0);

  values.push(id);
  const query = `UPDATE users SET ${fields.join(', ')} WHERE id = ?`;

  db.run(query, values, async function(err) {
    if (err) return rej(err);
    if (targetDeviceIds !== undefined && targetDeviceIds !== null && userId) {
      await setUserDevices(userId, targetDeviceIds).catch(() => {});
    }
    res(this.changes);
  });
});

const deleteUser = (id) => new Promise((res, rej) => {
  db.get("SELECT user_id FROM users WHERE id = ?", [id], (err, row) => {
    if (err) return rej(err);
    const userId = row ? row.user_id : null;
    db.serialize(() => {
      if (userId) {
        db.run("DELETE FROM user_devices WHERE user_id = ?", [userId]);
      }
      db.run("DELETE FROM users WHERE id = ?", [id], function(delErr) {
        if (delErr) rej(delErr);
        else res(this.changes);
      });
    });
  });
});

// ==========================================================================
// MÉTODOS DE LOGS
// ==========================================================================
const getLogs = (options = {}) => new Promise((res, rej) => {
  let query = "SELECT * FROM access_logs";
  const params = [];

  if (options.deviceId) {
    query += " WHERE device_id = ?";
    params.push(Number(options.deviceId));
  }

  const limit = parseInt(options.limit || 50, 10);
  query += ` ORDER BY id DESC LIMIT ${limit}`;

  db.all(query, params, (err, rows) => err ? rej(err) : res(rows));
});

const addLog = (userId, name, eventType, apiUrl, apiResponse, authorized, doorOpened, deviceId = null, deviceName = null, deviceIp = null) => new Promise((res, rej) => {
  db.run(
    `INSERT INTO access_logs (user_id, name, event_type, api_url, api_response, authorized, door_opened, device_id, device_name, device_ip) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      name,
      eventType,
      apiUrl,
      JSON.stringify(apiResponse),
      authorized ? 1 : 0,
      doorOpened ? 1 : 0,
      deviceId ? Number(deviceId) : null,
      deviceName || null,
      deviceIp || null
    ],
    function(err) {
      if (err) rej(err);
      else res(this.lastID);
    }
  );
});

const clearLogs = (deviceId = null) => new Promise((res, rej) => {
  let query = "DELETE FROM access_logs";
  const params = [];
  if (deviceId) {
    query += " WHERE device_id = ?";
    params.push(Number(deviceId));
  }
  db.run(query, params, (err) => err ? rej(err) : res(true));
});

/**
 * Purga registros de accesos más antiguos de N días
 */
const cleanOldLogs = (days) => new Promise((res, rej) => {
  const retentionDays = parseInt(days || process.env.LOG_RETENTION_DAYS || 30, 10);
  db.run(
    "DELETE FROM access_logs WHERE timestamp < datetime('now', '-' || ? || ' days')",
    [retentionDays],
    function(err) {
      if (err) {
        console.error('[DB ERROR] Error al purgar logs antiguos:', err.message);
        rej(err);
      } else {
        if (this.changes > 0) {
          console.log(`[DB] Mantenimiento automático: ${this.changes} registros antiguos (> ${retentionDays} días) purgados.`);
        }
        res(this.changes);
      }
    }
  );
});

// Programar mantenimiento diario automático de logs
setInterval(() => {
  cleanOldLogs().catch(() => {});
}, 24 * 60 * 60 * 1000).unref();

// ==========================================================================
// MÉTODOS DE SETTINGS GLOBALES (Contraseña Admin, etc.)
// ==========================================================================
const getSettings = () => new Promise((res, rej) => {
  db.all("SELECT * FROM settings", [], (err, rows) => {
    if (err) return rej(err);
    const settingsObj = {};
    rows.forEach(row => {
      settingsObj[row.key] = row.value;
    });
    res(settingsObj);
  });
});

const updateSettings = (settingsObj) => new Promise((res, rej) => {
  db.serialize(() => {
    let errorOccurred = null;
    const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(settingsObj)) {
      stmt.run(key, String(value), (err) => {
        if (err) errorOccurred = err;
      });
    }
    stmt.finalize((err) => {
      if (err || errorOccurred) rej(err || errorOccurred);
      else res(true);
    });
  });
});

// ==========================================================================
// MÉTODOS DE RECEPCIONISTAS
// ==========================================================================
const getReceptionists = () => new Promise((res, rej) => {
  db.all("SELECT id, name, username, created_at FROM receptionists ORDER BY id DESC", [], (err, rows) => {
    if (err) return rej(err);
    res(rows || []);
  });
});

const getReceptionistById = (id) => new Promise((res, rej) => {
  db.get("SELECT * FROM receptionists WHERE id = ?", [id], (err, row) => {
    if (err) return rej(err);
    res(row || null);
  });
});

const getReceptionistByUsername = (usernameOrName) => new Promise((res, rej) => {
  if (!usernameOrName) return res(null);
  const clean = String(usernameOrName).trim();
  db.get(
    "SELECT * FROM receptionists WHERE LOWER(username) = LOWER(?) OR LOWER(name) = LOWER(?) LIMIT 1",
    [clean, clean],
    (err, row) => {
      if (err) return rej(err);
      res(row || null);
    }
  );
});

const addReceptionist = ({ name, username, password }) => new Promise((res, rej) => {
  const cleanName = String(name).trim();
  const cleanUser = String(username || cleanName.toLowerCase().replace(/\s+/g, '.')).trim();
  db.run(
    "INSERT INTO receptionists (name, username, password) VALUES (?, ?, ?)",
    [cleanName, cleanUser, password],
    function(err) {
      if (err) return rej(err);
      res({ id: this.lastID, name: cleanName, username: cleanUser });
    }
  );
});

const updateReceptionist = (id, { name, username, password }) => new Promise((res, rej) => {
  const fields = [];
  const values = [];

  if (name !== undefined) { fields.push("name = ?"); values.push(String(name).trim()); }
  if (username !== undefined) { fields.push("username = ?"); values.push(String(username).trim()); }
  if (password !== undefined && String(password).trim() !== '') {
    fields.push("password = ?"); values.push(password);
  }

  if (fields.length === 0) return res(0);

  values.push(id);
  const query = `UPDATE receptionists SET ${fields.join(', ')} WHERE id = ?`;
  db.run(query, values, function(err) {
    if (err) return rej(err);
    res(this.changes);
  });
});

const deleteReceptionist = (id) => new Promise((res, rej) => {
  db.run("DELETE FROM receptionists WHERE id = ?", [id], function(err) {
    if (err) return rej(err);
    res(this.changes);
  });
});

initializeDatabase();

module.exports = {
  getDevices,
  getDeviceById,
  getDeviceByIp,
  getDefaultDevice,
  addDevice,
  updateDevice,
  deleteDevice,
  getUserDeviceIds,
  setUserDevices,
  isUserAllowedOnDevice,
  getUsers,
  getUserById,
  getUserByPk,
  addUser,
  updateUser,
  deleteUser,
  getLogs,
  addLog,
  clearLogs,
  cleanOldLogs,
  getSettings,
  updateSettings,
  getReceptionists,
  getReceptionistById,
  getReceptionistByUsername,
  addReceptionist,
  updateReceptionist,
  deleteReceptionist,
  db
};

