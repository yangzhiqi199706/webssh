'use strict';

const crypto = require('crypto');

const DEFAULT_API_BASE = 'https://127.0.0.1:18080';
const DEFAULT_TIMEOUT_MS = 6000;

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
  function count(key) { return has(key) && /^\d+$/.test(String(get(key))); }
  function enabledFlag(key) { return has(key) && /^(1|true|yes)$/i.test(String(get(key))); }
  function disabledFlag(key) { return has(key) && /^(0|false|no)$/i.test(String(get(key))); }
  const legacyActive = isActive(get('legacyService.active'));
  const legacyEnabled = isEnabled(get('legacyService.enabled'));
  const checks = {
    service: check('service', has('service.active') && has('service.enabled') && isActive(get('service.active')) && isEnabled(get('service.enabled')), 'wvp-opengauss service'),
    legacyService: check('legacyService', has('legacyService.active') && has('legacyService.enabled') && !legacyActive && !legacyEnabled, 'legacy service is inactive and disabled'),
    listeners: check('listeners', has('listeners.java_wvp') && has('listeners.http_18080') && has('listeners.sip_5060') && Number(get('listeners.java_wvp')) === 1 && Number(get('listeners.http_18080')) === 1 && Number(get('listeners.sip_5060')) === 1, 'WVP Java/HTTP 18080/SIP 5060 listeners'),
    datasource: check('datasource', enabledFlag('datasource.postgresDriver') && enabledFlag('datasource.postgresUrl') && enabledFlag('datasource.postgresDialect') && disabledFlag('datasource.mysqlUrl'), 'PostgreSQL driver/url/dialect and no MySQL URL'),
    database: check('database', count('database.wvp_app_connections') && Number(get('database.wvp_app_connections')) > 0 && count('database.wvp_device_rows') && count('database.wvp_channel_rows') && count('database.wvp_log_rows'), 'database row counts'),
    logs: check('logs', count('logs.db_error_lines') && Number(get('logs.db_error_lines')) === 0, 'recent database errors'),
  };
  const ready = Object.keys(checks).every(function (key) { return checks[key].healthy; });
  return {
    status: ready ? 'ready' : 'unhealthy',
    restartAllowed: has('legacyService.active') && has('legacyService.enabled') && !legacyActive && !legacyEnabled,
    checks: checks,
  };
}

function wvpRuntimeProbeCommand() {
  const gaussEnv = 'export GAUSSHOME=/opt/software/openGauss/app; export PATH=$GAUSSHOME/bin:$PATH; export LD_LIBRARY_PATH=$GAUSSHOME/lib:$LD_LIBRARY_PATH;';
  const configPath = '/www/media/wvp-GB28181-pro/target/classes/application-dev.yml';
  function gsqlCount(sql) {
    return "$( (runuser -u omm -- sh -c '" + gaussEnv + " gsql -d dcim -Atc \"" + sql + "\"' 2>/dev/null || echo 0) || true)";
  }
  return [
    "printf 'service.active=%s\\n' \"$(systemctl is-active wvp-opengauss.service 2>/dev/null || true)\"",
    "printf 'service.enabled=%s\\n' \"$(systemctl is-enabled wvp-opengauss.service 2>/dev/null || true)\"",
    "printf 'legacyService.active=%s\\n' \"$(systemctl is-active wvp-pro.service 2>/dev/null || true)\"",
    "printf 'legacyService.enabled=%s\\n' \"$(systemctl is-enabled wvp-pro.service 2>/dev/null || true)\"",
    "printf 'listeners.sip_5060=%s\\n' \"$(case \"$(ss -lntu 2>/dev/null | grep -cE ':5060([[:space:]]|$)' || true)\" in 0) echo 0;; *) echo 1;; esac)\"",
    "printf 'listeners.http_18080=%s\\n' \"$(case \"$(ss -lnt 2>/dev/null | grep -cE ':18080([[:space:]]|$)' || true)\" in 0) echo 0;; *) echo 1;; esac)\"",
    "printf 'listeners.java_wvp=%s\\n' \"$(case \"$(pgrep -af 'java.*wvp' 2>/dev/null | grep -c java || true)\" in 1) echo 1;; *) echo 0;; esac)\"",
    "printf 'datasource.postgresDriver=%s\\n' \"$(case \"$(grep -cE 'driver-class-name:.*postgresql' " + configPath + " 2>/dev/null | awk '{sum += $NF} END {print sum + 0}' || true)\" in 0) echo 0;; *) echo 1;; esac)\"",
    "printf 'datasource.postgresUrl=%s\\n' \"$(case \"$(grep -cF 'jdbc:postgresql://127.0.0.1:5432/dcim' " + configPath + " 2>/dev/null | awk '{sum += $NF} END {print sum + 0}' || true)\" in 0) echo 0;; *) echo 1;; esac)\"",
    "printf 'datasource.postgresDialect=%s\\n' \"$(case \"$(grep -cE 'database-platform:.*PostgreSQL' " + configPath + " 2>/dev/null | awk '{sum += $NF} END {print sum + 0}' || true)\" in 0) echo 0;; *) echo 1;; esac)\"",
    "printf 'datasource.mysqlUrl=%s\\n' \"$(case \"$(grep -cE 'url:.*jdbc:mysql:' " + configPath + " 2>/dev/null | awk '{sum += $NF} END {print sum + 0}' || true)\" in 0) echo 0;; *) echo 1;; esac)\"",
    "printf 'database.wvp_app_connections=%s\\n' \"" + gsqlCount('SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database();') + "\"",
    "printf 'database.wvp_device_rows=%s\\n' \"" + gsqlCount('SELECT COUNT(*) FROM wvp_device;') + "\"",
    "printf 'database.wvp_channel_rows=%s\\n' \"" + gsqlCount('SELECT COUNT(*) FROM wvp_device_channel;') + "\"",
    "printf 'database.wvp_log_rows=%s\\n' \"" + gsqlCount('SELECT COUNT(*) FROM wvp_log;') + "\"",
    "printf 'logs.db_error_lines=%s\\n' \"$( (journalctl -u wvp-opengauss.service --since '10 min ago' 2>/dev/null | grep -Eic 'error|exception|mysql.*jdbc' || true) || true)\"",
  ].join('; ');
}

module.exports = {
  mergeDcimVideoConfig: mergeDcimVideoConfig,
  publicDcimVideoConfig: publicDcimVideoConfig,
  parseWvpRuntimeProbe: parseWvpRuntimeProbe,
  wvpRuntimeProbeCommand: wvpRuntimeProbeCommand,
};
