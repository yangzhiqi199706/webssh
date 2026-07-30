'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

[
  './lib/access-control',
  './lib/ops-settings',
  './lib/log-rotation',
  './lib/ssh-idle-timer',
  "app.get('/api/ops-settings'",
  "app.put('/api/ops-settings'",
  "app.post('/api/ops-settings/rotate-logs'",
  "app.get('/api/access-control'",
  "app.put('/api/access-control/password'",
  "code: 'idle_timeout'",
].forEach(function (needle) {
  assert.ok(server.includes(needle), '缺少服务端接入：' + needle);
});

console.log('ops server integration: OK');
