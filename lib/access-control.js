'use strict';

const crypto = require('crypto');

const USERNAME = 'admin';
const SALT_HEX_RE = /^[0-9a-f]{32}$/i;
const HASH_HEX_RE = /^[0-9a-f]{128}$/i;

function hasPassword(config) {
  const record = config && config.password;
  return Boolean(record
    && record.algorithm === 'scrypt'
    && SALT_HEX_RE.test(String(record.salt || ''))
    && HASH_HEX_RE.test(String(record.hash || '')));
}

function createPasswordRecord(password, randomBytes) {
  const random = randomBytes || crypto.randomBytes;
  const salt = random(16);
  if (!Buffer.isBuffer(salt) || salt.length !== 16) {
    throw new Error('密码盐必须为 16 字节随机数据');
  }
  const hash = crypto.scryptSync(String(password), salt, 64);
  return {
    algorithm: 'scrypt',
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
  };
}

function verifyPassword(password, record) {
  if (!hasPassword({ password: record })) return false;
  try {
    const salt = Buffer.from(record.salt, 'hex');
    const expected = Buffer.from(record.hash, 'hex');
    const actual = crypto.scryptSync(String(password), salt, 64);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_err) {
    return false;
  }
}

function authenticate(config, username, password, legacyPassword) {
  if (String(username || '').trim() !== USERNAME) return false;
  if (hasPassword(config)) return verifyPassword(password, config.password);
  return String(password || '') === String(legacyPassword || '');
}

function publicConfig(config) {
  return { username: USERNAME, hasPassword: hasPassword(config) };
}

module.exports = {
  USERNAME,
  hasPassword,
  createPasswordRecord,
  verifyPassword,
  authenticate,
  publicConfig,
};
