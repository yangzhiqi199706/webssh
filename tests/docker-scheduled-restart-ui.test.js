'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const packageConfig = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

[
  'Docker 定时重启',
  'dsrEnabled',
  'dsrIntervalMinutes',
  'dsrStatus',
  'dsrLastResult',
  'dsrCancel',
  'dsrRestartCountdown',
  'dsrTrigger',
  'dsrSave',
  '/api/docker-scheduled-restart/config',
  '/api/docker-scheduled-restart/cancel',
  '/api/docker-scheduled-restart/restart-countdown',
  '/api/docker-scheduled-restart/trigger',
].forEach(function (needle) {
  assert.ok(html.includes(needle), '缺少 Docker 定时重启 UI/API：' + needle);
});
assert.ok(/倒计时.*分钟/.test(html), 'UI 必须以分钟为配置单位说明倒计时');
assert.ok(html.includes('1-10080'), 'UI 必须允许 10080 分钟上限');
assert.ok(packageConfig.scripts.test.includes('tests/docker-scheduled-restart.test.js'), 'npm test 未纳入调度器测试');
assert.ok(packageConfig.scripts.test.includes('tests/docker-scheduled-restart-api.test.js'), 'npm test 未纳入 API 测试');
assert.ok(packageConfig.scripts.test.includes('tests/docker-scheduled-restart-ui.test.js'), 'npm test 未纳入 UI 测试');

console.log('docker scheduled restart UI: passed');
