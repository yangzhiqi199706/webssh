'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

const updatedWhileRotating = ops.normalize({
  logRotation: { enabled: true, retentionDays: 31 },
  idleDisconnect: { enabled: true, timeoutMinutes: 45 },
});
const rotationRecorded = ops.recordLogRotation(updatedWhileRotating, '2026-07-30', {
  ok: true,
  rotated: ['webssh.out.log'],
  deleted: [],
  finishedAt: '2026-07-30T12:00:00.000Z',
});
assert.strictEqual(rotationRecorded.logRotation.retentionDays, 31);
assert.strictEqual(rotationRecorded.idleDisconnect.enabled, true);
assert.strictEqual(rotationRecorded.idleDisconnect.timeoutMinutes, 45);
assert.strictEqual(rotationRecorded.logRotation.lastRotationDate, '2026-07-30');
assert.deepStrictEqual(rotationRecorded.logRotation.lastResult.rotated, ['webssh.out.log']);

const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-ops-settings-'));
try {
  const target = path.join(configDirectory, 'ops-settings.json');
  const next = { enabled: true };
  let committed = false;
  ops.writeJsonThenCommit(fs, target, next, function (value) {
    committed = value === next;
  });
  assert.strictEqual(committed, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), next);

  committed = false;
  const failingFs = { mkdirSync: function () { throw new Error('disk full'); } };
  assert.throws(function () {
    ops.writeJsonThenCommit(failingFs, target, next, function () { committed = true; });
  }, /disk full/);
  assert.strictEqual(committed, false);
} finally {
  if (typeof fs.rmSync === 'function') fs.rmSync(configDirectory, { recursive: true, force: true });
  else fs.rmdirSync(configDirectory, { recursive: true });
}

console.log('ops settings: OK');
