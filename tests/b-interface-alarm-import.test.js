'use strict';
const assert = require('assert'), catalog = require('../proto-conv/b-interface-alarm-definitions'), merge = require('../proto-conv/assets/js/pc-b-alarm-import').merge;
const data = { source: 'db', deviceIds: ['3'], types: { 1: '高于阈值', 2: '低于阈值', 3: '告警', 5: '设备连接异常' },
  rules: [{ deviceId: '3', ruleId: '1', baseName: '温度', type: 0, upper: '40', lower: '10' }, { deviceId: '3', ruleId: '2', baseName: '漏水', type: 1, alarmValue: '1' }, { deviceId: '3', ruleId: '3', baseName: '断线', type: 5 }] };
let result = catalog.build(data);
assert.deepStrictEqual(result.candidates.map(c => c.alarmName), ['温度高于阈值', '温度低于阈值', '漏水告警', '断线设备连接异常']);
assert.strictEqual(result.ruleCount, 3); assert.strictEqual(result.review.length, 0);
const statuses = catalog.build(Object.assign({}, data, { rules: [
  { deviceId: '3', ruleId: '10', baseName: '通道', type: 0, alarmValue: '*1=漏水/2=断线' },
  { deviceId: '3', ruleId: '11', baseName: '烟感', type: 0, alarmValue: '0' },
  { deviceId: '3', ruleId: '12', baseName: '电压', type: 0, upper: '240' }
] }));
assert.deepStrictEqual(statuses.candidates.map(c => c.alarmName), ['漏水告警','断线告警','烟感告警','电压高于阈值']);
const invalidFeatures = catalog.build(Object.assign({}, data, { rules: [
  { deviceId: '3', ruleId: '13', baseName: '空规则', type: 0 },
  { deviceId: '3', ruleId: '14', baseName: '异常规则', type: 0, alarmValue: '*1=含,逗号/2=正常' },
  { deviceId: '3', ruleId: '15', baseName: '重复值', type: 1, alarmValue: '*1=甲/1.0=乙' }
] }));
assert.strictEqual(invalidFeatures.candidates.length, 0); assert.strictEqual(invalidFeatures.review.length, 3);
const duplicates = catalog.build(Object.assign({}, data, { rules: data.rules.concat([{ deviceId: '3', ruleId: '4', baseName: '温度', type: 0, upper: '40', lower: '10' }, { deviceId: '3', ruleId: '5', baseName: 'x,y', type: 5 }, { deviceId: '3', ruleId: '6', baseName: 'trap', type: 6 }]) }));
assert.strictEqual(duplicates.candidates.length, 2); assert.strictEqual(duplicates.review.length, 6);
assert.strictEqual(catalog.build(Object.assign({}, data, { types: {} })).review.length, 3);
const deleted = catalog.build(Object.assign({}, data, { rules: [{ deviceId: '17', ruleId: '1', baseName: '温度', type: 0, deviceStatus: -1 }] }));
assert.strictEqual(deleted.candidates.length, 0); assert.ok(deleted.review[0].reason.includes('删除'));
const devices = [{ selected: true, deviceId: '3', bDeviceId: '10012', params: [
  { selected: true, type: 'AI', paraName: '温度', signalId: '100120000100' },
  { selected: false, type: 'ALARM', alarmName: '温度高于阈值', signalId: '100120000200' },
  { selected: true, type: 'ALARM', alarmName: '手动告警', signalId: '' }
] }, { selected: false, deviceId: '4', params: [] }];
const before = JSON.stringify(devices);
let out = merge(devices, result.candidates);
assert.strictEqual(out.added, 3); assert.strictEqual(out.kept, 1); assert.strictEqual(out.filled, 4);
assert.strictEqual(JSON.stringify(devices), before);
assert.strictEqual(out.devices[0].params[1].selected, false); assert.strictEqual(out.devices[0].params[1].signalId, '100120000200');
assert.strictEqual(out.devices[0].params[2].signalId, '100120000300');
assert.strictEqual(new Set(out.devices[0].params.map(p => p.signalId.slice(0, 10))).size, 6);
assert.strictEqual(merge(out.devices, result.candidates).added, 0, 'Repeat import must be idempotent');
assert.throws(() => merge(devices, [{ deviceId: '4', alarmName: '未选设备' }]), /发生变化/);
out = merge([{ selected: true, deviceId: '3', bDeviceId: '', params: [] }], result.candidates);
assert.deepStrictEqual(out.missing, ['3']); assert.ok(out.devices[0].params.every(p => !p.signalId));
assert.throws(() => merge([{ selected: true, deviceId: '3', bDeviceId: '10012', params: Array.from({ length: 1000 }, (_v,i) => ({ type: 'AI', paraName: String(i), selected: true, signalId: '' })) }], result.candidates), /1000/);
const many = Array.from({ length: 11 }, (_v,i) => ({ selected: true, deviceId: String(i + 1), params: Array.from({ length: 1000 }, () => ({ type: 'AI', selected: true })) }));
assert.throws(() => merge(many, []), /10000/);
assert.strictEqual(merge(devices.concat([{ selected: false, deviceId: '100', params: Array(2000).fill({ selected: false, type: 'AI' }) }]), result.candidates).added, 3);
const match = require('../proto-conv/b-interface-forwarder').alarmMatches;
const event = { deviceId: '3', name: '温度高于阈值', legacyNames: ['旧动态描述'] };
const oldMap = { type: 'ALARM', alarmName: '旧动态描述' }, newMap = { type: 'ALARM', alarmName: event.name };
assert.strictEqual(match([{ deviceId: '3', params: [oldMap] }], event)[0].s, oldMap);
assert.strictEqual(match([{ deviceId: '3', params: [oldMap,newMap] }], event)[0].s, newMap, 'Stable mapping must take priority over legacy alias');
assert.strictEqual(match([{ deviceId: '3', params: [newMap,Object.assign({},newMap)] }], event).length, 2, 'Ambiguous direct names must remain ambiguous');
console.log('PASS alarm catalog/import: naming, unknown/duplicate review, preserved drafts/codes/selections, collision-free IDs, repeat import, scope and atomic limits');
