'use strict';

const childProcess = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 7 * DAY_MS;
const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_SSH_TIMEOUT_MS = 10 * 1000;

function createProbeCommand() {
  return [
    "awk '/^cpu / { printf \"cpu.user=%s\\ncpu.nice=%s\\ncpu.system=%s\\ncpu.idle=%s\\n\", $2, $3, $4, $5 }' /proc/stat",
    "awk '/^MemTotal:/ { print \"mem.totalKb=\" $2 } /^MemAvailable:/ { print \"mem.availableKb=\" $2 }' /proc/meminfo",
    "awk '{ print \"load.1m=\" $1 }' /proc/loadavg",
    "awk '{ print \"uptime.seconds=\" $1 }' /proc/uptime",
    "df -Pk / | awk 'NR == 2 { print \"disk.usedKb=\" $3; print \"disk.totalKb=\" $2 }'",
    "(systemctl is-active webssh || true) | awk 'NR == 1 { print \"service.webssh=\" $1 }'",
    "(systemctl is-active webssh-protocol || true) | awk 'NR == 1 { print \"service.protocol=\" $1 }'",
    "(systemctl is-active docker || true) | awk 'NR == 1 { print \"service.docker=\" $1 }'",
    "(docker inspect -f '{{.State.Running}}' dcim || true) | awk 'NR == 1 { print \"dcim.container=\" $1 }'",
    "(docker exec dcim systemctl is-active dcim || true) | awk 'NR == 1 { print \"dcim.service=\" $1 }'",
  ].join('; ');
}

function numberValue(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(numerator, denominator) {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 100);
}

function serviceState(state) {
  const value = state === undefined || state === null || String(state).trim() === ''
    ? 'unknown'
    : String(state).trim();
  return { state: value, healthy: value === 'active' };
}

function parseProbeOutput(output) {
  const values = Object.create(null);
  String(output || '').split(/\r?\n/).forEach(function (line) {
    const index = line.indexOf('=');
    if (index < 1) return;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  });

  const cpu = {
    user: numberValue(values['cpu.user']),
    nice: numberValue(values['cpu.nice']),
    system: numberValue(values['cpu.system']),
    idle: numberValue(values['cpu.idle']),
  };
  const totalKb = numberValue(values['mem.totalKb']);
  const availableKb = numberValue(values['mem.availableKb']);
  const diskUsedKb = numberValue(values['disk.usedKb']);
  const diskTotalKb = numberValue(values['disk.totalKb']);
  const memoryUsedKb = totalKb === null || availableKb === null ? null : totalKb - availableKb;
  const dcimContainer = String(values['dcim.container'] || '').toLowerCase() === 'true';
  const dcimService = serviceState(values['dcim.service']);
  const dcim = {
    container: dcimContainer,
    state: dcimService.state,
    healthy: dcimContainer && dcimService.healthy,
  };

  return {
    cpu: cpu,
    memory: {
      totalKb: totalKb,
      availableKb: availableKb,
      usedKb: memoryUsedKb,
      percent: percent(memoryUsedKb, totalKb),
    },
    disk: {
      usedKb: diskUsedKb,
      totalKb: diskTotalKb,
      percent: percent(diskUsedKb, diskTotalKb),
    },
    load: { oneMinute: numberValue(values['load.1m']) },
    uptime: { seconds: numberValue(values['uptime.seconds']) },
    services: {
      webssh: serviceState(values['service.webssh']),
      protocol: serviceState(values['service.protocol']),
      docker: serviceState(values['service.docker']),
      dcim: dcim,
    },
    dcim: dcim,
  };
}

function cpuPercent(previous, current) {
  if (!previous || !current) return null;
  const names = ['user', 'nice', 'system', 'idle'];
  const previousTotal = names.reduce(function (total, name) {
    const value = numberValue(previous[name]);
    return value === null ? null : (total === null ? null : total + value);
  }, 0);
  const currentTotal = names.reduce(function (total, name) {
    const value = numberValue(current[name]);
    return value === null ? null : (total === null ? null : total + value);
  }, 0);
  const previousIdle = numberValue(previous.idle);
  const currentIdle = numberValue(current.idle);
  if (previousTotal === null || currentTotal === null || previousIdle === null || currentIdle === null) return null;

  const totalDelta = currentTotal - previousTotal;
  const idleDelta = currentIdle - previousIdle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  return Math.max(0, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 100)));
}

function timestampValue(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pruneHistory(history, nowMs, retentionMs) {
  let now = timestampValue(nowMs);
  let retention = numberValue(retentionMs);
  if (now === null) now = Date.now();
  if (retention === null) retention = DEFAULT_RETENTION_MS;
  const cutoff = now - Math.max(0, retention);

  return (Array.isArray(history) ? history : []).filter(function (item) {
    const sampledAt = item && (item.sampledAt !== undefined ? item.sampledAt : item.at);
    const time = timestampValue(sampledAt);
    return time !== null && time >= cutoff;
  });
}

function redactText(value) {
  return String(value)
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/([^:\s/@]+):([^@\s]+)@/gi, '$1://$2:***@')
    .replace(/\b(set-cookie|cookie)\s*[:=]\s*[^\r\n]*/gi, '$1: ***')
    .replace(/\bauthorization\s*[:=]\s*bearer\s+("[^"]*"|'[^']*'|[^\s,;\]}]+)/gi, 'Authorization: Bearer ***')
    .replace(/\bbearer\s*[:=]?\s*("[^"]*"|'[^']*'|[^\s,;\]}]+)/gi, 'Bearer ***')
    .replace(/\b(password|passphrase|credential)\s+is\s+("[^"]*"|'[^']*'|[^\s,;\]}]+)/gi, '$1 is ***')
    .replace(/\b(password|token|secret|key|passphrase|credential)\s*(?:[=:]|\s+)\s*("[^"]*"|'[^']*'|[^\s,;\]}]+)/gi, '$1: ***');
}

function toPublicSnapshot(value, seen) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: redactText(value.message || String(value)) };

  const visited = seen || [];
  if (visited.indexOf(value) >= 0) return '[circular]';
  visited.push(value);

  let result;
  if (Array.isArray(value)) {
    result = value.map(function (item) { return toPublicSnapshot(item, visited); });
  } else {
    result = {};
    Object.keys(value).forEach(function (name) {
      if (/(password|token|secret|key|passphrase|credential|authorization|cookie)/i.test(name)) return;
      result[name] = toPublicSnapshot(value[name], visited);
    });
  }
  visited.pop();
  return result;
}

function createCollector(options) {
  const collectOnce = options && options.collectOnce;
  if (typeof collectOnce !== 'function') throw new TypeError('collectOnce 必须是函数');
  let inFlight = null;
  let latest = null;

  function refresh() {
    if (inFlight) return inFlight;
    const active = Promise.resolve().then(function () { return collectOnce(); });
    inFlight = active;
    active.then(function (result) {
      latest = result;
      if (inFlight === active) inFlight = null;
    }, function () {
      if (inFlight === active) inFlight = null;
    });
    return active;
  }

  return {
    refresh: refresh,
    getSnapshot: function () { return latest; },
  };
}

function currentTime(now) {
  const value = typeof now === 'function' ? now() : now;
  const timestamp = timestampValue(value);
  return timestamp === null ? Date.now() : timestamp;
}

function defaultLocalRunner(spawn, command) {
  return new Promise(function (resolve, reject) {
    let child;
    try {
      child = spawn('sh', ['-lc', command]);
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', function (chunk) { stdout += chunk; });
    if (child.stderr) child.stderr.on('data', function (chunk) { stderr += chunk; });
    child.once('error', reject);
    child.once('close', function (code) {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || ('probe command exited with code ' + code)));
    });
  });
}

function defaultPeerRunner(Client, ssh, command, timeoutMs) {
  return new Promise(function (resolve, reject) {
    if (typeof Client !== 'function') {
      reject(new Error('SSH 客户端不可用'));
      return;
    }
    let client;
    try {
      client = new Client();
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    let timeout = setTimeout(function () {
      finish(new Error('SSH 探针超时'));
    }, timeoutMs);
    function finish(err, output) {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      try { client.end(); } catch (_err) {}
      if (err) reject(err);
      else resolve(output);
    }

    client.once('ready', function () {
      if (settled) return;
      try {
        client.exec(command, function (err, stream) {
          if (settled) return;
          if (err) return finish(err);
          if (!stream) return finish(new Error('SSH 探针未返回数据流'));
          let stdout = '';
          let stderr = '';
          stream.on('data', function (chunk) { stdout += chunk; });
          if (stream.stderr) {
            stream.stderr.on('data', function (chunk) { stderr += chunk; });
            stream.stderr.once('error', finish);
          }
          stream.once('error', finish);
          stream.once('end', function () { finish(null, stdout); });
          stream.once('close', function (code) {
            if (code === 0 || code === undefined || code === null) finish(null, stdout);
            else finish(new Error(stderr || ('remote probe command exited with code ' + code)));
          });
        });
      } catch (err) {
        finish(err);
      }
    });
    client.once('error', finish);
    client.once('close', function () { finish(new Error('SSH 连接已关闭')); });
    client.once('end', function () { finish(new Error('SSH 连接已结束')); });
    try {
      client.connect({
        host: ssh.host,
        port: Number(ssh.port) || 22,
        username: ssh.user || ssh.username,
        password: ssh.password,
        readyTimeout: 8000,
      });
    } catch (err) {
      finish(err);
    }
  });
}

function createServiceOverview(options) {
  options = options || {};
  const fs = options.fs || require('fs');
  const path = options.path || require('path');
  const spawn = options.spawn || childProcess.spawn;
  const Client = options.Client;
  const historyPath = options.historyPath;
  const haConfigPath = options.haConfigPath;
  const intervalMs = numberValue(options.intervalMs) || DEFAULT_INTERVAL_MS;
  const retentionMs = numberValue(options.retentionMs) || DEFAULT_RETENTION_MS;
  const configuredSshTimeoutMs = numberValue(options.sshTimeoutMs);
  const sshTimeoutMs = configuredSshTimeoutMs !== null && configuredSshTimeoutMs > 0
    ? configuredSshTimeoutMs
    : DEFAULT_SSH_TIMEOUT_MS;
  const command = createProbeCommand();
  let timer = null;
  let latest = null;
  let previousLocalCpu = null;
  let previousPeerCpu = null;
  let history = loadHistory();

  function loadHistory() {
    if (!historyPath) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      const records = Array.isArray(parsed) ? parsed : [];
      const pruned = pruneHistory(records, currentTime(options.now), retentionMs);
      if (pruned.length !== records.length) writeHistoryRecords(pruned);
      return pruned;
    } catch (_err) {
      return [];
    }
  }

  function writeHistoryRecords(records) {
    if (!historyPath) return;
    const directory = path.dirname(historyPath);
    if (typeof fs.mkdirSync === 'function') fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = historyPath + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(temporaryPath, JSON.stringify(records, null, 2), 'utf8');
    fs.renameSync(temporaryPath, historyPath);
  }

  function writeHistory() {
    writeHistoryRecords(history);
  }

  function readHaConfig() {
    if (!haConfigPath) return null;
    try {
      return JSON.parse(fs.readFileSync(haConfigPath, 'utf8'));
    } catch (_err) {
      return null;
    }
  }

  function runProbe(target, ssh) {
    if (typeof options.runner === 'function') {
      return Promise.resolve(options.runner(command, { target: target, ssh: ssh || null }));
    }
    if (target === 'peer') return defaultPeerRunner(Client, ssh, command, sshTimeoutMs);
    return defaultLocalRunner(spawn, command);
  }

  function collectTarget(target, ssh, previousCpu) {
    return runProbe(target, ssh).then(function (output) {
      const metrics = parseProbeOutput(output);
      metrics.cpu.percent = cpuPercent(previousCpu, metrics.cpu);
      return { status: 'ok', metrics: metrics };
    }, function (err) {
      return {
        status: 'unknown',
        error: redactText(err && err.message ? err.message : err),
      };
    });
  }

  function collectOnce() {
    const config = readHaConfig();
    const selfRole = config && config.selfRole === 'primary' ? 'primary' : 'standby';
    const peerRole = selfRole === 'primary' ? 'standby' : 'primary';
    const peerSsh = config && config[peerRole] && config[peerRole].ssh;
    const localPromise = collectTarget('local', null, previousLocalCpu);
    const peerPromise = peerSsh
      ? collectTarget('peer', peerSsh, previousPeerCpu)
      : Promise.resolve({ status: 'unknown', error: '未配置对端 SSH' });

    return Promise.all([localPromise, peerPromise]).then(function (targets) {
      const local = targets[0];
      const peer = targets[1];
      if (local.status === 'ok') previousLocalCpu = local.metrics.cpu;
      if (peer.status === 'ok') previousPeerCpu = peer.metrics.cpu;

      const sampledAt = new Date(currentTime(options.now)).toISOString();
      latest = toPublicSnapshot({
        sampledAt: sampledAt,
        selfRole: selfRole,
        local: local.status === 'ok' ? local.metrics : local,
        peer: peer.status === 'ok' ? peer.metrics : peer,
      });
      history = pruneHistory(history.concat([latest]), currentTime(options.now), retentionMs);
      writeHistory();
      return latest;
    });
  }

  const collector = createCollector({ collectOnce: collectOnce });

  return {
    start: function () {
      if (timer) return;
      collector.refresh().catch(function () {});
      timer = setInterval(function () { collector.refresh().catch(function () {}); }, intervalMs);
    },
    stop: function () {
      if (timer) clearInterval(timer);
      timer = null;
    },
    refresh: function () { return collector.refresh(); },
    getSnapshot: function () { return toPublicSnapshot(latest); },
    getHistory: function () { return toPublicSnapshot(history); },
  };
}

module.exports = {
  createProbeCommand: createProbeCommand,
  parseProbeOutput: parseProbeOutput,
  cpuPercent: cpuPercent,
  pruneHistory: pruneHistory,
  toPublicSnapshot: toPublicSnapshot,
  createCollector: createCollector,
  createServiceOverview: createServiceOverview,
};
