# Guía Administrativa: Requisitos y Operación del Sistema de Control de Accesos
## Torniquete Link - Servidor de Integración Hikvision MinMoe

!!! tip Audiencia y Objetivo
    Esta guía está dirigida a directores de proyecto, personal administrativo, prefectura y personal de soporte técnico encargados de la infraestructura, administración de alumnos, monitoreo y mantenimiento del sistema de control de accesos.

---

## 1. Requisitos para una Operación Óptima

Para garantizar que los alumnos ingresen de manera fluida y sin retrasos durante los horarios pico de entrada, la institución debe cumplir con los siguientes estándares:

### A. Requisitos de Infraestructura de Red (LAN)

!!! abstract Estabilidad en Red Local
    El lector Hikvision y el servidor local se comunican de forma ininterrumpida. La estabilidad de la red interna es crítica para garantizar tiempos de respuesta menores a 300 ms.

* **Direccionamiento IP Estático (Obligatorio):**
  Tanto la computadora/laptop que opera como servidor como los lectores Hikvision deben contar con **direcciones IP fijas y reservadas** en el router local. Si la IP cambia por DHCP, el lector no podrá enviar las lecturas de los alumnos.
* **Puertos de Red Abiertos (LAN):**
  * **Puerto 3000 (TCP):** Abierto en el servidor local para recibir las peticiones del lector y servir el panel web administrativo y de feedback.
  * **Puerto 80 (HTTP):** Abierto en el lector MinMoe para recibir comandos remotos de apertura de puerta.
* **Conexión por Cable de Red Estructurado (Cat6):**
  No se permite el uso de conexiones Wi-Fi para las terminales de acceso físico ni para el servidor. La fluctuación de señal inalámbrica provoca demoras en la apertura física del torniquete.

---

### B. Requisitos del Servidor Local (Hardware)

El software está altamente optimizado y no requiere servidores de gama alta. Puede ejecutarse en:

* **Computadora / Laptop de Soporte:**
  * Sistema Operativo: Windows 10, Windows 11, Linux (Ubuntu/Debian) o macOS.
  * Procesador: Intel Core i3 (o equivalente) en adelante.
  * Memoria RAM: 4 GB o superior.
  * Espacio en Disco: 10 GB disponibles (la base de datos SQLite es ligera; 100,000 tránsitos ocupan menos de 50 MB).
* **Microcomputadoras:**
  * Compatible con Raspberry Pi 4 (de 2 GB o 4 GB de RAM) corriendo Linux, ideal para operación continua 24/7 con bajo consumo eléctrico.


### C. Requisitos de la API Externa de Asistencia (Sistemas Escolares)

La API externa del portal escolar institucional es la que dictamina si se autoriza o no el paso del alumno. Debe cumplir con:

* **Tiempo de Respuesta:**
  La API escolar debe responder la consulta de verificación en **menos de 800 milisegundos**.

!!! warning Límite Estricto de Latencia (Timeout del Hardware)
    Si la API institucional tarda más de 1.5 segundos (1500 ms) en responder, el lector físico MinMoe entrará en timeout y cancelará la solicitud por seguridad, bloqueando el torniquete.

* **Protocolo Seguro:** Conexión HTTPS para el resguardo y privacidad de los identificadores de los alumnos en tránsito.
* **Formato de Respuesta:** Cargas JSON estructuradas con códigos HTTP estándar (`200 OK` para accesos autorizados, y respuestas con `{ "message": "Motivo del rechazo" }` para casos denegados o cuotas vencidas).

---

### D. Pantalla de Retroalimentación Visual y Auditiva (Feedback)

* **Ubicación:** Monitor de PC, Smart TV o tablet montada junto al torniquete y visible para el alumno.
* **Acceso:** Navegador moderno (Google Chrome o Microsoft Edge) abierto en:
  * En la misma computadora del servidor: `http://localhost:3000/feedback.html`
  * Desde otra pantalla/dispositivo en la red: `http://<IP_DEL_SERVIDOR>:3000/feedback.html`
* **Audio Activo:** Es indispensable habilitar el audio en el navegador para que el alumno y el personal de prefectura escuchen los timbres acústicos distintivos (*Tono agudo = Acceso permitido*, *Tono grave = Acceso denegado*).

<div style="page-break-after: always;"></div>

## 2. Operación y Administración Diaria del Sistema

!!! info Direcciones de Acceso y Credenciales
    * **En la computadora donde está instalado el programa:** Ingrese en el navegador a **`http://localhost:3000`**.
    * **Desde otra computadora o laptop en la misma red:** Ingrese a **`http://<IP_ESTATICA_DEL_SERVIDOR>:3000`** (por ejemplo `http://192.168.100.10:3000`).
    * **Contraseña inicial por defecto:** La contraseña de acceso al panel es **`admin123`**. Por seguridad, se recomienda cambiarla inmediatamente tras el primer inicio de sesión.

---

### A. Perfiles y Roles de Usuario (Seguridad y Privilegios)

El sistema cuenta con control de accesos basado en roles (**RBAC**) para separar las tareas de recepción diaria de la configuración técnica crítica:

| Rol | Privilegios y Alcance | Uso Recomendado |
| :--- | :--- | :--- |
| **Administrador** | **Acceso total:** Puede agregar y configurar torniquetes, cambiar contraseñas de red e ISAPI, gestionar cuentas de recepcionistas, purgar historiales de logs y sincronizar con AcuaticApp. | Directores de proyecto, administradores generales y personal técnico de TI. |
| **Recepcionista** | **Operación de campo:** Puede buscar alumnos, dar de alta y editar datos de alumnos, archivar o restaurar accesos, emitir credenciales QR, ver el monitor de accesos en vivo y realizar aperturas manuales asistidas. *No tiene acceso a eliminar torniquetes ni cambiar contraseñas del sistema.* | Personal de recepción, prefectura, torniqueteros y guardias de entrada. |

#### Gestión de Cuentas de Recepcionistas (Solo Administrador):
1. Inicie sesión como Administrador en `http://localhost:3000`.
2. En la columna derecha, localice la sección **Recepcionistas**.
3. Haga clic en **Agregar Recepcionista**, ingrese su Nombre, Usuario y Contraseña, y guarde. El recepcionista podrá iniciar sesión desde `/login`.

---

### B. Gestión de Múltiples Torniquetes (MinMoe)

El sistema permite controlar y supervisar de forma centralizada múltiples terminales físicas de acceso (ejemplo: *Torniquete Entrada 1*, *Torniquete Entrada 2*, *Alberca*, *Acceso Empleados*):

1. **Registrar un Nuevo Torniquete:**
   * En la sección **Torniquetes / MinMoe**, haga clic en **Agregar Torniquete**.
   * Ingrese el Nombre identificativo, la Dirección IP local, Puerto ISAPI (80), Canal de Puerta (1) y las credenciales del dispositivo (`admin` y su contraseña).
   * **Contraseña obligatoria:** Para nuevos registros, la contraseña es obligatoria para garantizar la autenticación ISAPI.
2. **Probar Conexión Segura (Ping ISAPI):**
   * Antes de guardar o en cualquier momento, puede presionar el botón **"Probar Conexión"**.
   * El servidor realiza una consulta de diagnóstico no intrusiva (`GET /ISAPI/System/deviceInfo`) que **valida la IP y la contraseña sin abrir la puerta física**.
3. **Torniquete Predeterminado (Default Device):**
   * Permite marcar un torniquete como principal. Las aperturas rápidas generales de recepción y los eventos con origen no especificado se canalizan automáticamente a este dispositivo.

---

### C. Gestión de Alumnos, Credenciales y Estados de Acceso

Desde la tabla central de **Alumnos Registrados**, el personal puede gestionar el padrón de forma ágil:

#### 1. Alta y Edición de Alumnos:
* Ingrese el Nombre Completo (o Nombres y Apellidos por separado), Matrícula y Teléfono.
* **Attendance Token (Token de Acceso Multihivesoft / AcuaticApp):**
  * Al ingresar o sincronizar el token del alumno (clave única alfanumérica de 64 caracteres), el sistema auto-completa la **API URL de Verificación** apuntando a `https://multihivesoft.com/api/attendance/scan/<token>`.
* **Asignación de Torniquetes:** Marque las casillas de los torniquetes por los cuales el alumno tiene permitido el paso (o marque *Seleccionar todos*).
* **Campo API URL Relacionada:**
  * Si cuenta con una URL de validación externa personalizada, péguela en el campo correspondiente.
  * Si se deja en blanco, el sistema le asignará automáticamente validación interna garantizada (`allow`), otorgando acceso permanente.
<div id="seccion-sincronizar-minmoe"></div>

* **Botón "Registrar en dispositivos MinMoe" (Enrolamiento Directo al Hardware):**
  * En la ventana de edición de datos del alumno, dispone del botón azul **"Registrar en dispositivos MinMoe"**.
  * Al presionarlo, el sistema toma la matrícula y nombre del alumno y los graba de forma instantánea vía ISAPI únicamente en los torniquetes que tenga marcados en **Torniquetes Permitidos**.
  * Ideal para enrolar o actualizar a un alumno específico en el hardware sin tener que ejecutar una sincronización masiva general.

---

#### 2. Estados del Alumno (Activo, Con Token, Sin Token y Archivado):
Para mantener la integridad de los registros de asistencia sin borrar historiales:
**Filtros en Tabla:** Puede filtrar rápidamente entre:
  * *"Alumnos Activos"*: Todo el padrón con acceso vigente.
  * *"Con Token de Acceso"*: Alumnos que ya cuentan con su token institucional de AcuaticApp.
  * *"Sin Token de Acceso"*: Alumnos registrados localmente o que requieren asignación de credencial.
  * *"Alumnos Archivados"*: Alumnos con acceso suspendido temporalmente.
  * *"Todos los Alumnos"*: Padrón completo sin exclusiones.

**Archivar Alumno (Acción Temporal):**
  * Al hacer clic en el botón amarillo **Archivar**, el alumno conserva su perfil e historial en la base de datos, pero **se le revoca el acceso físico en los torniquetes** (su tarjeta se retira del MinMoe y cualquier intento marcará *"Acceso Denegado / Alumno Archivado"*).
  * Puede reactivarse en cualquier momento con un clic en **Desarchivar**.

**Eliminar Alumno (*Soft-Delete* de Seguridad):**
  * Al presionar el botón rojo **Eliminar**, el sistema retira al alumno del hardware MinMoe y lo oculta de la interfaz web, pero **preserva sus registros históricos de auditoría** en la base de datos.

!!! Info 3. Búsqueda Rápida en Tiempo Real:
    Escriba en la barra de búsqueda para filtrar instantáneamente por Nombre, Matrícula, Teléfono o ID de AcuaticApp.

---

### D. Sincronización Automática con AcuaticApp (API v2 Multihivesoft)

El sistema cuenta con un motor de integración bidireccional diseñado para mantener sincronizados los registros del torniquete con la plataforma institucional escolar:

#### 1. Sincronización Automática en Segundo Plano (Cada 24 Horas):
* **Completamente Autónoma:** El servidor ejecuta una tarea interna programada que se dispara **cada 24 horas**.
* **Detección Continua de Alumnos Nuevos:** Consulta la API de producción (`https://multihivesoft.com`), detecta alumnos recién inscritos y los da de alta automáticamente en la base de datos local SQLite y en los torniquetes.
* **Actualización No Destructiva:** No borra ni altera el historial de los alumnos existentes; únicamente actualiza tokens de asistencia o cambios de nombre.
* **Mecanismo de Resiliencia (Reintentos y Fallback de Red):**
  * Ante lentitud de red o saturación temporal en la nube, el sistema ejecuta hasta **3 reintentos automáticos** de 20 segundos con pausas progresivas.
  * Forzado de IPv4 y caché de DNS público para evitar interrupciones por resolución de nombres.
* **Reactivación Automática:** Si un alumno fue previamente archivado o marcado como inactivo localmente pero continúa matriculado en AcuaticApp, el ciclo automático lo reactiva con acceso vigente.

#### 2. Sincronización Manual Inmediata desde el Panel Web:
Si necesita reflejar altas inmediatas de alumnos antes del ciclo diario automático:
1. En el panel principal, presione el botón **"Sincronizar AcuaticApp"**.
2. Se desplegará el menú de credenciales. Las credenciales de producción (`ACUATICAPP_USER`, `ACUATICAPP_PASSWORD` y `ACUATICAPP_BASE_URL`) se toman directamente de su archivo de configuración `.env`.
3. *(Opcional)* Si desea realizar un reemplazo integral desde cero, marque la casilla **"Limpiar alumnos previos antes de sincronizar"** (la limpieza local se ejecuta únicamente después de haber descargado exitosamente todo el catálogo en memoria, protegiendo sus datos ante cualquier fallo de red).
4. Presione **"Sincronizar"**. El progreso se muestra en tiempo real en la consola inferior con el número exacto de alumnos procesados, nuevos y actualizados.

---

### E. Flujo de Enrolamiento Biométrico (Rostro o Huella)

Para habilitar el acceso biométrico (reconocimiento facial o huella dactilar) a un alumno:

#### Paso 1: Alta previa en el Panel Web
Registre al alumno en el panel web (`http://localhost:3000`), sincronícelo desde AcuaticApp o utilice el botón [**"Registrar en dispositivos MinMoe"**](#seccion-sincronizar-minmoe). El sistema creará el registro y grabará automáticamente su **Nombre** e **ID de Usuario** en la memoria del MinMoe para que el dispositivo ya reconozca al alumno antes de asociarle su biometría facial.

#### Paso 2: Captura Biométrica en el Dispositivo
* **Método 1: Enrolamiento directo en la pantalla del lector MinMoe (Recomendado):**
  1. Toque la pantalla del MinMoe e ingrese al menú de administración con su clave de administrador.
  2. Seleccione **Usuario (User)** $\rightarrow$ **Gestionar Usuario (Manage User)**.
  3. Busque y seleccione al alumno por su **ID** o **Nombre**.
  4. **Para Rostro:** Seleccione *Rostro (Face)* y pida al alumno colocarse frente a la cámara dentro del recuadro verde hasta que el dispositivo confirme la captura.
  5. **Para Huella:** Seleccione *Huella (Fingerprint)* y pida al alumno colocar y levantar el dedo en el sensor 3 veces consecutivas.
  6. Presione **Guardar**.

* **Método 2: Carga fotográfica desde la Interfaz Web del MinMoe:**
  1. Ingrese en el navegador a la IP del lector (ej. `http://192.168.100.8`) con usuario `admin`.
  2. Diríjase a **Gestión de Personas (Person)** y seleccione al alumno por su ID.
  3. En la sección de Rostro, cargue una fotografía frontal nítida en formato JPEG (fondo claro, buena iluminación, sin lentes oscuros ni cubrebocas).
  4. Guarde los cambios.

---

### F. Monitoreo en Tiempo Real y Diagnóstico
* **Historial en Vivo (SSE):** La tabla de accesos se actualiza automáticamente mediante eventos en tiempo real (*Server-Sent Events*), registrando fecha, hora exacta, alumno, torniquete por el que ingresó, credencial utilizada (Rostro, Huella, Tarjeta o QR) y resultado de la validación.
* **Consola de Sistema:** La consola inferior en el panel muestra en vivo el tráfico entre los torniquetes, la base de datos y los servicios externos.

---

### G. Apertura Manual y Control de Emergencia
En caso de requerir la apertura inmediata de un torniquete:
* **Desde el Panel Principal (`/`):** En cada tarjeta de torniquete de la columna izquierda, haga clic en el botón azul **"Abrir Puerta"**.
* **Desde la Vista de Pruebas (`/pruebas`):** Puede emitir comandos de apertura manual y realizar escaneos de prueba con credenciales demo (1001, 1002, 1003) para verificar la mecánica del torniquete sin afectar las estadísticas escolares reales.

---

## 3. Políticas de Seguridad, Respaldo y Mantenimiento

### A. Respaldo Periódico de la Base de Datos
* Toda la información del padrón de alumnos, torniquetes, recepcionistas e historial de accesos se almacena en el archivo **`database.sqlite`** en la raíz de la aplicación.
* **Recomendación:** Copiar semanalmente este archivo a una memoria USB o almacenamiento seguro en la nube. Ante cualquier eventualidad o reemplazo de computadora, basta con restaurar este archivo para reactivar el sistema en 5 minutos.

<div style="page-break-after: always;"></div>

### B. Modo de Contingencia y Alumnos sin URL (Acceso Siempre Permitido)

!!! success Operación Autónoma Garantizada
    Si se registra a un alumno o personal administrativo dejando el campo de **API URL** en blanco, el sistema le asignará de forma automática una URL interna de validación garantizada (`allow`).

* **Beneficio Operativo:** Esto asegura que dicho usuario tenga **acceso y apertura de torniquete garantizados en todo momento**, permitiendo mantener la operación escolar fluida incluso ante caídas del servicio de internet o cuando el alumno aún no esté dado de alta en la plataforma web escolar.

---

### C. Diagnóstico de Acceso: Alumnos Fuera de Horario vs. Acceso Concedido

Para evitar confusiones en recepción respecto a por qué el torniquete no abre a un alumno registrado:

| Respuesta en Pantalla / Log | Causa Operativa | Acción del Personal de Recepción |
| :--- | :--- | :--- |
| **`Acceso correcto` (HTTP 200)** | El alumno tiene horario y clase activa en ese momento y está al corriente. | El torniquete abre de inmediato y se reproduce el tono acústico verde de éxito en la pantalla de feedback. |
| **`Fuera de horario o alumno sin grupo` (HTTP 404)** | El alumno está debidamente registrado en AcuaticApp y cuenta con token válido, pero **no tiene clase asignada en el bloque horario actual**. | El sistema deniega el paso por política de horario de la escuela. La recepcionista puede verificar su horario en AcuaticApp o autorizar una apertura manual de cortesía si corresponde. |
| **`Token inválido o alumno no encontrado` (HTTP 404)** | El alumno no tiene token o fue dado de baja en la plataforma escolar. | Realizar una sincronización con AcuaticApp para actualizar su token o verificar su estatus administrativo. |

---

### D. Lista de Chequeo Rápida ante Pérdida de Conexión de un Torniquete

Si una tarjeta de torniquete aparece desconectada o no responde a los comandos de apertura:
1. **Comprobar Alimentación:** Verificar que el lector MinMoe tenga encendida la pantalla y los LEDs indicadores de red traseros.
2. **Ping ISAPI desde el Panel:** Presione el botón **"Probar Conexión"** en la tarjeta del torniquete. Si responde con error:
   * Verificar que la laptop/servidor y el MinMoe estén en el mismo segmento de red local (ej. `192.168.100.x`).
   * Verificar que no exista conflicto de IP duplicada con otro equipo o switch.
3. **Re-sincronizar el Alumno:** Si el torniquete sí responde a la apertura manual pero no reconoce a un alumno específico, abra el alumno en el panel y presione **"Registrar en dispositivos MinMoe"**.

<div style="page-break-after: always;"></div>

### E. Cambio de Contraseña Administrativa

!!! danger Seguridad del Sistema
    El sistema se entrega configurado con la contraseña de administrador predeterminada **`admin123`**. Se recomienda enfáticamente reemplazarla por una clave institucional segura para evitar accesos no autorizados a la configuración y al padrón de alumnos.

**Procedimiento para cambiar la contraseña:**
1. Inicie sesión como Administrador en el Panel Principal (`http://localhost:3000`).
2. En la columna izquierda, localice el panel **Seguridad del Panel**.
3. Ingrese su nueva contraseña en el campo **Nueva Contraseña de Administrador (Acceso al Panel)**.
4. Haga clic en **Actualizar**. La nueva clave se actualizará de inmediato en la base de datos.
