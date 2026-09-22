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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

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
  db.get("SELECT * FROM devices WHERE ip = ? OR ip LIKE ? LIMIT 1", [cleanIp, `%${cleanIp}%`], (err, row) => {
    if (err) return rej(err);
    res(row || null);
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
const getUsers = (filter, deviceId) => new Promise((res, rej) => {
  let query = `
    SELECT u.*, 
           GROUP_CONCAT(d.id) as device_ids_str,
           GROUP_CONCAT(d.name) as device_names_str
    FROM users u
    LEFT JOIN user_devices ud ON u.user_id = ud.user_id
    LEFT JOIN devices d ON ud.device_id = d.id
  `;
  const params = [];

  if (deviceId) {
    query += ` WHERE ud.device_id = ? `;
    params.push(Number(deviceId));
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
        created_at: r.created_at,
        device_ids,
        device_names
      };
    });
    res(users);
  });
});

const getUserById = (userId) => new Promise((res, rej) => {
  if (!userId) return res(null);
  const cleanId = String(userId).trim();
  
  db.get("SELECT * FROM users WHERE user_id = ? OR id = ?", [cleanId, cleanId], async (err, row) => {
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
        cleanId.includes(u.user_id) || 
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

const addUser = (userId, name, apiUrl, deviceIds = null) => new Promise((res, rej) => {
  db.run("INSERT INTO users (user_id, name, api_url) VALUES (?, ?, ?)", [userId, name, apiUrl], async function(err) {
    if (err) return rej(err);
    const lastId = this.lastID;
    
    // Si no se pasaron dispositivos, asignar al dispositivo por defecto
    let targetDeviceIds = deviceIds;
    if (!targetDeviceIds || (Array.isArray(targetDeviceIds) && targetDeviceIds.length === 0)) {
      const defDev = await getDefaultDevice().catch(() => null);
      targetDeviceIds = defDev ? [defDev.id] : [];
    }

    await setUserDevices(userId, targetDeviceIds).catch(() => {});
    res({ id: lastId, user_id: userId, name, api_url: apiUrl, device_ids: targetDeviceIds });
  });
});

const updateUser = (id, userId, name, apiUrl, deviceIds = null) => new Promise((res, rej) => {
  db.run("UPDATE users SET user_id = ?, name = ?, api_url = ? WHERE id = ?", [userId, name, apiUrl, id], async function(err) {
    if (err) return rej(err);
    if (deviceIds !== null) {
      await setUserDevices(userId, deviceIds).catch(() => {});
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

