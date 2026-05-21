const express = require('express');
const { attachLocalApiRoutes } = require('../server/local-api-routes');

module.exports = function setupProxy(app) {
  app.use('/api/local', express.json({ limit: '50mb' }));
  app.use('/api/local', express.urlencoded({ extended: true, limit: '50mb' }));
  attachLocalApiRoutes(app, '/api/local');
};

