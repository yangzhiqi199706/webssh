'use strict';
const assert = require('assert'), fs = require('fs'), vm = require('vm');
const file = 'proto-conv/assets/js/pc-b-test-ids.js';
assert.ok(fs.existsSync(file), 'test ID generation needs a reusable deterministic helper');
const { fill } = require('../' + file);
function device(code) { return { bDeviceId: code, params: [{ type: 'AI', signalId: '100123456700', selected: true }, { type: 'DI', signalId: '', selected: false }, { type: 'ALARM', signalId: '' }] }; }
let d = device('10012');
assert.strictEqual(fill(d), 3);
assert.deepStrictEqual(d.params.map(v => v.signalId), ['100120000100', '100120000200', '100120000300']);
assert.strictEqual(d.params[1].selected, false); assert.strictEqual(d.params[2].type, 'ALARM');
assert.strictEqual(fill(d), 0);
d.bDeviceId = '10013'; assert.strictEqual(fill(d), 3); assert.strictEqual(d.params[2].signalId, '100130000300');
for (const code of ['', '1001', '10x12', '100123']) { const other = device(code), before = JSON.stringify(other); assert.strictEqual(fill(other), 0); assert.strictEqual(JSON.stringify(other), before); }
d = { bDeviceId: '00001', params: Array.from({ length: 1000 }, () => ({ signalId: '' })) }; assert.strictEqual(fill(d), 1000);
assert.strictEqual(d.params[999].signalId, '000010100000'); assert.strictEqual(new Set(d.params.map(v => v.signalId.slice(0, 10))).size, 1000);
assert.ok(d.params.every(v => /^\d{12}$/.test(v.signalId) && v.signalId.slice(0, 3) === '000' && v.signalId.endsWith('00')));
const context = { window: {} }; vm.runInNewContext(fs.readFileSync(file, 'utf8'), context); assert.strictEqual(typeof context.window.PcBTestIds.fill, 'function');
console.log('PASS deterministic test IDs: 5-digit input, all types/points, stable numbering, invalid-input guard, leading zeros and 1000-point uniqueness');
