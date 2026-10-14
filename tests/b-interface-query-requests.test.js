'use strict';
const assert = require('assert'), http = require('http'), express = require('express');
const fs = require('fs'), path = require('path'), os = require('os');
const p = require('../proto-conv/b-interface-protocol');
const { Forwarder } = require('../proto-conv/b-interface-forwarder');
const { register } = require('../proto-conv/b-interface-routes');
function call(port, name, role, method, origin) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/proto-conv/b-interface/' + name, method: method || 'GET',
      headers: { 'X-Role': role || '', Origin: origin || 'http://127.0.0.1:' + port } }, res => {
      let text = ''; res.on('data', v => { text += v; }); res.on('end', () => { let data; try { data = JSON.parse(text); } catch (_e) { data = text; } resolve({ status: res.statusCode, data }); });
    }); req.on('error', reject); req.end();
  });
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b-routes-'));
  const samples = [{ deviceId: '1', paraName: 'temperature', value: 25.5 }, { deviceId: '1', paraName: 'door', value: 1 }];
  const alarms = [{ key: 'a1', deviceId: '1', name: 'hot', startedAt: '2026-10-13T04:00:00Z', value: 90, desc: 'hot' }];
  const manager = new Forwarder({ file: path.join(dir, 'config.json'), sourceId: () => 'fixture', collect: async () => ({ samples, alarms }),
    send: async (_url, xml) => { const m = p.message(xml); return p.packet('Response', m.name + '_ACK', m.code + 1, m.name === 'LOGIN' ? '<RightLevel>1</RightLevel>' : '<Result>1</Result>'); } });
  const app = express();
  register(app, manager, (req, res) => { if (!req.get('X-Role')) { res.status(401).json({ ok: false }); return null; } return { role: req.get('X-Role') }; }, {});
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); const port = server.address().port;
  try {
    await manager.configure({ enabled: false, suId: '001122AABBCC', suRId: 'asset&su', suIp: '127.0.0.1', userName: 'USER_PRIVATE', password: 'PASSWORD_PRIVATE',
      devices: [
        { deviceId: '1', bDeviceId: '10001', rId: 'rack&"1', params: [
          { type: 'AI', paraName: 'temperature', signalId: '100200101000' }, { type: 'DI', paraName: 'door', signalId: '100300101000' }, { type: 'ALARM', alarmName: 'hot', signalId: '100220101001' }] },
        { deviceId: '2', bDeviceId: '10101', params: [{ type: 'AI', paraName: 'voltage', signalId: '101200101000' }, { type: 'DI', paraName: 'switch', signalId: '101300101000' }] }
      ] });
    let r = await call(port, 'query-requests', 'viewer');
    assert.strictEqual(r.status, 200, 'saved mappings should generate three complete query requests');
    assert.deepStrictEqual(r.data.requests.map(v => v.type), ['AI', 'DI', 'ALARM']);
    const expectations = { AI: ['GET_AIDATA', 201, 2, 2], DI: ['GET_DIDATA', 301, 2, 2], ALARM: ['GET_ALARM', 601, 1, 1] };
    for (const q of r.data.requests) {
      assert.strictEqual(q.method, 'POST'); assert.strictEqual(q.endpoint, 'http://127.0.0.1:8080/services/SUService');
      const m = p.message(p.unwrap(q.xml, manager.rawConfig().soap));
      assert.deepStrictEqual([m.name, m.code, q.deviceCount, q.pointCount], expectations[q.type]);
      assert.strictEqual(p.value(m.info, 'SURId'), 'asset&su');
      const list = p.children(p.child(m.info, 'DeviceList'), 'Device'); assert.strictEqual(list.length, q.deviceCount);
      assert.strictEqual(list[0].attrs.RId, 'rack&"1');
      const ids = list.reduce((all, d) => all.concat(p.children(d, 'Signal').map(v => v.attrs.Id)), []);
      if (q.type === 'DI') assert.ok(ids.every(id => id.endsWith('FF')), 'DI queries must encode unknown signal state as FF');
      if (q.type === 'AI') assert.deepStrictEqual(ids, ['100200101000', '101200101000']);
      if (q.type === 'ALARM') assert.deepStrictEqual(ids, ['1002201010FF']);
      assert.ok(!q.xml.includes('USER_PRIVATE') && !q.xml.includes('PASSWORD_PRIVATE'));
    }
    assert.strictEqual((await call(port, 'query-requests')).status, 401);
    const beforeMock = JSON.stringify(manager.rawConfig()), beforeLogs = manager.logs().length;
    r = await call(port, 'mock-login-ack', 'viewer'); assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.name, 'LOGIN_ACK'); assert.strictEqual(r.data.code, 102);
    assert.strictEqual(p.ack(p.unwrap(r.data.xml, manager.rawConfig().soap, true), 'LOGIN', 101, '001122AABBCC'), true);
    assert.ok(!r.data.xml.includes('PRIVATE'));
    assert.strictEqual(JSON.stringify(manager.rawConfig()), beforeMock); assert.strictEqual(manager.logs().length, beforeLogs);
    assert.strictEqual(manager.registered, false, 'Generating a mock response must not mark SC registered');
    assert.strictEqual((await call(port, 'mock-login-ack')).status, 401);
    await manager.configure({ soap: { version: '1.2', namespace: 'urn:custom', method: 'exchange', parameter: 'payload', result: 'reply' } });
    r = await call(port, 'mock-login-ack', 'viewer'); assert.strictEqual(p.ack(p.unwrap(r.data.xml, manager.rawConfig().soap, true), 'LOGIN', 101, '001122AABBCC'), true);
    r = await call(port, 'query-requests', 'viewer'); assert.ok(r.data.requests[0].contentType.includes('application/soap+xml'));
    assert.strictEqual(p.message(p.unwrap(r.data.requests[0].xml, manager.rawConfig().soap)).name, 'GET_AIDATA');
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const suPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
    await manager.configure({ enabled: true, host: '127.0.0.1', port: suPort, allowedIps: ['127.0.0.1'], scUrls: ['http://127.0.0.1:9000/SCService'] });
    await manager.cycle();
    const heartbeat = manager.lastHeartbeat;
    for (const type of ['AI', 'DI', 'ALARM']) {
      r = await call(port, 'query-preview/' + type, 'viewer', 'POST'); assert.strictEqual(r.status, 200);
      const m = p.message(p.unwrap(r.data.response, manager.rawConfig().soap, true)); assert.strictEqual(m.name, expectations[type][0] + '_ACK');
      if (type === 'AI') assert.ok(r.data.response.includes('25.5'));
      if (type === 'ALARM') assert.ok(r.data.response.includes('BEGIN'));
    }
    assert.strictEqual(manager.lastHeartbeat, heartbeat, 'local preview must not fake an SC heartbeat');
    assert.strictEqual((await call(port, 'query-preview/OTHER', 'viewer', 'POST')).status, 400);
    assert.strictEqual((await call(port, 'query-preview/AI', 'viewer', 'POST', 'https://evil.test')).status, 403);
    const filtered = p.packet('Request', 'GET_ALARM', 601, p.identity(manager.rawConfig()) + '<DeviceList><Device Id="10101"/></DeviceList>');
    assert.ok(!manager.respond(p.message(filtered)).includes('<TAlarm>'), 'alarm query must respect requested device/point filters');
    await manager.configure({ enabled: false, devices: [] });
    r = await call(port, 'query-requests', 'viewer'); assert.ok(r.data.requests.every(v => v.pointCount === 0));
    await manager.configure({ suId: '' }); assert.strictEqual((await call(port, 'query-requests', 'viewer')).status, 400);
    assert.strictEqual((await call(port, 'mock-login-ack', 'viewer')).status, 400);
    console.log('PASS query request generation: all saved devices by type, FF IDs, XML escaping, SOAP bindings, auth, empty mappings and cached previews');
  } finally { await manager.stop(false); await new Promise(resolve => server.close(resolve)); require('./helpers/b-interface-cleanup')(dir); }
})().catch(e => { console.error(e); process.exitCode = 1; });
