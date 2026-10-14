'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const state = fs.readFileSync(path.join(root, 'lib', 'sms-monitor-state.js'), 'utf8');

[
  "app.get('/api/sms/db/status'",
  "app.post('/api/sms/db/connect'",
  "app.post('/api/sms/db/disconnect'",
  "app.get('/api/sms/monitor/config'",
  "app.put('/api/sms/monitor/config'",
  "app.get('/api/sms/monitor/recent'",
  "app.get('/api/sms/monitor/cancels'",
  "app.post('/api/sms/monitor/clear'",
  "app.get('/api/sms/push/config'",
  "app.put('/api/sms/push/config'",
  "app.post('/api/sms/push/send'",
  "app.get('/api/sms/push/history'",
  "app.post('/api/sms/push/refresh-results'",
  "app.get('/api/sms/push/sim-status'",
  "app.post('/api/sms/push/clear-history'",
  "app.get('/api/sms/scheduled/config'",
  "app.get('/api/sms/scheduled/recent'",
  "app.post('/api/sms/scheduled/trigger'",
].forEach(function (needle) {
  assert.ok(server.includes(needle), '缺少目标路由：' + needle);
  const start = server.indexOf(needle);
  const nextRoute = server.indexOf('\n  app.', start + needle.length);
  const block = server.slice(start, nextRoute >= 0 ? nextRoute : server.length);
  assert.ok(block.includes('requireSettingsAuth(req, res)'), '短信猫路由缺少登录门禁：' + needle);
});

assert.ok(server.includes("requireSettingsAuth(req, res)"), '短信猫路由必须使用主壳登录门禁');
assert.ok(state.includes('CancelTime = ? AND id > ?'), '解除查询必须使用时间 + id 复合游标');
assert.ok(state.includes('ORDER BY CancelTime ASC, id ASC'), '解除查询必须按时间和 id 稳定排序');
assert.ok(server.includes("require('./lib/sms-monitor-state')"), '监测服务必须复用状态工具');
assert.ok(server.includes('MAX_PENDING_ALARMS'), 'pending 队列必须有固定上限');
assert.ok(server.includes("app.use('/config', function"), '配置目录必须禁止静态下载');

console.log('sms monitor API auth: passed');
