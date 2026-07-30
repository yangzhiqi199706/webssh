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

const localAccountConfig = access.normalizeConfig({
  version: 2,
  passwordPolicy: { maxAgeDays: 90 },
  loginIpAllowlist: ['192.168.0.0/24'],
  users: [{
    id: 'u-admin', username: 'admin', role: 'viewer', enabled: true,
    password: record, passwordChangedAt: '2026-07-01T00:00:00.000Z',
    sessionVersion: 1, loginIpAllowlist: ['192.168.0.8/32'],
  }],
  temporaryGrants: [{
    id: 'g-admin', userId: 'u-admin', role: 'admin',
    startsAt: '2026-07-29T00:00:00.000Z', endsAt: '2026-07-31T00:00:00.000Z',
  }],
});
const activeGrantTime = new Date('2026-07-30T12:00:00.000Z');
assert.strictEqual(localAccountConfig.version, 2);
assert.strictEqual(localAccountConfig.users.length, 1);
assert.strictEqual(access.roleLevel('viewer'), 1);
assert.strictEqual(access.roleLevel('operator'), 2);
assert.strictEqual(access.roleLevel('admin'), 3);
assert.strictEqual(access.effectiveRole(localAccountConfig, localAccountConfig.users[0], activeGrantTime), 'admin');
assert.strictEqual(access.effectiveRole(localAccountConfig, localAccountConfig.users[0], new Date('2026-08-01T00:00:00.000Z')), 'viewer');
assert.strictEqual(access.isIpAllowed('::ffff:192.168.0.8', ['192.168.0.0/24']), true);
assert.strictEqual(access.isIpAllowed('192.168.1.8', ['192.168.0.0/24']), false);
const validLogin = access.evaluateLogin(localAccountConfig, 'admin', 'N3w-Secret!', '::ffff:192.168.0.8', activeGrantTime, legacyPassword);
assert.strictEqual(validLogin.ok, true);
assert.strictEqual(validLogin.user.id, 'u-admin');
assert.strictEqual(validLogin.role, 'admin');
const deniedLogin = access.evaluateLogin(localAccountConfig, 'admin', 'N3w-Secret!', '192.168.0.9', activeGrantTime, legacyPassword);
assert.deepStrictEqual(deniedLogin, { ok: false, code: 'ip_not_allowed' });
const expiredConfig = access.normalizeConfig({
  version: 2, passwordPolicy: { maxAgeDays: 90 }, users: [{
    id: 'u-expired', username: 'expired', role: 'operator', enabled: true,
    password: record, passwordChangedAt: '2026-04-01T00:00:00.000Z',
    sessionVersion: 1, loginIpAllowlist: [],
  }], temporaryGrants: [],
});
assert.deepStrictEqual(access.evaluateLogin(expiredConfig, 'expired', 'N3w-Secret!', '192.168.0.8', activeGrantTime, legacyPassword), { ok: false, code: 'password_expired' });
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
