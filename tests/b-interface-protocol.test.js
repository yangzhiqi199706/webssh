'use strict';
const assert = require('assert');
const p = require('../proto-conv/b-interface-protocol');
const cfg = { suId: '001122AABBCC', suRId: 'asset', suIp: '127.0.0.1', port: 8080, userName: 'u', password: 'a<&', configTime: '2026-10-12 12:00:00', vendor: 'WEBSSH', model: 'DCIM', hardVer: '1', suVer: '3.0', longitude: 0, latitude: 0,
  soap: { version: '1.1', namespace: 'urn:su', method: 'invoke', parameter: 'xmlData', result: 'invokeReturn', action: '' },
  devices: [{ deviceId: '9', bDeviceId: '42601', rId: 'r', deviceName: 'UPS', params: [{ paraName: 'Voltage', signalId: '426220301000', type: 'AI' }, { paraName: 'Door', signalId: '426330301000', type: 'DI' }] }] };
const login = p.login(cfg);
assert.strictEqual(p.message(login).name, 'LOGIN');
assert.strictEqual(p.message(login).code, 101);
assert.strictEqual(p.value(p.message(login).info, 'PassWord'), 'a<&');
assert.strictEqual(p.message(p.unwrap(p.envelope(login, cfg.soap), cfg.soap)).name, 'LOGIN');
assert.strictEqual(p.message(p.unwrap(p.envelope(login, Object.assign({}, cfg.soap, { version: '1.2' })), cfg.soap)).name, 'LOGIN');
const cdata = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><invoke xmlns="urn:su"><xmlData><![CDATA[' + login + ']]></xmlData></invoke></s:Body></s:Envelope>';
assert.strictEqual(p.message(p.unwrap(cdata, cfg.soap)).name, 'LOGIN');
assert.throws(() => p.parse('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><x>&a;</x>'));
assert.throws(() => p.parse('<x><y></x>'));
assert.throws(() => p.parse('<x/><x/>'));
assert.throws(() => p.parse('<x>'.repeat(66) + '</x>'.repeat(66)));
const ai = p.data(cfg, [{ deviceId: '9', paraName: 'Voltage', value: 12.5 }], 'AI', 'GET_AIDATA_ACK', 202);
assert.ok(ai.includes('Value="12.5"'));
const di = p.data(cfg, [{ deviceId: '9', paraName: 'Door', value: 1 }], 'DI', 'GET_DIDATA_ACK', 302);
assert.ok(di.includes('Id="426330301001"')); assert.ok(!di.includes('Value='));
assert.ok(p.data(cfg, [], 'DI', 'GET_DIDATA_ACK', 302).includes('Id="4263303010FF"'));
const filtered = p.message(p.packet('Request', 'GET_AIDATA', 201, '<DeviceList><Device Id="42601"><Signal Id="426220301000"/></Device></DeviceList>'));
assert.ok(p.data(cfg, [], 'AI', 'GET_AIDATA_ACK', 202, filtered.info).includes('Value=""'));
const ack = p.packet('Response', 'SEND_ALARM_ACK', 604, '<SUId>001122AABBCC</SUId><Result>1</Result>');
assert.strictEqual(p.ack(ack, 'SEND_ALARM', 603, cfg.suId), true);
assert.throws(() => p.ack(ack, 'LOGIN', 101, cfg.suId));
assert.throws(() => p.ack(ack.replace('<Result>1', '<Result>0'), 'SEND_ALARM', 603, cfg.suId));
assert.throws(() => p.ack(ack.replace('001122AABBCC', 'BAD'), 'SEND_ALARM', 603, cfg.suId));
const alarm = { serial: '0000000001', bDeviceId: '42601', rId: 'r', signalId: '426220301001', time: '2026-10-12 12:00:00', value: 1, flag: 'BEGIN', desc: '温度过高<&' };
const alarmXml = p.alarms(cfg, [alarm]);
assert.ok(alarmXml.includes('<Signal Id="426220301001"/>'));
assert.ok(Buffer.byteLength(p.truncate('温'.repeat(40), 40)) <= 40);
for (const version of ['1.1', '1.2']) {
  const c = Object.assign({}, cfg, { userName: 'USER_PRIVATE', password: 'PASSWORD_PRIVATE', soap: Object.assign({}, cfg.soap, { version, namespace: 'urn:mock?a=1&b=2', method: 'exchange', result: 'reply' }) });
  const before = JSON.stringify(c), response = p.mockLoginAck(c), xml = p.unwrap(response, c.soap, true), m = p.message(xml);
  assert.strictEqual(m.root, 'Response'); assert.strictEqual(m.name, 'LOGIN_ACK'); assert.strictEqual(m.code, 102);
  assert.strictEqual(p.value(m.info, 'SUId'), c.suId); assert.strictEqual(p.value(m.info, 'RightLevel'), '1');
  assert.strictEqual(p.ack(xml, 'LOGIN', 101, c.suId), true);
  assert.ok(response.includes('<![CDATA[')); assert.ok(!response.includes('PRIVATE') && !response.includes('UPS'));
  assert.strictEqual(JSON.stringify(c), before, 'Mock response must not change settings');
}
assert.throws(() => p.mockLoginAck(Object.assign({}, cfg, { suId: '' })), /SU 编码/);
console.log('PASS B interface protocol: SOAP, XML bounds, escaping, AI/DI IDs, ACK and alarms');
