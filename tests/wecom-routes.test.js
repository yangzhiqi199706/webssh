'use strict';
const assert = require('assert');
const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Forwarder } = require('../proto-conv/wecom-forwarder');
const { register } = require('../proto-conv/wecom-routes');
function request(port, method, route, body, role, origin) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: '/api/proto-conv/wecom/' + route,
      headers: { 'Content-Type': 'application/json', 'X-Test-Role': role || '', Origin: origin || 'http://127.0.0.1:' + port } }, res => {
      let text = ''; res.on('data', d => { text += d; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-routes-'));
  let sent = 0;
  const manager = new Forwarder({ file: path.join(dir, 'state.json'), sourceId: () => 'local', collect: async () => ({ live: [], history: [] }), send: async () => { sent++; } });
  const app = express(); app.use(express.json());
  register(app, manager, (req, res) => { const role = req.get('X-Test-Role'); if (!role) { res.status(401).json({ ok: false }); return null; } return { role }; });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  try {
    assert.strictEqual((await request(port, 'GET', 'config')).status, 401);
    assert.strictEqual((await request(port, 'PUT', 'config', {}, 'viewer')).status, 403);
    assert.strictEqual((await request(port, 'POST', 'test', {}, 'viewer')).status, 403);
    assert.strictEqual((await request(port, 'POST', 'credentials', {}, 'viewer')).status, 403);
    assert.strictEqual((await request(port, 'POST', 'credentials', {}, 'admin', 'https://evil.test')).status, 403);
    assert.strictEqual((await request(port, 'PUT', 'config', {}, 'admin', 'https://evil.test')).status, 403);
    assert.strictEqual((await request(port, 'PUT', 'config', {}, 'admin', 'https://127.0.0.1:' + port)).status, 403);
    assert.strictEqual((await request(port, 'PUT', 'config', { webhook: 'http://127.0.0.1/' }, 'admin')).status, 400);
    let response = await request(port, 'PUT', 'config', { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-fixture' }, 'operator');
    assert.strictEqual(response.status, 200); assert.ok(!JSON.stringify(response).includes('secret-fixture'));
    response = await request(port, 'GET', 'config', null, 'viewer'); assert.strictEqual(response.body.canManage, false);
    assert.strictEqual((await request(port, 'POST', 'preview', {}, 'viewer')).status, 200); assert.strictEqual(sent, 0);
    assert.strictEqual((await request(port, 'POST', 'test', {}, 'admin')).status, 200); assert.strictEqual(sent, 1);
    assert.strictEqual((await request(port, 'GET', 'logs', null, 'viewer')).body.logs[0].type, 'test');
    assert.strictEqual((await request(port, 'POST', 'test', {}, 'admin')).status, 400); assert.strictEqual(sent, 1);
    manager.appClient = { credentials: async () => {} };
    response = await request(port, 'PUT', 'config', { channel: 'application', application: { corpId: 'ww123', agentId: '10001', secret: 'app-secret', toUser: 'user1' } }, 'admin');
    assert.strictEqual(response.status, 200); assert.ok(!JSON.stringify(response).includes('app-secret'));
    assert.strictEqual((await request(port, 'POST', 'credentials', {}, 'operator')).status, 200);
    console.log('PASS wecom HTTP authorization, same-origin, redaction, preview, test and logs');
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
