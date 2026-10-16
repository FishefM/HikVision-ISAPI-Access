const db = require('../config/database');
const device = require('../utils/device');

async function syncAll() {
  const defaultDev = await db.getDefaultDevice().catch(() => null);
  const settings = await db.getSettings().catch(() => ({}));
  
  const deviceConfig = {
    device_ip: (defaultDev && defaultDev.ip) || settings.device_ip,
    device_port: (defaultDev && defaultDev.port) || settings.device_port || 80,
    device_user: (defaultDev && defaultDev.username) || settings.device_username || settings.device_user || 'admin',
    device_password: (defaultDev && defaultDev.password) || settings.device_password
  };

  const users = await db.getUsers();

  console.log(`\n======================================================`);
  console.log(`  SINCRONIZANDO USUARIOS Y TARJETAS AL MÓDULO HIKVISION`);
  console.log(`  Dispositivo: ${defaultDev ? defaultDev.name : 'MinMoe'} (${deviceConfig.device_ip}:${deviceConfig.device_port})`);
  console.log(`  Total alumnos en base de datos: ${users.length}`);
  console.log(`======================================================\n`);

  if (!deviceConfig.device_ip || !deviceConfig.device_user || !deviceConfig.device_password) {
    console.error('[ERROR] Configuración de dispositivo incompleta (IP, Usuario o Contraseña).');
    process.exit(1);
  }

  let okCount = 0;
  let warnCount = 0;

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    console.log(`\n[${i + 1}/${users.length}] Sincronizando: ${u.name} (ID: ${u.user_id})...`);
    
    const res = await device.syncFullUserToDevice(settings, u, null);
    
    if (res.synced) {
      okCount++;
      console.log(`  ✓ Éxito: Sincronizado en el biométrico.`);
    } else {
      warnCount++;
      console.log(`  ✗ Advertencia: ${res.summary}`);
    }

    res.diagnostics.forEach(d => console.log(`     └─ ${d}`));
  }

  console.log(`\n======================================================`);
  console.log(`  RESUMEN: ${okCount} exitosos | ${warnCount} advertencias de ${users.length} alumnos`);
  console.log(`======================================================\n`);
  process.exit(0);
}

syncAll().catch((err) => {
  console.error('Error durante sincronización:', err);
  process.exit(1);
});
