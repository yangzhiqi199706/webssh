'use strict';

const WVP_RESTART_COMMAND = [
  "legacy_active=$(systemctl is-active wvp-pro.service 2>/dev/null || true)",
  "legacy_enabled=$(systemctl is-enabled wvp-pro.service 2>/dev/null || true)",
  "if [ \"$legacy_active\" = \"inactive\" ] && [ \"$legacy_enabled\" = \"disabled\" ]; then systemctl restart wvp-opengauss.service 2>&1; else exit 75; fi",
].join('; ');
const CHECK_NAMES = ['service', 'legacyService', 'listeners', 'datasource', 'database', 'logs'];
const MAX_POLL_ATTEMPTS = 15;
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_RESTART_DEADLINE_MS = 30000;
const LEGACY_CONFLICT_EXIT_CODE = 75;

function safeCode(value) {
  return Number.isInteger(value) ? value : -1;
}

function safeSummary(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 160 || !/^[A-Za-z0-9 .,:/()+-]+$/.test(text)) return 'unavailable';
  if (/password|secret|jdbc|stdout|stderr|command|raw|token|env/i.test(text)) return 'unavailable';
  return text;
}

function publicStatus(value) {
  const source = value && typeof value === 'object' ? value : {};
  const sourceChecks = source.checks && typeof source.checks === 'object' ? source.checks : {};
  const checks = {};
  CHECK_NAMES.forEach(function (name) {
    const sourceCheck = sourceChecks[name] && typeof sourceChecks[name] === 'object' ? sourceChecks[name] : {};
    checks[name] = {
      name: name,
      healthy: Boolean(sourceCheck.healthy),
      detail: safeSummary(sourceCheck.detail),
      summary: safeSummary(sourceCheck.summary),
    };
  });
  const ready = Boolean(source.ready) && CHECK_NAMES.every(function (name) { return checks[name].healthy; });
  const status = source.status === 'unavailable' || !source.status ? 'unavailable' : (ready ? 'ready' : 'unhealthy');
  return {
    status: status,
    ready: ready,
    restartAllowed: Boolean(source.restartAllowed),
    checks: checks,
  };
}

function publicRuntime(value) {
  const source = value && typeof value === 'object' ? value : {};
  const sshCode = safeCode(source.sshCode);
  return {
    ok: Boolean(source.ok) && sshCode === 0,
    sshCode: sshCode,
    status: publicStatus(source.status),
  };
}

function coreReady(runtime) {
  const checks = runtime.status && runtime.status.checks ? runtime.status.checks : {};
  return Boolean(checks.service && checks.service.healthy && checks.listeners && checks.listeners.healthy);
}

function unavailableRuntime() {
  return publicRuntime(null);
}

function isSshUnavailable(runtime) {
  return !runtime.ok || runtime.sshCode !== 0;
}

function legacyConflictStatus(status) {
  const conflict = publicStatus(status);
  conflict.status = 'unhealthy';
  conflict.ready = false;
  conflict.restartAllowed = false;
  conflict.checks.legacyService.healthy = false;
  conflict.checks.legacyService.summary = 'legacy conflict';
  return conflict;
}

function createSshCommandRunner(ClientCtor) {
  if (typeof ClientCtor !== 'function') throw new Error('Client constructor is required');
  return function runSshCommand(cfg, command, callback) {
    const client = new ClientCtor();
    const timeoutMs = Number(cfg && cfg.commandTimeoutMs);
    let stream = null;
    let timer = null;
    let finished = false;

    function closeChannel(channel) {
      if (!channel) return;
      try { if (typeof channel.close === 'function') channel.close(); } catch (_e) {}
      try { if (typeof channel.destroy === 'function') channel.destroy(); } catch (_e) {}
    }
    function closeClient(forceDestroy) {
      if (forceDestroy) {
        try {
          if (typeof client.destroy === 'function') {
            client.destroy();
            return;
          }
        } catch (_e) {}
      }
      try { client.end(); } catch (_e) {}
    }
    function finish(error, result, shouldCloseChannel, forceDestroy) {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (shouldCloseChannel) closeChannel(stream);
      closeClient(forceDestroy);
      callback(error, result);
    }
    function timeout() {
      const error = new Error('SSH command timed out');
      error.code = 'SSH_COMMAND_TIMEOUT';
      finish(error, null, true, true);
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(timeout, timeoutMs);
    client.on('ready', function () {
      if (finished) return;
      try {
        client.exec(command, function (error, channel) {
          if (finished) {
            closeChannel(channel);
            return;
          }
          if (error) { finish(error); return; }
          stream = channel;
          let stdout = '';
          let stderr = '';
          stream.on('data', function (data) { stdout += data.toString('utf8'); });
          stream.stderr.on('data', function (data) { stderr += data.toString('utf8'); });
          stream.on('close', function (code, signal) {
            finish(null, {
              code: typeof code === 'number' ? code : -1,
              signal: signal || null,
              stdout: stdout.trim(),
              stderr: stderr.trim(),
            });
          });
          stream.on('error', function (error) { finish(error); });
        });
      } catch (error) {
        if (!finished) finish(error);
      }
    });
    client.on('error', function (error) { finish(error); });
    client.on('end', function () {
      if (!finished) finish(new Error('SSH connection ended prematurely'));
    });
    client.connect({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      password: cfg.password,
      readyTimeout: 10000,
    });
  };
}

function createWvpRuntimeOperations(deps) {
  const options = deps || {};
  if (typeof options.collect !== 'function' || typeof options.restartService !== 'function' || typeof options.sleep !== 'function') {
    throw new Error('collect, restartService and sleep are required');
  }
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const restartDeadlineMs = Number.isInteger(options.restartDeadlineMs) && options.restartDeadlineMs > 0 ? options.restartDeadlineMs : DEFAULT_RESTART_DEADLINE_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  function remainingTimeout(deadlineAt) {
    const remaining = deadlineAt == null ? timeoutMs : deadlineAt - now();
    return remaining > 0 ? Math.min(timeoutMs, remaining) : 0;
  }

  async function collectWithTimeout(deadlineAt) {
    const activeTimeoutMs = remainingTimeout(deadlineAt);
    if (!activeTimeoutMs) return { runtime: unavailableRuntime(), timedOut: true };
    try {
      const value = await options.collect({ timeoutMs: activeTimeoutMs });
      if (value && (value.timedOut || value.code === 124 || value.sshCode === 124)) {
        return { runtime: unavailableRuntime(), timedOut: true };
      }
      return { runtime: publicRuntime(value), timedOut: false };
    } catch (_e) {
      return { runtime: unavailableRuntime(), timedOut: false };
    }
  }

  function restartTimeoutResult() {
    return { statusCode: 504, ok: false, restartCode: -1, status: unavailableRuntime().status };
  }

  async function readStatus() {
    const result = await collectWithTimeout(null);
    return Object.assign({}, result.runtime, { timedOut: result.timedOut });
  }

  async function restart() {
    const deadlineAt = now() + restartDeadlineMs;
    const beforeResult = await collectWithTimeout(deadlineAt);
    if (beforeResult.timedOut) return restartTimeoutResult();
    const before = beforeResult.runtime;
    if (isSshUnavailable(before)) {
      return { statusCode: 503, ok: false, restartCode: -1, status: before.status };
    }
    if (!before.status.restartAllowed) {
      return { statusCode: 409, ok: false, restartCode: null, status: before.status };
    }

    const restartTimeoutMs = remainingTimeout(deadlineAt);
    if (!restartTimeoutMs) return restartTimeoutResult();
    let restartValue;
    try {
      restartValue = await options.restartService(WVP_RESTART_COMMAND, { timeoutMs: restartTimeoutMs });
    } catch (_e) {
      return { statusCode: 503, ok: false, restartCode: -1, status: unavailableRuntime().status };
    }
    const restartCode = safeCode(restartValue && restartValue.code);
    if (restartCode === 124 || (restartValue && restartValue.timedOut)) return restartTimeoutResult();

    if (restartCode === LEGACY_CONFLICT_EXIT_CODE) {
      return { statusCode: 409, ok: false, restartCode: restartCode, status: legacyConflictStatus(before.status) };
    }

    if (restartCode !== 0) {
      const afterFailure = await collectWithTimeout(deadlineAt);
      if (afterFailure.timedOut) return restartTimeoutResult();
      if (isSshUnavailable(afterFailure.runtime)) {
        return { statusCode: 503, ok: false, restartCode: restartCode, status: afterFailure.runtime.status };
      }
      return { statusCode: 502, ok: false, restartCode: restartCode, status: afterFailure.runtime.status };
    }

    let after = null;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const sleepTimeoutMs = remainingTimeout(deadlineAt);
      if (!sleepTimeoutMs) return restartTimeoutResult();
      try {
        await options.sleep(Math.min(1000, sleepTimeoutMs));
      } catch (_e) {
        return restartTimeoutResult();
      }
      const poll = await collectWithTimeout(deadlineAt);
      if (poll.timedOut) return restartTimeoutResult();
      after = poll.runtime;
      if (isSshUnavailable(after)) {
        return { statusCode: 503, ok: false, restartCode: restartCode, status: after.status };
      }
      if (coreReady(after)) break;
    }
    if (!after || !coreReady(after)) {
      if (remainingTimeout(deadlineAt) === 0) return restartTimeoutResult();
      return { statusCode: 502, ok: false, restartCode: restartCode, status: (after || unavailableRuntime()).status };
    }
    return {
      statusCode: 200,
      ok: true,
      restartCode: restartCode,
      status: after.status,
    };
  }

  return { readStatus: readStatus, restart: restart };
}

function registerWvpRuntimeRoutes(app, deps) {
  const options = deps || {};
  const runtimeOperations = options.runtimeOperations;
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express app is required');
  }
  if (!runtimeOperations || typeof runtimeOperations.readStatus !== 'function' || typeof runtimeOperations.restart !== 'function') {
    throw new Error('runtimeOperations is required');
  }
  if (typeof options.isAuthed !== 'function') throw new Error('isAuthed is required');
  const appendLog = typeof options.appendLog === 'function' ? options.appendLog : function () {};
  const runtimeSummary = typeof options.runtimeSummary === 'function' ? options.runtimeSummary : function () { return ''; };

  app.get('/api/db-manager/opengauss/wvp/runtime-status', async function (_req, res) {
    const runtime = await runtimeOperations.readStatus();
    appendLog('wvp/runtime-status ' + runtimeSummary(runtime));
    const statusCode = runtime.timedOut ? 504 : (runtime.ok ? 200 : 503);
    res.status(statusCode).json(runtime);
  });

  app.post('/api/db-manager/opengauss/wvp/restart', async function (req, res) {
    if (!options.isAuthed(req)) {
      return res.status(401).json({ ok: false, message: '请先登录' });
    }
    const result = await runtimeOperations.restart();
    appendLog('wvp/restart code=' + result.restartCode + ' coreReady=' + result.ok +
      ' ' + runtimeSummary({ sshCode: null, status: result.status }));
    res.status(result.statusCode).json({
      ok: result.ok,
      restartCode: result.restartCode,
      statusCode: result.statusCode,
      status: result.status,
    });
  });
}

module.exports = {
  createSshCommandRunner: createSshCommandRunner,
  createWvpRuntimeOperations: createWvpRuntimeOperations,
  registerWvpRuntimeRoutes: registerWvpRuntimeRoutes,
};
