'use strict';
const assert = require('assert');
const alarms = require('../proto-conv/wecom-alarms');
const { loadOptions } = require('../proto-conv/wecom-options');
(async () => {
  const live = { eventId: '7587', updatedate: '2026-08-31 10:09:28', create_time: '2026-08-31 18:09:27', alarmAreaName: 'Room', alarmLevel: '2', deviceName: 'UPS', eventName: 'Power' };
  const history = { AlarmId: '7587', AlarmDateTime: '2026-08-31 10:09:28', DateOnRes: '2026-08-31 18:09:39', LevelNo: '2', LevelName: 'Minor', DeviceName: 'UPS' };
  const a = alarms.normalize(live), b = alarms.normalize(history);
  assert.strictEqual(a.key, b.key); assert.strictEqual(a.area, 'Room'); assert.strictEqual(a.level, b.level); assert.ok(b.recoveredAt);
  assert.strictEqual(alarms.extract({ data: { Count: 12, data: [] } }).total, 12);
  let calls = 0;
  const all = await alarms.readPages(async () => { calls++; return { ok: true, data: { status: 'ok', data: [live, Object.assign({}, live, { eventId: '2' })] } }; }, 'GetRealAlarmsKey', {}, {}, 1);
  assert.strictEqual(all.length, 2); assert.strictEqual(calls, 1);
  const queried = [];
  const result = await alarms.collect({ getCfg: () => ({ userLsh: '1' }), callUpstream: async ({ key, body }) => {
    if (key === 'GetRealAlarmsKey') return { ok: true, data: { status: 'ok', data: [Object.assign({}, live, { serverCode: '2' })] } };
    if (key === 'GetNewAllAreasKey') return { ok: true, data: { status: 'ok', data: [{ ServerCode: '1' }] } };
    queried.push(body.serverCode);
    assert.ok(!body.startDateTime, 'legacy history must not filter by display timestamp');
    return { ok: true, data: { status: 'ok', data: { Count: 1, data: [history] } } };
  } }, { recovery: true, fields: {} }, Date.now() - 60000);
  assert.deepStrictEqual(queried.sort(), ['1', '2']);
  assert.strictEqual(result.historyError, '');
  assert.ok(result.live[0].recoveredAt, 'legacy live rows need explicit historical recovery evidence');
  assert.throws(() => alarms.extract({ status: 'error', data: [] }), /失败/);
  const helper = { getCfg: () => ({ userLsh: '1' }), callUpstream: async ({ key, body }) => {
    if (key === 'GetDeviceListKey') return { ok: false, status: 404 };
    let rows = [];
    if (key === 'GetNewAllAreasKey') rows = [{ Zonesubno: '61', ServerCode: '1', Zonesubname: 'Room' }];
    if (key === 'GetGroupByZonesubnoKey') { assert.strictEqual(body.Zonesubno, '61'); rows = [{ GroupId: '7' }]; }
    if (key === 'GetDeviceByGroupKey') rows = [{ DeviceName: 'Idle UPS' }];
    if (key === 'GetRealAlarmsKey') rows = [live];
    return { ok: true, data: { status: 'ok', data: rows } };
  } };
  const options = await loadOptions(helper, {});
  assert.ok(options.devices.includes('Idle UPS')); assert.deepStrictEqual(options.levels, ['2']); assert.deepStrictEqual(options.warnings, []);
  console.log('PASS 8082 event identity, recovery, Count, unpaged lists and group fallback');
})().catch(e => { console.error(e); process.exitCode = 1; });
