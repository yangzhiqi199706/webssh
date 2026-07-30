'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const rotation = require('../lib/log-rotation');

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  fs.readdirSync(target).forEach(function (name) {
    const child = path.join(target, name);
    const stat = fs.lstatSync(child);
    if (stat.isDirectory()) removeTree(child);
    else fs.unlinkSync(child);
  });
  fs.rmdirSync(target);
}

(async function () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-log-'));
  const activeLog = path.join(directory, 'webssh.out.log');
  const expiredArchive = path.join(directory, 'webssh.err.log.20260101.gz');
  const backup = path.join(directory, 'ha-sync-bak.sql.gz');
  const now = new Date(2026, 6, 30, 12, 0, 0);

  try {
    fs.writeFileSync(activeLog, 'first line\n');
    fs.writeFileSync(expiredArchive, 'expired');
    fs.utimesSync(expiredArchive, new Date(2026, 0, 1), new Date(2026, 0, 1));
    fs.writeFileSync(backup, 'keep');

    const first = await rotation.rotateLogs({ logDir: directory, now: now, retentionDays: 30 });
    assert.deepStrictEqual(first.rotated, ['webssh.out.log']);
    assert.strictEqual(fs.readFileSync(activeLog, 'utf8'), '');
    assert.strictEqual(
      zlib.gunzipSync(fs.readFileSync(path.join(directory, 'webssh.out.log.20260730.gz'))).toString('utf8'),
      'first line\n',
    );
    assert.strictEqual(fs.existsSync(expiredArchive), false);
    assert.strictEqual(fs.readFileSync(backup, 'utf8'), 'keep');

    fs.writeFileSync(activeLog, 'second line\n');
    await rotation.rotateLogs({ logDir: directory, now: now, retentionDays: 30, force: true });
    assert.strictEqual(
      zlib.gunzipSync(fs.readFileSync(path.join(directory, 'webssh.out.log.20260730-120000.gz'))).toString('utf8'),
      'second line\n',
    );
  } finally {
    removeTree(directory);
  }

  console.log('log rotation: OK');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
