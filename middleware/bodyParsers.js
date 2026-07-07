const express = require('express');
const xml2js = require('xml2js');
const { logEvent } = require('../utils/logger');

/**
 * Configure the multi-format body parsers on the Express application.
 */
function configureBodyParsers(app) {
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
