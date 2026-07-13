'use strict';

const crypto = require('crypto');

const DEFAULT_API_BASE = 'https://127.0.0.1:18080';
const DEFAULT_TIMEOUT_MS = 6000;

function normalizeApiBase(value) {
  const raw = value == null || value === '' ? DEFAULT_API_BASE : String(value);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new Error('DCIM video apiBase must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('DCIM video apiBase must use HTTPS');
  }
  return parsed.origin;
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

function check(name, healthy, detail, summary) {
  return { name: name, healthy: Boolean(healthy), detail: detail || '', summary: summary || '' };
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
  const serviceReady = has('service.active') && has('service.enabled') && isActive(get('service.active')) && isEnabled(get('service.enabled'));
  const legacyReady = has('legacyService.active') && has('legacyService.enabled') && !legacyActive && !legacyEnabled;
  const listenersReady = has('listeners.java_wvp') && has('listeners.http_18080') && has('listeners.sip_5060') && Number(get('listeners.java_wvp')) === 1 && Number(get('listeners.http_18080')) === 1 && Number(get('listeners.sip_5060')) === 1;
  const datasourceReady = enabledFlag('datasource.postgresDriver') && enabledFlag('datasource.postgresUrl') && enabledFlag('datasource.postgresDialect') && disabledFlag('datasource.mysqlUrl');
  const databaseReady = count('database.wvp_app_connections') && Number(get('database.wvp_app_connections')) > 0 && count('database.wvp_device_rows') && Number(get('database.wvp_device_rows')) > 0 && count('database.wvp_channel_rows') && Number(get('database.wvp_channel_rows')) > 0 && count('database.wvp_log_rows') && Number(get('database.wvp_log_rows')) > 0;
  const logsReady = count('logs.db_error_lines') && Number(get('logs.db_error_lines')) === 0;
  const safeCount = function (key) { return count(key) ? String(Number(get(key))) : '不可用'; };
  const checks = {
    service: check('service', serviceReady, 'wvp-opengauss service', serviceReady ? 'active and enabled' : 'service unavailable'),
    legacyService: check('legacyService', legacyReady, 'legacy service is inactive and disabled', legacyReady ? 'inactive and disabled' : 'legacy conflict or unavailable'),
    listeners: check('listeners', listenersReady, 'WVP Java/HTTP 18080/SIP 5060 listeners', 'Java/18080/5060: ' + safeCount('listeners.java_wvp') + '/' + safeCount('listeners.http_18080') + '/' + safeCount('listeners.sip_5060')),
    datasource: check('datasource', datasourceReady, 'PostgreSQL driver/url/dialect and no MySQL URL', datasourceReady ? 'PostgreSQL config matches' : 'datasource check failed'),
    database: check('database', databaseReady, 'database row counts', 'connections/devices/channels/logs: ' + safeCount('database.wvp_app_connections') + '/' + safeCount('database.wvp_device_rows') + '/' + safeCount('database.wvp_channel_rows') + '/' + safeCount('database.wvp_log_rows')),
    logs: check('logs', logsReady, 'recent database errors', 'DB errors in last 10 min: ' + safeCount('logs.db_error_lines')),
  };
  const ready = Object.keys(checks).every(function (key) { return checks[key].healthy; });
  return {
    status: ready ? 'ready' : 'unhealthy',
    ready: ready,
    restartAllowed: has('legacyService.active') && has('legacyService.enabled') && !legacyActive && !legacyEnabled,
    checks: checks,
  };
}

function wvpRuntimeStatusFromSshResult(result) {
  const sshCode = result && Number.isInteger(result.code) ? result.code : -1;
  if (sshCode !== 0) {
    const status = parseWvpRuntimeProbe('');
    status.status = 'unavailable';
    return { ok: false, sshCode: sshCode, status: status };
  }
  return {
    ok: true,
    sshCode: sshCode,
    status: parseWvpRuntimeProbe(result && result.stdout),
  };
}

function wvpRuntimeProbeCommand() {
  const gaussEnv = 'export GAUSSHOME=/opt/software/openGauss/app; export PATH=$GAUSSHOME/bin:$PATH; export LD_LIBRARY_PATH=$GAUSSHOME/lib:$LD_LIBRARY_PATH;';
  const configPath = '/www/media/wvp-GB28181-pro/target/classes/application-dev.yml';
  const driverPattern = "^[[:space:]]*driver-class-name:[[:space:]]*org[.]postgresql[.]Driver[[:space:]]*(#.*)?$";
  const urlPattern = "^[[:space:]]*url:[[:space:]]*jdbc:postgresql://127.0.0.1:5432/dcim([?][^[:space:]#]*)?[[:space:]]*(#.*)?$";
  const dialectPattern = "^[[:space:]]*helper-dialect:[[:space:]]*postgresql[[:space:]]*(#.*)?$";
  const mysqlPattern = "^[[:space:]]*url:[[:space:]]*jdbc:mysql:([^[:space:]#]*)[[:space:]]*(#.*)?$";
  function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
  }
  function yamlFlag(pattern) {
    return "$(grep -cE '" + pattern + "' " + configPath + " 2>/dev/null | awk '{sum += $NF} END {print (sum > 0 ? 1 : 0)}' || true)";
  }
  function gsqlCount(sql) {
    const script = gaussEnv + ' gsql -d dcim -Atc ' + shellQuote(sql);
    return "$(runuser -u omm -- sh -c " + shellQuote(script) + " 2>/dev/null || printf '%s\\n' -1)";
  }
  return [
    "printf 'service.active=%s\\n' \"$(systemctl is-active wvp-opengauss.service 2>/dev/null || true)\"",
    "printf 'service.enabled=%s\\n' \"$(systemctl is-enabled wvp-opengauss.service 2>/dev/null || true)\"",
    "printf 'legacyService.active=%s\\n' \"$(systemctl is-active wvp-pro.service 2>/dev/null || true)\"",
    "printf 'legacyService.enabled=%s\\n' \"$(systemctl is-enabled wvp-pro.service 2>/dev/null || true)\"",
    "printf 'listeners.sip_5060=%s\\n' \"$(ss -lntu 2>/dev/null | grep -cE ':5060([[:space:]]|$)' | awk '{print ($1 > 0 ? 1 : 0)}' || true)\"",
    "printf 'listeners.http_18080=%s\\n' \"$(ss -lnt 2>/dev/null | grep -cE ':18080([[:space:]]|$)' | awk '{print ($1 > 0 ? 1 : 0)}' || true)\"",
    "printf 'listeners.java_wvp=%s\\n' \"$(ps -eo args= 2>/dev/null | grep '[w]vp-pro-2.6.9-06021439.jar' | grep -c '[w]vp-pro-2.6.9-06021439.jar' | awk '{print ($1 == 1 ? 1 : 0)}' || true)\"",
    "printf 'datasource.postgresDriver=%s\\n' \"" + yamlFlag(driverPattern) + "\"",
    "printf 'datasource.postgresUrl=%s\\n' \"" + yamlFlag(urlPattern) + "\"",
    "printf 'datasource.postgresDialect=%s\\n' \"" + yamlFlag(dialectPattern) + "\"",
    "printf 'datasource.mysqlUrl=%s\\n' \"" + yamlFlag(mysqlPattern) + "\"",
    "printf 'database.wvp_app_connections=%s\\n' \"" + gsqlCount("SELECT COUNT(*) FROM pg_stat_activity WHERE usename='wvp_app' AND datname='dcim';") + "\"",
    "printf 'database.wvp_device_rows=%s\\n' \"" + gsqlCount('SELECT COUNT(*) FROM wvp_device;') + "\"",
    "printf 'database.wvp_channel_rows=%s\\n' \"" + gsqlCount('SELECT COUNT(*) FROM wvp_device_channel;') + "\"",
    "printf 'database.wvp_log_rows=%s\\n' \"" + gsqlCount('SELECT COUNT(*) FROM wvp_log;') + "\"",
    "journalctl_status=0; journalctl_probe=$(journalctl -u wvp-opengauss.service --since '10 min ago' 2>/dev/null) || journalctl_status=$?; if [ \"$journalctl_status\" -ne 0 ]; then printf 'logs.db_error_lines=-1\\n'; else printf 'logs.db_error_lines=%s\\n' \"$(printf '%s\\n' \"$journalctl_probe\" | grep -Eic 'error|exception|mysql.*jdbc' || true)\"; fi",
  ].join('; ');
}

module.exports = {
  mergeDcimVideoConfig: mergeDcimVideoConfig,
  publicDcimVideoConfig: publicDcimVideoConfig,
  parseWvpRuntimeProbe: parseWvpRuntimeProbe,
  wvpRuntimeStatusFromSshResult: wvpRuntimeStatusFromSshResult,
  wvpRuntimeProbeCommand: wvpRuntimeProbeCommand,
};
