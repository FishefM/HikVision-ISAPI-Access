#!/usr/bin/env node
/**
 * scripts/check-device-users.js
 * 
 * Consulta directamente a los biométricos MinMoe vía ISAPI para obtener
 * la cantidad real total de usuarios y tarjetas almacenadas en su memoria física.
 */

const dbHelper = require('../config/database');
const deviceHelper = require('../utils/device');

async function checkDeviceUsers() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║            CONSULTA DE USUARIOS Y TARJETAS EN MEMORIA MINMOE                    ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════╝\n');

  const allDevices = await dbHelper.getDevices();
  const activeDevices = allDevices.filter(d => d.is_active !== 0 && d.ip && d.username && d.password);

  if (activeDevices.length === 0) {
    console.error('❌ No hay torniquetes activos configurados.');
    process.exit(1);
  }

  for (const dev of activeDevices) {
    console.log(`──────────────────────────────────────────────────────────────────────────────────`);
    console.log(`▶ Dispositivo: ${dev.name} (${dev.ip}:${dev.port || 80})`);

    // 1. Verificar conexión
    const conn = await deviceHelper.checkDeviceConnection(dev.ip, dev.port || 80, dev.username, dev.password).catch(e => ({ success: false, error: e.message }));
    if (!conn.success) {
      console.log(`   ✗ Estado: Sin conexión o no responde (${conn.error || 'Timeout'}).\n`);
      continue;
    }
    console.log(`   ✓ Estado: En línea y autenticado`);

    let userCount = null;
    let cardCount = null;

    // 2. Consultar conteo de usuarios vía UserInfo/Count o UserInfo/Search
    try {
      const searchRes = await deviceHelper.sendISAPIGenericRequest(
        dev.ip,
        dev.port || 80,
        dev.username,
        dev.password,
        'POST',
        '/ISAPI/AccessControl/UserInfo/Search?format=json',
        { 'Content-Type': 'application/json' },
        {
          UserInfoSearchCond: {
            searchID: "checkCount",
            searchResultPosition: 0,
            maxResults: 1
          }
        }
      );

      const d = searchRes.data;
      if (d && d.UserInfoSearch && typeof d.UserInfoSearch.totalMatches === 'number') {
        userCount = d.UserInfoSearch.totalMatches;
      }
    } catch (_) {}

    if (userCount === null) {
      try {
        const countRes = await deviceHelper.sendISAPIGenericRequest(
          dev.ip,
          dev.port || 80,
          dev.username,
          dev.password,
          'GET',
          '/ISAPI/AccessControl/UserInfo/Count?format=json'
        );
        const cd = countRes.data;
        if (cd && cd.UserInfoCount && typeof cd.UserInfoCount.userNumber === 'number') {
          userCount = cd.UserInfoCount.userNumber;
        }
      } catch (_) {}
    }

    // 3. Consultar conteo de tarjetas vía CardInfo/Search
    try {
      const cardRes = await deviceHelper.sendISAPIGenericRequest(
        dev.ip,
        dev.port || 80,
        dev.username,
        dev.password,
        'POST',
        '/ISAPI/AccessControl/CardInfo/Search?format=json',
        { 'Content-Type': 'application/json' },
        {
          CardInfoSearchCond: {
            searchID: "checkCardCount",
            searchResultPosition: 0,
            maxResults: 1
          }
        }
      );

      const cd = cardRes.data;
      if (cd && cd.CardInfoSearch && typeof cd.CardInfoSearch.totalMatches === 'number') {
        cardCount = cd.CardInfoSearch.totalMatches;
      }
    } catch (_) {}

    console.log(`   👥 Total de personas en memoria : ${userCount !== null ? userCount : 'No reportado por firmware'}`);
    console.log(`   💳 Total de tarjetas vinculadas : ${cardCount !== null ? cardCount : 'No reportado por firmware'}`);

    if (userCount !== null && userCount > 20) {
      console.log(`   ℹ️  Nota: En la interfaz web de Hikvision solo se ven 20 por página (página 1 de ${Math.ceil(userCount / 20)}).`);
    }
    console.log();
  }

  process.exit(0);
}

checkDeviceUsers().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
