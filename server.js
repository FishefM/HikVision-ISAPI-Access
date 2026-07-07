const express = require('express');
const cors = require('cors');
const path = require('path');

const configureBodyParsers = require('./middleware/bodyParsers');
const { authMiddleware } = require('./middleware/auth');
const { logEvent } = require('./utils/logger');

// Import routes
const apiRoutes = require('./routes/api');
const deviceRoutes = require('./routes/device');

// Initialize application
const app = express();
const PORT = process.env.PORT || 3000;

// Enable Cross-Origin Resource Sharing
app.use(cors());

// Configure multi-format custom body parsing middleware
configureBodyParsers(app);

// Enable authorization check middleware
app.use(authMiddleware);

// Mount Hikvision Event receiver routes
app.use('/', deviceRoutes);

// Mount Admin REST API endpoints
app.use('/api', apiRoutes);

// Serve dashboard static assets
app.use(express.static(path.join(__dirname, 'public')));

// Boot server listener
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  SERVIDOR DE CONTROL DE ACCESO INICIADO EN PUERTO ${PORT}`);
  console.log(`  Admin Dashboard: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
  logEvent('info', `Servidor iniciado en puerto ${PORT}`);
});
