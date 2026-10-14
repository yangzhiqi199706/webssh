'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const { register } = require('../proto-conv/b-interface-routes');
const { Forwarder } = require('../proto-conv/b-interface-forwarder');
const fs = require('fs'), path = require('path'), os = require('os');
function call(port, method, name, role, body, origin) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/proto-conv/b-interface/' + name, method,
      headers: { 'X-Role': role || '', 'Content-Type': 'application/json', Origin: origin || 'http://127.0.0.1:' + port } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', b => { data += b; }); res.on('end', () => { let result; try { result = JSON.parse(data); } catch (_e) { result = data; } resolve({ status: res.statusCode, body: result }); });
    }); r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
  });
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b-routes-'));
  const manager = new Forwarder({ file: path.join(dir, 'config.json'), sourceId: () => 'fixture', collect: async () => ({ samples: [], alarms: [] }) });
  const app = express(); app.use(express.json());
  let definitionReads = 0;
  register(app, manager, (req, res) => { if (!req.get('X-Role')) { res.status(401).json({ ok: false }); return null; } return { role: req.get('X-Role') }; }, {
    loadDevice: async () => ({ params: [] }), inherited: () => [],
    sourceId: () => 'fixture',
    loadAlarmDefinitions: async ids => { definitionReads++; return { deviceIds: ids, candidates: [], review: [], ruleCount: 0 }; }
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); const port = server.address().port;
  try {
    assert.strictEqual((await call(port, 'GET', 'config')).status, 401);
    assert.strictEqual((await call(port, 'PUT', 'config', 'viewer', {})).status, 403);
    assert.strictEqual((await call(port, 'POST', 'poll', 'viewer')).status, 403);
    assert.strictEqual((await call(port, 'PUT', 'config', 'admin', {}, 'https://evil.test')).status, 403);
    let r = await call(port, 'PUT', 'config', 'operator', { password: 'secret-fixture' });
    assert.strictEqual(r.status, 200); assert.ok(!JSON.stringify(r.body).includes('secret-fixture'));
    r = await call(port, 'GET', 'config', 'viewer'); assert.strictEqual(r.body.canManage, false); assert.strictEqual(r.body.config.hasPassword, true);
    assert.strictEqual((await call(port, 'POST', 'preview', 'viewer')).status, 200);
    assert.strictEqual((await call(port, 'GET', 'logs', 'viewer')).status, 200);
    const beforeMock = JSON.stringify([manager.rawConfig(),manager.state]);
    assert.strictEqual((await call(port, 'GET', 'mock-ack-script')).status, 401);
    r = await call(port, 'GET', 'mock-ack-script', 'viewer'); assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.responseBody, '${bAckEnvelope}'); assert.ok(r.body.script.includes('SEND_HISALARM'));
    assert.ok(!r.body.script.includes('secret-fixture'));
    assert.strictEqual(JSON.stringify([manager.rawConfig(),manager.state]),beforeMock,'Generating mock script must not configure/register or modify queue');
    assert.strictEqual((await call(port, 'POST', 'alarm-definitions', null, { deviceIds: ['3'] })).status, 401);
    r = await call(port, 'POST', 'alarm-definitions', 'viewer', { deviceIds: ['3', '3'] }); assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.definitions.deviceIds, ['3']);
    assert.strictEqual((await call(port, 'POST', 'alarm-definitions', 'operator', { deviceIds: ['3;DROP TABLE x'] })).status, 400);
    assert.strictEqual((await call(port, 'POST', 'alarm-definitions', 'operator', { deviceIds: ['3'] }, 'https://evil.test')).status, 403);
    assert.strictEqual(definitionReads, 1, 'Invalid and cross-site queries must not reach the DB');
    assert.strictEqual((await call(port, 'GET', 'alarm-definitions-source')).status, 401);
    assert.strictEqual((await call(port, 'GET', 'alarm-definitions-source', 'viewer')).body.sourceId, 'fixture');
    console.log('PASS B interface management: authorization, same-origin, password redaction, read-only preview and logs');
  } finally { await manager.stop(false); await new Promise(resolve => server.close(resolve)); require('./helpers/b-interface-cleanup')(dir); }
})().catch(e => { console.error(e); process.exitCode = 1; });
