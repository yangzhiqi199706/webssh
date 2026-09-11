'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const lib = fs.readFileSync(path.join(root, 'lib', 'docker-scheduled-restart.js'), 'utf8');

assert.ok(server.includes("require('./lib/docker-scheduled-restart')"), '主服务必须加载 Docker 定时重启调度器');
assert.ok(server.includes('docker-scheduled-restart.json'), '必须使用独立的 Docker 定时重启配置文件');
assert.ok(server.includes('docker-scheduled-restart.log'), '必须使用独立的 Docker 定时重启日志文件');
[
  "app.get('/api/docker-scheduled-restart/config'",
  "app.put('/api/docker-scheduled-restart/config'",
  "app.post('/api/docker-scheduled-restart/cancel'",
  "app.post('/api/docker-scheduled-restart/restart-countdown'",
  "app.post('/api/docker-scheduled-restart/trigger'",
].forEach(function (needle) {
  assert.ok(server.includes(needle), '缺少接口：' + needle);
});
assert.ok(server.includes("spawn('systemctl', ['restart', 'docker'])"), '定时任务必须重启 docker 服务');
assert.ok(lib.includes("scheduleCountdown('restart-success')"), '成功重启后必须安排下一轮倒计时');
assert.ok(lib.includes('result.ok && config.enabled'), '只有启用且重启成功才自动续排');
assert.ok(server.includes('value > 10080'), 'API 必须允许 10080 分钟上限');
assert.ok(server.includes('1-10080 分钟'), 'API 校验提示必须反映 10080 分钟上限');

console.log('docker scheduled restart API: passed');
