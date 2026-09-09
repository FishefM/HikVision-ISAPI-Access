// middleware/requestLogger.js

/**
 * Middleware para registrar tráfico HTTP relevante en la consola del servidor.
 * Omite recursos estáticos, endpoints de sondeo repetitivo (polling), latidos (heartbeat)
 * y peticiones al endpoint raíz del dispositivo que ya son reportadas por el controlador de accesos.
 */
const requestLogger = (req, res, next) => {
  const url = req.originalUrl || req.url;

  // 1. Omitir recursos estáticos del navegador
  if (url.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|map)$/i)) {
    return next();
  }

  // 2. Omitir conexión SSE persistente
  if (url === '/api/logs-stream') {
    return next();
  }

  // 3. Omitir consultas GET repetitivas del panel (logs, usuarios, ajustes, vistas html)
  if (req.method === 'GET' && (url === '/' || url === '/feedback.html' || url.startsWith('/api/logs') || url.startsWith('/api/users') || url.startsWith('/api/settings'))) {
    return next();
  }

  // 4. Omitir peticiones al endpoint raíz "/" de Hikvision (los eventos reales ya los imprime accessController de forma legible)
  if (req.method === 'POST' && (url === '/' || url.startsWith('/?'))) {
    return next();
  }

  const start = Date.now();
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;

    // Colores según código de estado
    let statusColor = '\x1b[32m'; // Verde 2xx
    if (status >= 300 && status < 400) statusColor = '\x1b[36m'; // Cian 3xx
    if (status >= 400 && status < 500) statusColor = '\x1b[33m'; // Amarillo 4xx
    if (status >= 500) statusColor = '\x1b[31m'; // Rojo 5xx
    const resetColor = '\x1b[0m';
    const grayColor = '\x1b[90m';

    console.log(`${grayColor}[${timestamp}] [PORT-3000]${resetColor} ${req.method} ${url} - ${statusColor}${status}${resetColor} (${duration}ms) | IP: ${clientIp}`);

    // Si ocurre un error (4xx o 5xx) o es una acción de escritura administrativa, registrar payload resumido
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && (status >= 400 || url.startsWith('/api/settings'))) {
      const payload = req.rawBody || (req.body ? (typeof req.body === 'object' ? JSON.stringify(req.body) : req.body) : null);
      if (payload) {
        const cleanPayload = payload.toString().trim();
        const truncated = cleanPayload.length > 200 ? cleanPayload.substring(0, 200) + '...' : cleanPayload;
        console.log(`  ${grayColor}[Payload]${resetColor} ${truncated}`);
      }
    }
  });

  next();
};

module.exports = requestLogger;
