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
  const value = {};
  if (typeof probe === 'string') {
    probe.split(/\r?\n/).forEach(function (line) {
      const separator = line.indexOf('=');
      if (separator === -1) return;
      value[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    });
  } else if (probe && typeof probe === 'object') {
    Object.keys(probe).forEach(function (key) { value[key] = probe[key]; });
  }
  function get(key) { return value[key]; }
  function has(key) { return get(key) !== undefined && get(key) !== ''; }
  function positive(key) { return /^(1|up|ok|active|enabled|true|none)$/i.test(String(get(key))); }
  const legacyActive = isActive(get('legacyService.active'));
  const legacyEnabled = isEnabled(get('legacyService.enabled'));
  const checks = {
    service: check('service', has('service.active') && has('service.enabled') && isActive(get('service.active')) && isEnabled(get('service.enabled')), 'wvp-opengauss service'),
    legacyService: check('legacyService', has('legacyService.active') && has('legacyService.enabled') && !legacyActive && !legacyEnabled, 'legacy service is inactive and disabled'),
    listeners: check('listeners', has('listeners.tcp5060') && has('listeners.http18080') && positive('listeners.tcp5060') && positive('listeners.http18080'), '5060/18080'),
    datasource: check('datasource', has('datasource.driver') && has('datasource.url') && has('datasource.dialect') && has('datasource.mysqlUrl') && /postgresql/i.test(get('datasource.driver')) && /jdbc:postgresql:/i.test(get('datasource.url')) && /postgresql/i.test(get('datasource.dialect')) && /jdbc:mysql:/i.test(get('datasource.mysqlUrl')), 'PostgreSQL driver/url/dialect and MySQL URL'),
    database: check('database', has('database.reachable') && positive('database.reachable'), 'database connectivity'),
    logs: check('logs', has('logs.recentError') && positive('logs.recentError'), 'recent logs'),
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
    "printf 'service.active=%s\\n' \"$(systemctl is-active wvp-opengauss.service 2>/dev/null || true)\"",
    "printf 'service.enabled=%s\\n' \"$(systemctl is-enabled wvp-opengauss.service 2>/dev/null || true)\"",
    "printf 'legacyService.active=%s\\n' \"$(systemctl is-active wvp-pro.service 2>/dev/null || true)\"",
    "printf 'legacyService.enabled=%s\\n' \"$(systemctl is-enabled wvp-pro.service 2>/dev/null || true)\"",
    "printf 'listeners.tcp5060=%s\\n' \"$( (ss -lnt 2>/dev/null | grep -q ':5060' && echo up || echo down) || true)\"",
    "printf 'listeners.http18080=%s\\n' \"$( (ss -lnt 2>/dev/null | grep -q ':18080' && echo up || echo down) || true)\"",
    "printf 'datasource.driver=%s\\n' \"$(grep -hE 'driver-class-name:.*postgresql' /opt/wvp/config/*.yml /opt/wvp/config/*.yaml 2>/dev/null | head -n 1 || true)\"",
    "printf 'datasource.url=%s\\n' \"$(grep -hE 'url:.*jdbc:postgresql:' /opt/wvp/config/*.yml /opt/wvp/config/*.yaml 2>/dev/null | head -n 1 || true)\"",
    "printf 'datasource.dialect=%s\\n' \"$(grep -hE 'database-platform:.*PostgreSQL' /opt/wvp/config/*.yml /opt/wvp/config/*.yaml 2>/dev/null | head -n 1 || true)\"",
    "printf 'datasource.mysqlUrl=%s\\n' \"$(grep -hE 'url:.*jdbc:mysql:' /opt/wvp/config/*.yml /opt/wvp/config/*.yaml 2>/dev/null | head -n 1 || true)\"",
    "printf 'database.reachable=%s\\n' \"$( (pgrep -f 'java.*wvp' >/dev/null 2>&1 && echo ok || echo down) || true)\"",
    "printf 'logs.recentError=%s\\n' \"$( (test -d /opt/wvp/logs && echo none || echo unavailable) || true)\"",
  ].join('; ');
}

module.exports = {
  mergeDcimVideoConfig: mergeDcimVideoConfig,
  publicDcimVideoConfig: publicDcimVideoConfig,
  parseWvpRuntimeProbe: parseWvpRuntimeProbe,
  wvpRuntimeProbeCommand: wvpRuntimeProbeCommand,
};
