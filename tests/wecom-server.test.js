'use strict';
const assert = require('assert');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const access = require('../lib/access-control');
function request(port, route, method, data, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: method || 'GET', headers: {
      'Content-Type': 'application/json', Cookie: cookie || ''
    } }, res => {
      let text = ''; res.on('data', d => { text += d; }); res.on('end', () => { let body; try { body = JSON.parse(text); } catch (_e) { body = text; } resolve({ status: res.statusCode, body, headers: res.headers }); });
    }); req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined);
  });
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-main-server-'));
  const config = path.join(dir, 'accounts.json');
  fs.writeFileSync(config, JSON.stringify({ version: 2, passwordPolicy: { maxAgeDays: 90 }, loginIpAllowlist: [], temporaryGrants: [],
    users: ['admin', 'viewer'].map(role => ({ id: role, username: role, role, enabled: true, password: access.createPasswordRecord('Fixture-2026!'), passwordChangedAt: new Date().toISOString(), sessionVersion: 1, loginIpAllowlist: [] })) }));
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = Object.assign({}, process.env, { PORT: String(port), WEBSSH_ACCESS_CONTROL_CONFIG: config, WECOM_CONFIG: path.join(dir, 'wecom.json') });
  ['HA_CONFIG', 'SMS_DB_CONFIG', 'SMS_MONITOR_CONFIG', 'SMS_PUSH_CONFIG', 'MODBUS_CONFIG', 'MODBUS_CTRL_CONFIG', 'SNMP_CONFIG', 'IEC104_CONFIG', 'DOCKER_RESTART_CONFIG', 'DOCKER_SCHEDULED_RESTART_CONFIG', 'SERIAL_BRIDGE_CONFIG'].forEach(k => { env[k] = path.join(dir, k + '.json'); });
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    let healthy = false;
    for (let i = 0; i < 150; i++) { try { healthy = (await request(port, '/health')).status === 200; } catch (_e) {} if (healthy) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(healthy, output);
    assert.strictEqual((await request(port, '/api/proto-conv/wecom/config')).status, 401);
    for (const role of ['admin', 'viewer']) {
      const login = await request(port, '/api/auth/login', 'POST', { user: role, password: 'Fixture-2026!' });
      assert.strictEqual(login.status, 200);
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      const result = await request(port, '/api/proto-conv/wecom/config', 'GET', null, cookie);
      assert.strictEqual(result.status, 200); assert.strictEqual(result.body.canManage, role === 'admin');
      const save = await request(port, '/api/proto-conv/wecom/config', 'PUT', { pollIntervalSec: 60 }, cookie);
      assert.strictEqual(save.status, role === 'admin' ? 200 : 403);
      assert.strictEqual((await request(port, '/config/proto-conv-wecom.json', 'GET', null, cookie)).status, 404);
    }
    console.log('PASS actual server account login, WeCom routes, role enforcement and config protection');
  } finally { child.kill(); await exited; fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
