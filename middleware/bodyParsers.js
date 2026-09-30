const express = require('express');
const xml2js = require('xml2js');
const { logEvent } = require('../utils/logger');

/**
 * Configure the multi-format body parsers on the Express application.
 */
function configureBodyParsers(app) {
  // 0. Capturar el stream crudo para rutas del lector Hikvision (multipart, streams raw, XML o JSON)
  app.use((req, res, next) => {
    const isDeviceRoute = 
      req.path === '/' || 
      req.path === '/event' || 
      req.path === '/api/event' || 
      req.path.startsWith('/device') || 
      req.path.startsWith('/devices') || 
      req.path.startsWith('/api/device') || 
      req.path.startsWith('/api/devices') || 
      req.path.startsWith('/ISAPI') || 
      req.path === '/remoteCheck';

    const contentType = req.headers['content-type'] || '';
    const isMultipart = contentType.includes('multipart/');
    const isUserUpload = req.path.startsWith('/api/users');

    // Capturar si es ruta del lector o multipart (excepto carga de usuarios en panel administrativo)
    if ((isDeviceRoute || (isMultipart && !isUserUpload)) && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        req.rawBody = buf.toString('utf8');
        
        // Intentar parsear automáticamente si es JSON o XML
        if (contentType.includes('application/json')) {
          try { req.body = JSON.parse(req.rawBody); } catch (e) {}
        } else if (isMultipart) {
          // Extraer payload JSON dentro del multipart boundary de Hikvision
          const jsonMatch = req.rawBody.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try { req.body = JSON.parse(jsonMatch[0]); } catch (e) {}
          }
          if (!req.body) {
            const xmlMatch = req.rawBody.match(/<([A-Za-z0-9_]+)[\s\S]*<\/\1>/);
            if (xmlMatch) {
              xml2js.parseString(xmlMatch[0], { explicitArray: false, mergeAttrs: true }, (err, result) => {
                if (!err && result) req.body = result;
                next();
              });
              return;
            }
          }
        } else if (contentType.includes('/xml') || contentType.includes('+xml') || req.rawBody.trim().startsWith('<')) {
          xml2js.parseString(req.rawBody, { explicitArray: false, mergeAttrs: true }, (err, result) => {
            if (!err && result) req.body = result;
            next();
          });
          return;
        }
        next();
      });
      req.on('error', next);
      return;
    }
    next();
  });

  // 1. JSON body parser with raw body verification
  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    }
  }));

  // 2. URL-encoded body parser with raw body verification
  app.use(express.urlencoded({
    extended: true,
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    }
  }));

  // 3. Text/XML body parser to capture raw XML/plain text
  app.use(express.text({
    type: ['*/xml', 'application/xml', 'text/xml', 'text/plain'],
    limit: '10mb'
  }));

  // 4. Middleware to process text bodies and parse XML formally
  app.use((req, res, next) => {
    if (typeof req.body === 'string') {
      req.rawBody = req.body;
      
      const isXml = req.headers['content-type'] && 
                   (req.headers['content-type'].includes('/xml') || req.headers['content-type'].includes('+xml'));
                   
      if (isXml) {
        xml2js.parseString(req.rawBody, { explicitArray: false, mergeAttrs: true }, (err, result) => {
          if (err) {
            logEvent('warning', 'Fallo al procesar el cuerpo XML formal. Se utilizará el extractor fallback.');
          } else {
            req.body = result;
          }
          next();
        });
        return;
      }
    }
    next();
  });
}

module.exports = configureBodyParsers;
