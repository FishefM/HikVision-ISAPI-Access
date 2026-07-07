const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, '..', 'database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.serialize(() => {
    // Create Users table
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        api_url TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create Access Logs table
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
        door_opened INTEGER
      )
    `);

    // Create Settings table
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    // Insert dummy users if empty (seed data)
    db.all("SELECT COUNT(*) as count FROM users", [], (err, rows) => {
      if (!err && rows[0].count === 0) {
        console.log('Inserting seed data into users table...');
        const stmt = db.prepare("INSERT INTO users (user_id, name, api_url) VALUES (?, ?, ?)");
        stmt.run("1001", "Juan Pérez (Permitido)", "http://localhost:3000/api/mock-external-api/allow");
        stmt.run("1002", "María Gómez (Denegado)", "http://localhost:3000/api/mock-external-api/deny");
        stmt.run("1003", "Carlos Ruíz (Error API)", "http://localhost:3000/api/mock-external-api/error");
        stmt.run("cda21c1f", "Felix Pelaez Gonzalez", "https://multihivesoft.com/api/attendance/scan/cda21c1ff7a426acadf323eb0261da3949c98ffb00f2c016f1ecbb29c57f4d56");
        stmt.run("77248842", "Alumno 77248842", "https://multihivesoft.com/api/attendance/scan/772488429f6ecf753920d435b41d45bf4ade9fc7cc71b3888739d3312cd99f71");
        stmt.finalize();
      }
    });

    // Insert default settings if empty
    db.all("SELECT COUNT(*) as count FROM settings", [], (err, rows) => {
      if (!err && rows[0].count === 0) {
        console.log('Initializing default settings...');
        const stmt = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
        stmt.run("device_ip", "192.168.1.100");
        stmt.run("device_port", "80");
        stmt.run("device_user", "admin");
        stmt.run("device_password", "Admin12345");
        stmt.run("device_door_channel", "1");
        stmt.run("enable_device_api_open", "false"); 
        stmt.run("admin_password", "admin123");
        stmt.finalize();
      } else if (!err) {
        // Ensure admin_password exists even if settings are already seeded
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_password', 'admin123')");
      }
    });
  });
}

// User methods
const getUsers = () => new Promise((res, rej) => {
  db.all("SELECT * FROM users ORDER BY id DESC", [], (err, rows) => err ? rej(err) : res(rows));
});

const getUserById = (userId) => new Promise((res, rej) => {
  db.get("SELECT * FROM users WHERE user_id = ?", [userId], (err, row) => err ? rej(err) : res(row));
});

const addUser = (userId, name, apiUrl) => new Promise((res, rej) => {
  db.run("INSERT INTO users (user_id, name, api_url) VALUES (?, ?, ?)", [userId, name, apiUrl], function(err) {
    if (err) rej(err);
    else res({ id: this.lastID, user_id: userId, name, api_url: apiUrl });
  });
});

const updateUser = (id, userId, name, apiUrl) => new Promise((res, rej) => {
  db.run("UPDATE users SET user_id = ?, name = ?, api_url = ? WHERE id = ?", [userId, name, apiUrl, id], function(err) {
    if (err) rej(err);
    else res(this.changes);
  });
});

const deleteUser = (id) => new Promise((res, rej) => {
  db.run("DELETE FROM users WHERE id = ?", [id], function(err) {
    if (err) rej(err);
    else res(this.changes);
  });
});

// Logs methods
const getLogs = () => new Promise((res, rej) => {
  db.all("SELECT * FROM access_logs ORDER BY id DESC LIMIT 50", [], (err, rows) => err ? rej(err) : res(rows));
});

const addLog = (userId, name, eventType, apiUrl, apiResponse, authorized, doorOpened) => new Promise((res, rej) => {
  db.run(
    "INSERT INTO access_logs (user_id, name, event_type, api_url, api_response, authorized, door_opened) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [userId, name, eventType, apiUrl, JSON.stringify(apiResponse), authorized ? 1 : 0, doorOpened ? 1 : 0],
    function(err) {
      if (err) rej(err);
      else res(this.lastID);
    }
  );
});

const clearLogs = () => new Promise((res, rej) => {
  db.run("DELETE FROM access_logs", [], (err) => err ? rej(err) : res(true));
});

// Settings methods
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

module.exports = {
  getUsers,
  getUserById,
  addUser,
  updateUser,
  deleteUser,
  getLogs,
  addLog,
  clearLogs,
  getSettings,
  updateSettings,
  db
};
