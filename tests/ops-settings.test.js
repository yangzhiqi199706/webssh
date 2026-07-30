'use strict';

const assert = require('assert');
const ops = require('../lib/ops-settings');

assert.deepStrictEqual(ops.normalize(null), {
  logRotation: { enabled: true, retentionDays: 30, lastRotationDate: '', lastResult: null },
  idleDisconnect: { enabled: false, timeoutMinutes: 30 },
});

assert.deepStrictEqual(ops.normalize({
  logRotation: { enabled: 0, retentionDays: 99999, lastRotationDate: 'not-a-date' },
  idleDisconnect: { enabled: true, timeoutMinutes: 0 },
}), {
  logRotation: { enabled: false, retentionDays: 3650, lastRotationDate: '', lastResult: null },
  idleDisconnect: { enabled: true, timeoutMinutes: 1 },
});

assert.strictEqual(ops.localDateKey(new Date(2026, 6, 30)), '2026-07-30');

console.log('ops settings: OK');
