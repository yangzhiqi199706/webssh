'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const access = require('../lib/access-control');

const fixedRandom = function (size) { return Buffer.alloc(size, 0xab); };
const legacyPassword = '20260730';

assert.strictEqual(access.authenticate(null, 'admin', legacyPassword, legacyPassword), true);
assert.strictEqual(access.authenticate(null, 'root', legacyPassword, legacyPassword), false);

const record = access.createPasswordRecord('N3w-Secret!', fixedRandom);
assert.strictEqual(record.algorithm, 'scrypt');
assert.strictEqual(record.salt, 'ab'.repeat(16));
assert.notStrictEqual(record.hash, 'N3w-Secret!');
assert.strictEqual(access.verifyPassword('N3w-Secret!', record), true);
assert.strictEqual(access.verifyPassword('wrong', record), false);

const configured = { username: 'admin', password: record };
assert.strictEqual(access.authenticate(configured, 'admin', 'N3w-Secret!', legacyPassword), true);
assert.strictEqual(access.authenticate(configured, 'admin', legacyPassword, legacyPassword), false);
assert.deepStrictEqual(access.publicConfig(configured), { username: 'admin', hasPassword: true });

const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-access-control-'));
try {
  const missing = access.loadConfig(fs, path.join(configDirectory, 'access-control.json'));
  assert.deepStrictEqual(missing, { config: { username: 'admin' }, error: null });

  const corruptPath = path.join(configDirectory, 'corrupt.json');
  fs.writeFileSync(corruptPath, '{not-json', 'utf8');
  const corrupt = access.loadConfig(fs, corruptPath);
  assert.strictEqual(corrupt.config, null);
  assert.ok(corrupt.error instanceof Error);

  const incompletePath = path.join(configDirectory, 'incomplete.json');
  fs.writeFileSync(incompletePath, '{"username":"admin"}', 'utf8');
  const incomplete = access.loadConfig(fs, incompletePath);
  assert.strictEqual(incomplete.config, null);
  assert.ok(incomplete.error instanceof Error);
} finally {
  if (typeof fs.rmSync === 'function') fs.rmSync(configDirectory, { recursive: true, force: true });
  else fs.rmdirSync(configDirectory, { recursive: true });
}

console.log('access control: OK');
