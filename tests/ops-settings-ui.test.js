'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const packageConfig = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

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
  'opsSettings.writeJsonThenCommit',
  'const sshIdleSessionReconfigurers = new Set();',
  'function refreshSshIdleTimers()',
  'sshIdleSessionReconfigurers.add(reconfigureIdleTimer);',
  'refreshSshIdleTimers();',
  'const accessConfigLoad = accessControl.loadConfig(fs, ACCESS_CONTROL_PATH);',
  'if (accessConfigLoadError || !accessControl.authenticate(accessConfig, user, pwd, todayPassword()))',
].forEach(function (needle) {
  assert.ok(server.includes(needle), '缺少服务端接入：' + needle);
});

const rotationStart = server.indexOf('const result = await rotateLogs(');
const rotationMerge = server.indexOf('const nextOpsSettings = opsSettings.recordLogRotation(currentOpsSettings,', rotationStart);
assert.ok(rotationStart >= 0 && rotationMerge > rotationStart,
  '日志轮转完成后必须基于最新运维设置合并轮转状态');

[
  'opsLogRotateEnabled',
  'opsLogRetentionDays',
  'opsRotateNow',
  'opsIdleEnabled',
  'opsIdleMinutes',
  'accessCurrentPassword',
  'accessNewPassword',
  'accessConfirmPassword',
  '/api/ops-settings',
  '/api/access-control/password',
].forEach(function (needle) {
  assert.ok(html.includes(needle), '缺少运维 UI 或 API 调用：' + needle);
});

[
  'tests/access-control.test.js',
  'tests/ops-settings.test.js',
  'tests/log-rotation.test.js',
  'tests/ssh-idle-timer.test.js',
  'tests/ops-settings-ui.test.js',
].forEach(function (needle) {
  assert.ok(packageConfig.scripts.test.includes(needle), 'npm test 未纳入：' + needle);
});

console.log('ops settings integration: OK');
