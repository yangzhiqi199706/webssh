'use strict';

const assert = require('assert');
const state = require('../lib/sms-monitor-state');

const cursor = state.createCancelCursor(0, 0);
assert.deepStrictEqual(state.buildCancelQuery('dcim-alarmlist', cursor), {
  sql: 'SELECT * FROM `dcim-alarmlist` WHERE CancelTime IS NOT NULL AND (CancelTime > ? OR (CancelTime = ? AND id > ?)) ORDER BY CancelTime ASC, id ASC LIMIT 200',
  params: [new Date(0), new Date(0), 0],
});

assert.strictEqual(state.acceptCancelRow(cursor, { id: 10, CancelTime: '2026-08-28 10:00:00' }), true);
assert.deepStrictEqual(cursor.value(), { timeMs: new Date('2026-08-28T10:00:00').getTime(), id: 10 });
assert.strictEqual(state.acceptCancelRow(cursor, { id: 11, CancelTime: '2026-08-28 10:00:00' }), true,
  '同一秒内更大的 id 必须被接受');
assert.strictEqual(state.acceptCancelRow(cursor, { id: 9, CancelTime: '2026-08-28 10:00:00' }), false,
  '同一秒内已经处理过的较小 id 必须跳过');
assert.strictEqual(state.acceptCancelRow(cursor, { id: 12, CancelTime: '2026-08-28 09:59:59' }), false,
  '较早时间的记录必须跳过');
assert.strictEqual(state.acceptCancelRow(cursor, { id: 1, CancelTime: '2026-08-28 10:00:01' }), true);
assert.deepStrictEqual(cursor.value(), { timeMs: new Date('2026-08-28T10:00:01').getTime(), id: 1 });

const pending = new Map();
const flushed = [];
state.pushPendingWithLimit(pending, { id: 1 }, 1000, 2, function (row, reason) { flushed.push({ row, reason }); });
state.pushPendingWithLimit(pending, { id: 2 }, 1001, 2, function (row, reason) { flushed.push({ row, reason }); });
state.pushPendingWithLimit(pending, { id: 3 }, 1002, 2, function (row, reason) { flushed.push({ row, reason }); });
assert.deepStrictEqual(Array.from(pending.keys()), [2, 3]);
assert.deepStrictEqual(flushed, [{ row: { id: 1 }, reason: 'pending-cap' }]);
assert.deepStrictEqual(state.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);

console.log('sms monitor hardening: passed');
