'use strict';

const assert = require('assert');
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

console.log('access control: OK');
