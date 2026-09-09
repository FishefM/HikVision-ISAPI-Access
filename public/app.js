// ==========================================================================
// Initialization & Global State
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  // Initialize Lucide Icons
  if (window.lucide) {
    window.lucide.createIcons();
  }

  // API base endpoints
  const API_USERS = '/api/users';
  const API_LOGS = '/api/logs';
  const API_SETTINGS = '/api/settings';
  const API_TEST_SCAN = '/api/test-scan';
  const API_TEST_OPEN = '/api/test-open-door';
  const API_CLEAR_LOGS = '/api/logs/clear';

  // State
  let usersList = [];
  let logsList = [];

  // Dom Elements
  const consoleLogs = document.getElementById('console-logs');
  const btnClearConsole = document.getElementById('btn-clear-console');
  
  const simUserIdSelect = document.getElementById('sim-user-id');
  const btnSimulateScan = document.getElementById('btn-simulate-scan');
  const btnTestOpen = document.getElementById('btn-test-open');
  
  const deviceForm = document.getElementById('device-settings-form');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  
  const btnShowAddUser = document.getElementById('btn-show-add-user');
  const userFormContainer = document.getElementById('user-form-container');
  const userFormTitle = document.getElementById('user-form-title');
  const userForm = document.getElementById('user-form');
  const userDbIdInput = document.getElementById('user-db-id');
  const userIdInput = document.getElementById('user-id');
  const userNameInput = document.getElementById('user-name');
  const userApiUrlInput = document.getElementById('user-api-url');
  const btnCancelUser = document.getElementById('btn-cancel-user');
  
  const usersTableBody = document.querySelector('#users-table tbody');
  const logsTableBody = document.querySelector('#logs-table tbody');
  const btnClearDbLogs = document.getElementById('btn-clear-db-logs');
  const btnLogout = document.getElementById('btn-logout');

  // Metrics elements
  const metricTotal = document.getElementById('metric-total');
  const metricAuthorized = document.getElementById('metric-authorized');
  const metricDenied = document.getElementById('metric-denied');
  const metricRate = document.getElementById('metric-rate');

  // ==========================================================================
  // Console Log Utilities
  // ==========================================================================
  function appendConsoleLog(type, message, timestamp) {
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = `[${timestamp || new Date().toLocaleTimeString()}]`;
    
    const msgSpan = document.createElement('span');
    msgSpan.className = 'log-message';
    msgSpan.textContent = message;
    
    line.appendChild(timeSpan);
    line.appendChild(msgSpan);
    consoleLogs.appendChild(line);
    
    // Auto scroll to bottom
    consoleLogs.scrollTop = consoleLogs.scrollHeight;
  }

  // Clear UI console logs
  btnClearConsole.addEventListener('click', () => {
    consoleLogs.innerHTML = '';
    appendConsoleLog('info', 'Consola limpia. Esperando nuevos eventos...');
  });

  // ==========================================================================
  // SSE Event Stream Integration
  // ==========================================================================
  function connectEventStream() {
    const source = new EventSource('/api/logs-stream');
    
    source.onmessage = (event) => {
      try {
        const logData = JSON.parse(event.data);
        if (logData.type === 'access_feedback') return;
        const timeStr = logData.timestamp ? (logData.timestamp.includes(' ') ? logData.timestamp.split(' ')[1] : logData.timestamp) : '';
        appendConsoleLog(logData.type, logData.message, timeStr);
        
        // Refresh logs and statistics on any new activity
        refreshLogs();
      } catch (err) {
        console.error('Error parsing SSE event:', err);
      }
    };

    source.onerror = (err) => {
      console.error('SSE connection lost. Reconnecting in 3s...', err);
      source.close();
      setTimeout(connectEventStream, 3000);
    };
  }

  // ==========================================================================
  // Fetch Data Functions
  // ==========================================================================
  async function refreshUsers() {
    try {
      const res = await fetch(API_USERS);
      if (res.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      usersList = await res.json();
      renderUsersTable();
      populateSimulatorOptions();
    } catch (err) {
      console.error('Error fetching users:', err);
      appendConsoleLog('error', `Error al cargar la base de datos de usuarios: ${err.message}`);
    }
  }

  async function refreshLogs() {
    try {
      const res = await fetch(API_LOGS);
      if (res.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      logsList = await res.json();
      renderLogsTable();
      updateMetrics();
    } catch (err) {
      console.error('Error fetching logs:', err);
    }
  }

  async function refreshSettings() {
    try {
      const res = await fetch(API_SETTINGS);
      if (res.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      const settings = await res.json();
      
      document.getElementById('setting-device-ip').value = settings.device_ip || '';
      document.getElementById('setting-device-port').value = settings.device_port || '';
      document.getElementById('setting-device-user').value = settings.device_user || '';
      document.getElementById('setting-device-password').value = settings.device_password || '';
      document.getElementById('setting-device-door').value = settings.device_door_channel || '1';
      document.getElementById('setting-enable-api-open').checked = settings.enable_device_api_open === 'true';
    } catch (err) {
      console.error('Error fetching settings:', err);
      appendConsoleLog('error', `Error al cargar configuración del lector: ${err.message}`);
    }
  }

  // ==========================================================================
  // Rendering Functions
  // ==========================================================================
  function renderUsersTable() {
    usersTableBody.innerHTML = '';
    
    if (usersList.length === 0) {
      usersTableBody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No hay usuarios registrados.</td></tr>`;
      return;
    }

    usersList.forEach(user => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHTML(user.user_id)}</strong></td>
        <td>${escapeHTML(user.name)}</td>
        <td><span class="text-muted" style="font-size:0.8rem; word-break:break-all;">${escapeHTML(user.api_url)}</span></td>
        <td class="actions-col">
          <div class="action-btn-group">
            <button class="btn btn-icon-only text-warning sync-user-btn" data-id="${user.id}" title="Sincronizar este alumno al MinMoe">
              <i data-lucide="refresh-cw"></i>
            </button>
            <button class="btn btn-icon-only text-info qr-user-btn" data-id="${user.id}" title="Ver Código QR">
              <i data-lucide="qr-code"></i>
            </button>
            <button class="btn btn-icon-only edit-user-btn" data-id="${user.id}" title="Editar">
              <i data-lucide="edit"></i>
            </button>
            <button class="btn btn-icon-only text-danger delete-user-btn" data-id="${user.id}" title="Eliminar">
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        </td>
      `;
      usersTableBody.appendChild(tr);
    });

    // Re-trigger icon rendering
    if (window.lucide) window.lucide.createIcons();

    // Attach Event Listeners to actions
    document.querySelectorAll('.sync-user-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = parseInt(e.currentTarget.getAttribute('data-id'));
        const user = usersList.find(u => u.id === id);
        if (!user) return;
        appendConsoleLog('info', `[MinMoe] Sincronizando alumno "${user.name}" (ID: ${user.user_id})...`);
        btn.disabled = true;
        try {
          const res = await fetch(`${API_USERS}/${id}/sync-device`, { method: 'POST' });
          const data = await res.json();
          if (res.ok && data.success) {
            appendConsoleLog('success', `[MinMoe OK] "${user.name}" sincronizado exitosamente en el biométrico.`);
            alert(`Sincronización Exitosa:\nAlumno "${user.name}" registrado en la memoria del MinMoe.`);
          } else {
            const warnMsg = data.summary || data.error || 'Respuesta inesperada del biométrico';
            appendConsoleLog('warning', `[MinMoe Advertencia] ${user.name}: ${warnMsg}`);
            if (data.diagnostics && data.diagnostics.length > 0) {
              data.diagnostics.forEach(d => appendConsoleLog('info', `  └─ ${d}`));
            }
            alert(`Aviso del Biométrico para "${user.name}":\n${warnMsg}`);
          }
        } catch (err) {
          appendConsoleLog('error', `[MinMoe Error] Fallo de red: ${err.message}`);
          alert(`Error de red al sincronizar: ${err.message}`);
        } finally {
          btn.disabled = false;
        }
      });
    });

    document.querySelectorAll('.qr-user-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = parseInt(e.currentTarget.getAttribute('data-id'));
        const user = usersList.find(u => u.id === id);
        if (user) showUserQR(user);
      });
    });

    document.querySelectorAll('.edit-user-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = parseInt(e.currentTarget.getAttribute('data-id'));
        const user = usersList.find(u => u.id === id);
        if (user) showUserForm(user);
      });
    });

    document.querySelectorAll('.delete-user-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = parseInt(e.currentTarget.getAttribute('data-id'));
        const user = usersList.find(u => u.id === id);
        if (user && confirm(`¿Está seguro de eliminar al usuario ${user.name} de la base de datos local y del biométrico MinMoe?`)) {
          appendConsoleLog('info', `Eliminando a "${user.name}" (ID: ${user.user_id})...`);
          try {
            const res = await fetch(`${API_USERS}/${id}`, { method: 'DELETE' });
            const data = await res.json();
            if (res.ok) {
              appendConsoleLog('success', `Alumno "${user.name}" eliminado de la base de datos local.`);
              if (data.deviceSummary) {
                appendConsoleLog(data.deviceDeleted ? 'success' : 'warning', `Biométrico MinMoe: ${data.deviceSummary}`);
              }
              refreshUsers();
            } else {
              throw new Error(data.error || 'Fallo al borrar');
            }
          } catch (err) {
            appendConsoleLog('error', `Error al eliminar: ${err.message}`);
            alert(`Error: ${err.message}`);
          }
        }
      });
    });
  }

  function renderLogsTable() {
    logsTableBody.innerHTML = '';
    
    if (logsList.length === 0) {
      logsTableBody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">Historial vacío.</td></tr>`;
      return;
    }

    logsList.forEach(log => {
      const isAuthorized = log.authorized === 1;
      
      const badgeAuth = isAuthorized 
        ? `<span class="badge badge-success" style="white-space:nowrap;"><i data-lucide="check-circle" style="width:10px;height:10px;"></i> Permitido</span>`
        : `<span class="badge badge-danger" style="white-space:nowrap;"><i data-lucide="x-circle" style="width:10px;height:10px;"></i> Denegado</span>`;

      // Short clean date formatting (e.g., 07/07 12:42:47)
      const date = new Date(log.timestamp);
      const pad = (n) => String(n).padStart(2, '0');
      const timeString = `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

      // Friendly event type badges in Spanish
      const eventTypeMap = {
        'simulated_scan': '<span class="badge badge-info">Simulado</span>',
        'card': '<span class="badge badge-success">Tarjeta</span>',
        'face': '<span class="badge badge-primary">Rostro</span>',
        'heartBeat': '<span class="badge badge-warning">Latido</span>',
        'unknown': '<span class="badge badge-secondary">Desconocido</span>'
      };
      const badgeType = eventTypeMap[log.event_type] || `<span class="badge badge-secondary">${escapeHTML(log.event_type)}</span>`;

      // Summarize raw JSON response to save space
      let friendlyResponse = 'N/A';
      if (log.api_response && log.api_response !== 'N/A') {
        try {
          const parsed = JSON.parse(log.api_response);
          if (parsed.message) {
            friendlyResponse = parsed.message;
            if (parsed.student) {
              friendlyResponse += ` (${parsed.student})`;
            }
          } else if (parsed.error) {
            friendlyResponse = parsed.error;
          } else if (parsed.authorized !== undefined) {
            friendlyResponse = parsed.authorized ? 'Permitido por API' : 'Denegado por API';
          } else {
            friendlyResponse = log.api_response;
          }
        } catch (e) {
          friendlyResponse = log.api_response;
        }
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${timeString}</td>
        <td><strong>${escapeHTML(log.user_id || 'N/A')}</strong><br><small class="text-muted">${escapeHTML(log.name || 'Desconocido')}</small></td>
        <td>${badgeType}</td>
        <td><span class="text-muted" style="font-size:0.75rem; word-break:break-all;">${escapeHTML(log.api_url || 'N/A')}</span></td>
        <td><span class="text-muted" style="font-size:0.75rem; word-break:break-word;">${escapeHTML(friendlyResponse)}</span></td>
        <td>${badgeAuth}</td>
      `;
      logsTableBody.appendChild(tr);
    });

    if (window.lucide) window.lucide.createIcons();
  }

  function populateSimulatorOptions() {
    // Keep first option
    simUserIdSelect.innerHTML = `<option value="">-- Cargar usuarios del sistema --</option>`;
    
    usersList.forEach(user => {
      const opt = document.createElement('option');
      opt.value = user.user_id;
      opt.textContent = `${user.user_id} - ${user.name}`;
      simUserIdSelect.appendChild(opt);
    });
  }

  function updateMetrics() {
    const total = logsList.length;
    const authorized = logsList.filter(l => l.authorized === 1).length;
    const denied = logsList.filter(l => l.authorized === 0).length;
    const rate = total > 0 ? Math.round((authorized / total) * 100) : 0;

    metricTotal.textContent = total;
    metricAuthorized.textContent = authorized;
    metricDenied.textContent = denied;
    metricRate.textContent = `${rate}%`;
  }

  // ==========================================================================
  // Form Actions & Modals
  // ==========================================================================
  function showUserForm(user = null) {
    userFormContainer.classList.remove('hidden');
    if (user) {
      userFormTitle.textContent = 'Editar Usuario';
      userDbIdInput.value = user.id;
      userIdInput.value = user.user_id;
      userNameInput.value = user.name;
      userApiUrlInput.value = user.api_url;
    } else {
      userFormTitle.textContent = 'Registrar Nuevo Usuario';
      userForm.reset();
      userDbIdInput.value = '';
    }
  }

  function hideUserForm() {
    userFormContainer.classList.add('hidden');
    userForm.reset();
    userDbIdInput.value = '';
  }

  btnShowAddUser.addEventListener('click', () => showUserForm());
  btnCancelUser.addEventListener('click', () => hideUserForm());

  // Bulk Sync to Device listener
  const btnSyncAllUsers = document.getElementById('btn-sync-all-users');
  if (btnSyncAllUsers) {
    btnSyncAllUsers.addEventListener('click', async () => {
      if (!confirm('¿Desea sincronizar todos los alumnos de la base de datos con el biométrico Hikvision MinMoe?')) return;
      appendConsoleLog('info', '[MinMoe] Iniciando sincronización masiva de alumnos...');
      btnSyncAllUsers.disabled = true;
      try {
        const res = await fetch(`${API_USERS}/sync-all`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          appendConsoleLog('success', `[MinMoe OK] ${data.message}`);
          alert(`Sincronización Masiva:\n${data.message}`);
        } else {
          appendConsoleLog('error', `[MinMoe Error] ${data.error || 'Fallo en la sincronización masiva.'}`);
          alert(`Error al sincronizar:\n${data.error}`);
        }
      } catch (err) {
        appendConsoleLog('error', `[MinMoe Error] Fallo de conexión: ${err.message}`);
        alert(`Error de conexión:\n${err.message}`);
      } finally {
        btnSyncAllUsers.disabled = false;
      }
    });
  }

  userForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const dbId = userDbIdInput.value;
    
    let apiUrlValue = userApiUrlInput.value.trim();
    if (!apiUrlValue) {
      apiUrlValue = 'http://localhost:3000/api/mock-external-api/allow';
    }

    const payload = {
      user_id: userIdInput.value.trim(),
      name: userNameInput.value.trim(),
      api_url: apiUrlValue
    };

    const isEdit = dbId !== '';
    const url = isEdit ? `${API_USERS}/${dbId}` : API_USERS;
    const method = isEdit ? 'PUT' : 'POST';

    try {
      appendConsoleLog('info', `${isEdit ? 'Actualizando' : 'Creando'} alumno "${payload.name}" (ID: ${payload.user_id})...`);
      const res = await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const responseData = await res.json();

      if (res.ok) {
        appendConsoleLog('success', `Alumno "${payload.name}" guardado en la base de datos local SQLite.`);

        if (responseData.syncSummary) {
          appendConsoleLog(responseData.synced ? 'success' : 'warning', `Biométrico MinMoe: ${responseData.syncSummary}`);
        }

        if (responseData.diagnostics && responseData.diagnostics.length > 0) {
          responseData.diagnostics.forEach(diag => {
            appendConsoleLog('info', `  └─ ${diag}`);
          });
        }

        let alertMessage = `Alumno "${payload.name}" registrado en base de datos local SQLite.`;
        if (responseData.synced) {
          alertMessage += `\n\n[OK] Sincronizado exitosamente con el biométrico MinMoe (Usuario y Tarjeta).`;
        } else if (responseData.syncSummary) {
          alertMessage += `\n\n[AVISO]:\n${responseData.syncSummary}`;
        }
        alert(alertMessage);

        hideUserForm();
        refreshUsers();
      } else {
        const errorMsg = responseData.error || 'Error al guardar el alumno';
        appendConsoleLog('error', `Fallo al registrar: ${errorMsg}`);
        if (responseData.dbError) {
          appendConsoleLog('error', `  └─ [SQLite Detalle] ${responseData.dbError}`);
        }
        alert(`Fallo en el registro:\n${errorMsg}`);
      }
    } catch (err) {
      alert(`Error de red al guardar: ${err.message}`);
      appendConsoleLog('error', `Excepción de red al guardar: ${err.message}`);
    }
  });

  // Settings Submission
  btnSaveSettings.addEventListener('click', async () => {
    const data = {
      device_ip: document.getElementById('setting-device-ip').value.trim(),
      device_port: document.getElementById('setting-device-port').value.trim(),
      device_user: document.getElementById('setting-device-user').value.trim(),
      device_door_channel: document.getElementById('setting-device-door').value.trim(),
      enable_device_api_open: document.getElementById('setting-enable-api-open').checked ? 'true' : 'false'
    };

    const devicePasswordInput = document.getElementById('setting-device-password');
    if (devicePasswordInput && devicePasswordInput.value.trim() !== '') {
      data.device_password = devicePasswordInput.value;
    }

    const adminPasswordInput = document.getElementById('setting-admin-password');
    if (adminPasswordInput && adminPasswordInput.value.trim() !== '') {
      data.admin_password = adminPasswordInput.value;
    }

    try {
      const res = await fetch(API_SETTINGS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      
      if (res.ok) {
        appendConsoleLog('success', 'Configuración de dispositivo y acceso guardada correctamente.');
        if (adminPasswordInput) adminPasswordInput.value = '';
        refreshSettings();
      } else {
        throw new Error('Fallo al guardar configuración.');
      }
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  });

  // ==========================================================================
  // Simulator Controls
  // ==========================================================================
  btnSimulateScan.addEventListener('click', async () => {
    const val = simUserIdSelect.value;
    if (!val) {
      // Allow custom typing of an ID for simulation
      const customId = prompt("Ingrese un ID de usuario a simular (ej. 1001 o uno no registrado):");
      if (!customId) return;
      triggerSimulation(customId.trim());
    } else {
      triggerSimulation(val);
    }
  });

  async function triggerSimulation(userId) {
    try {
      appendConsoleLog('info', `Enviando simulación para ID: ${userId}...`);
      const res = await fetch(API_TEST_SCAN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, eventType: 'simulated_scan' })
      });
      
      const result = await res.json();
      if (res.ok) {
        if (result.authorized) {
          appendConsoleLog('success', `Simulación exitosa: Acceso AUTORIZADO para ${result.name}.`);
        } else {
          appendConsoleLog('warning', `Simulación exitosa: Acceso DENEGADO. Razón: ${result.reason || 'Sin detalles'}`);
        }
      } else {
        throw new Error(result.error || 'Error de simulación');
      }
    } catch (err) {
      appendConsoleLog('error', `Error durante la simulación: ${err.message}`);
    }
  }

  // Direct Door Open Test
  btnTestOpen.addEventListener('click', async () => {
    btnTestOpen.disabled = true;
    appendConsoleLog('info', 'Enviando comando manual de apertura al dispositivo...');
    try {
      const res = await fetch(API_TEST_OPEN, { method: 'POST' });
      const data = await res.json();
      
      if (res.ok && data.success) {
        appendConsoleLog('success', 'Comando de apertura ejecutado. El dispositivo respondió OK.');
      } else {
        throw new Error(data.error || 'Respuesta errónea del dispositivo');
      }
    } catch (err) {
      appendConsoleLog('error', `Error al abrir la puerta: ${err.message}`);
      alert(`Fallo en hardware: ${err.message}. Revise IP y contraseña de red del dispositivo en la sección inferior.`);
    } finally {
      btnTestOpen.disabled = false;
    }
  });

  // Clear Database Access Logs History
  btnClearDbLogs.addEventListener('click', async () => {
    if (confirm('¿Está seguro de borrar todo el historial de accesos de la base de datos?')) {
      try {
        const res = await fetch(API_CLEAR_LOGS, { method: 'POST' });
        if (res.ok) {
          appendConsoleLog('info', 'Historial de registros limpiado en base de datos.');
          refreshLogs();
        } else {
          throw new Error('Fallo al limpiar');
        }
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    }
  });

  // Logout Handler
  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      if (confirm('¿Desea cerrar la sesión del panel de administración?')) {
        try {
          const res = await fetch('/api/logout', { method: 'POST' });
          if (res.ok) {
            window.location.href = '/login.html';
          } else {
            alert('Error al cerrar sesión');
          }
        } catch (err) {
          alert('Error al conectar con el servidor');
        }
      }
    });
  }

  // ==========================================================================
  // Helper Functions
  // ==========================================================================
  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ==========================================================================
  // QR Code Modal Handlers
  // ==========================================================================
  const qrModal = document.getElementById('qr-modal');
  const qrModalImage = document.getElementById('qr-modal-image');
  const qrModalUserInfo = document.getElementById('qr-modal-user-info');
  const qrModalUserId = document.getElementById('qr-modal-user-id');
  const btnCloseQrIcon = document.getElementById('btn-close-qr-icon');
  const btnQrDownload = document.getElementById('btn-qr-download');
  const btnQrCopy = document.getElementById('btn-qr-copy');
  const btnQrShare = document.getElementById('btn-qr-share');
  const qrShareOptions = document.getElementById('qr-share-options');
  const btnShareWhatsapp = document.getElementById('btn-share-whatsapp');
  const btnShareEmail = document.getElementById('btn-share-email');

  let currentQrUser = null;
  let currentQrBlob = null;
  let currentQrUrl = '';

  function downloadBlob(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }

  function drawRoundedRect(ctx, x, y, width, height, radius) {
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, width, height, radius);
    } else {
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + width - radius, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
      ctx.lineTo(x + width, y + height - radius);
      ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
      ctx.lineTo(x + radius, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
    }
  }

  /**
   * Genera la credencial digital completa con el diseno visual de la web:
   * fondo oscuro degradado, resplandor, esquinas redondeadas, contenedor blanco de QR y datos del alumno.
   */
  async function generateCredentialCardBlob(user) {
    const qrImg = new Image();
    qrImg.crossOrigin = 'anonymous';
    const qrSource = `/api/users/${user.id}/qr`;

    await new Promise((resolve, reject) => {
      qrImg.onload = () => resolve();
      qrImg.onerror = () => reject(new Error('No se pudo cargar el codigo QR base.'));
      qrImg.src = qrSource;
    });

    const canvas = document.createElement('canvas');
    canvas.width = 520;
    canvas.height = 680;
    const ctx = canvas.getContext('2d');

    const cardRadius = 24;

    // Fondo con esquinas redondeadas
    ctx.save();
    drawRoundedRect(ctx, 0, 0, 520, 680, cardRadius);
    ctx.clip();

    // Fondo degradado oscuro con la paleta de la web
    const bgGrad = ctx.createLinearGradient(0, 0, 0, 680);
    bgGrad.addColorStop(0, '#0f172a');
    bgGrad.addColorStop(0.4, '#0a0f1d');
    bgGrad.addColorStop(1, '#060913');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, 520, 680);

    // Resplandor superior sutil
    const glowGrad = ctx.createRadialGradient(260, 0, 20, 260, 0, 280);
    glowGrad.addColorStop(0, 'rgba(99, 102, 241, 0.28)');
    glowGrad.addColorStop(1, 'rgba(99, 102, 241, 0)');
    ctx.fillStyle = glowGrad;
    ctx.fillRect(0, 0, 520, 300);

    // Insignia superior "CREDENCIAL DE ACCESO"
    const pillW = 200;
    const pillH = 28;
    const pillX = (520 - pillW) / 2;
    const pillY = 32;
    drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 14);
    ctx.fillStyle = 'rgba(99, 102, 241, 0.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(129, 140, 248, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#a5b4fc';
    ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CREDENCIAL DE ACCESO', 260, pillY + pillH / 2);

    // Titulo institucional secundario
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('SISTEMA DE CONTROL DE ACCESO', 260, 84);

    // Contenedor blanco con esquinas redondeadas y sombra para el QR
    const qrBoxSize = 330;
    const qrBoxX = (520 - qrBoxSize) / 2;
    const qrBoxY = 108;
    const qrBoxRadius = 18;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 22;
    ctx.shadowOffsetY = 8;
    drawRoundedRect(ctx, qrBoxX, qrBoxY, qrBoxSize, qrBoxSize, qrBoxRadius);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.restore();

    // Dibujar el QR centrado dentro del contenedor blanco
    const qrPadding = 18;
    const qrInnerSize = qrBoxSize - qrPadding * 2;
    ctx.drawImage(qrImg, qrBoxX + qrPadding, qrBoxY + qrPadding, qrInnerSize, qrInnerSize);

    // Nombre del alumno
    const studentName = (user.name || 'Alumno').trim();
    let nameFontSize = 22;
    if (studentName.length > 25) nameFontSize = 18;
    if (studentName.length > 34) nameFontSize = 15;

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${nameFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(studentName, 260, 485);

    // ID / Matricula del alumno (color cyan/azul de la web)
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 16px "Courier New", monospace, sans-serif';
    ctx.fillText(`ID: ${user.user_id}`, 260, 518);

    // Linea decorativa divisoria
    ctx.beginPath();
    ctx.moveTo(180, 550);
    ctx.lineTo(340, 550);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Pie institucional
    ctx.fillStyle = '#64748b';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('ACCESO VALIDO EN TORNIQUETE', 260, 580);

    // Borde exterior sutil de la tarjeta
    ctx.restore();
    drawRoundedRect(ctx, 1, 1, 518, 678, cardRadius);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 2;
    ctx.stroke();

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('No se pudo generar la credencial digital.'));
      }, 'image/png', 1.0);
    });
  }

  async function showUserQR(user) {
    currentQrUser = user;
    currentQrBlob = null;
    if (qrShareOptions) qrShareOptions.classList.add('hidden');
    qrModal.classList.remove('hidden');

    if (qrModalUserInfo) qrModalUserInfo.textContent = user.name;
    if (qrModalUserId) qrModalUserId.textContent = `ID: ${user.user_id}`;

    try {
      currentQrBlob = await generateCredentialCardBlob(user);
      if (currentQrUrl && currentQrUrl.startsWith('blob:')) {
        URL.revokeObjectURL(currentQrUrl);
      }
      currentQrUrl = URL.createObjectURL(currentQrBlob);
      qrModalImage.src = currentQrUrl;
    } catch (err) {
      console.warn('[QR] Error al generar credencial personalizada:', err);
      currentQrUrl = `/api/users/${user.id}/qr`;
      qrModalImage.src = currentQrUrl;
    }

    if (window.lucide) window.lucide.createIcons();
  }

  if (qrModalImage) {
    qrModalImage.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'copyMove';
    });
  }

  // Helper para obtener el Blob PNG de la credencial completa
  async function getQrImageBlob() {
    if (currentQrBlob) return currentQrBlob;
    if (currentQrUser) {
      currentQrBlob = await generateCredentialCardBlob(currentQrUser);
      return currentQrBlob;
    }
    throw new Error('No hay credencial activa para generar.');
  }

  // Opcion 1: Guardar credencial (Descarga local en PNG)
  if (btnQrDownload) {
    btnQrDownload.addEventListener('click', async () => {
      if (!currentQrUser) return;
      const originalHtml = btnQrDownload.innerHTML;
      btnQrDownload.disabled = true;
      try {
        const blob = await getQrImageBlob();
        const safeName = currentQrUser.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `credencial_${safeName}_${currentQrUser.user_id}.png`;
        downloadBlob(blob, filename);
        appendConsoleLog('info', `[QR] Credencial descargada: ${filename}`);
      } catch (err) {
        appendConsoleLog('error', `[QR Error] Error al guardar credencial: ${err.message}`);
        alert(`No se pudo guardar la credencial: ${err.message}`);
      } finally {
        btnQrDownload.disabled = false;
        btnQrDownload.innerHTML = originalHtml;
        if (window.lucide) window.lucide.createIcons();
      }
    });
  }

  // Opcion 2: Copiar credencial al portapapeles
  if (btnQrCopy) {
    btnQrCopy.addEventListener('click', async () => {
      if (!currentQrUser) return;
      const originalHtml = btnQrCopy.innerHTML;
      btnQrCopy.disabled = true;

      const safeName = currentQrUser.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `credencial_${safeName}_${currentQrUser.user_id}.png`;

      try {
        const blob = await getQrImageBlob();

        // Intento 1: API nativa ClipboardItem (funciona en contextos seguros/localhost)
        if (navigator.clipboard && window.ClipboardItem && navigator.clipboard.write) {
          try {
            const item = new ClipboardItem({ 'image/png': blob });
            await navigator.clipboard.write([item]);
            appendConsoleLog('success', `[QR] Credencial copiada al portapapeles para ${currentQrUser.name}.`);
            btnQrCopy.innerHTML = '<i data-lucide="check" style="width: 16px; height: 16px;"></i> Credencial Copiada';
            if (window.lucide) window.lucide.createIcons();
            setTimeout(() => {
              btnQrCopy.disabled = false;
              btnQrCopy.innerHTML = originalHtml;
              if (window.lucide) window.lucide.createIcons();
            }, 2500);
            return;
          } catch (_) {}
        }

        // Si el navegador bloquea la copia binaria por ser HTTP no seguro:
        downloadBlob(blob, filename);
        appendConsoleLog('info', `[QR] Credencial descargada como ${filename}. En red HTTP puede hacer clic derecho en la imagen y seleccionar "Copiar imagen".`);
        alert(`En este entorno de red HTTP el navegador no permite acceso directo al portapapeles por seguridad.\n\nSe ha descargado el archivo "${filename}" a su equipo.\nTambien puede hacer clic derecho directamente sobre la credencial y seleccionar "Copiar imagen".`);
      } catch (err) {
        appendConsoleLog('error', `[QR Error] Error al procesar credencial: ${err.message}`);
        alert(`No se pudo copiar la credencial: ${err.message}`);
      } finally {
        btnQrCopy.disabled = false;
        btnQrCopy.innerHTML = originalHtml;
        if (window.lucide) window.lucide.createIcons();
      }
    });
  }

  // Opcion 3: Compartir credencial
  if (btnQrShare) {
    btnQrShare.addEventListener('click', async () => {
      if (!currentQrUser) return;
      const originalHtml = btnQrShare.innerHTML;
      btnQrShare.disabled = true;

      try {
        const blob = await getQrImageBlob();
        const safeName = currentQrUser.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `credencial_${safeName}_${currentQrUser.user_id}.png`;
        const file = new File([blob], filename, { type: 'image/png' });

        // Si el navegador soporta Web Share API con archivos reales
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({
              title: `Credencial de Acceso - ${currentQrUser.name}`,
              text: `Credencial digital de acceso para ${currentQrUser.name} (ID: ${currentQrUser.user_id})`,
              files: [file]
            });
            appendConsoleLog('info', `[QR] Credencial compartida exitosamente para ${currentQrUser.name}.`);
            return;
          } catch (err) {
            if (err.name === 'AbortError') return;
            console.warn('[QR Share] navigator.share error:', err);
          }
        }

        // Fallback en PC de escritorio sin Web Share de archivos:
        let clipboardCopied = false;
        if (navigator.clipboard && window.ClipboardItem && navigator.clipboard.write) {
          try {
            const item = new ClipboardItem({ 'image/png': blob });
            await navigator.clipboard.write([item]);
            clipboardCopied = true;
          } catch (_) {}
        }

        downloadBlob(blob, filename);

        if (qrShareOptions) {
          qrShareOptions.classList.remove('hidden');
          if (window.lucide) window.lucide.createIcons();
        }

        appendConsoleLog('info', `[QR] Credencial preparada (${filename}) para compartir.`);
        const msg = clipboardCopied
          ? `Se ha copiado la credencial al portapapeles y se ha descargado "${filename}".\n\nPuede pegar con Ctrl+V directamente en WhatsApp Web o en su correo, o arrastrar la credencial desde esta ventana.`
          : `Se ha descargado la credencial "${filename}".\n\nPuede arrastrar la credencial directamente al chat de WhatsApp Web o adjuntar el archivo descargado en su correo.`;
        alert(msg);
      } catch (err) {
        appendConsoleLog('error', `[QR Error] Error al preparar credencial para compartir: ${err.message}`);
        alert(`No se pudo preparar la credencial: ${err.message}`);
      } finally {
        btnQrShare.disabled = false;
        btnQrShare.innerHTML = originalHtml;
        if (window.lucide) window.lucide.createIcons();
      }
    });
  }

  // Boton Compartir por WhatsApp
  if (btnShareWhatsapp) {
    btnShareWhatsapp.addEventListener('click', async () => {
      if (!currentQrUser) return;
      try {
        const blob = await getQrImageBlob().catch(() => null);
        const safeName = currentQrUser.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `credencial_${safeName}_${currentQrUser.user_id}.png`;

        if (blob) {
          downloadBlob(blob, filename);
          if (navigator.clipboard && window.ClipboardItem && navigator.clipboard.write) {
            try {
              const item = new ClipboardItem({ 'image/png': blob });
              await navigator.clipboard.write([item]);
            } catch (_) {}
          }
        }

        const text = `Credencial de acceso - ${currentQrUser.name} (ID: ${currentQrUser.user_id})`;
        const url = `https://web.whatsapp.com/send?text=${encodeURIComponent(text)}`;
        window.open(url, '_blank', 'noopener,noreferrer');
        appendConsoleLog('info', `[QR] Abriendo WhatsApp Web para ${currentQrUser.name}.`);
      } catch (err) {
        appendConsoleLog('error', `[QR Error] Error al abrir WhatsApp: ${err.message}`);
      }
    });
  }

  // Boton Compartir por Correo Electronico
  if (btnShareEmail) {
    btnShareEmail.addEventListener('click', async () => {
      if (!currentQrUser) return;
      try {
        const blob = await getQrImageBlob().catch(() => null);
        const safeName = currentQrUser.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `credencial_${safeName}_${currentQrUser.user_id}.png`;

        if (blob) {
          downloadBlob(blob, filename);
        }

        const subject = `Credencial digital de acceso - ${currentQrUser.name}`;
        const body = `Hola,\n\nSe adjunta la credencial digital de acceso:\n\nAlumno: ${currentQrUser.name}\nMatricula / ID: ${currentQrUser.user_id}\n\n(Archivo adjunto: ${filename})\n\nSaludos.`;
        const url = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        window.location.href = url;
        appendConsoleLog('info', `[QR] Abriendo cliente de correo para ${currentQrUser.name}...`);
      } catch (err) {
        appendConsoleLog('error', `[QR Error] Error al preparar correo: ${err.message}`);
      }
    });
  }

  if (btnCloseQrIcon) {
    btnCloseQrIcon.addEventListener('click', () => {
      if (qrShareOptions) qrShareOptions.classList.add('hidden');
      qrModal.classList.add('hidden');
    });
  }

  // Close modal when clicking outside the box
  if (qrModal) {
    qrModal.addEventListener('click', (e) => {
      if (e.target === qrModal) {
        if (qrShareOptions) qrShareOptions.classList.add('hidden');
        qrModal.classList.add('hidden');
      }
    });
  }

  // ==========================================================================
  // Startup
  // ==========================================================================
  connectEventStream();
  refreshUsers();
  refreshLogs();
  refreshSettings();
});
