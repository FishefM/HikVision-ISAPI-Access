// public/pruebas.js - Entorno de pruebas y simulación
document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) {
    window.lucide.createIcons();
  }

  // Endpoints
  const API_USERS = '/api/users';
  const API_LOGS = '/api/logs';
  const API_TEST_SCAN = '/api/test-scan';
  const API_TEST_OPEN = '/api/test-open-door';
  const API_CLEAR_LOGS = '/api/logs/clear';

  // State
  let testUsersList = [];
  let logsList = [];
  let simCountTotal = 0;
  let simCountAuth = 0;
  let simCountDenied = 0;

  // DOM Elements
  const consoleLogs = document.getElementById('console-logs');
  const btnClearConsole = document.getElementById('btn-clear-console');

  const simUserIdSelect = document.getElementById('sim-user-id');
  const simCustomIdInput = document.getElementById('sim-custom-id');
  const simModeSelect = document.getElementById('sim-mode');
  const btnSimulateScan = document.getElementById('btn-simulate-scan');
  const simResultBox = document.getElementById('sim-result-box');
  const simResultTitle = document.getElementById('sim-result-title');
  const simResultDetail = document.getElementById('sim-result-detail');
  const btnTestOpen = document.getElementById('btn-test-open');

  const testUsersTableBody = document.querySelector('#test-users-table tbody');
  const btnShowAddTestUser = document.getElementById('btn-show-add-test-user');
  const testUserFormContainer = document.getElementById('test-user-form-container');
  const testUserFormTitle = document.getElementById('test-user-form-title');
  const testUserForm = document.getElementById('test-user-form');
  const testUserDbIdInput = document.getElementById('test-user-db-id');
  const testUserIdInput = document.getElementById('test-user-id');
  const testUserNameInput = document.getElementById('test-user-name');
  const testUserApiUrlInput = document.getElementById('test-user-api-url');
  const btnCancelTestUser = document.getElementById('btn-cancel-test-user');

  const testLogsTableBody = document.querySelector('#test-logs-table tbody');
  const btnClearDbLogs = document.getElementById('btn-clear-db-logs');
  const btnLogout = document.getElementById('btn-logout');

  // Metrics
  const metricTestUsers = document.getElementById('metric-test-users');
  const metricSimAuthorized = document.getElementById('metric-sim-authorized');
  const metricSimDenied = document.getElementById('metric-sim-denied');
  const metricSimTotal = document.getElementById('metric-sim-total');

  // QR Modal
  const qrModal = document.getElementById('qr-modal');
  const qrModalImage = document.getElementById('qr-modal-image');
  const btnCloseQrIcon = document.getElementById('btn-close-qr-icon');
  const btnQrDownload = document.getElementById('btn-qr-download');
  const btnQrCopy = document.getElementById('btn-qr-copy');
  let currentActiveQrBlob = null;
  let currentActiveQrUser = null;

  // Utilities
  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

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
    consoleLogs.scrollTop = consoleLogs.scrollHeight;
  }

  if (btnClearConsole) {
    btnClearConsole.addEventListener('click', () => {
      consoleLogs.innerHTML = '';
      appendConsoleLog('info', 'Consola limpia. Esperando nuevos eventos de prueba...');
    });
  }

  // SSE Event Stream
  let refreshLogsTimer = null;
  function debouncedRefreshLogs() {
    if (refreshLogsTimer) clearTimeout(refreshLogsTimer);
    refreshLogsTimer = setTimeout(() => {
      refreshLogs();
    }, 400);
  }

  function connectEventStream() {
    const source = new EventSource('/api/logs-stream');
    source.onmessage = (event) => {
      try {
        const logData = JSON.parse(event.data);
        if (logData.type === 'access_feedback') return;
        const timeStr = logData.timestamp ? (logData.timestamp.includes(' ') ? logData.timestamp.split(' ')[1] : logData.timestamp) : '';
        appendConsoleLog(logData.type, logData.message, timeStr);
        debouncedRefreshLogs();
      } catch (err) {
        console.error('Error parsing SSE event:', err);
      }
    };
    source.onerror = () => {
      source.close();
      setTimeout(connectEventStream, 3000);
    };
  }

  // Fetching Data
  async function refreshTestUsers() {
    try {
      const res = await fetch(`${API_USERS}?filter=test`);
      if (res.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      testUsersList = await res.json();
      renderTestUsersTable();
      populateSimulatorSelect();
      if (metricTestUsers) {
        metricTestUsers.textContent = testUsersList.length;
      }
    } catch (err) {
      console.error('Error fetching test users:', err);
      appendConsoleLog('error', `Error al cargar usuarios de prueba: ${err.message}`);
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
      renderTestLogsTable();
    } catch (err) {
      console.error('Error fetching logs:', err);
    }
  }

  // Rendering
  function renderTestUsersTable() {
    testUsersTableBody.innerHTML = '';

    if (testUsersList.length === 0) {
      testUsersTableBody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No hay usuarios de prueba registrados. Use el botón superior para agregar uno.</td></tr>`;
      return;
    }

    testUsersList.forEach(user => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHTML(user.user_id)}</strong></td>
        <td>${escapeHTML(user.name)}</td>
        <td><span class="text-muted" style="font-size:0.8rem; word-break:break-all;">${escapeHTML(user.api_url)}</span></td>
        <td class="actions-col" style="text-align: right;">
          <div class="action-btn-group" style="justify-content: flex-end;">
            <button class="btn btn-icon-only text-success run-sim-btn" data-id="${user.user_id}" title="Simular Escaneo Inmediato">
              <i data-lucide="play"></i>
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
      testUsersTableBody.appendChild(tr);
    });

    if (window.lucide) window.lucide.createIcons();

    // Event listeners
    document.querySelectorAll('.run-sim-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const uid = e.currentTarget.getAttribute('data-id');
        triggerSimulation(uid, simModeSelect ? simModeSelect.value : 'card');
      });
    });

    document.querySelectorAll('.qr-user-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = parseInt(e.currentTarget.getAttribute('data-id'), 10);
        const user = testUsersList.find(u => u.id === id);
        if (user) showUserQR(user);
      });
    });

    document.querySelectorAll('.edit-user-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = parseInt(e.currentTarget.getAttribute('data-id'), 10);
        const user = testUsersList.find(u => u.id === id);
        if (user) showTestUserForm(user);
      });
    });

    document.querySelectorAll('.delete-user-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = parseInt(e.currentTarget.getAttribute('data-id'), 10);
        const user = testUsersList.find(u => u.id === id);
        if (!user) return;
        if (!confirm(`¿Eliminar al usuario de prueba "${user.name}" (${user.user_id})?`)) return;

        try {
          const res = await fetch(`${API_USERS}/${id}`, { method: 'DELETE' });
          if (res.ok) {
            appendConsoleLog('info', `Usuario de prueba "${user.name}" eliminado.`);
            refreshTestUsers();
          } else {
            const errData = await res.json();
            alert(`Error al eliminar: ${errData.error}`);
          }
        } catch (err) {
          alert(`Error de red: ${err.message}`);
        }
      });
    });
  }

  function populateSimulatorSelect() {
    simUserIdSelect.innerHTML = `<option value="">-- Seleccionar usuario de prueba --</option>`;
    testUsersList.forEach(user => {
      const opt = document.createElement('option');
      opt.value = user.user_id;
      opt.textContent = `${user.user_id} - ${user.name}`;
      simUserIdSelect.appendChild(opt);
    });
  }

  function renderTestLogsTable() {
    testLogsTableBody.innerHTML = '';

    if (logsList.length === 0) {
      testLogsTableBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No hay registros de accesos.</td></tr>`;
      return;
    }

    const recentLogs = logsList.slice(0, 50);

    recentLogs.forEach(log => {
      const timeString = log.timestamp || 'N/A';
      const badgeAuth = log.authorized === 1
        ? `<span class="badge badge-success">Autorizado</span>`
        : `<span class="badge badge-danger">Denegado</span>`;

      const eventTypeMap = {
        'card': '<span class="badge badge-info">Tarjeta</span>',
        'simulated_scan': '<span class="badge badge-warning">Simulado</span>',
        'qrCode': '<span class="badge badge-primary">QR</span>',
        'face': '<span class="badge badge-primary">Rostro</span>',
        'barcode': '<span class="badge badge-info">Barras</span>',
        'faceOrFpOrCardOrPw': '<span class="badge badge-secondary">Cualquiera</span>'
      };
      const badgeType = eventTypeMap[log.event_type] || `<span class="badge badge-secondary">${escapeHTML(log.event_type)}</span>`;

      let friendlyResponse = 'N/A';
      if (log.api_response && log.api_response !== 'N/A') {
        try {
          const parsed = JSON.parse(log.api_response);
          friendlyResponse = parsed.message || parsed.error || (parsed.authorized !== undefined ? (parsed.authorized ? 'Permitido' : 'Denegado') : log.api_response);
        } catch (_) {
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
      testLogsTableBody.appendChild(tr);
    });

    if (window.lucide) window.lucide.createIcons();
  }

  // Simulator Execution
  async function triggerSimulation(userId, mode = 'simulated_scan') {
    if (!userId) return;
    appendConsoleLog('info', `Ejecutando simulación de lectura [Modo: ${mode}] para ID: ${userId}...`);

    try {
      const res = await fetch(API_TEST_SCAN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, eventType: mode })
      });

      const result = await res.json();
      simCountTotal++;
      if (result.authorized) {
        simCountAuth++;
      } else {
        simCountDenied++;
      }

      if (metricSimTotal) metricSimTotal.textContent = simCountTotal;
      if (metricSimAuthorized) metricSimAuthorized.textContent = simCountAuth;
      if (metricSimDenied) metricSimDenied.textContent = simCountDenied;

      // Show result box
      if (simResultBox) {
        simResultBox.classList.remove('hidden');
        if (result.authorized) {
          simResultBox.style.borderColor = 'var(--success)';
          simResultTitle.className = 'text-success';
          simResultTitle.textContent = `Acceso AUTORIZADO - ${result.name || userId}`;
        } else {
          simResultBox.style.borderColor = 'var(--danger)';
          simResultTitle.className = 'text-danger';
          simResultTitle.textContent = `Acceso DENEGADO - ID: ${userId}`;
        }
        simResultDetail.textContent = `Motivo: ${result.reason || 'Sin detalles'}. Torniquete: ${result.doorOpened ? 'Apertura enviada' : 'Bloqueado'}.`;
      }

      if (res.ok) {
        if (result.authorized) {
          appendConsoleLog('success', `Simulación: Acceso AUTORIZADO para "${result.name}".`);
        } else {
          appendConsoleLog('warning', `Simulación: Acceso DENEGADO. Razón: ${result.reason || 'Sin detalles'}`);
        }
      } else {
        throw new Error(result.error || 'Fallo en la simulación');
      }
    } catch (err) {
      appendConsoleLog('error', `Error durante simulación: ${err.message}`);
      if (simResultBox) {
        simResultBox.classList.remove('hidden');
        simResultBox.style.borderColor = 'var(--danger)';
        simResultTitle.className = 'text-danger';
        simResultTitle.textContent = 'Error en Simulación';
        simResultDetail.textContent = err.message;
      }
    }
  }

  if (btnSimulateScan) {
    btnSimulateScan.addEventListener('click', () => {
      const customVal = simCustomIdInput ? simCustomIdInput.value.trim() : '';
      const selectVal = simUserIdSelect ? simUserIdSelect.value.trim() : '';
      const targetId = customVal || selectVal;
      const mode = simModeSelect ? simModeSelect.value : 'card';

      if (!targetId) {
        alert('Por favor seleccione un usuario de prueba o ingrese un ID manual para simular.');
        return;
      }
      triggerSimulation(targetId, mode);
    });
  }

  // Hardware Door Open Test
  if (btnTestOpen) {
    btnTestOpen.addEventListener('click', async () => {
      btnTestOpen.disabled = true;
      appendConsoleLog('info', 'Enviando comando manual de apertura al dispositivo...');
      try {
        const res = await fetch(API_TEST_OPEN, { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.success) {
          appendConsoleLog('success', 'Comando de apertura ejecutado. El dispositivo respondió OK.');
          alert('Comando de apertura enviado exitosamente al dispositivo.');
        } else {
          throw new Error(data.error || 'Respuesta errónea del hardware');
        }
      } catch (err) {
        appendConsoleLog('error', `Error al abrir la puerta: ${err.message}`);
        alert(`Fallo de hardware: ${err.message}. Verifique la IP y contraseña del lector en el Panel Principal.`);
      } finally {
        btnTestOpen.disabled = false;
      }
    });
  }

  // Test User Form Handling
  function showTestUserForm(user = null) {
    testUserFormContainer.classList.remove('hidden');
    if (user) {
      testUserFormTitle.textContent = 'Editar Usuario de Prueba';
      testUserDbIdInput.value = user.id;
      testUserIdInput.value = user.user_id;
      testUserNameInput.value = user.name;
      testUserApiUrlInput.value = user.api_url;
    } else {
      testUserFormTitle.textContent = 'Registrar Usuario de Prueba';
      testUserForm.reset();
      testUserDbIdInput.value = '';

      // Suggest next 100x ID
      let nextId = 1001;
      if (testUsersList.length > 0) {
        const numIds = testUsersList
          .map(u => parseInt(u.user_id, 10))
          .filter(n => !isNaN(n) && n >= 1000);
        if (numIds.length > 0) {
          nextId = Math.max(...numIds) + 1;
        }
      }
      testUserIdInput.value = String(nextId);
      testUserApiUrlInput.value = 'http://localhost:3000/api/mock-external-api/allow';
    }
  }

  function hideTestUserForm() {
    testUserFormContainer.classList.add('hidden');
    testUserForm.reset();
    testUserDbIdInput.value = '';
  }

  if (btnShowAddTestUser) {
    btnShowAddTestUser.addEventListener('click', () => showTestUserForm());
  }
  if (btnCancelTestUser) {
    btnCancelTestUser.addEventListener('click', () => hideTestUserForm());
  }

  // Presets
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const type = e.currentTarget.getAttribute('data-type');
      if (type === 'allow') {
        testUserNameInput.value = testUserNameInput.value || 'Usuario Demo (Permitido)';
        testUserApiUrlInput.value = 'http://localhost:3000/api/mock-external-api/allow';
      } else if (type === 'deny') {
        testUserNameInput.value = testUserNameInput.value || 'Usuario Demo (Denegado)';
        testUserApiUrlInput.value = 'http://localhost:3000/api/mock-external-api/deny';
      } else if (type === 'error') {
        testUserNameInput.value = testUserNameInput.value || 'Usuario Demo (Error 500)';
        testUserApiUrlInput.value = 'http://localhost:3000/api/mock-external-api/error';
      }
    });
  });

  if (testUserForm) {
    testUserForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const dbId = testUserDbIdInput.value;
      const payload = {
        user_id: testUserIdInput.value.trim(),
        name: testUserNameInput.value.trim(),
        api_url: testUserApiUrlInput.value.trim() || 'http://localhost:3000/api/mock-external-api/allow'
      };

      const isEdit = dbId !== '';
      const url = isEdit ? `${API_USERS}/${dbId}` : API_USERS;
      const method = isEdit ? 'PUT' : 'POST';

      try {
        const res = await fetch(url, {
          method: method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          appendConsoleLog('success', `Usuario de prueba "${payload.name}" guardado.`);
          hideTestUserForm();
          refreshTestUsers();
        } else {
          alert(`Error al guardar: ${data.error}`);
        }
      } catch (err) {
        alert(`Error de red: ${err.message}`);
      }
    });
  }

  // Clear Logs
  if (btnClearDbLogs) {
    btnClearDbLogs.addEventListener('click', async () => {
      if (!confirm('¿Desea limpiar el historial de accesos?')) return;
      try {
        const res = await fetch(API_CLEAR_LOGS, { method: 'POST' });
        if (res.ok) {
          appendConsoleLog('info', 'Historial de accesos limpiado.');
          refreshLogs();
        }
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    });
  }

  // QR Modal
  async function showUserQR(user) {
    currentActiveQrUser = user;
    qrModal.classList.remove('hidden');
    qrModalImage.src = '';
    qrModalImage.alt = `Cargando credencial para ${user.name}...`;

    try {
      const res = await fetch(`${API_USERS}/${user.id}/qr`);
      if (res.ok) {
        const blob = await res.blob();
        currentActiveQrBlob = blob;
        qrModalImage.src = URL.createObjectURL(blob);
      } else {
        alert('No se pudo generar la credencial QR');
        qrModal.classList.add('hidden');
      }
    } catch (err) {
      alert(`Error al obtener QR: ${err.message}`);
      qrModal.classList.add('hidden');
    }
  }

  function hideQRModal() {
    qrModal.classList.add('hidden');
    currentActiveQrBlob = null;
    currentActiveQrUser = null;
  }

  if (btnCloseQrIcon) btnCloseQrIcon.addEventListener('click', hideQRModal);
  if (qrModal) {
    qrModal.addEventListener('click', (e) => {
      if (e.target === qrModal) hideQRModal();
    });
  }

  if (btnQrDownload) {
    btnQrDownload.addEventListener('click', () => {
      if (!currentActiveQrBlob || !currentActiveQrUser) return;
      const safeName = currentActiveQrUser.name.replace(/[^a-zA-Z0-9_\-]/g, '_');
      const url = URL.createObjectURL(currentActiveQrBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Credencial_${safeName}_${currentActiveQrUser.user_id}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }

  if (btnQrCopy) {
    btnQrCopy.addEventListener('click', async () => {
      if (!currentActiveQrBlob) return;
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': currentActiveQrBlob })
        ]);
        alert('Credencial copiada al portapapeles.');
      } catch (err) {
        alert(`No se pudo copiar automáticamente: ${err.message}`);
      }
    });
  }

  // Logout
  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      try {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/login.html';
      } catch (_) {
        window.location.href = '/login.html';
      }
    });
  }

  // Initialize
  connectEventStream();
  refreshTestUsers();
  refreshLogs();
});
