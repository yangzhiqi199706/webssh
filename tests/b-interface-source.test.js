'use strict';
const assert = require('assert');
const { collect, loadDevice } = require('../proto-conv/b-interface-source');
const cfg = { devices: [{ deviceId: '9', deviceName: 'UPS', groupId: '3', params: [{ type: 'AI', paraName: 'Voltage' }, { type: 'ALARM', alarmName: '高温告警' }] }], alarmFields: {}, recovery: true };
const calls = [];
const helper = { getCfg: () => ({ userLsh: '1' }), callUpstream: async r => {
  calls.push(r);
  const result = { GetDeviceByGroupKey: [{ DeviceId: '9', DeviceName: 'UPS', ParaList: [{ ParaName: 'Voltage', CurValue: '12.3V' }] }],
    GetDeviceParasKey: [{ ParaName: 'Voltage', CurValue: '12.3', DataType: '模拟量' }, { ParaName: 'Door', CurValue: '1', DataType: '开关量' }],
    GetRealAlarmsKey: [{ AlarmId: '1', AlarmTime: '2026-10-12 12:00:00', DeviceId: '9', DeviceName: 'UPS', AlarmContent: '高温告警' }] };
  return { ok: true, data: { rows: result[r.key] || [] } };
} };
(async () => {
  const snapshot = await collect(helper, cfg, null, Date.parse('2026-10-12T12:01:00+08:00'));
  assert.strictEqual(snapshot.samples[0].value, 12.3);
  assert.strictEqual(snapshot.alarms[0].deviceId, '9'); assert.strictEqual(snapshot.alarms[0].name, '高温告警');
  const device = await loadDevice(helper, '9', '3'); assert.strictEqual(device.params[0].paraName, 'Voltage');
  assert.strictEqual(device.params[0].type, 'AI'); assert.strictEqual(device.params[1].type, 'DI');
  const multiple = { devices: [
    { deviceId: '3', groupId: '', serverCode: '1', params: [{ type: 'AI', paraName: '温度' }, { type: 'AI', paraName: '湿度' }] },
    { deviceId: '4', groupId: '1', serverCode: '', params: [{ type: 'AI', paraName: '温度' }] }
  ], alarmFields: {} };
  const multiCalls = [];
  const multiHelper = { getCfg: helper.getCfg, callUpstream: async r => {
    multiCalls.push(r);
    const rows = r.key === 'GetDeviceByGroupKey' ? [] : r.body.DeviceId === '3' ? [{ ParaName: '温度', CurValue: '25.5' }, { ParaName: '湿度', CurValue: '66.1' }] : [{ ParaName: '温度', CurValue: '23.9' }];
    return { ok: true, data: { rows } };
  } };
  let multi = await collect(multiHelper, multiple, null);
  assert.deepStrictEqual(multi.samples.map(v => v.value), [25.5, 66.1, 23.9], 'missing group membership should fall back to exact device ID');
  assert.ok(multi.warnings.some(v => v.includes('4') && v.includes('分组')));
  const oneFailure = { getCfg: helper.getCfg, callUpstream: async r => r.body.DeviceId === '4' ? { ok: false, status: 500 } : multiHelper.callUpstream(r) };
  multi = await collect(oneFailure, multiple, null);
  assert.deepStrictEqual(multi.samples.map(v => v.value), [25.5, 66.1, null], 'one failed device must not erase healthy devices');
  assert.strictEqual(multi.errors.length, 1); assert.ok(multi.errors[0].includes('4'));
  const wrongGroupApi = { getCfg: helper.getCfg, callUpstream: async r => r.key === 'GetDeviceByGroupKey' ? { ok: true, data: { code: 500, data: [] } } : multiHelper.callUpstream(r) };
  multi = await collect(wrongGroupApi, multiple, null); assert.deepStrictEqual(multi.samples.map(v => v.value), [25.5, 66.1, 23.9]);
  const globalCalls = [];
  const globalFailure = { getCfg: helper.getCfg, callUpstream: async r => { globalCalls.push(r); return { ok: false, status: 0 }; } };
  await assert.rejects(() => collect(globalFailure, multiple, null)); assert.strictEqual(globalCalls.length, 1, 'global outage must not retry every device');
  let expiredCalls = 0;
  const expired = { getCfg: helper.getCfg, callUpstream: async () => { expiredCalls++; return { ok: false, status: 200, data: { code: 300 } }; } };
  await assert.rejects(() => collect(expired, multiple, null)); assert.strictEqual(expiredCalls, 1, 'expired DCIM session must not trigger a retry for each device');
  const failure = { getCfg: helper.getCfg, callUpstream: async () => ({ ok: false }) };
  await assert.rejects(() => collect(failure, cfg, null));
  const businessFailure = { getCfg: helper.getCfg, callUpstream: async () => ({ ok: true, data: { code: 500, data: [] } }) };
  await assert.rejects(() => collect(businessFailure, cfg, null));
  const eventName = '温度高于阈值', dynamic = '[SC]A区域,UPS,温度高于阈值,主要,10-12 12:00:00,当前值:90';
  const stableHelper = { getCfg: helper.getCfg, callUpstream: async r => {
    const data = r.key === 'GetRealAlarmsKey' ? [{ eventId: '42', eventName, deviceName: 'UPS', updatedate: '2026-10-12 12:00:00', TextMessage: dynamic }] :
      r.key === 'GetNewAllAreasKey' ? [{ ServerCode: '1' }] :
      [{ AlarmId: '42', AlarmName: eventName, DeviceId: '9', DeviceName: 'UPS', AlarmDateTime: '2026-10-12 12:00:00', DateOnRes: '2026-10-12 12:01:00' }];
    return { ok: true, data: { status: 'ok', data } };
  } };
  const stableConfig = { devices: [{ deviceId: '9', params: [{ type: 'ALARM', alarmName: eventName }] }], alarmFields: {} };
  const stable = await collect(stableHelper, stableConfig, Date.parse('2026-10-12T11:59:00+08:00'), Date.parse('2026-10-12T12:02:00+08:00'));
  assert.strictEqual(stable.alarms[0].name, eventName); assert.strictEqual(stable.alarms[0].deviceId, '9');
  assert.ok(stable.alarms[0].legacyNames.includes(dynamic), 'Legacy dynamic mapping must survive history enrichment');
  assert.ok(stable.alarms[0].recoveredAt, 'Stable-name collection must retain recovery evidence');
  console.log('PASS B interface DCIM source: devices, values, alarm identity and upstream failures');
})().catch(e => { console.error(e); process.exitCode = 1; });
