'use strict';
const assert = require('assert');
const csv = require('../proto-conv/assets/js/pc-b-csv');
const selected = { selected: true, deviceId: '003', deviceName: '温湿度,"A"\n机房', groupId: '01', serverCode: '1', bDeviceId: '00123', rId: '=HYPERLINK("http://example.invalid")', password: 'secret', params: [
  { selected: true, type: 'AI', paraName: '温度', signalId: '001230000100' },
  { selected: false, type: 'DI', paraName: '未选状态', signalId: '001230000200' },
  { selected: true, type: 'DI', paraName: '门状态', signalId: '001230000300' },
  { selected: true, type: 'ALARM', paraName: '旧参数名', alarmName: '\t=1+1', signalId: '001230000400' }
] };
const input = [selected, Object.assign({}, selected, { selected: false }), { selected: true, params: [] }];
const before = JSON.stringify(input), out = csv.generate(input);
assert.strictEqual(out.pointCount, 3); assert.strictEqual(out.deviceCount, 1);
assert.ok(out.text.startsWith('\uFEFF"DCIM 设备 ID"'));
assert.ok(out.text.includes('"温湿度,""A""\n机房"'));
assert.ok(out.text.includes('"003"') && out.text.includes('"001230000100"'), 'Raw leading-zero IDs must remain intact');
assert.ok(out.text.includes('"\'=HYPERLINK(""http://example.invalid"")"'));
assert.ok(out.text.includes('"\'\t=1+1"'));
assert.ok(out.text.includes('"ALARM","","\'\t=1+1"'));
assert.ok(!out.text.includes('secret') && !out.text.includes('未选状态') && !out.text.includes('旧参数名'));
assert.strictEqual(JSON.stringify(input), before, 'Export must not mutate draft');
assert.strictEqual(csv.generate([]).pointCount, 0);
const many = csv.generate(Array.from({ length: 12 }, (_v, i) => ({ selected: true, deviceId: String(i), params: Array.from({ length: 83 }, () => ({ selected: true, type: 'AI' })) })));
assert.strictEqual(many.pointCount, 996); assert.strictEqual(many.deviceCount, 12);
['=1+1', '+SUM(1)', '-1+1', '@SUM(1)', '  =1', '\r=1', '\n=1'].forEach(name => {
  const text = csv.generate([{ selected: true, deviceName: name, params: [{ selected: true }] }]).text;
  assert.ok(text.includes('"\'' + name + '"'), 'Formula-like text must be neutralized');
});
console.log('PASS selected CSV: all pages/types, BOM, escaping, exact IDs, formula guard, empty selection, privacy and no mutation');
