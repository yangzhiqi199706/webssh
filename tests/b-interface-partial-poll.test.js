'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { Forwarder } = require('../proto-conv/b-interface-forwarder'), p = require('../proto-conv/b-interface-protocol');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b-forward-'));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  let partial = true, clock = Date.now();
  const manager = new Forwarder({ file: path.join(dir, 'config.json'), sourceId: () => 'fixture', now: () => clock,
    collect: async () => ({ samples: [{ deviceId: '3', paraName: '温度', value: 25.5 }, { deviceId: '4', paraName: '温度', value: partial ? null : 23.9 }], alarms: [],
      errors: partial ? ['设备 4：查询失败'] : [], warnings: partial ? [] : ['设备 4：分组 1 未返回该设备，已改按设备 ID 查询'] }),
    send: async (_url, xml) => { const m = p.message(xml); return p.packet('Response', m.name + '_ACK', m.code + 1, m.name === 'LOGIN' ? '<RightLevel>1</RightLevel>' : '<Result>1</Result>'); } });
  try {
    await manager.configure({ enabled: true, host: '127.0.0.1', suIp: '127.0.0.1', suId: '001122AABBCC', port, userName: 'fixture', password: 'fixture', allowedIps: ['127.0.0.1'], scUrls: ['http://127.0.0.1:9000/SC'],
      devices: [{ deviceId: '3', bDeviceId: '10012', params: [{ type: 'AI', paraName: '温度', signalId: '100123456700' }] }, { deviceId: '4', bDeviceId: '10013', params: [{ type: 'AI', paraName: '温度', signalId: '100123456900' }] }] });
    await manager.cycle();
    assert.deepStrictEqual(manager.samples().map(v => v.value), [25.5, null]);
    assert.ok(manager.logs().some(v => v.name === 'POLL' && v.result === 'partial')); assert.ok(manager.status().lastError.includes('设备 4'));
    partial = false; clock += 10000; await manager.cycle();
    assert.deepStrictEqual(manager.samples().map(v => v.value), [25.5, 23.9]); assert.strictEqual(manager.status().lastError, '');
    assert.ok(manager.logs().some(v => v.name === 'SOURCE' && v.result === 'fallback'));
    clock += 40000; assert.deepStrictEqual(manager.samples(), [], 'stale partial samples still expire');
    console.log('PASS partial polls: healthy values, failed-device nulls, diagnostics, recovery and stale cache guard');
  } finally { await manager.stop(false); require('./helpers/b-interface-cleanup')(dir); }
})().catch(e => { console.error(e); process.exitCode = 1; });
