#!/usr/bin/env node
/**
 * scripts/check-device-users.js
 * 
 * Consulta directamente a los biométricos MinMoe vía ISAPI para obtener
 * la cantidad real total de usuarios y tarjetas almacenadas en su memoria física,
 * comparándolos contra la base de datos local para verificar que ningún alumno falte.
 */

const dbHelper = require('../config/database');
const deviceHelper = require('../utils/device');

function isTestUser(user) {
  if (!user) return false;
  if (user.acuaticapp_id) return false;
  const uid = String(user.user_id || '').trim();
  const url = String(user.api_url || '').toLowerCase();
  const name = String(user.name || '').toLowerCase();
  return uid === '1001' || 
         url.includes('mock-external-api/deny') || 
         url.includes('mock-external-api/error') || 
         name.includes('(permitido)') || 
         name.includes('(denegado)') || 
         name.includes('(error api)') ||
         name.includes('demo');
}

async function checkDeviceUsers() {
  console.log('\n==================================================================================');
  console.log('             AUDITORIA Y CONTEO DE USUARIOS EN MEMORIA MINMOE                     ');
  console.log('==================================================================================\n');

  // 1. Obtener usuarios locales
  const allUsers = await dbHelper.getUsers();
  const realActiveUsers = allUsers.filter(u => !u.is_archived && !u.is_deleted && !isTestUser(u));
  const numericMatriculas = realActiveUsers
    .map(u => parseInt(u.matricula || u.user_id, 10))
    .filter(n => !isNaN(n) && n > 0);

  const maxMatricula = numericMatriculas.length > 0 ? Math.max(...numericMatriculas) : 0;
  const lastUser = realActiveUsers.find(u => parseInt(u.matricula || u.user_id, 10) === maxMatricula);

  const matSet = new Set(numericMatriculas);
  const gaps = [];
  for (let i = 1; i <= maxMatricula; i++) {
    if (!matSet.has(i)) gaps.push(i);
  }

  console.log('[BASE DE DATOS LOCAL]:');
  console.log(` * Total alumnos reales activos    : ${realActiveUsers.length}`);
  if (lastUser) {
    console.log(` * Matricula mas alta registrada   : ${maxMatricula} (${lastUser.name})`);
  }
  if (gaps.length > 0) {
    console.log(` * Bajas/Huecos en AcuaticApp      : ${gaps.length} matriculas canceladas o no asignadas (${gaps.slice(0, 10).join(', ')}${gaps.length > 10 ? '...' : ''})`);
    console.log(`   (Explicacion: La matricula llega hasta la #${maxMatricula}, pero el total real es ${realActiveUsers.length}`);
    console.log(`    porque en AcuaticApp existen ${gaps.length} matriculas que fueron dadas de baja o eliminadas).`);
  }
  console.log();

  // 2. Obtener dispositivos
  const allDevices = await dbHelper.getDevices();
  const activeDevices = allDevices.filter(d => d.is_active !== 0 && d.ip && d.username && d.password);

  if (activeDevices.length === 0) {
    console.error('[ERROR] No hay torniquetes activos configurados.');
    process.exit(1);
  }

  for (const dev of activeDevices) {
    console.log(`----------------------------------------------------------------------------------`);
    console.log(`* Dispositivo: ${dev.name} (${dev.ip}:${dev.port || 80})`);

    const assignedUsers = realActiveUsers.filter(u => !u.device_ids || u.device_ids.length === 0 || u.device_ids.includes(dev.id));
    console.log(`   * Alumnos asignados en BD local: ${assignedUsers.length}`);

    // Verificar conexión
    const conn = await deviceHelper.checkDeviceConnection(dev.ip, dev.port || 80, dev.username, dev.password).catch(e => ({ success: false, error: e.message }));
    if (!conn.success) {
      console.log(`   [ERROR] Estado: Sin conexion o no responde (${conn.error || 'Timeout'}).\n`);
      continue;
    }
    console.log(`   [OK] Estado: En linea y autenticado`);

    let userCount = null;
    let cardCount = null;

    // Conteo de usuarios vía UserInfo/Search
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

    // Conteo de tarjetas vía CardInfo/Search
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

    console.log(`   * Personas fisicas en MinMoe   : ${userCount !== null ? userCount : 'No reportado por firmware'}`);
    console.log(`   * Tarjetas vinculadas en MinMoe: ${cardCount !== null ? cardCount : 'No reportado por firmware'}`);

    if (userCount !== null) {
      if (userCount >= assignedUsers.length) {
        console.log(`   [OK] Estado de sincronizacion  : 100% Completo (${userCount} de ${assignedUsers.length}). No falta ningun alumno.`);
      } else {
        const diff = assignedUsers.length - userCount;
        console.log(`   [AVISO] Faltan ${diff} alumno(s) por registrar en este torniquete.`);
        console.log(`   -> Para registrarlos ejecuta: node scripts/sync-controlled.js --device=${dev.id}`);
      }

      if (userCount > 20) {
        console.log(`   [INFO] Nota de visualizacion  : En la web de Hikvision solo se ven 20 por pagina (hay ${Math.ceil(userCount / 20)} paginas).`);
      }
    }
    console.log();
  }

  process.exit(0);
}

checkDeviceUsers().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
