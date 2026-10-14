'use strict';
const assert = require('assert'), view = require('../proto-conv/assets/js/pc-b-mapping-view');
const devices = [
  { deviceId: '3', deviceName: '温湿度一', groupId: '11', bDeviceId: '10012', selected: true, params: [
    { type: 'AI', paraName: '温度', signalId: '100120000100', selected: true },
    { type: 'DI', paraName: '漏水状态', signalId: '', selected: false },
    { type: 'ALARM', alarmName: '漏水告警', signalId: '', selected: true }
  ] },
  { deviceId: '4', deviceName: 'UPS', groupId: '12', bDeviceId: '24124', selected: false, params: [{ type: 'AI', paraName: '电压', signalId: '', selected: true }] }
];
const before = JSON.stringify(devices);
assert.strictEqual(view.filterDevices(devices, '温湿度')[0], devices[0]);
assert.strictEqual(view.filterDevices(devices, 'UPS')[0], devices[1]);
assert.strictEqual(view.filterDevices(devices, '11')[0], devices[0]);
assert.strictEqual(view.filterDevices(devices, '24124')[0], devices[1]);
assert.strictEqual(view.filterDevices(devices, ' 不存在 ').length, 0);
assert.strictEqual(view.filterDevices(devices, '').length, 2);
assert.strictEqual(view.filterPoints(devices[0].params, 'DI', '')[0], devices[0].params[1]);
assert.strictEqual(view.filterPoints(devices[0].params, 'ALL', '漏水').length, 2);
assert.strictEqual(view.filterPoints(devices[0].params, 'ALARM', '漏水')[0], devices[0].params[2]);
assert.strictEqual(view.filterPoints(devices[0].params, 'AI', '100120000100').length, 1);
assert.strictEqual(view.filterPoints(devices[0].params, 'AI', '漏水').length, 0);
assert.deepStrictEqual(view.summary(devices), { devices: 2, selectedDevices: 1, points: 2, AI: 1, DI: 0, ALARM: 1, missingIds: 1 });
assert.strictEqual(JSON.stringify(devices), before, 'Filtering/statistics must not mutate selections or codes');
assert.strictEqual(view.filterDevices([{ deviceId: '1', deviceName: '<img onerror=alert(1)>' }], '<img').length, 1);
console.log('PASS mapping view: device identity/name/group search, combined type/point search, selected-only totals, no draft mutation');
