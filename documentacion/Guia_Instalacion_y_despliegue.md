# Guía de Instalación, Despliegue y Puesta en Producción
## Torniquete Link - Servidor de Integración Hikvision MinMoe

Este documento detalla los procedimientos técnicos para desplegar, configurar y entregar el sistema en entornos de producción, garantizando alta disponibilidad, auto-recuperación ante cortes de energía y operación desatendida las 24 horas del día.

---

## 1. Despliegue en Microsoft Windows (Servidor Principal)

!!! abstract Resumen de Arquitectura
    El sistema se ejecuta de forma nativa en Node.js y se registra como un **Servicio de Windows** mediante **NSSM** (*Non-Sucking Service Manager*). Esto permite que el servidor inicie automáticamente al encender la computadora, sin necesidad de que un usuario inicie sesión.

### Requisitos Previos
* Computadora o Laptop con Windows 10, Windows 11 o Windows Server (64 bits).
* **Node.js LTS** (versión 20 o 22 recomendada) instalado desde [nodejs.org](https://nodejs.org).
* **NSSM (64 bits)** descargado desde [nssm.cc](https://nssm.cc/download).

---

### Paso 1: Instalación del Proyecto y Dependencias
1. Copie la carpeta completa del proyecto en una ruta fija del disco local (por ejemplo `C:\Torniquete`).
2. Abra **Símbolo del sistema (CMD)** o **PowerShell** como **Administrador**:
   ```cmd
   cd C:\Torniquete
   npm install --production
   ```
3. Realice un arranque de prueba manual para verificar que no existan errores:
   ```cmd
   node server.js
   ```
4. Verifique que la consola muestre el mensaje de confirmación en el puerto `3000`. Presione `Ctrl + C` para detener el proceso antes de continuar.

---

### Paso 2: Registro del Servicio con NSSM
1. Extraiga el archivo ZIP de NSSM y copie el archivo `nssm.exe` (ubicado dentro de la carpeta `win64`) en `C:\Windows\System32\` o directamente dentro de `C:\Torniquete\`.

!!! tip Ejecución con Privilegios Elevados
    Asegúrese de abrir la terminal como **Administrador** antes de ejecutar comandos de NSSM, de lo contrario Windows bloqueará el registro del servicio arrojando el error *"Acceso denegado"*.

2. Ejecute el asistente de instalación:
   ```cmd
   nssm install TorniqueteService
   ```
3. Se abrirá la ventana gráfica de configuración. Configure las siguientes pestañas:

   * **Pestaña Application:**
     * **Path:** `C:\Program Files\nodejs\node.exe` *(o la ruta donde se instaló Node.js)*
     * **Startup directory:** `C:\Torniquete`
     * **Arguments:** `server.js`

   * **Pestaña Details:**
     * **Display name:** `Torniquete Link Server`
     * **Description:** `Servidor de integracion y control de acceso Hikvision MinMoe`
     * **Startup type:** `Automatic`

   * **Pestaña Exit actions:**
     * **Restart:** `Restart application`
     * **Delay:** `1000 ms` *(reinicia el proceso en 1 segundo ante cualquier cierre inesperado)*

4. Haga clic en el botón **Install service**.

---

### Paso 3: Administración y Control del Servicio

Puede gestionar el servicio mediante los siguientes comandos en CMD como Administrador:

```cmd
# Iniciar el servicio
nssm start TorniqueteService

# Consultar estado en tiempo real
nssm status TorniqueteService

# Detener el servicio
nssm stop TorniqueteService

# Reiniciar el servicio
nssm restart TorniqueteService

# Modificar configuración gráfica
nssm edit TorniqueteService

# Eliminar el servicio
nssm remove TorniqueteService confirm
```

!!! info Monitoreo Visual
    También puede verificar el estado del servicio abriendo la consola de servicios de Windows (`Win + R` $\rightarrow$ `services.msc`) buscando el nombre **Torniquete Link Server**.

<div style="page-break-after: always;"></div>

## 2. Despliegue en Linux (Alternativo: PM2 / Systemd)

Si el servidor final se ejecuta bajo distribuciones Linux (Ubuntu, Debian, AlmaLinux o Raspberry Pi OS):

### Opción A: Gestor de Procesos PM2 (Recomendada)
```bash
# 1. Instalar PM2 de forma global
sudo npm install -g pm2

# 2. Iniciar el servidor
cd /ruta/hacia/Torniquete
pm2 start server.js --name "torniquete-server"

# 3. Guardar estado de la aplicación
pm2 save

# 4. Configurar inicio automático al encender el sistema
pm2 startup
```

### Opción B: Servicio Nativo Systemd
Crear el archivo de configuración `/etc/systemd/system/torniquete.service`:
```ini
[Unit]
Description=Torniquete Link Server - Hikvision Integration
After=network.target

[Service]
Type=simple
User=usuario_sistema
WorkingDirectory=/ruta/hacia/Torniquete
ExecStart=/usr/bin/node /ruta/hacia/Torniquete/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production PORT=3000

[Install]
WantedBy=multi-user.target
```

Habilitar e iniciar el servicio:
```bash
sudo systemctl daemon-reload
sudo systemctl enable torniquete.service
sudo systemctl start torniquete.service
```

---

## 3. Configuración de Red y Dispositivo Hikvision MinMoe

### 3.1. Fijación de IP Estática en la Laptop / Servidor

!!! warning Requisito Indispensable
    La computadora/laptop que actúa como servidor debe tener asignada una **dirección IP estática**. Si la IP cambia por DHCP, el lector MinMoe perderá la comunicación con el servidor y no podrá consultar la validación de acceso.

#### A. Diagnóstico de Red:
1. Abra una terminal (`CMD`) y ejecute:
   ```cmd
   ipconfig
   ```
2. Identifique su adaptador de red activo (*Ethernet* o *Wi-Fi*) y anote los valores:
   * **Puerta de enlace predeterminada:** (ej. `192.168.100.1` o `192.168.1.1`).
   * **Máscara de subred:** `255.255.255.0`.

#### B. Asignación de IP Fija (Método Gráfico):
1. Presione `Win + R`, escriba **`ncpa.cpl`** y presione Enter.
2. Haga clic derecho sobre su adaptador de red y seleccione **Propiedades**.
3. Haga doble clic en **Protocolo de Internet versión 4 (TCP/IPv4)**.
4. Seleccione **"Usar la siguiente dirección IP"** e introduzca:
   * **Dirección IP:** Una IP fija libre en su segmento (ej. `192.168.100.10`).
   * **Máscara de subred:** `255.255.255.0`.
   * **Puerta de enlace predeterminada:** La anotada en el paso anterior (ej. `192.168.100.1`).
5. En la sección DNS, introduzca:
   * **Servidor DNS preferido:** `8.8.8.8` (Google) o `1.1.1.1` (Cloudflare).
   * **Servidor DNS alternativo:** `8.8.4.4`.
6. Haga clic en **Aceptar** en ambas ventanas para guardar.

#### C. Asignación Rápida por Consola (CMD Administrador):
```cmd
netsh interface ipv4 set address name="Ethernet" static 192.168.100.10 255.255.255.0 192.168.100.1
netsh interface ipv4 set dns name="Ethernet" static 8.8.8.8
```

---

### 3.2. Regla de Entrada en el Firewall de Windows
Para garantizar que Windows no bloquee las notificaciones HTTP provenientes del torniquete en el puerto 3000, ejecute en PowerShell como Administrador:
```powershell
New-NetFirewallRule -DisplayName "Torniquete Link Server (3000)" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

---

### 3.3. Configuración en la Interfaz Web del Lector MinMoe (Multi-Dispositivo)

El servidor soporta la conexión simultánea de múltiples terminales MinMoe. Repita este procedimiento en cada lector físico (ej. Lector 1: `192.168.100.8`, Lector 2: `192.168.100.9`, etc.):

1. Ingrese a la IP del lector desde un navegador web (ej. `http://192.168.100.8`) con usuario `admin`.
2. **Configuración de Red $\rightarrow$ Ajustes Avanzados $\rightarrow$ Escucha HTTP (HTTP Listening):**
   * **Dirección IP de Host:** Ingrese la IP estática del servidor central (ej. `192.168.100.10`).
   * **Puerto:** `3000`.
   * **URL de Petición:** `/` (o `/event`).
   * **Tipo de Protocolo:** HTTP.
   * *El servidor mapeará automáticamente cada evento con su torniquete correspondiente detectando la IP de origen.*

3. **Control de Acceso $\rightarrow$ Parámetros:**
   * **Verificación Remota (Remote Check):** Activada.
   * **Tiempo de Espera (Timeout):** Configurar en **2 a 3 segundos** *(evita bloqueos si la red escolar presenta latencia temporal)*.
   * **Modo de Autenticación:** `Rostro o Tarjeta` (o `Cualquiera`).

4. **Control de Acceso $\rightarrow$ Horario y Plan de Vacaciones:**
   * Asigne a la puerta el horario **Todo el día (24/7)** para que la autorización dependa exclusivamente de la decisión en tiempo real del servidor.

---

## 4. Pantalla de Retroalimentación en Modo Kiosco (Feedback)

Para el monitor o Smart TV orientado a los alumnos frente al torniquete:

### Configuración en Windows:
1. Cree un acceso directo en el escritorio con el siguiente destino:
   ```cmd
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --noerrdialogs --disable-infobars http://localhost:3000/feedback.html
   ```
   *(En Microsoft Edge puede usar: `msedge.exe --kiosk http://localhost:3000/feedback.html --edge-kiosk-type=fullscreen`).*

2. **Auto-arranque al encender el equipo:**
   * Presione `Win + R`, escriba **`shell:startup`** y presione Enter.
   * Mueva o copie el acceso directo creado dentro de esta carpeta.

!!! tip Activación de Sonido
    Por políticas de seguridad de los navegadores web modernos, al abrir la pantalla por primera vez haga un clic en cualquier parte de la ventana para habilitar la reproducción automática de los timbres auditivos de acceso (*Tono agudo = Pase*, *Tono grave = Bloqueado*).

---

## 5. Protocolo de Pruebas de Aceptación en Sitio (UAT)

Lista de verificación técnica para validar la correcta operación previa a la entrega final:

| Caso de Prueba | Acción Realizada | Resultado Esperado |
| :--- | :--- | :--- |
| **Prueba 1: Acceso Autorizado** | Escanear credencial o QR de alumno activo | Torniquete abre y da acceso al alumno, monitor muestra banner verde con nombre y reproduce sonido de éxito. |
| **Prueba 2: Acceso Denegado** | Escanear credencial con pago vencido o suspendida | Torniquete bloqueado, monitor muestra banner rojo con motivo devuelto por la API. |
| **Prueba 3: Credencial Desconocida** | Escanear credencial no registrada | Monitor muestra "ID de tarjeta no registrado", torniquete permanece bloqueado. |
| **Prueba 4: Reconocimiento Facial** | Acercar rostro enrolado en el MinMoe | Lectura biométrica instantánea y liberación física de la puerta. |
| **Prueba 5: Múltiples Torniquetes** | Registrar Lector 1 y Lector 2 con permisos diferenciados | Alumno solo puede pasar por los torniquetes que tiene asignados en sus casillas. |
| **Prueba 6: Archivar Alumno** | Marcar alumno como "Archivado" y presentar credencial | El acceso es rechazado de inmediato (*"Alumno Archivado"*); al desarchivar, el acceso se restablece. |
| **Prueba 7: Eliminación Lógica** | Eliminar alumno de la web | Se retira del biométrico y se oculta de la lista, pero se preservan sus registros en `access_logs`. |
| **Prueba 8: Sincronización AcuaticApp** | Ejecutar *"Sincronizar AcuaticApp"* | Importación masiva paginada; reactivación automática de usuarios activos en la plataforma. |
| **Prueba 9: Ping Seguro de Torniquete** | En el panel, presionar "Probar Conexión" | Valida IP y credenciales con `GET /ISAPI/System/deviceInfo` sin accionar puertas físicamente. |
| **Prueba 10: Apertura Manual Asistida** | En la tarjeta del torniquete, presionar "Abrir Puerta" | El relevador físico del torniquete específico se acciona de forma inmediata. |

---

## 6. Mantenimiento, Respaldo y Recuperación

1. **Estructura y Respaldo de Base de Datos:**
   * Toda la configuración, torniquetes (`devices`), recepcionistas (`receptionists`), asignaciones (`user_devices`), padrón de alumnos (`users`) e historiales (`access_logs`) residen en el archivo **`database.sqlite`** en la raíz del proyecto.
   * Se recomienda respaldar este archivo de forma periódica en un medio externo o nube.
   * El sistema incluye mantenimiento automatizado que purga de forma periódica registros antiguos de logs para evitar un crecimiento desmedido del archivo SQLite.

2. **Control de Sesiones y Seguridad:**
   * El sistema utiliza autenticación basada en cookies firmadas (`session_token`) con roles `admin` y `receptionist`.
   * El administrador puede modificar contraseñas de acceso y credenciales de red desde el panel principal.

3. **Separación de Entornos:**
   * **Panel Principal (`/`):** Exclusivo para operación en vivo con alumnos reales.
   * **Entorno de Pruebas (`/pruebas`):** Módulo aislado para pruebas de diagnóstico, simulaciones y credenciales demo.

---

## 7. Integración con APIs Externas de Asistencia (AcuaticApp y Enlaces Escolares)

El sistema soporta validación en tiempo real tanto mediante endpoints individuales como mediante sincronización masiva:

### 7.1. Sincronización Automática con AcuaticApp (API v2)
* **Endpoint de Autenticación:** `POST /api/v2/administration/login` (obtiene Bearer Token institucional).
* **Endpoint de Directorio de Alumnos:** `GET /api/v2/administration/student/getStudents?page=X&per_page=50`.
* **Procesamiento:** El sistema recorre las páginas automáticamente, actualiza o da de alta en SQLite y sincroniza las credenciales biométricas al MinMoe.
* **Reactivación Automática:** Si un alumno fue previamente marcado como eliminado (`is_deleted = 1`) o archivado en el sistema local, la sincronización con AcuaticApp lo reactiva inmediatamente (`is_deleted = 0`).

### 7.2. Endpoints Individuales de Asistencia
Cada alumno puede contar con una URL individual que incluye su token hash seguro:
```text
https://acuaticapp.com/api/attendance/scan/<TOKEN_HASH_DEL_ALUMNO>
```

### 7.3. Modo de Contingencia (Acceso Siempre Permitido)
Si se registra a un alumno dejando el campo de **API URL** en blanco, el sistema le asignará automáticamente:
`http://localhost:3000/api/mock-external-api/allow`
Garantizando que la apertura del torniquete se ejecute sin depender de la conexión a internet.
