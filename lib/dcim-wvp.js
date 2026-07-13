'use strict';

const crypto = require('crypto');

const DEFAULT_API_BASE = 'https://127.0.0.1:8082';
const DEFAULT_TIMEOUT_MS = 8000;

function normalizeApiBase(value) {
  const apiBase = value == null || value === '' ? DEFAULT_API_BASE : String(value).replace(/\/+$/, '');
  if (!/^https:\/\//i.test(apiBase)) {
    throw new Error('DCIM video apiBase must use HTTPS');
  }
  return apiBase;
}

function normalizeTimeout(value) {
  const timeoutMs = value == null ? DEFAULT_TIMEOUT_MS : Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new Error('DCIM video timeoutMs must be between 1000 and 30000');
  }
  return timeoutMs;
}

function mergeDcimVideoConfig(input, previous) {
  const next = input || {};
  const old = previous || {};
  const config = {
    apiBase: normalizeApiBase(next.apiBase == null ? old.apiBase : next.apiBase),
    username: next.username == null ? (old.username || '') : String(next.username),
    timeoutMs: normalizeTimeout(next.timeoutMs == null ? old.timeoutMs : next.timeoutMs),
  };
  const password = next.password;
  if (password !== undefined && password !== null && password !== '' && password !== '***') {
    config.passwordHash = crypto.createHash('md5').update(String(password), 'utf8').digest('hex');
  } else if (old.passwordHash) {
    config.passwordHash = old.passwordHash;
  }
  return config;
}

function publicDcimVideoConfig(config) {
  const value = config || {};
  return {
    apiBase: value.apiBase,
    username: value.username,
    timeoutMs: value.timeoutMs,
    hasPasswordHash: Boolean(value.passwordHash),
  };
}

function isActive(value) {
  return value === true || value === 'active';
}

function isEnabled(value) {
  return value === true || value === 'enabled';
}

function check(name, healthy, detail) {
  return { name: name, healthy: Boolean(healthy), detail: detail || '' };
}

function parseWvpRuntimeProbe(probe) {
  let value = probe || {};
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (error) { value = {}; }
  }
  const service = value.service || {};
  const legacy = value.legacyService || value.legacy_service || {};
  const listeners = value.listeners || {};
  const datasource = value.datasource || {};
  const database = value.database || {};
  const logs = value.logs || {};
  const legacyActive = isActive(legacy.active);
  const legacyEnabled = isEnabled(legacy.enabled);
  const legacyComplete = legacy.active !== undefined && legacy.enabled !== undefined;
  const checks = {
    service: check('service', isActive(service.active) && isEnabled(service.enabled), 'wvp-opengauss service'),
    legacyService: check('legacyService', legacyComplete && !legacyActive && !legacyEnabled, 'legacy service is inactive and disabled'),
    listeners: check('listeners', Boolean(listeners.tcp5060 || listeners.port5060) && Boolean(listeners.http18080 || listeners.port18080), '5060/18080'),
    datasource: check('datasource', /postgresql/i.test(String(datasource.driver || '')) && /jdbc:postgresql:/i.test(String(datasource.url || '')) && /postgresql/i.test(String(datasource.dialect || '')), 'PostgreSQL driver/url/dialect'),
    database: check('database', database.reachable === true || database.ok === true || database.status === 'ok', 'database connectivity'),
    logs: check('logs', logs.recentError === false || logs.healthy === true || logs.ok === true, 'recent logs'),
  };
  const ready = Object.keys(checks).every(function (key) { return checks[key].healthy; });
  return {
    status: ready ? 'ready' : 'unhealthy',
    restartAllowed: !legacyActive && !legacyEnabled,
    checks: checks,
  };
}

function wvpRuntimeProbeCommand() {
  return [
    'systemctl is-active wvp-opengauss.service',
    'systemctl is-enabled wvp-opengauss.service',
    'systemctl is-active wvp-pro.service',
    'pgrep -af "java.*wvp"',
    'ss -lnt | grep -E ":(5060|18080)\\b"',
    'grep -E "driver-class-name:.*postgresql|url:.*jdbc:postgresql:|database-platform:.*PostgreSQL|url:.*jdbc:mysql:" /opt/wvp/config/*.yml /opt/wvp/config/*.yaml 2>/dev/null',
  ].join(' && ');
}

module.exports = {
  mergeDcimVideoConfig: mergeDcimVideoConfig,
  publicDcimVideoConfig: publicDcimVideoConfig,
  parseWvpRuntimeProbe: parseWvpRuntimeProbe,
  wvpRuntimeProbeCommand: wvpRuntimeProbeCommand,
};
