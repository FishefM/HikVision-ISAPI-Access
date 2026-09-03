const db = require('../config/database');
const device = require('../utils/device');

async function syncAll() {
  const settings = await db.getSettings();
  const users = await db.getUsers();

  console.log(`\n======================================================`);
  console.log(`  SINCRONIZANDO USUARIOS Y TARJETAS AL MÓDULO HIKVISION`);
  console.log(`  Dispositivo IP: ${settings.device_ip}:${settings.device_port}`);
  console.log(`======================================================\n`);

  for (const u of users) {
    console.log(`[INFO] Sincronizando: ${u.name} (ID: ${u.user_id})...`);
    
    // 1. Sincronizar usuario
    const userRes = await device.syncUserInfo(
      settings.device_ip,
      settings.device_port,
      settings.device_user,
      settings.device_password,
      u.user_id,
      u.name
    );

    if (userRes.success) {
      console.log(`  ✓ Usuario registrado en biométrico`);
    } else {
      console.log(`  ✗ Advertencia al registrar usuario:`, userRes.data || userRes.error);
    }

    // 2. Sincronizar tarjeta física
    const cardRes = await device.syncCardInfo(
      settings.device_ip,
      settings.device_port,
      settings.device_user,
      settings.device_password,
      u.user_id,
      u.user_id
    );

    if (cardRes.success) {
      console.log(`  ✓ Tarjeta ${u.user_id} vinculada al usuario`);
    } else {
      console.log(`  ✗ Advertencia al vincular tarjeta:`, cardRes.data || cardRes.error);
    }
  }

  console.log(`\n¡Proceso de sincronización finalizado!\n`);
  process.exit(0);
}

syncAll().catch((err) => {
  console.error('Error durante sincronización:', err);
  process.exit(1);
});
