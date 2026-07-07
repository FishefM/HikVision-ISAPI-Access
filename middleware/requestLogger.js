// middleware/requestLogger.js

/**
 * Middleware to log all incoming HTTP traffic to the server console.
 * This captures everything passing through port 3000 (such as heartbeats,
 * static assets, api calls, and invalid or unauthorized requests)
 * without broadcasting to the frontend SSE client (keeping the page console clean).
 */
const requestLogger = (req, res, next) => {
  const start = Date.now();
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // Use res.on('finish') to log after the request has been fully processed and responded to
  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;

    // Determine color coding for status codes
    let statusColor = '\x1b[32m'; // Green for 2xx
    if (status >= 300 && status < 400) statusColor = '\x1b[36m'; // Cyan for 3xx
    if (status >= 400 && status < 500) statusColor = '\x1b[33m'; // Yellow for 4xx
    if (status >= 500) statusColor = '\x1b[31m'; // Red for 5xx
    const resetColor = '\x1b[0m';
    const grayColor = '\x1b[90m';

    console.log(`${grayColor}[${timestamp}] [PORT-3000]${resetColor} ${req.method} ${req.originalUrl} - ${statusColor}${status}${resetColor} (${duration}ms) | IP: ${clientIp}`);

    // If it is a POST, PUT, or PATCH request, log a snippet of the body payload if available
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const payload = req.rawBody || (req.body ? (typeof req.body === 'object' ? JSON.stringify(req.body) : req.body) : null);
      if (payload) {
        const cleanPayload = payload.toString().trim();
        // Limit printing size to avoid flooding console with large packets
        const maxLen = 300;
        const truncated = cleanPayload.length > maxLen ? cleanPayload.substring(0, maxLen) + '... [TRUNCATED]' : cleanPayload;
        console.log(`  ${grayColor}[Payload]${resetColor} ${truncated}`);
      }
    }
  });

  next();
};

module.exports = requestLogger;
