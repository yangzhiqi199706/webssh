'use strict';
const assert = require('assert'), http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const p = require('../proto-conv/b-interface-protocol');
const { Forwarder } = require('../proto-conv/b-interface-forwarder');
const { request } = require('../proto-conv/b-interface-transport');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b-soap-http-'));
  const received = [], cfg = { soap: { version: '1.2', namespace: 'urn:fixture', method: 'invoke', parameter: 'xmlData', result: 'invokeReturn', action: '' }, timeoutMs: 1000 };
  const sc = http.createServer((req, res) => {
    if (req.url === '/timeout') return;
    let text = ''; req.on('data', b => { text += b; }); req.on('end', () => {
      assert.ok(req.headers['content-type'].includes('application/soap+xml'));
      const m = p.message(p.unwrap(text, cfg.soap)); received.push(m);
      const reply = p.packet('Response', m.name + '_ACK', m.code + 1, m.name === 'LOGIN' ? '<RightLevel>1</RightLevel>' : '<Result>1</Result>');
      res.setHeader('Connection', 'close'); res.end(p.envelope(reply, cfg.soap, true));
    });
  });
  await new Promise(resolve => sc.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const manager = new Forwarder({ file: path.join(dir, 'config.json'), sourceId: () => 'fixture',
    collect: async () => ({ samples: [], alarms: [{ key: 'a1', deviceId: '9', name: '温度高', startedAt: '2026-10-12T04:00:00Z', value: 90, desc: '温度高' }] }) });
  try {
    await manager.configure({ enabled: true, port, host: '127.0.0.1', suIp: '127.0.0.1', suId: '001122AABBCC', userName: 'fixture', password: 'fixture',
      allowedIps: ['127.0.0.1'], scUrls: ['http://127.0.0.1:' + sc.address().port + '/SCService'], soap: cfg.soap,
      devices: [{ deviceId: '9', bDeviceId: '42601', params: [{ type: 'ALARM', alarmName: '温度高', signalId: '426220301001' }] }] });
    await manager.cycle(); assert.deepStrictEqual(received.map(m => m.name), ['LOGIN', 'SEND_ALARM']); assert.strictEqual(manager.status().pending, 0);
    const inner = p.packet('Request', 'GET_ALARM', 601, p.identity(manager.rawConfig()));
    const reply = await request('http://127.0.0.1:' + port + '/services/SUService', inner, Object.assign({}, cfg));
    const m = p.message(reply); assert.strictEqual(m.name, 'GET_ALARM_ACK'); assert.ok(reply.includes('<SerialNo>0000000001</SerialNo>'));
    await assert.rejects(() => request('http://127.0.0.1:' + sc.address().port + '/timeout', inner, cfg), /超时/);
    await manager.stop(); assert.strictEqual(received[received.length - 1].name, 'LOGOUT');
    console.log('PASS real SOAP 1.2 HTTP registration, alarm delivery, SU query, total timeout and logout');
  } finally { await manager.stop(false); await new Promise(resolve => sc.close(resolve)); require('./helpers/b-interface-cleanup')(dir); }
})().catch(e => { console.error(e); process.exitCode = 1; });
