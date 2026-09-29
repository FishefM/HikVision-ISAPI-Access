// ==========================================================================
// Initialization & Global State
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  // Initialize Lucide Icons
  if (window.lucide) {
    window.lucide.createIcons();
  }

  // API base endpoints
  const API_ME = '/api/me';
  const API_USERS = '/api/users';
  const API_DEVICES = '/api/devices';
  const API_LOGS = '/api/logs';
  const API_SETTINGS = '/api/settings';
  const API_CLEAR_LOGS = '/api/logs/clear';
  const API_RECEPTIONISTS = '/api/receptionists';

  // State
  let currentUser = null;
  let usersList = [];
  let devicesList = [];
  let logsList = [];
  let receptionistsList = [];

  // Current User Badge
  const currentUserBadge = document.getElementById('current-user-badge');
  const currentUserName = document.getElementById('current-user-name');

  // Dom Elements
  const consoleLogs = document.getElementById('console-logs');
  const btnClearConsole = document.getElementById('btn-clear-console');

  // Devices Elements
  const devicesContainer = document.getElementById('devices-container');
  const btnShowAddDevice = document.getElementById('btn-show-add-device');
  const deviceFormContainer = document.getElementById('device-form-container');
  const deviceFormTitle = document.getElementById('device-form-title');
  const deviceForm = document.getElementById('device-form');
  const deviceIdInput = document.getElementById('device-id');
  const deviceNameInput = document.getElementById('device-name');
  const deviceIpInput = document.getElementById('device-ip');
  const devicePortInput = document.getElementById('device-port');
  const deviceDoorInput = document.getElementById('device-door');
  const deviceUserInput = document.getElementById('device-user');
  const devicePasswordInput = document.getElementById('device-password');
  const deviceEnableOpenInput = document.getElementById('device-enable-api-open');
  const deviceIsDefaultInput = document.getElementById('device-is-default');
  const btnCancelDevice = document.getElementById('btn-cancel-device');

  // Receptionists Elements
  const btnShowAddReceptionist = document.getElementById('btn-show-add-receptionist');
  const receptionistFormContainer = document.getElementById('receptionist-form-container');
  const receptionistFormTitle = document.getElementById('receptionist-form-title');
  const receptionistForm = document.getElementById('receptionist-form');
  const receptionistIdInput = document.getElementById('receptionist-id');
  const receptionistNameInput = document.getElementById('receptionist-name');
  const receptionistUsernameInput = document.getElementById('receptionist-username');
  const receptionistPasswordInput = document.getElementById('receptionist-password');
  const receptionistConfirmPasswordInput = document.getElementById('receptionist-confirm-password');
  const btnCancelReceptionist = document.getElementById('btn-cancel-receptionist');
  const receptionistsListBody = document.getElementById('receptionists-list-body');

  // Users Form & Table Elements
  const btnShowAddUser = document.getElementById('btn-show-add-user');
  const btnSyncAcuaticApp = document.getElementById('btn-sync-acuaticapp');
  const searchUserInput = document.getElementById('search-user-input');
  const btnClearSearch = document.getElementById('btn-clear-search');
  const userFormContainer = document.getElementById('user-form-container');
  const userFormTitle = document.getElementById('user-form-title');
  const userForm = document.getElementById('user-form');
  const userDbIdInput = document.getElementById('user-db-id');
  const userIdInput = document.getElementById('user-id');
  const userAcuaticAppIdInput = document.getElementById('user-acuaticapp-id');
  const userFirstNameInput = document.getElementById('user-first-name');
  const userSecondNameInput = document.getElementById('user-second-name');
  const userLastNameInput = document.getElementById('user-last-name');
  const userMatriculaInput = document.getElementById('user-matricula');
  const userPhoneInput = document.getElementById('user-phone');
  const userImageFileInput = document.getElementById('user-image-file');
  const userIdPreview = document.getElementById('user-id-preview');
  const userApiUrlInput = document.getElementById('user-api-url');
  const userDeviceSelect = document.getElementById('user-device-select');
  const userAssignAllCheckbox = document.getElementById('user-assign-all');
  const btnCancelUser = document.getElementById('btn-cancel-user');
  const filterUserDevice = document.getElementById('filter-user-device');
  const usersTableBody = document.querySelector('#users-table tbody');

  // Logs Elements
  const filterLogDevice = document.getElementById('filter-log-device');
  const logsTableBody = document.querySelector('#logs-table tbody');
  const btnClearDbLogs = document.getElementById('btn-clear-db-logs');

  // Admin Security Settings
  const btnSaveAdminPassword = document.getElementById('btn-save-admin-password');
  const settingAdminPassword = document.getElementById('setting-admin-password');
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
  if (btnClearConsole) {
    btnClearConsole.addEventListener('click', () => {
      consoleLogs.innerHTML = '';
      appendConsoleLog('info', 'Consola limpia. Esperando nuevos eventos...');
    });
  }

  // ==========================================================================
  // SSE Event Stream Integration
  // ==========================================================================
  let refreshLogsTimer = null;
  function debouncedRefreshLogs() {
    if (refreshLogsTimer) clearTimeout(refreshLogsTimer);
    refreshLogsTimer = setTimeout(() => {
      refreshLogs();
    }, 400);
  }

  function connectEventStream() {
    const source = new EventSource('/api/logs-stream');
    const backendStatusDot = document.getElementById('backend-status-dot');
    
    source.onopen = () => {
      if (backendStatusDot) {
        backendStatusDot.className = 'status-indicator online';
      }
    };

    source.onmessage = (event) => {
      if (backendStatusDot) {
        backendStatusDot.className = 'status-indicator online';
      }
      try {
        const logData = JSON.parse(event.data);
        if (logData.type === 'access_feedback') return;
        const timeStr = logData.timestamp ? (logData.timestamp.includes(' ') ? logData.timestamp.split(' ')[1] : logData.timestamp) : '';
        appendConsoleLog(logData.type, logData.message, timeStr);
        
        // Refresh logs and statistics on any new activity with debounce
        debouncedRefreshLogs();
      } catch (err) {
        console.error('Error parsing SSE event:', err);
      }
    };

    source.onerror = () => {
      if (backendStatusDot) {
        backendStatusDot.className = 'status-indicator offline';
      }
      source.close();
      setTimeout(connectEventStream, 3000);
    };
  }

  // ==========================================================================
  // Fetch Data Functions
  // ==========================================================================
  async function refreshDevices() {
    try {
      const res = await fetch(API_DEVICES);
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      devicesList = await res.json();
      renderDevicesList();
      populateDeviceDropdowns();
    } catch (err) {
      console.error('Error fetching devices:', err);
      appendConsoleLog('error', `Error al cargar lista de torniquetes: ${err.message}`);
    }
  }

  let searchDebounceTimer = null;
  async function refreshUsers(searchQuery = null) {
    try {
      const selectedDevId = filterUserDevice ? filterUserDevice.value : '';
      const search = searchQuery !== null ? searchQuery : (searchUserInput ? searchUserInput.value.trim() : '');
      let url = `${API_USERS}?filter=production`;
      if (selectedDevId) {
        url += `&deviceId=${encodeURIComponent(selectedDevId)}`;
      }
      if (search) {
        url += `&search=${encodeURIComponent(search)}`;
      }

      const res = await fetch(url);
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      usersList = await res.json();
      renderUsersTable();
    } catch (err) {
      console.error('Error fetching users:', err);
      appendConsoleLog('error', `Error al consultar usuarios: ${err.message}`);
    }
  }

  async function refreshLogs() {
    try {
      const selectedDevId = filterLogDevice ? filterLogDevice.value : '';
      let url = API_LOGS;
      if (selectedDevId) {
        url += `?deviceId=${encodeURIComponent(selectedDevId)}`;
      }

      const res = await fetch(url);
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      logsList = await res.json();
      renderLogsTable();
      updateMetrics();
    } catch (err) {
      console.error('Error fetching logs:', err);
    }
  }

  // ==========================================================================
  // Devices Rendering & Handlers
  // ==========================================================================
  function renderDevicesList() {
    if (!devicesContainer) return;
    devicesContainer.innerHTML = '';

    if (devicesList.length === 0) {
      devicesContainer.innerHTML = `<div class="text-center text-muted" style="padding: 1rem;">No hay torniquetes registrados. Agregue uno con el botón superior.</div>`;
      return;
    }

    devicesList.forEach(dev => {
      const isDefault = dev.is_default === 1 || dev.is_default === true;
      const defaultBadge = isDefault
        ? `<span class="badge badge-primary" style="font-size: 0.7rem; padding: 0.15rem 0.45rem;">Predeterminado</span>`
        : '';
      
      const devCard = document.createElement('div');
      devCard.className = 'device-card';
      
      devCard.innerHTML = `
        <div class="device-card-info">
          <div class="device-card-header">
            <div class="device-card-title-wrap">
              <i data-lucide="cpu" class="device-card-icon"></i>
              <strong class="device-card-name">${escapeHTML(dev.name)}</strong>
            </div>
            ${defaultBadge}
          </div>
          <div class="device-card-meta">
            <span class="device-meta-tag"><i data-lucide="network" style="width:12px;height:12px;"></i> ${escapeHTML(dev.ip)}:${dev.port || 80}</span>
            <span class="device-meta-tag"><i data-lucide="door-closed" style="width:12px;height:12px;"></i> Puerta ${dev.door_channel || 1}</span>
            <span class="device-meta-tag ${dev.enable_api_open ? 'meta-success' : 'meta-muted'}">
              <i data-lucide="${dev.enable_api_open ? 'unlock' : 'lock'}" style="width:12px;height:12px;"></i> ${dev.enable_api_open ? 'Apertura Remota ON' : 'Apertura OFF'}
            </span>
          </div>
        </div>
        <div class="device-card-actions">
          <a href="/feedback?device=${dev.id}" target="_blank" class="btn btn-secondary btn-sm dev-action-btn" title="Abrir pantalla de visualización para ${escapeHTML(dev.name)}">
            <i data-lucide="tv" style="width:14px;height:14px;"></i> Pantalla
          </a>
          <button type="button" class="btn btn-secondary btn-sm test-ping-btn dev-action-btn" data-id="${dev.id}" title="Probar conexión ISAPI con este torniquete">
            <i data-lucide="radio" style="width:14px;height:14px;"></i> Ping
          </button>
          <button type="button" class="btn btn-primary btn-sm test-open-btn dev-action-btn" data-id="${dev.id}" title="Enviar comando de apertura a este torniquete">
            <i data-lucide="unlock" style="width:14px;height:14px;"></i> Abrir
          </button>
          <div class="dev-card-admin-actions">
            <button type="button" class="btn btn-icon-only edit-device-btn" data-id="${dev.id}" title="Editar torniquete">
              <i data-lucide="edit" style="width:14px;height:14px;"></i>
            </button>
            <button type="button" class="btn btn-icon-only text-danger delete-device-btn" data-id="${dev.id}" title="Eliminar torniquete" ${devicesList.length <= 1 ? 'disabled style="opacity:0.3;"' : ''}>
              <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
            </button>
          </div>
        </div>
      `;

      devicesContainer.appendChild(devCard);
    });

    if (window.lucide) window.lucide.createIcons();

    // Attach device action listeners
    document.querySelectorAll('.test-ping-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const dev = devicesList.find(d => String(d.id) === String(id));
        const btnElem = e.currentTarget;
        btnElem.disabled = true;
        appendConsoleLog('info', `[Ping] Probando comunicación con ${dev ? dev.name : id} (${dev ? dev.ip : ''})...`);
        try {
          const res = await fetch(`/api/devices/${id}/test-ping`, { method: 'POST' });
          const data = await res.json();
          if (res.ok && data.success) {
            appendConsoleLog('success', `[Ping OK] ${data.message}`);
            alert(`[Conexión Exitosa]\n${data.message}`);
          } else {
            appendConsoleLog('warning', `[Ping Fallo] ${data.error || data.message || 'Sin respuesta'}`);
            alert(`[Fallo de Conexión]\n${data.error || data.message}`);
          }
        } catch (err) {
          appendConsoleLog('error', `[Ping Error] Excepción: ${err.message}`);
          alert(`Error al probar conexión: ${err.message}`);
        } finally {
          btnElem.disabled = false;
        }
      });
    });

    document.querySelectorAll('.test-open-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const dev = devicesList.find(d => String(d.id) === String(id));
        const btnElem = e.currentTarget;
        btnElem.disabled = true;
        appendConsoleLog('info', `[Apertura] Enviando comando de apertura a "${dev ? dev.name : id}"...`);
        try {
          const res = await fetch(`/api/devices/${id}/open-door`, { method: 'POST' });
          const data = await res.json();
          if (res.ok && data.success) {
            appendConsoleLog('success', `[Apertura OK] Puerta abierta en ${dev ? dev.name : 'torniquete'}.`);
          } else {
            throw new Error(data.error || 'Respuesta inesperada');
          }
        } catch (err) {
          appendConsoleLog('error', `[Apertura Error] Fallo al abrir ${dev ? dev.name : ''}: ${err.message}`);
          alert(`Fallo al abrir puerta:\n${err.message}`);
        } finally {
          btnElem.disabled = false;
        }
      });
    });

    document.querySelectorAll('.edit-device-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const dev = devicesList.find(d => String(d.id) === String(id));
        if (dev) showDeviceForm(dev);
      });
    });

    document.querySelectorAll('.delete-device-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const dev = devicesList.find(d => String(d.id) === String(id));
        if (dev && confirm(`¿Desea eliminar el torniquete "${dev.name}" (${dev.ip})? Los alumnos asignados a este torniquete mantendrán sus otros accesos.`)) {
          appendConsoleLog('info', `Eliminando torniquete "${dev.name}"...`);
          try {
            const res = await fetch(`/api/devices/${id}`, { method: 'DELETE' });
            if (res.ok) {
              appendConsoleLog('success', `Torniquete "${dev.name}" eliminado correctamente.`);
              refreshDevices();
              refreshUsers();
            } else {
              const data = await res.json();
              throw new Error(data.error || 'Fallo al eliminar');
            }
          } catch (err) {
            appendConsoleLog('error', `Error al eliminar torniquete: ${err.message}`);
            alert(`Error: ${err.message}`);
          }
        }
      });
    });
  }

  function populateDeviceDropdowns() {
    // 1. Selector en formulario de registro de usuario (Asignación habitual de 1 dispositivo)
    if (userDeviceSelect) {
      const currentSelected = userDeviceSelect.value;
      userDeviceSelect.innerHTML = '';
      devicesList.forEach(dev => {
        const opt = document.createElement('option');
        opt.value = dev.id;
        opt.textContent = `${dev.name} (${dev.ip})`;
        if (dev.is_default) {
          opt.textContent += ' [Predeterminado]';
          if (!currentSelected) opt.selected = true;
        }
        if (String(currentSelected) === String(dev.id)) {
          opt.selected = true;
        }
        userDeviceSelect.appendChild(opt);
      });
    }

    // 2. Filtro en tabla de usuarios
    if (filterUserDevice) {
      const currentVal = filterUserDevice.value;
      filterUserDevice.innerHTML = '<option value="">Todos los Torniquetes</option>';
      devicesList.forEach(dev => {
        const opt = document.createElement('option');
        opt.value = dev.id;
        opt.textContent = dev.name;
        if (String(currentVal) === String(dev.id)) opt.selected = true;
        filterUserDevice.appendChild(opt);
      });
    }

    // 3. Filtro en tabla de historial de logs
    if (filterLogDevice) {
      const currentVal = filterLogDevice.value;
      filterLogDevice.innerHTML = '<option value="">Todos los Torniquetes</option>';
      devicesList.forEach(dev => {
        const opt = document.createElement('option');
        opt.value = dev.id;
        opt.textContent = dev.name;
        if (String(currentVal) === String(dev.id)) opt.selected = true;
        filterLogDevice.appendChild(opt);
      });
    }
  }

  function showDeviceForm(dev = null) {
    if (!deviceFormContainer) return;
    deviceFormContainer.classList.remove('hidden');
    if (dev) {
      deviceFormTitle.textContent = 'Editar Torniquete';
      deviceIdInput.value = dev.id;
      deviceNameInput.value = dev.name;
      deviceIpInput.value = dev.ip;
      devicePortInput.value = dev.port || 80;
      deviceDoorInput.value = dev.door_channel || 1;
      deviceUserInput.value = dev.username || 'admin';
      devicePasswordInput.value = '';
      devicePasswordInput.placeholder = '•••••••• (Dejar en blanco para conservar)';
      deviceEnableOpenInput.checked = Boolean(dev.enable_api_open);
      deviceIsDefaultInput.checked = Boolean(dev.is_default);
    } else {
      deviceFormTitle.textContent = 'Registrar Nuevo Torniquete';
      deviceForm.reset();
      deviceIdInput.value = '';
      devicePortInput.value = '80';
      deviceDoorInput.value = '1';
      deviceUserInput.value = 'admin';
      devicePasswordInput.placeholder = '••••••••';
      deviceEnableOpenInput.checked = true;
      deviceIsDefaultInput.checked = devicesList.length === 0;
    }
  }

  function hideDeviceForm() {
    if (!deviceFormContainer) return;
    deviceFormContainer.classList.add('hidden');
    deviceForm.reset();
    deviceIdInput.value = '';
  }

  if (btnShowAddDevice) btnShowAddDevice.addEventListener('click', () => showDeviceForm());
  if (btnCancelDevice) btnCancelDevice.addEventListener('click', () => hideDeviceForm());

  if (deviceForm) {
    deviceForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const devId = deviceIdInput.value;
      const isEdit = Boolean(devId);

      const payload = {
        name: deviceNameInput.value.trim(),
        ip: deviceIpInput.value.trim(),
        port: parseInt(devicePortInput.value || 80, 10),
        door_channel: parseInt(deviceDoorInput.value || 1, 10),
        username: deviceUserInput.value.trim() || 'admin',
        enable_api_open: deviceEnableOpenInput.checked,
        is_default: deviceIsDefaultInput.checked
      };

      if (devicePasswordInput.value.trim() !== '') {
        payload.password = devicePasswordInput.value.trim();
      }

      const url = isEdit ? `/api/devices/${devId}` : API_DEVICES;
      const method = isEdit ? 'PUT' : 'POST';

      appendConsoleLog('info', `${isEdit ? 'Actualizando' : 'Creando'} torniquete "${payload.name}" (${payload.ip})...`);

      try {
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (res.ok) {
          appendConsoleLog('success', `Torniquete "${payload.name}" guardado exitosamente.`);
          hideDeviceForm();
          refreshDevices();
          refreshUsers();
        } else {
          throw new Error(data.error || 'Error al guardar torniquete');
        }
      } catch (err) {
        appendConsoleLog('error', `Error al guardar torniquete: ${err.message}`);
        alert(`Error: ${err.message}`);
      }
    });
  }



  // ==========================================================================
  // Users Rendering & Handlers
  // ==========================================================================
  // Search and Filter Listeners
  if (filterUserDevice) {
    filterUserDevice.addEventListener('change', () => refreshUsers());
  }

  if (searchUserInput) {
    searchUserInput.addEventListener('input', (e) => {
      const val = e.target.value;
      if (btnClearSearch) {
        btnClearSearch.style.display = val.trim() ? 'block' : 'none';
      }
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        refreshUsers(val.trim());
      }, 250);
    });
  }

  if (btnClearSearch && searchUserInput) {
    btnClearSearch.addEventListener('click', () => {
      searchUserInput.value = '';
      btnClearSearch.style.display = 'none';
      refreshUsers('');
    });
  }

  if (btnSyncAcuaticApp) {
    btnSyncAcuaticApp.addEventListener('click', async () => {
      if (btnSyncAcuaticApp.disabled) return;
      if (!confirm('¿Desea importar y sincronizar el catálogo de alumnos desde AcuaticApp v2 ahora? Se registrarán automáticamente con acceso escolar permitido.')) return;

      btnSyncAcuaticApp.disabled = true;
      const originalHtml = btnSyncAcuaticApp.innerHTML;
      btnSyncAcuaticApp.innerHTML = `<i data-lucide="loader-2" class="spin-icon" style="width:14px;height:14px;"></i> Sincronizando...`;
      if (window.lucide) window.lucide.createIcons();

      appendConsoleLog('info', 'Iniciando sincronización con AcuaticApp v2...');

      try {
        const res = await fetch('/api/users/sync-acuaticapp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });

        const data = await res.json();
        if (res.ok && data.success) {
          appendConsoleLog('success', `[AcuaticApp OK] ${data.message}`);
          alert(`[Sincronización Exitosa]\n${data.message}`);
          refreshUsers();
        } else {
          throw new Error(data.error || 'Fallo en la sincronización');
        }
      } catch (err) {
        appendConsoleLog('error', `[AcuaticApp Error] ${err.message}`);
        alert(`Error al sincronizar con AcuaticApp:\n${err.message}`);
      } finally {
        btnSyncAcuaticApp.disabled = false;
        btnSyncAcuaticApp.innerHTML = originalHtml;
        if (window.lucide) window.lucide.createIcons();
      }
    });
  }

  if (filterLogDevice) {
    filterLogDevice.addEventListener('change', () => refreshLogs());
  }

  // Toggle habitual single device select when "Asignar a todos" is checked
  if (userAssignAllCheckbox && userDeviceSelect) {
    userAssignAllCheckbox.addEventListener('change', () => {
      userDeviceSelect.disabled = userAssignAllCheckbox.checked;
      if (userAssignAllCheckbox.checked) {
        userDeviceSelect.style.opacity = '0.5';
      } else {
        userDeviceSelect.style.opacity = '1';
      }
    });
  }

  function renderUsersTable() {
    usersTableBody.innerHTML = '';
    
    if (usersList.length === 0) {
      usersTableBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted" style="padding: 1.5rem;">No se encontraron alumnos que coincidan con la búsqueda.</td></tr>`;
      return;
    }

    usersList.forEach(user => {
      let devicesBadge = '';
      if (user.device_names && user.device_names.length > 0) {
        if (user.device_names.length === devicesList.length && devicesList.length > 1) {
          devicesBadge = `<span class="badge badge-primary" style="font-size:0.75rem;">Todos (${user.device_names.length})</span>`;
        } else {
          devicesBadge = user.device_names.map(name => `<span class="badge badge-info" style="font-size:0.75rem; margin-right: 0.2rem;">${escapeHTML(name)}</span>`).join('');
        }
      } else {
        devicesBadge = `<span class="badge badge-secondary" style="font-size:0.75rem;">Predeterminado</span>`;
      }

      // Avatar o Foto
      const initials = (user.name || '').split(' ').map(n => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'AL';
      let avatarHtml = `<div class="user-avatar-initials">${initials}</div>`;
      if (user.image_file) {
        avatarHtml = `
          <div class="user-avatar-wrap">
            <img src="${escapeHTML(user.image_file)}" alt="${escapeHTML(user.name)}" class="user-avatar-img" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
            <div class="user-avatar-initials" style="display:none;">${initials}</div>
          </div>
        `;
      }

      const acuaticBadge = user.acuaticapp_id 
        ? `<span class="badge badge-info" style="font-size:0.65rem; padding: 0.1rem 0.35rem; margin-left: 0.35rem;">AcuaticApp</span>` 
        : '';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHTML(user.matricula || user.user_id)}</strong></td>
        <td style="text-align: center;">${avatarHtml}</td>
        <td>
          <div style="display: flex; align-items: center; flex-wrap: wrap;">
            <strong>${escapeHTML(user.name)}</strong>
            ${acuaticBadge}
          </div>
        </td>
        <td><span class="text-muted" style="font-size:0.85rem;">${user.phone ? escapeHTML(user.phone) : '—'}</span></td>
        <td>${devicesBadge}</td>
        <td class="actions-col" style="text-align: right;">
          <div class="action-btn-group" style="justify-content: flex-end;">
            <button class="btn btn-icon-only text-info qr-user-btn" data-id="${user.id}" title="Ver Credencial / Código QR">
              <i data-lucide="qr-code"></i>
            </button>
            <button class="btn btn-icon-only edit-user-btn" data-id="${user.id}" title="Editar Alumno">
              <i data-lucide="edit"></i>
            </button>
            <button class="btn btn-icon-only text-danger delete-user-btn" data-id="${user.id}" title="Eliminar Alumno">
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        </td>
      `;
      usersTableBody.appendChild(tr);
    });

    if (window.lucide) window.lucide.createIcons();

    // Attach Event Listeners to actions
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
        if (user && confirm(`¿Está seguro de eliminar al alumno "${user.name}" de la base de datos local y de sus torniquetes asignados?`)) {
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
        'qrCode': '<span class="badge badge-primary">QR</span>',
        'remote_open': '<span class="badge badge-warning">Remoto</span>',
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

        // Sanitizar si contiene HTML o etiquetas para no deformar la tabla
        if (typeof friendlyResponse === 'string') {
          if (friendlyResponse.includes('<html') || friendlyResponse.includes('<!DOCTYPE') || friendlyResponse.includes('<head')) {
            const titleMatch = friendlyResponse.match(/<title[^>]*>([^<]+)<\/title>/i);
            friendlyResponse = titleMatch ? `[Error HTML] ${titleMatch[1].trim()}` : '[Respuesta HTML no válida]';
          }
          if (friendlyResponse.length > 70) {
            friendlyResponse = friendlyResponse.slice(0, 67) + '...';
          }
        }
      }

      const deviceLabel = log.device_name 
        ? `<strong style="font-size:0.8rem;">${escapeHTML(log.device_name)}</strong><br><small class="text-muted" style="font-size:0.7rem;">${escapeHTML(log.device_ip || '')}</small>`
        : `<span class="text-muted" style="font-size:0.8rem;">${escapeHTML(log.device_ip || 'N/A')}</span>`;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${timeString}</td>
        <td><strong>${escapeHTML(log.user_id || 'N/A')}</strong><br><small class="text-muted">${escapeHTML(log.name || 'Desconocido')}</small></td>
        <td>${deviceLabel}</td>
        <td>${badgeType}</td>
        <td><span class="text-muted" style="font-size:0.75rem; word-break:break-all;">${escapeHTML(log.api_url || 'N/A')}</span></td>
        <td><span class="text-muted" style="font-size:0.75rem; word-break:break-word;">${escapeHTML(friendlyResponse)}</span></td>
        <td>${badgeAuth}</td>
      `;
      logsTableBody.appendChild(tr);
    });

    if (window.lucide) window.lucide.createIcons();
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
  function extractIdFromUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (segments.length > 0) {
        const last = segments[segments.length - 1];
        if (last && /^[a-zA-Z0-9_-]{8,}$/.test(last)) {
          return last.substring(0, 8).toLowerCase();
        }
      }
    } catch (_) {
      const match = String(url).match(/([a-zA-Z0-9]{8,})/);
      if (match && match[1]) {
        return match[1].substring(0, 8).toLowerCase();
      }
    }
    return '';
  }

  function updateUserIdPreview() {
    if (!userIdPreview) return;
    const url = userApiUrlInput.value.trim();
    const isEdit = userDbIdInput.value !== '';
    const extracted = extractIdFromUrl(url);

    if (isEdit && userIdInput.value) {
      if (extracted && extracted !== userIdInput.value) {
        userIdPreview.textContent = `ID actual: ${userIdInput.value} | Nuevo detectado: ${extracted}`;
      } else {
        userIdPreview.textContent = `ID asignado: ${userIdInput.value}`;
      }
    } else if (extracted) {
      userIdPreview.textContent = `ID asignado: ${extracted}`;
      userIdInput.value = extracted;
    } else if (url) {
      userIdPreview.textContent = 'ID: Automático (generado por sistema)';
      userIdInput.value = '';
    } else {
      userIdPreview.textContent = 'ID: Automático (generado por sistema)';
      userIdInput.value = '';
    }
  }

  userApiUrlInput.addEventListener('input', updateUserIdPreview);

  function showUserForm(user = null) {
    userFormContainer.classList.remove('hidden');
    if (user) {
      userFormTitle.textContent = 'Editar Alumno';
      userDbIdInput.value = user.id;
      userIdInput.value = user.user_id || '';
      if (userAcuaticAppIdInput) userAcuaticAppIdInput.value = user.acuaticapp_id || '';
      
      // Separar nombres o usar campos existentes
      if (userFirstNameInput) userFirstNameInput.value = user.first_name || user.name || '';
      if (userSecondNameInput) userSecondNameInput.value = user.second_name || '';
      if (userLastNameInput) userLastNameInput.value = user.last_name || '';
      if (userMatriculaInput) userMatriculaInput.value = user.matricula || user.user_id || '';
      if (userPhoneInput) userPhoneInput.value = user.phone || '';
      if (userImageFileInput) userImageFileInput.value = user.image_file || '';
      if (userApiUrlInput) userApiUrlInput.value = user.api_url || 'http://localhost:3000/api/mock-external-api/allow';

      // Asignación de torniquetes
      const userDevs = user.device_ids || [];
      const hasAll = devicesList.length > 1 && userDevs.length === devicesList.length;
      if (userAssignAllCheckbox) {
        userAssignAllCheckbox.checked = hasAll || userDevs.length === 0;
      }
      if (userDeviceSelect) {
        userDeviceSelect.disabled = userAssignAllCheckbox ? userAssignAllCheckbox.checked : false;
        userDeviceSelect.style.opacity = (userAssignAllCheckbox && userAssignAllCheckbox.checked) ? '0.5' : '1';
        if (userDevs.length > 0) {
          userDeviceSelect.value = userDevs[0];
        }
      }

      updateUserIdPreview();
    } else {
      userFormTitle.textContent = 'Registrar Nuevo Alumno';
      userForm.reset();
      userDbIdInput.value = '';
      userIdInput.value = '';
      if (userAcuaticAppIdInput) userAcuaticAppIdInput.value = '';
      if (userFirstNameInput) userFirstNameInput.value = '';
      if (userSecondNameInput) userSecondNameInput.value = '';
      if (userLastNameInput) userLastNameInput.value = '';
      if (userMatriculaInput) userMatriculaInput.value = '';
      if (userPhoneInput) userPhoneInput.value = '';
      if (userImageFileInput) userImageFileInput.value = '';
      if (userApiUrlInput) userApiUrlInput.value = 'http://localhost:3000/api/mock-external-api/allow';

      if (userAssignAllCheckbox) {
        userAssignAllCheckbox.checked = true;
      }
      if (userDeviceSelect) {
        userDeviceSelect.disabled = true;
        userDeviceSelect.style.opacity = '0.5';
        const defaultDev = devicesList.find(d => d.is_default);
        if (defaultDev) {
          userDeviceSelect.value = defaultDev.id;
        } else if (devicesList.length > 0) {
          userDeviceSelect.value = devicesList[0].id;
        }
      }

      updateUserIdPreview();
    }
  }

  function hideUserForm() {
    userFormContainer.classList.add('hidden');
    userForm.reset();
    userDbIdInput.value = '';
    userIdInput.value = '';
    if (userAcuaticAppIdInput) userAcuaticAppIdInput.value = '';
    if (userIdPreview) userIdPreview.textContent = '';
  }

  btnShowAddUser.addEventListener('click', () => showUserForm());
  btnCancelUser.addEventListener('click', () => hideUserForm());

  userForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const dbId = userDbIdInput.value;
    
    let apiUrlValue = userApiUrlInput ? userApiUrlInput.value.trim() : '';
    if (!apiUrlValue) {
      apiUrlValue = 'http://localhost:3000/api/mock-external-api/allow';
    }

    const firstName = userFirstNameInput ? userFirstNameInput.value.trim() : '';
    const secondName = userSecondNameInput ? userSecondNameInput.value.trim() : '';
    const lastName = userLastNameInput ? userLastNameInput.value.trim() : '';
    const matricula = userMatriculaInput ? userMatriculaInput.value.trim() : '';
    const phone = userPhoneInput ? userPhoneInput.value.trim() : '';
    const imageFile = userImageFileInput ? userImageFileInput.value.trim() : '';
    const acuaticId = userAcuaticAppIdInput && userAcuaticAppIdInput.value ? parseInt(userAcuaticAppIdInput.value, 10) : null;

    const fullName = [firstName, secondName, lastName].filter(Boolean).join(' ').trim() || matricula;
    let finalUserId = matricula || userIdInput.value.trim();

    if (!finalUserId && apiUrlValue && !apiUrlValue.includes('mock-external-api')) {
      finalUserId = extractIdFromUrl(apiUrlValue);
    }

    const assignAll = userAssignAllCheckbox ? userAssignAllCheckbox.checked : true;
    const selectedDeviceId = userDeviceSelect ? parseInt(userDeviceSelect.value, 10) : null;

    const payload = {
      user_id: finalUserId,
      matricula: matricula,
      name: fullName,
      first_name: firstName,
      second_name: secondName,
      last_name: lastName,
      phone: phone,
      image_file: imageFile,
      acuaticapp_id: acuaticId,
      api_url: apiUrlValue,
      assign_all: assignAll,
      device_ids: (!assignAll && selectedDeviceId) ? [selectedDeviceId] : []
    };

    const isEdit = dbId !== '';
    const url = isEdit ? `${API_USERS}/${dbId}` : API_USERS;
    const method = isEdit ? 'PUT' : 'POST';

    try {
      appendConsoleLog('info', `${isEdit ? 'Actualizando' : 'Creando'} alumno "${payload.name}"${payload.user_id ? ` (ID: ${payload.user_id})` : ''}...`);
      const res = await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const responseData = await res.json();

      if (res.ok) {
        const assignedId = (responseData.user && responseData.user.user_id) || payload.user_id;
        appendConsoleLog('success', `Alumno "${payload.name}" (ID: ${assignedId}) guardado en la base de datos local SQLite.`);

        if (responseData.syncSummary) {
          appendConsoleLog(responseData.synced ? 'success' : 'warning', `Biométrico MinMoe: ${responseData.syncSummary}`);
        }

        if (responseData.diagnostics && responseData.diagnostics.length > 0) {
          responseData.diagnostics.forEach(diag => {
            appendConsoleLog('info', `  └─ ${diag}`);
          });
        }

        let alertMessage = `Alumno "${payload.name}" (ID: ${assignedId}) guardado en base de datos local SQLite.`;
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

  // Admin Password Update
  if (btnSaveAdminPassword && settingAdminPassword) {
    btnSaveAdminPassword.addEventListener('click', async () => {
      const newPass = settingAdminPassword.value.trim();
      if (!newPass) {
        alert('Ingrese una nueva contraseña para actualizar.');
        return;
      }

      try {
        const res = await fetch(API_SETTINGS, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ admin_password: newPass })
        });
        if (res.ok) {
          appendConsoleLog('success', 'Contraseña de administrador actualizada correctamente.');
          settingAdminPassword.value = '';
          alert('Contraseña de administrador actualizada con éxito.');
        } else {
          throw new Error('Fallo al actualizar contraseña');
        }
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    });
  }

  // Clear Database Access Logs History (supports filter)
  btnClearDbLogs.addEventListener('click', async () => {
    const selectedDevId = filterLogDevice ? filterLogDevice.value : '';
    const confirmMsg = selectedDevId
      ? '¿Está seguro de borrar los registros de este torniquete en la base de datos?'
      : '¿Está seguro de borrar todo el historial de accesos de la base de datos?';

    if (confirm(confirmMsg)) {
      try {
        let url = API_CLEAR_LOGS;
        if (selectedDevId) url += `?deviceId=${encodeURIComponent(selectedDevId)}`;
        const res = await fetch(url, { method: 'POST' });
        if (res.ok) {
          appendConsoleLog('info', 'Historial de registros limpiado.');
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
            window.location.href = '/login';
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
  // Current User & Session Info
  // ==========================================================================
  async function fetchCurrentUser() {
    try {
      const res = await fetch(API_ME);
      if (res.status === 401) {
        window.location.href = '/login';
        return null;
      }
      const data = await res.json();
      currentUser = data.user || { role: 'admin', name: 'Administrador' };

      if (currentUserName) {
        if (currentUser.role === 'admin') {
          currentUserName.textContent = 'Administrador';
        } else {
          currentUserName.textContent = `${currentUser.name} (Recepcionista)`;
        }
      }

      // Hide or show admin-only elements depending on role
      const adminElements = document.querySelectorAll('.admin-only');
      if (currentUser.role === 'receptionist') {
        adminElements.forEach(el => el.style.display = 'none');
      } else {
        adminElements.forEach(el => el.style.display = '');
        refreshReceptionists();
      }
      return currentUser;
    } catch (err) {
      console.error('Error fetching current user:', err);
      return null;
    }
  }

  // ==========================================================================
  // Receptionists Management (Admin only)
  // ==========================================================================
  async function refreshReceptionists() {
    if (!receptionistsListBody) return;
    try {
      const res = await fetch(API_RECEPTIONISTS);
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (res.status === 403) return;

      receptionistsList = await res.json();
      renderReceptionistsTable();
    } catch (err) {
      console.error('Error fetching receptionists:', err);
    }
  }

  function renderReceptionistsTable() {
    if (!receptionistsListBody) return;
    receptionistsListBody.innerHTML = '';

    if (!receptionistsList || receptionistsList.length === 0) {
      receptionistsListBody.innerHTML = `<tr><td colspan="4" class="text-center text-muted" style="padding: 1rem;">No hay recepcionistas registrados.</td></tr>`;
      return;
    }

    receptionistsList.forEach(rec => {
      const tr = document.createElement('tr');
      const formattedDate = rec.created_at ? new Date(rec.created_at).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '-';

      tr.innerHTML = `
        <td><strong>${escapeHTML(rec.name)}</strong></td>
        <td><span class="badge badge-info" style="font-size:0.75rem;">@${escapeHTML(rec.username)}</span></td>
        <td><span class="text-muted" style="font-size:0.8rem;">${formattedDate}</span></td>
        <td class="actions-col">
          <div class="action-btn-group">
            <button class="btn btn-icon-only edit-receptionist-btn" data-id="${rec.id}" title="Editar Recepcionista">
              <i data-lucide="edit"></i>
            </button>
            <button class="btn btn-icon-only text-danger delete-receptionist-btn" data-id="${rec.id}" title="Eliminar Recepcionista">
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        </td>
      `;
      receptionistsListBody.appendChild(tr);
    });

    if (window.lucide) window.lucide.createIcons();

    // Attach listeners
    document.querySelectorAll('.edit-receptionist-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = parseInt(e.currentTarget.getAttribute('data-id'), 10);
        const rec = receptionistsList.find(r => r.id === id);
        if (rec) showReceptionistForm(rec);
      });
    });

    document.querySelectorAll('.delete-receptionist-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = parseInt(e.currentTarget.getAttribute('data-id'), 10);
        const rec = receptionistsList.find(r => r.id === id);
        if (rec && confirm(`¿Está seguro de eliminar al recepcionista "${rec.name}" (@${rec.username})?`)) {
          try {
            const res = await fetch(`${API_RECEPTIONISTS}/${id}`, { method: 'DELETE' });
            if (res.ok) {
              appendConsoleLog('info', `[RECEPCIONISTA] Recepcionista "${rec.name}" eliminado.`);
              refreshReceptionists();
            } else {
              const data = await res.json();
              alert(data.error || 'Error al eliminar recepcionista');
            }
          } catch (err) {
            alert(`Error: ${err.message}`);
          }
        }
      });
    });
  }

  function showReceptionistForm(rec = null) {
    if (!receptionistFormContainer) return;
    receptionistForm.reset();
    if (rec) {
      receptionistFormTitle.textContent = 'Editar Recepcionista';
      receptionistIdInput.value = rec.id;
      receptionistNameInput.value = rec.name;
      receptionistUsernameInput.value = rec.username;
      receptionistPasswordInput.required = false;
      receptionistConfirmPasswordInput.required = false;
      receptionistPasswordInput.placeholder = 'Dejar vacío para conservar actual';
      receptionistConfirmPasswordInput.placeholder = 'Dejar vacío para conservar actual';
    } else {
      receptionistFormTitle.textContent = 'Dar de Alta Recepcionista';
      receptionistIdInput.value = '';
      receptionistPasswordInput.required = true;
      receptionistConfirmPasswordInput.required = true;
      receptionistPasswordInput.placeholder = '••••••••';
      receptionistConfirmPasswordInput.placeholder = '••••••••';
    }
    receptionistFormContainer.classList.remove('hidden');
    receptionistNameInput.focus();
  }

  function hideReceptionistForm() {
    if (!receptionistFormContainer) return;
    receptionistFormContainer.classList.add('hidden');
    receptionistForm.reset();
    receptionistIdInput.value = '';
  }

  if (btnShowAddReceptionist) {
    btnShowAddReceptionist.addEventListener('click', () => showReceptionistForm());
  }

  if (btnCancelReceptionist) {
    btnCancelReceptionist.addEventListener('click', () => hideReceptionistForm());
  }

  if (receptionistForm) {
    receptionistForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = receptionistIdInput.value;
      const name = receptionistNameInput.value.trim();
      const username = receptionistUsernameInput.value.trim();
      const password = receptionistPasswordInput.value;
      const confirmPassword = receptionistConfirmPasswordInput.value;

      if (password || confirmPassword || !id) {
        if (password !== confirmPassword) {
          alert('La contraseña y la confirmación no coinciden.');
          receptionistConfirmPasswordInput.focus();
          return;
        }
        if (!id && password.length < 4) {
          alert('La contraseña debe tener al menos 4 caracteres.');
          receptionistPasswordInput.focus();
          return;
        }
      }

      const isEdit = id !== '';
      const url = isEdit ? `${API_RECEPTIONISTS}/${id}` : API_RECEPTIONISTS;
      const method = isEdit ? 'PUT' : 'POST';

      const payload = {
        name,
        username,
        password,
        confirm_password: confirmPassword
      };

      try {
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (res.ok) {
          appendConsoleLog('success', `[RECEPCIONISTA] Recepcionista "${name}" guardado correctamente.`);
          alert(`Recepcionista "${name}" guardado con éxito.`);
          hideReceptionistForm();
          refreshReceptionists();
        } else {
          alert(`Error: ${data.error || 'No se pudo guardar el recepcionista'}`);
        }
      } catch (err) {
        alert(`Error de red: ${err.message}`);
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
  fetchCurrentUser();
  connectEventStream();
  refreshDevices();
  refreshUsers();
  refreshLogs();
});


