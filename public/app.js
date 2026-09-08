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
        appendConsoleLog(logData.type, logData.message, logData.timestamp.split(' ')[1]);
        
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
  let capturedFaceBlob = null;

  function showUserForm(user = null) {
    userFormContainer.classList.remove('hidden');
    const previewContainer = document.getElementById('face-preview-container');
    const previewImg = document.getElementById('face-preview-img');
    const previewInfo = document.getElementById('face-preview-info');
    const btnDeviceImportFace = document.getElementById('btn-device-import-face');
    capturedFaceBlob = null;
    
    if (user) {
      userFormTitle.textContent = 'Editar Usuario';
      userDbIdInput.value = user.id;
      userIdInput.value = user.user_id;
      userNameInput.value = user.name;
      userApiUrlInput.value = user.api_url;
      if (btnDeviceImportFace) btnDeviceImportFace.classList.remove('hidden');

      // Cargar vista previa de fotografía existente en el sistema si la tiene
      if (previewContainer && previewImg && previewInfo) {
        previewImg.src = `${API_USERS}/${user.id}/photo?t=${Date.now()}`;
        previewImg.onload = () => {
          previewInfo.textContent = 'Fotografía guardada en el sistema (MinMoe / Local)';
          previewContainer.classList.remove('hidden');
        };
        previewImg.onerror = () => {
          previewContainer.classList.add('hidden');
          previewImg.src = '';
        };
      }
    } else {
      userFormTitle.textContent = 'Registrar Nuevo Usuario';
      userForm.reset();
      userDbIdInput.value = '';
      if (btnDeviceImportFace) btnDeviceImportFace.classList.add('hidden');
      if (previewContainer) previewContainer.classList.add('hidden');
      if (previewImg) previewImg.src = '';
    }
  }

  function hideUserForm() {
    userFormContainer.classList.add('hidden');
    userForm.reset();
    userDbIdInput.value = '';
    capturedFaceBlob = null;
    const btnDeviceImportFace = document.getElementById('btn-device-import-face');
    if (btnDeviceImportFace) btnDeviceImportFace.classList.add('hidden');
    const previewContainer = document.getElementById('face-preview-container');
    const previewImg = document.getElementById('face-preview-img');
    if (previewContainer) previewContainer.classList.add('hidden');
    if (previewImg) previewImg.src = '';
  }

  // Helper para recortar a cuadrado 1:1, redimensionar a 600x600 px y comprimir a JPEG < 180KB para Hikvision MinMoe
  async function optimizeFaceImage(file, maxSizeKB = 180, targetDim = 600) {
    if (!file) return null;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          // Hikvision MinMoe requiere estrictamente una imagen cuadrada (relacion de aspecto 1:1).
          // Recortamos proporcionalmente centrado (square crop) para evitar cualquier distorsion en el rostro.
          const sDim = Math.min(img.width, img.height);
          let sx = 0;
          let sy = 0;

          if (img.width > img.height) {
            // Paisaje (horizontal): centrado horizontal
            sx = Math.round((img.width - sDim) / 2);
            sy = 0;
          } else if (img.height > img.width) {
            // Retrato (vertical): en fotos de carnet/identificacion el rostro suele ubicarse en la parte superior-media.
            // Usamos un desplazamiento del 25% del excedente superior para encuadrar frente, ojos y hombros.
            sy = Math.round((img.height - sDim) * 0.25);
            sx = 0;
          }

          const canvas = document.createElement('canvas');
          canvas.width = targetDim;
          canvas.height = targetDim;
          const ctx = canvas.getContext('2d');

          // Rellenar con fondo blanco solido para evitar transparencias o fondos oscuros
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, targetDim, targetDim);

          // Dibujar el recorte cuadrado proporcionalmente en el lienzo cuadrado de targetDim x targetDim
          ctx.drawImage(img, sx, sy, sDim, sDim, 0, 0, targetDim, targetDim);

          let quality = 0.85;
          function attemptCompress() {
            canvas.toBlob((blob) => {
              if (!blob) return reject(new Error('No se pudo procesar la imagen seleccionada.'));
              if (blob.size <= maxSizeKB * 1024 || quality <= 0.3) {
                const optimizedFile = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), {
                  type: 'image/jpeg',
                  lastModified: Date.now()
                });
                resolve(optimizedFile);
              } else {
                quality -= 0.15;
                attemptCompress();
              }
            }, 'image/jpeg', quality);
          }
          attemptCompress();
        };
        img.onerror = () => reject(new Error('El archivo seleccionado no es una imagen válida.'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Error al leer el archivo de fotografía.'));
      reader.readAsDataURL(file);
    });
  }

  // Vista previa de fotografia en el formulario
  const faceInputEl = document.getElementById('user-face-image');
  if (faceInputEl) {
    faceInputEl.addEventListener('change', async () => {
      const previewContainer = document.getElementById('face-preview-container');
      const previewImg = document.getElementById('face-preview-img');
      const previewInfo = document.getElementById('face-preview-info');

      if (faceInputEl.files && faceInputEl.files[0]) {
        try {
          const opt = await optimizeFaceImage(faceInputEl.files[0]);
          if (previewImg && previewContainer && previewInfo) {
            previewImg.src = URL.createObjectURL(opt);
            previewInfo.textContent = `Cuadrada 1:1 (600x600 px) - ${Math.round(opt.size / 1024)} KB (JPEG sRGB)`;
            previewContainer.classList.remove('hidden');
          }
        } catch (_) {}
      } else if (previewContainer) {
        previewContainer.classList.add('hidden');
      }
    });
  }

  // Botón para capturar foto directamente con la cámara del MinMoe
  const btnDeviceCaptureFace = document.getElementById('btn-device-capture-face');
  if (btnDeviceCaptureFace) {
    btnDeviceCaptureFace.addEventListener('click', async () => {
      const originalText = btnDeviceCaptureFace.innerHTML;
      btnDeviceCaptureFace.disabled = true;
      btnDeviceCaptureFace.innerHTML = '<span>Mire a la cámara del MinMoe...</span>';
      appendConsoleLog('info', '[MinMoe Captura] Disparando captura remota... Mire a la cámara del lector biométrico.');

      try {
        const res = await fetch('/api/device/capture-face', { method: 'POST' });
        const data = await res.json();

        if (res.ok && data.success && data.imageBufferBase64) {
          appendConsoleLog('success', `[MinMoe Captura OK] Rostro capturado con éxito (${data.sizeKB} KB).`);
          
          const previewContainer = document.getElementById('face-preview-container');
          const previewImg = document.getElementById('face-preview-img');
          const previewInfo = document.getElementById('face-preview-info');

          if (previewImg && previewContainer && previewInfo) {
            previewImg.src = data.imageBufferBase64;
            previewInfo.textContent = `Capturada con MinMoe: 600x600 px (${data.sizeKB} KB, JPEG)`;
            previewContainer.classList.remove('hidden');
          }

          // Convertir base64 a File para adjuntar en el formulario al guardar
          const byteCharacters = atob(data.imageBufferBase64.split(',')[1]);
          const byteNumbers = new Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
          }
          const byteArray = new Uint8Array(byteNumbers);
          capturedFaceBlob = new File([byteArray], 'minmoe_capture.jpg', { type: 'image/jpeg' });
          alert('Foto capturada exitosamente con el biométrico MinMoe.');
        } else {
          appendConsoleLog('error', `[MinMoe Captura Error] ${data.error || 'No se pudo capturar el rostro.'}`);
          alert(`Error en captura remota:\n${data.error || 'El dispositivo no completó la captura.'}`);
        }
      } catch (err) {
        appendConsoleLog('error', `[MinMoe Captura Error] Excepción de conexión: ${err.message}`);
        alert(`Error de comunicación con el biométrico:\n${err.message}`);
      } finally {
        btnDeviceCaptureFace.disabled = false;
        btnDeviceCaptureFace.innerHTML = originalText;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    });
  }

  // Botón para importar foto ya registrada físicamente en el MinMoe
  const btnDeviceImportFace = document.getElementById('btn-device-import-face');
  if (btnDeviceImportFace) {
    btnDeviceImportFace.addEventListener('click', async () => {
      const dbId = userDbIdInput.value;
      if (!dbId) {
        alert('Debe seleccionar un alumno existente para importar su foto.');
        return;
      }

      const originalText = btnDeviceImportFace.innerHTML;
      btnDeviceImportFace.disabled = true;
      btnDeviceImportFace.innerHTML = '<span>Importando...</span>';
      appendConsoleLog('info', `[MinMoe] Consultando fotografía existente en el biométrico...`);

      try {
        const res = await fetch(`${API_USERS}/${dbId}/import-face`, { method: 'POST' });
        const data = await res.json();

        if (res.ok && data.success) {
          appendConsoleLog('success', `[MinMoe OK] Fotografía importada y guardada localmente (${data.sizeKB} KB).`);
          const previewContainer = document.getElementById('face-preview-container');
          const previewImg = document.getElementById('face-preview-img');
          const previewInfo = document.getElementById('face-preview-info');

          if (previewImg && previewContainer && previewInfo) {
            previewImg.src = `${API_USERS}/${dbId}/photo?t=${Date.now()}`;
            previewInfo.textContent = `Importada desde MinMoe (${data.sizeKB} KB)`;
            previewContainer.classList.remove('hidden');
          }
          alert('Fotografía importada con éxito desde el MinMoe y guardada localmente.');
        } else {
          appendConsoleLog('error', `[MinMoe Error] ${data.error || 'No se encontró fotografía en el lector.'}`);
          alert(`No se pudo importar la foto:\n${data.error || 'No hay fotografía registrada en el MinMoe.'}`);
        }
      } catch (err) {
        appendConsoleLog('error', `[MinMoe Error] Excepción: ${err.message}`);
        alert(`Error de conexión:\n${err.message}`);
      } finally {
        btnDeviceImportFace.disabled = false;
        btnDeviceImportFace.innerHTML = originalText;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    });
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

    // Construct FormData to handle multipart text and files
    const formData = new FormData();
    formData.append('user_id', userIdInput.value.trim());
    formData.append('name', userNameInput.value.trim());
    formData.append('api_url', apiUrlValue);
    
    const faceInput = document.getElementById('user-face-image');
    if (faceInput && faceInput.files && faceInput.files[0]) {
      const originalFile = faceInput.files[0];
      try {
        appendConsoleLog('info', `Optimizando fotografía (${Math.round(originalFile.size / 1024)} KB) a formato cuadrado 1:1 (600x600 px)...`);
        const optimizedFile = await optimizeFaceImage(originalFile);
        formData.append('faceImage', optimizedFile);
        appendConsoleLog('info', `Fotografía optimizada con éxito (${Math.round(optimizedFile.size / 1024)} KB, 600x600 px, JPEG).`);
      } catch (optErr) {
        console.warn('Fallo optimización de imagen:', optErr);
        appendConsoleLog('warning', `No se pudo auto-comprimir foto: ${optErr.message}. Enviando original.`);
        formData.append('faceImage', originalFile);
      }
    } else if (capturedFaceBlob) {
      formData.append('faceImage', capturedFaceBlob);
      appendConsoleLog('info', 'Adjuntando fotografía capturada con la cámara del MinMoe.');
    }

    const isEdit = dbId !== '';
    const url = isEdit ? `${API_USERS}/${dbId}` : API_USERS;
    const method = isEdit ? 'PUT' : 'POST';

    try {
      appendConsoleLog('info', `${isEdit ? 'Actualizando' : 'Creando'} alumno "${userNameInput.value.trim()}" (ID: ${userIdInput.value.trim()})...`);
      const res = await fetch(url, {
        method: method,
        body: formData // Browser sets proper boundary
      });

      const responseData = await res.json();

      if (res.ok) {
        appendConsoleLog('success', `Alumno "${userNameInput.value.trim()}" guardado en la base de datos local SQLite.`);

        if (responseData.syncSummary) {
          appendConsoleLog(responseData.synced ? 'success' : 'warning', `Biométrico MinMoe: ${responseData.syncSummary}`);
        }

        if (responseData.diagnostics && responseData.diagnostics.length > 0) {
          responseData.diagnostics.forEach(diag => {
            appendConsoleLog('info', `  └─ ${diag}`);
          });
        }

        let alertMessage = `Alumno "${userNameInput.value.trim()}" registrado en base de datos local SQLite.`;
        if (responseData.faceSuccess === false) {
          alertMessage += `\n\n[AVISO DEL BIOMETRICO]\nEl alumno fue registrado, pero la fotografia facial no se pudo cargar en el MinMoe.\n\nDetalle:\n${responseData.syncSummary || ''}`;
        } else if (responseData.synced) {
          alertMessage += `\n\n[OK] Sincronizado exitosamente con el biometrico MinMoe (Usuario, Tarjeta y Rostro).`;
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

  function showUserQR(user) {
    // Generate large clean QR code using the public api.qrserver.com
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&margin=10&data=${encodeURIComponent(user.user_id)}`;
    qrModalImage.src = qrUrl;
    qrModalUserInfo.textContent = user.name;
    qrModalUserId.textContent = `ID: ${user.user_id}`;
    qrModal.classList.remove('hidden');
  }

  if (btnCloseQrIcon) {
    btnCloseQrIcon.addEventListener('click', () => {
      qrModal.classList.add('hidden');
    });
  }

  // Close modal when clicking outside the box
  if (qrModal) {
    qrModal.addEventListener('click', (e) => {
      if (e.target === qrModal) {
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
