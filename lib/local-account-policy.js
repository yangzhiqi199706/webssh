'use strict';

const crypto = require('crypto');

const USERNAME = 'admin';
const SALT_HEX_RE = /^[0-9a-f]{32}$/i;
const HASH_HEX_RE = /^[0-9a-f]{128}$/i;
const ROLE_LEVELS = { viewer: 1, operator: 2, admin: 3 };
const ROLE_NAMES = ['viewer', 'operator', 'admin'];
const DEFAULT_PASSWORD_POLICY = { maxAgeDays: 90 };
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,31}$/;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasPassword(config) {
  const record = config && config.password;
  return Boolean(record && record.algorithm === 'scrypt'
    && SALT_HEX_RE.test(String(record.salt || ''))
    && HASH_HEX_RE.test(String(record.hash || '')));
}

function createPasswordRecord(password, randomBytes) {
  const random = randomBytes || crypto.randomBytes;
  const salt = random(16);
  if (!Buffer.isBuffer(salt) || salt.length !== 16) throw new Error('密码盐必须为 16 字节随机数据');
  const hash = crypto.scryptSync(String(password), salt, 64);
  return { algorithm: 'scrypt', salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function verifyPassword(password, record) {
  if (!hasPassword({ password: record })) return false;
  try {
    const actual = crypto.scryptSync(String(password), Buffer.from(record.salt, 'hex'), 64);
    const expected = Buffer.from(record.hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_error) {
    return false;
  }
}

function roleLevel(role) {
  return ROLE_LEVELS[String(role || '').toLowerCase()] || 0;
}

function normalizeRole(role, fallback) {
  const value = String(role || '').toLowerCase();
  return roleLevel(value) ? value : (fallback || 'viewer');
}

function normalizeTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function normalizeIpv4(value) {
  let input = String(value || '').trim();
  if (input.indexOf('::ffff:') === 0) input = input.slice(7);
  const parts = input.split('.');
  if (parts.length !== 4) return '';
  for (let i = 0; i < parts.length; i += 1) {
    if (!/^\d{1,3}$/.test(parts[i]) || Number(parts[i]) > 255) return '';
  }
  return parts.map(function (part) { return String(Number(part)); }).join('.');
}

function ipv4Number(value) {
  const ip = normalizeIpv4(value);
  if (!ip) return null;
  const parts = ip.split('.');
  return (((Number(parts[0]) * 256 + Number(parts[1])) * 256 + Number(parts[2])) * 256 + Number(parts[3])) >>> 0;
}

function normalizeCidr(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  const slash = source.indexOf('/');
  const ip = normalizeIpv4(slash < 0 ? source : source.slice(0, slash));
  const prefixText = slash < 0 ? '32' : source.slice(slash + 1);
  if (!ip || !/^\d{1,2}$/.test(prefixText)) return '';
  const prefix = Number(prefixText);
  return prefix >= 0 && prefix <= 32 ? ip + '/' + prefix : '';
}

function normalizeIpAllowlist(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const result = [];
  source.forEach(function (entry) {
    const cidr = normalizeCidr(entry);
    if (cidr && result.indexOf(cidr) < 0) result.push(cidr);
  });
  return result;
}

function isIpAllowed(sourceIp, allowlist) {
  const rules = normalizeIpAllowlist(allowlist);
  if (!rules.length) return true;
  const source = ipv4Number(sourceIp);
  if (source === null) return false;
  return rules.some(function (rule) {
    const parts = rule.split('/');
    const network = ipv4Number(parts[0]);
    const prefix = Number(parts[1]);
    const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
    return ((source & mask) >>> 0) === ((network & mask) >>> 0);
  });
}

function normalizePasswordPolicy(value) {
  const days = Math.floor(Number(isObject(value) ? value.maxAgeDays : NaN));
  return { maxAgeDays: Number.isFinite(days) && days >= 1 && days <= 3650 ? days : DEFAULT_PASSWORD_POLICY.maxAgeDays };
}

function normalizeUser(value, index, usedIds) {
  const source = isObject(value) ? value : {};
  const username = String(source.username || '').trim();
  const idBase = String(source.id || 'u-' + (index + 1)).trim() || 'u-' + (index + 1);
  let id = idBase;
  let suffix = 2;
  while (usedIds[id]) { id = idBase + '-' + suffix; suffix += 1; }
  usedIds[id] = true;
  return {
    id: id,
    username: username,
    role: normalizeRole(source.role, 'viewer'),
    enabled: source.enabled !== false,
    password: hasPassword({ password: source.password }) ? {
      algorithm: 'scrypt', salt: String(source.password.salt), hash: String(source.password.hash),
    } : null,
    passwordChangedAt: normalizeTimestamp(source.passwordChangedAt),
    sessionVersion: Math.max(1, Math.floor(Number(source.sessionVersion) || 1)),
    loginIpAllowlist: normalizeIpAllowlist(source.loginIpAllowlist),
  };
}

function normalizeConfig(value) {
  const source = isObject(value) ? value : {};
  const rawUsers = source.version === 2 && Array.isArray(source.users) ? source.users : [{
    id: 'u-admin', username: USERNAME, role: 'admin', enabled: true,
    password: source.password, passwordChangedAt: '', sessionVersion: 1, loginIpAllowlist: [],
  }];
  const usedIds = {};
  const users = rawUsers.map(function (user, index) { return normalizeUser(user, index, usedIds); })
    .filter(function (user) { return USERNAME_RE.test(user.username); });
  const knownUsers = {};
  users.forEach(function (user) { knownUsers[user.id] = true; });
  const temporaryGrants = (Array.isArray(source.temporaryGrants) ? source.temporaryGrants : []).map(function (grant, index) {
    const input = isObject(grant) ? grant : {};
    return {
      id: String(input.id || 'g-' + (index + 1)).trim(),
      userId: String(input.userId || '').trim(),
      role: normalizeRole(input.role, 'viewer'),
      startsAt: normalizeTimestamp(input.startsAt),
      endsAt: normalizeTimestamp(input.endsAt),
      createdAt: normalizeTimestamp(input.createdAt),
      createdBy: String(input.createdBy || '').trim(),
      note: String(input.note || '').trim().slice(0, 200),
    };
  }).filter(function (grant) {
    return grant.id && knownUsers[grant.userId] && grant.startsAt && grant.endsAt
      && Date.parse(grant.endsAt) > Date.parse(grant.startsAt);
  });
  return {
    version: 2,
    passwordPolicy: normalizePasswordPolicy(source.passwordPolicy),
    loginIpAllowlist: normalizeIpAllowlist(source.loginIpAllowlist),
    users: users,
    temporaryGrants: temporaryGrants,
  };
}

function passwordExpiresAt(user, policy) {
  if (!user || !hasPassword({ password: user.password }) || !user.passwordChangedAt) return '';
  const changedAt = Date.parse(user.passwordChangedAt);
  if (!Number.isFinite(changedAt)) return '';
  return new Date(changedAt + normalizePasswordPolicy(policy).maxAgeDays * 86400000).toISOString();
}

function isPasswordExpired(user, policy, now) {
  const expiresAt = passwordExpiresAt(user, policy);
  return Boolean(expiresAt) && (now || new Date()).getTime() >= Date.parse(expiresAt);
}

function publicUser(user, policy) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled,
    passwordChangedAt: user.passwordChangedAt || '',
    passwordExpiresAt: passwordExpiresAt(user, policy),
    sessionVersion: user.sessionVersion,
    loginIpAllowlist: user.loginIpAllowlist.slice(),
  };
}

function effectiveRole(config, user, now) {
  const normalized = config && config.version === 2 ? config : normalizeConfig(config);
  const timestamp = (now || new Date()).getTime();
  let level = roleLevel(user && user.role);
  normalized.temporaryGrants.forEach(function (grant) {
    if (grant.userId === user.id && Date.parse(grant.startsAt) <= timestamp && timestamp < Date.parse(grant.endsAt)) {
      level = Math.max(level, roleLevel(grant.role));
    }
  });
  return ROLE_NAMES.filter(function (role) { return roleLevel(role) === level; })[0] || 'viewer';
}

function authenticate(config, username, password, legacyPassword) {
  const result = evaluateLogin(config, username, password, '', new Date(), legacyPassword, true);
  return result.ok;
}

function evaluateLogin(configInput, username, password, sourceIp, now, legacyPassword, skipIpCheck) {
  const config = normalizeConfig(configInput);
  const user = config.users.filter(function (candidate) { return candidate.username === String(username || '').trim(); })[0];
  if (!user || !user.enabled) return { ok: false, code: 'invalid_credentials' };
  if (!skipIpCheck && (!isIpAllowed(sourceIp, config.loginIpAllowlist) || !isIpAllowed(sourceIp, user.loginIpAllowlist))) {
    return { ok: false, code: 'ip_not_allowed' };
  }
  const passwordOk = hasPassword({ password: user.password })
    ? verifyPassword(password, user.password)
    : String(password || '') === String(legacyPassword || '');
  if (!passwordOk) return { ok: false, code: 'invalid_credentials' };
  if (isPasswordExpired(user, config.passwordPolicy, now)) return { ok: false, code: 'password_expired' };
  return { ok: true, user: publicUser(user, config.passwordPolicy), role: effectiveRole(config, user, now) };
}

function publicConfig(config) {
  if (!config || config.version !== 2) return { username: USERNAME, hasPassword: hasPassword(config) };
  const normalized = normalizeConfig(config);
  return {
    version: 2,
    passwordPolicy: normalized.passwordPolicy,
    loginIpAllowlist: normalized.loginIpAllowlist.slice(),
    users: normalized.users.map(function (user) { return publicUser(user, normalized.passwordPolicy); }),
    temporaryGrants: normalized.temporaryGrants.map(function (grant) { return Object.assign({}, grant); }),
  };
}

function loadConfig(fileSystem, configPath) {
  try {
    const config = JSON.parse(fileSystem.readFileSync(configPath, 'utf8'));
    if (config && config.version === 2) {
      if (!Array.isArray(config.users) || !config.users.length) throw new Error('本地账号配置格式无效');
      const normalized = normalizeConfig(config);
      if (!normalized.users.length) throw new Error('本地账号配置没有有效用户名');
      return { config: normalized, error: null };
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || config.username !== USERNAME || !hasPassword(config)) throw new Error('访问控制配置格式无效');
    return { config: config, error: null };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { config: { username: USERNAME }, error: null };
    return { config: null, error: error };
  }
}

module.exports = {
  USERNAME,
  ROLE_LEVELS,
  hasPassword,
  createPasswordRecord,
  verifyPassword,
  authenticate,
  roleLevel,
  normalizeRole,
  normalizeConfig,
  normalizeIpAllowlist,
  isIpAllowed,
  publicUser,
  passwordExpiresAt,
  isPasswordExpired,
  effectiveRole,
  evaluateLogin,
  publicConfig,
  loadConfig,
};
