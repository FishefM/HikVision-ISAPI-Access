#!/usr/bin/env node
/**
 * scripts/sync-controlled.js
 * 
 * Sincronización controlada y protegida de alumnos hacia los torniquetes MinMoe Hikvision.
 * Diseñado específicamente para evitar la saturación de CPU, memoria y sockets ISAPI.
 *
 * Características:
 *  - Rate-limiting con delay configurable (por defecto 300 ms por alumno).
 *  - Cooldown periódico (pausa de 1.5s cada 25 alumnos) para liberar memoria del biométrico.
 *  - Pre-verificación de conectividad (omite automáticamente dispositivos offline).
 *  - Reintento con backoff en caso de saturación o micro-cortes.
 *  - Compatible con múltiples torniquetes y selección individual.
 *
 * Uso:
 *  npm run sync:torniquetes
 *  node scripts/sync-controlled.js [--delay=300] [--device=1] [--only-token] [--limit=10] [--dry-run]
 */

const dbHelper = require('../config/database');
const deviceHelper = require('../utils/device');

// Parseo ligero de argumentos CLI
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    delay: 300,        // ms entre alumnos
    batchSize: 25,     // cantidad de alumnos por lote
    cooldownMs: 1500,  // ms de enfriamiento tras cada lote
    deviceId: null,    // ID específico de torniquete
    startFrom: 1,      // alumno inicial (1-indexed) para reanudar
    onlyToken: false,  // solo alumnos con attendance_token
    includeTests: false, // incluir usuarios de prueba
    limit: null,       // límite de alumnos a sincronizar
    dryRun: false,     // simulación sin enviar a hardware
    help: false
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--only-token') options.onlyToken = true;
    else if (arg === '--include-tests') options.includeTests = true;
    else if (arg.startsWith('--delay=')) options.delay = parseInt(arg.split('=')[1], 10) || options.delay;
    else if (arg.startsWith('--batch=')) options.batchSize = parseInt(arg.split('=')[1], 10) || options.batchSize;
    else if (arg.startsWith('--cooldown=')) options.cooldownMs = parseInt(arg.split('=')[1], 10) || options.cooldownMs;
    else if (arg.startsWith('--device=')) options.deviceId = arg.split('=')[1].trim();
    else if (arg.startsWith('--start-from=')) options.startFrom = parseInt(arg.split('=')[1], 10) || 1;
    else if (arg.startsWith('--from=')) options.startFrom = parseInt(arg.split('=')[1], 10) || 1;
    else if (arg.startsWith('--limit=')) options.limit = parseInt(arg.split('=')[1], 10);
  }
  return options;
}

function printHelp() {
  console.log(`
Uso: node scripts/sync-controlled.js [opciones]

Opciones disponibles:
  --delay=<ms>       Pausa en milisegundos entre cada alumno (por defecto: 300 ms).
  --batch=<n>        Número de alumnos por lote antes de una pausa de enfriamiento (por defecto: 25).
  --cooldown=<ms>    Pausa de enfriamiento entre lotes (por defecto: 1500 ms).
  --device=<id>      Sincronizar únicamente el torniquete especificado (por ID o nombre, ej: --device=2 o --device="Bebés").
  --start-from=<n>   Reanudar la sincronización a partir del alumno número <n> (ej: --start-from=241).
  --only-token       Sincronizar únicamente alumnos que cuenten con attendance_token de AcuaticApp.
  --include-tests    Incluir usuarios demo/pruebas (por defecto se excluyen).
  --limit=<n>        Sincronizar únicamente los primeros <n> alumnos (útil para pruebas).
  --dry-run          Simula el proceso completo sin realizar llamadas reales a la API Hikvision.
  --help, -h         Muestra este mensaje de ayuda.
  `);
}

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

async function run() {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const startTime = Date.now();

  console.log('\n╔══════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║       SINCRONIZACIÓN CONTROLADA DE ALUMNOS (PROTECCIÓN API HIKVISION)            ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════╝');
  console.log(` • Pacing: ${options.delay} ms entre alumnos`);
  console.log(` • Lotes de enfriamiento: Cada ${options.batchSize} alumnos (${options.cooldownMs} ms de pausa)`);
  if (options.deviceId) console.log(` • Filtro dispositivo: ID ${options.deviceId}`);
  if (options.onlyToken) console.log(` • Filtro: Solo alumnos con token de AcuaticApp`);
  if (options.limit) console.log(` • Límite máximo: ${options.limit} alumnos`);
  if (options.dryRun) console.log(` • MODO SIMULACIÓN (DRY-RUN): No se enviarán llamadas al hardware`);
  console.log('──────────────────────────────────────────────────────────────────────────────────\n');

  // 1. Obtener dispositivos
  const allDevices = await dbHelper.getDevices();
  let devicesToSync = allDevices.filter(d => d.is_active !== 0 && d.ip && d.username && d.password);

  if (options.deviceId) {
    const term = options.deviceId.toLowerCase();
    devicesToSync = devicesToSync.filter(d => 
      String(d.id) === String(options.deviceId) || 
      d.name.toLowerCase() === term ||
      d.name.toLowerCase().includes(term)
    );
  }

  if (devicesToSync.length === 0) {
    console.error('❌ [ERROR] No se encontraron torniquetes activos o configurados para sincronizar.');
    process.exit(1);
  }

  // 2. Pre-chequeo de conectividad con cada dispositivo
  console.log('🔍 [1/3] Verificando conectividad con los biométricos...');
  const activeOnlineDevices = [];

  for (const dev of devicesToSync) {
    process.stdout.write(`   └─ Probando ${dev.name} (${dev.ip}:${dev.port || 80})... `);
    if (options.dryRun) {
      console.log('✓ OK (Simulado)');
      activeOnlineDevices.push(dev);
      continue;
    }

    try {
      const conn = await deviceHelper.checkDeviceConnection(dev.ip, dev.port || 80, dev.username, dev.password);
      if (conn.success) {
        console.log('✓ Conectado');
        activeOnlineDevices.push(dev);
      } else {
        console.log(`✗ No responde (${conn.error || 'Fallo de autenticación o timeout'})`);
        console.log(`      ↳ [AVISO] Se omitirá "${dev.name}" para no detener el proceso por timeouts.`);
      }
    } catch (e) {
      console.log(`✗ Sin conexión (${e.message})`);
      console.log(`      ↳ [AVISO] Se omitirá "${dev.name}" para no detener el proceso por timeouts.`);
    }
  }

  if (activeOnlineDevices.length === 0) {
    console.error('\n❌ [ERROR] Ninguno de los torniquetes seleccionados respondió a la verificación.');
    console.error('   Verifique que este equipo esté conectado a la red local (LAN) de los torniquetes');
    console.error('   y que las IPs y credenciales sean correctas.');
    process.exit(1);
  }

  // 3. Obtener lista de alumnos
  console.log('\n📋 [2/3] Cargando lista de alumnos desde la base de datos...');
  let users = await dbHelper.getUsers();

  // Filtrar archivados
  users = users.filter(u => !u.is_archived);

  // Filtrar pruebas si aplica
  if (!options.includeTests) {
    users = users.filter(u => !isTestUser(u));
  }

  // Filtrar solo con token si aplica
  if (options.onlyToken) {
    users = users.filter(u => Boolean(u.attendance_token));
  }

  // Aplicar límite si se solicitó
  if (options.limit && options.limit > 0) {
    users = users.slice(0, options.limit);
  }

  // Ordenar: primero los que tienen attendance_token
  users.sort((a, b) => {
    const aHas = Boolean(a.attendance_token);
    const bHas = Boolean(b.attendance_token);
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    return (b.id || 0) - (a.id || 0);
  });

  console.log(`   └─ Total de alumnos a procesar: ${users.length} alumnos.`);
  console.log(`   └─ Torniquetes a sincronizar: ${activeOnlineDevices.map(d => d.name).join(', ')}.`);

  // 4. Ejecución secuencial y controlada
  console.log('\n🚀 [3/3] Iniciando sincronización controlada...');
  
  const deviceReports = {};

  for (const dev of activeOnlineDevices) {
    console.log(`\n──────────────────────────────────────────────────────────────────────────────────`);
    console.log(`▶ Procesando torniquete: ${dev.name} (${dev.ip}:${dev.port || 80})`);
    console.log(`──────────────────────────────────────────────────────────────────────────────────`);

    const devUsers = users.filter(u => !u.device_ids || u.device_ids.length === 0 || u.device_ids.includes(dev.id));
    console.log(`   Alumnos asignados a este dispositivo: ${devUsers.length}`);

    // Purgar alumnos explícitamente restringidos de este torniquete si los hay
    const restrictedUsers = users.filter(u => u.device_ids && u.device_ids.length > 0 && !u.device_ids.includes(dev.id));
    if (restrictedUsers.length > 0) {
      console.log(`   🧹 Purgando ${restrictedUsers.length} alumno(s) con acceso no permitido en este torniquete...`);
      for (const ru of restrictedUsers) {
        if (!options.dryRun) {
          const idsToPurge = new Set();
          if (ru.attendance_token && String(ru.attendance_token).trim().length >= 8) {
            idsToPurge.add(String(ru.attendance_token).trim().substring(0, 8));
          }
          if (ru.user_id) idsToPurge.add(String(ru.user_id).trim());
          if (ru.matricula) idsToPurge.add(String(ru.matricula).trim());
          for (const cid of idsToPurge) {
            await deviceHelper.deleteUserFromDevice(dev.ip, dev.port || 80, dev.username, dev.password, cid).catch(() => {});
          }
        }
      }
    }

    let okCount = 0;
    let warnCount = 0;
    let failCount = 0;

    const startIndex = Math.max(0, (options.startFrom || 1) - 1);
    if (startIndex > 0) {
      console.log(`   ⏭ Reanudando desde el alumno #${options.startFrom} (omitiendo primeros ${startIndex} alumnos)...`);
    }

    for (let i = startIndex; i < devUsers.length; i++) {
      const u = devUsers[i];
      const percent = (((i + 1) / devUsers.length) * 100).toFixed(1).padStart(5, ' ');
      const idxStr = `[${String(i + 1).padStart(String(devUsers.length).length, ' ')}/${devUsers.length}]`;
      const tokenPreview = u.attendance_token ? u.attendance_token.substring(0, 8) : 'sin-token';
      
      process.stdout.write(`   ${idxStr} (${percent}%) ${u.name.padEnd(30, ' ').substring(0, 30)} [ID:${tokenPreview}] ... `);

      if (options.dryRun) {
        console.log('✓ OK (Simulado)');
        okCount++;
        await sleep(20);
        continue;
      }

      let syncRes = null;
      let attempt = 0;
      const maxAttempts = 2;

      while (attempt < maxAttempts) {
        attempt++;
        try {
          syncRes = await deviceHelper.syncFullUserToDevice({
            device_ip: dev.ip,
            device_port: dev.port || 80,
            device_user: dev.username,
            device_password: dev.password
          }, u);
          break; // éxito o respuesta recibida
        } catch (callErr) {
          if (attempt < maxAttempts) {
            process.stdout.write(`[Reintento en 2s...] `);
            await sleep(2000); // enfriar socket
          } else {
            syncRes = { synced: false, summary: callErr.message, diagnostics: [callErr.message] };
          }
        }
      }

      if (syncRes && syncRes.synced) {
        okCount++;
        console.log('✓ OK');
      } else if (syncRes && syncRes.userSuccess) {
        warnCount++;
        console.log(`⚠ Usuario OK, Tarjeta pendiente (${syncRes.summary || 'Aviso'})`);
      } else {
        failCount++;
        console.log(`✗ Error: ${syncRes ? syncRes.summary : 'Fallo de sincronización'}`);
      }

      // Pausa entre alumnos
      if (i < devUsers.length - 1) {
        await sleep(options.delay);

        // Cooldown periódico para evitar saturar la memoria y socket del MinMoe
        if ((i + 1) % options.batchSize === 0) {
          console.log(`   ⏳ [Cooldown] Pausa de ${options.cooldownMs / 1000}s para liberar memoria del biométrico...`);
          await sleep(options.cooldownMs);
        }
      }
    }

    deviceReports[dev.name] = {
      total: devUsers.length,
      ok: okCount,
      warn: warnCount,
      fail: failCount
    };
  }

  const elapsed = Date.now() - startTime;

  // 5. Reporte Final
  console.log('\n╔══════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                            RESUMEN DE SINCRONIZACIÓN                             ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════╝');
  console.log(` Tiempo total transcurrido: ${formatDuration(elapsed)}`);
  console.log('──────────────────────────────────────────────────────────────────────────────────');
  
  for (const [devName, rep] of Object.entries(deviceReports)) {
    console.log(` • ${devName}:`);
    console.log(`     Total asignados : ${rep.total}`);
    console.log(`     ✓ Exitosos      : ${rep.ok}`);
    if (rep.warn > 0) console.log(`     ⚠ Con avisos    : ${rep.warn}`);
    if (rep.fail > 0) console.log(`     ✗ Con errores   : ${rep.fail}`);
  }
  
  console.log('──────────────────────────────────────────────────────────────────────────────────');
  console.log(' ✓ Proceso finalizado de forma controlada y segura.\n');
  process.exit(0);
}

run().catch((err) => {
  console.error('\n❌ Error crítico durante la sincronización:', err);
  process.exit(1);
});
