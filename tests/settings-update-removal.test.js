'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const claudeSource = fs.readFileSync(path.join(rootDir, 'CLAUDE.md'), 'utf8');

assert.doesNotMatch(indexSource, /data-pane="update"/);
assert.doesNotMatch(indexSource, /id: 'update', label: '更新'/);

[
  'updateConnState', 'updateFileInput', 'updateResetBtn', 'updateFileMeta',
  'updateStatus', 'updateLog', 'updateApplyBtn', 'refreshUpdatePane',
  'appendUpdateLog', 'setUpdateStatus', 'setUpdateBusy', 'resetUpdateFile',
  'onUpdateFilePicked', 'applyUpdatePackage',
].forEach((identifier) => assert.doesNotMatch(indexSource, new RegExp(identifier)));

['update:apply', 'update:progress', 'update:result', 'update:error'].forEach((messageType) => {
  assert.doesNotMatch(indexSource, new RegExp(messageType));
  assert.doesNotMatch(serverSource, new RegExp(messageType));
});

assert.ok(!fs.existsSync(path.join(rootDir, 'scripts', 'pack-8081-src.bat')));
assert.strictEqual(
  packageJson.scripts.test,
  'node tests/settings-update-removal.test.js && node tests/dcim-wvp-opengauss.test.js',
);
assert.doesNotMatch(claudeSource, /pack-8081-src\.bat/);
assert.doesNotMatch(claudeSource, /主壳"在线更新"使用/);

console.log('settings update feature removal: OK');
