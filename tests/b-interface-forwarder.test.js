'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const p = require('../proto-conv/b-interface-protocol');
const { Forwarder, validate } = require('../proto-conv/b-interface-forwarder');
const { request } = require('../proto-conv/b-interface-transport');
const fixture = { enabled: true, scUrls: ['http://127.0.0.1:9001/SCService'], allowedIps: ['127.0.0.1'], host: '127.0.0.1', port: 8080,
  suId: '001122AABBCC', suIp: '127.0.0.1', userName: 'u', password: 'secret-fixture', pollSec: 5,
  devices: [{ deviceId: '9', deviceName: 'UPS', bDeviceId: '42601', params: [{ type: 'AI', paraName: 'Voltage', signalId: '426220301000' }, { type: 'DI', paraName: 'Door', signalId: '426330301000' }, { type: 'ALARM', alarmName: '高温告警', signalId: '426220302001' }] }] };
function soapCall(port, cfg, inner) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/services/SUService', method: 'POST', headers: { 'Content-Type': 'text/xml' } }, res => {
      let body = ''; res.on('data', b => { body += b; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }); r.on('error', reject); r.end(p.envelope(inner, cfg.soap));
  });
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b-forward-'));
  const portProbe = http.createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  let now = Date.parse('2026-10-12T12:00:00+08:00'), success = false, recovered = false, source = 'DCIM-A', collectFailure = false;
  const sent = [], collectedSince = [];
  const options = { file: path.join(dir, 'config.json'), now: () => now, sourceId: () => source,
    collect: async (_cfg, since) => { collectedSince.push(since); if (collectFailure) throw new Error('DCIM unavailable'); return ({ samples: [{ deviceId: '9', paraName: 'Voltage', value: 12.5 }, { deviceId: '9', paraName: 'Door', value: 1 }],
      alarms: [{ key: 'alarm-1', deviceId: '9', deviceName: 'UPS', name: '稳定高温事件名', legacyNames: ['高温告警'], startedAt: '2026-10-12T03:59:00Z', recoveredAt: recovered ? '2026-10-12T04:01:00Z' : '', value: 90, desc: '高温告警' }] }); },
    send: async (_url, xml) => { const m = p.message(xml); sent.push(xml); return p.packet('Response', m.name + '_ACK', m.code + 1,
      m.name === 'LOGIN' ? '<RightLevel>1</RightLevel>' : '<Result>' + (success ? '1' : '0') + '</Result>'); } };
  let f = new Forwarder(options);
  try {
    assert.throws(() => validate(Object.assign({}, fixture, { allowedIps: [] })));
    assert.throws(() => validate(Object.assign({}, fixture, { scUrls: ['file:///etc/passwd'] })));
    assert.throws(() => validate(Object.assign({}, fixture, { password: 'a'.repeat(21) })));
    const duplicate = JSON.parse(JSON.stringify(fixture)); duplicate.devices.push(duplicate.devices[0]); assert.throws(() => validate(duplicate));
    await f.configure(Object.assign({}, fixture, { port }));
    assert.ok(!JSON.stringify(f.config()).includes('secret-fixture'));
    await f.cycle(); // LOGIN succeeds, alarm business ACK fails.
    assert.strictEqual(f.status().pending, 1); assert.strictEqual(f.status().registered, true);
    source = 'DCIM-B'; await f.configure({ enabled: false });
    assert.strictEqual(f.status().enabled, false, 'must be able to stop after source switch');
    await assert.rejects(() => f.configure({ enabled: true }), /未确认/);
    source = 'DCIM-A'; await f.configure({ enabled: true });
    assert.ok(!JSON.stringify(f.logs()).includes('secret-fixture'));
    const cfg = f.rawConfig();
    let r = await soapCall(port, cfg, p.packet('Request', 'GET_AIDATA', 201, p.identity(cfg)));
    assert.strictEqual(r.status, 200); assert.ok(p.unwrap(r.body, cfg.soap, true).includes('Value="12.5"'));
    r = await soapCall(port, cfg, p.packet('Request', 'GET_DIDATA', 301, p.identity(cfg)));
    assert.ok(p.unwrap(r.body, cfg.soap, true).includes('426330301001'));
    r = await soapCall(port, cfg, p.packet('Request', 'SET_DODATA', 503, p.identity(cfg)));
    assert.strictEqual(p.value(p.message(p.unwrap(r.body, cfg.soap, true)).info, 'Result'), '0');
    r = await soapCall(port, cfg, p.packet('Request', 'GET_SUINFO', 901, '<SUId>WRONG</SUId>'));
    assert.strictEqual(r.status, 400);
    now += 40000;
    r = await soapCall(port, cfg, p.packet('Request', 'GET_AIDATA', 201, p.identity(cfg)));
    assert.ok(p.unwrap(r.body, cfg.soap, true).includes('Value=""'), 'stale sample must not look fresh');
    await f.stop(false);
    f = new Forwarder(options); assert.strictEqual(f.status().pending, 1, 'pending survives restart');
    success = true; await f.start(); collectFailure = true;
    await assert.rejects(() => f.cycle(), /DCIM unavailable/);
    assert.strictEqual(f.status().pending, 0, 'persisted queue should drain even while current DCIM fetch fails');
    collectFailure = false; await f.cycle();
    assert.strictEqual(f.status().pending, 0);
    assert.ok(sent.some(x => p.message(x).name === 'SEND_HISALARM'));
    assert.ok(collectedSince[collectedSince.length - 1] <= Date.parse('2026-10-12T03:59:00Z'), 'recovery query must include original start of active alarm');
    recovered = true; now = Date.parse('2026-10-12T12:02:00+08:00'); await f.cycle();
    const alarms = sent.filter(x => ['SEND_ALARM', 'SEND_HISALARM'].includes(p.message(x).name));
    const serials = alarms.map(x => p.value(p.children(p.child(p.child(p.message(x).info, 'Values'), 'TAlarmList'), 'TAlarm')[0], 'SerialNo'));
    assert.ok(serials.length >= 3); assert.strictEqual(new Set(serials).size, 1, 'recovery must reuse serial');
    assert.ok(alarms[alarms.length - 1].includes('<AlarmFlag>END</AlarmFlag>'));
    const count = sent.length; await f.cycle(); assert.strictEqual(sent.length, count, 'no duplicate after business ACK');
    source = 'DCIM-B'; await assert.rejects(() => f.cycle(), /数据源/); assert.strictEqual(sent.length, count);
    source = 'DCIM-A';
    await f.configure({ enabled: true, allowedIps: ['192.0.2.10'] });
    r = await soapCall(port, f.rawConfig(), p.packet('Request', 'GET_SUINFO', 901, p.identity(f.rawConfig())));
    assert.strictEqual(r.status, 403);
    const stub = http.createServer((_req, res) => res.end('bad response'));
    await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
    try { await assert.rejects(() => request('http://127.0.0.1:' + stub.address().port, p.login(cfg), cfg)); }
    finally { await new Promise(resolve => stub.close(resolve)); }
    const corruptedFile = path.join(dir, 'corrupted.json');
    fs.writeFileSync(corruptedFile, JSON.stringify({ config: cfg, state: { seq: 1, sourceId: 'DCIM-A', lastPollAt: now, pending: [], events: { broken: { serial: 'bad', ended: false } } } }));
    const corrupt = new Forwarder(Object.assign({}, options, { file: corruptedFile }));
    assert.strictEqual(corrupt.status().enabled, false, 'malformed persisted events must fail closed');
    await f.configure({ allowedIps: ['127.0.0.1'], scUrls: ['http://127.0.0.1:9001/SCService', 'http://127.0.0.1:9002/SCService'], pollSec: 3600, heartbeatSec: 10, retrySec: 60 });
    const loginTargets = []; f.send = async url => { loginTargets.push(url); throw new Error('offline fixture'); };
    await f.cycle(false); const collected = collectedSince.length;
    now += 60000; await f.cycle(false); now += 60000; await f.cycle(false); now += 60000; await f.cycle(false);
    assert.strictEqual(collectedSince.length, collected, 'registration ticks must not shorten configured DCIM polling interval');
    assert.deepStrictEqual(loginTargets.map(url => new URL(url).port), ['9001', '9001', '9001', '9002']);
    console.log('PASS B interface: config bounds, business ACK, persistent retry, BEGIN/END, queries, stale cache, source guard and IP restriction');
  } finally { await f.stop(false); require('./helpers/b-interface-cleanup')(dir); }
})().catch(e => { console.error(e); process.exitCode = 1; });
