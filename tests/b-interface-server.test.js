'use strict';
const assert = require('assert'), http = require('http'), net = require('net'), fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const access = require('../lib/access-control');
function call(port, route, method, body, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie || '' } }, res => {
      let text = ''; res.on('data', b => { text += b; }); res.on('end', () => { let data; try { data = JSON.parse(text); } catch (_e) { data = text; } resolve({ status: res.statusCode, data, headers: res.headers }); });
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b-server-')), accounts = path.join(dir, 'accounts.json');
  fs.writeFileSync(accounts, JSON.stringify({ version: 2, passwordPolicy: { maxAgeDays: 90 }, users: ['admin', 'viewer'].map(role => ({ id: role, username: role, role, enabled: true,
    password: access.createPasswordRecord('Fixture-2026!'), passwordChangedAt: new Date().toISOString(), sessionVersion: 1, loginIpAllowlist: [] })), loginIpAllowlist: [], temporaryGrants: [] }));
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = Object.assign({}, process.env, { PORT: String(port), WEBSSH_ACCESS_CONTROL_CONFIG: accounts, B_INTERFACE_CONFIG: path.join(dir, 'b.json') });
  ['HA_CONFIG', 'SMS_DB_CONFIG', 'SMS_MONITOR_CONFIG', 'SMS_PUSH_CONFIG', 'MODBUS_CONFIG', 'MODBUS_CTRL_CONFIG', 'SNMP_CONFIG', 'IEC104_CONFIG', 'DOCKER_RESTART_CONFIG', 'DOCKER_SCHEDULED_RESTART_CONFIG', 'SERIAL_BRIDGE_CONFIG', 'WECOM_CONFIG'].forEach(k => { env[k] = path.join(dir, k + '.json'); });
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; }); const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    let healthy = false;
    for (let n = 0; n < 150; n++) { try { healthy = (await call(port, '/health')).status === 200; } catch (_e) {} if (healthy) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(healthy, output);
    assert.strictEqual((await call(port, '/api/proto-conv/b-interface/config')).status, 401);
    for (const role of ['admin', 'viewer']) {
      const login = await call(port, '/api/auth/login', 'POST', { user: role, password: 'Fixture-2026!' }); assert.strictEqual(login.status, 200, output);
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      const config = await call(port, '/api/proto-conv/b-interface/config', 'GET', null, cookie); assert.strictEqual(config.status, 200); assert.strictEqual(config.data.canManage, role === 'admin');
      assert.strictEqual((await call(port, '/api/proto-conv/b-interface/config', 'PUT', { pollSec: 60 }, cookie)).status, role === 'admin' ? 200 : 403);
      if (role === 'admin') assert.strictEqual((await call(port, '/api/proto-conv/b-interface/config', 'PUT', { suIp: '127.0.0.1', scUrls: ['http://127.0.0.1:8079/services/SCService'] }, cookie)).status, 200);
      const wsdl = await call(port, '/api/proto-conv/b-interface/wsdl/su', 'GET', null, cookie);
      assert.strictEqual(wsdl.status, 200); assert.ok(wsdl.data.includes('<wsdl:definitions'));
      if (role === 'admin') assert.strictEqual((await call(port, '/api/proto-conv/b-interface/config', 'PUT', { suId: '001122AABBCC' }, cookie)).status, 200);
      const queries = await call(port, '/api/proto-conv/b-interface/query-requests', 'GET', null, cookie);
      assert.strictEqual(queries.status, 200); assert.strictEqual(queries.data.requests.length, 3);
      const mockAck = await call(port, '/api/proto-conv/b-interface/mock-login-ack', 'GET', null, cookie);
      assert.strictEqual(mockAck.status, 200); assert.strictEqual(mockAck.data.name, 'LOGIN_ACK');
      const script = await call(port, '/api/proto-conv/b-interface/mock-ack-script', 'GET', null, cookie);
      assert.strictEqual(script.status, 200); assert.strictEqual(script.data.responseBody, '${bAckEnvelope}');
      assert.ok(script.data.script.includes('SEND_HISALARM') && !script.data.script.includes('Fixture-2026!'));
      assert.strictEqual((await call(port, '/api/proto-conv/b-interface/alarm-definitions', 'POST', { deviceIds: ['bad'] }, cookie)).status, 400);
      const binding = await call(port, '/api/proto-conv/b-interface/alarm-definitions-source', 'GET', null, cookie);
      assert.strictEqual(binding.status, 200); assert.ok(/^[a-f0-9]{64}$/.test(binding.data.sourceId));
      const protocol = require('../proto-conv/b-interface-protocol');
      assert.strictEqual(protocol.ack(protocol.unwrap(mockAck.data.xml, require('../proto-conv/b-interface-forwarder').defaults.soap, true), 'LOGIN', 101, '001122AABBCC'), true);
      const queryPreview = await call(port, '/api/proto-conv/b-interface/query-preview/AI', 'POST', {}, cookie);
      assert.strictEqual(queryPreview.status, 200); assert.ok(queryPreview.data.response.includes('invokeResponse'));
      assert.strictEqual((await call(port, '/config/proto-conv-b-interface.json', 'GET', null, cookie)).status, 404);
      assert.strictEqual((await call(port, '/proto-conv/assets/js/pc-b-interface.js', 'GET', null, cookie)).status, 200);
    }
    assert.strictEqual((await call(port, '/api/proto-conv/b-interface/wsdl/su')).status, 401);
    assert.strictEqual((await call(port, '/api/proto-conv/b-interface/query-requests')).status, 401);
    assert.strictEqual((await call(port, '/api/proto-conv/b-interface/mock-login-ack')).status, 401);
    assert.strictEqual((await call(port, '/api/proto-conv/b-interface/mock-ack-script')).status, 401);
    assert.strictEqual((await call(port, '/api/proto-conv/b-interface/alarm-definitions', 'POST', { deviceIds: ['3'] })).status, 401);
    console.log('PASS actual WebSSH server B interface routes, local login, roles, config protection and static entry');
  } finally { child.kill(); await exited; require('./helpers/b-interface-cleanup')(dir); }
})().catch(e => { console.error(e); process.exitCode = 1; });
