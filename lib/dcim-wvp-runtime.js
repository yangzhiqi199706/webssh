'use strict';

const WVP_RESTART_COMMAND = [
  "legacy_active=$(systemctl is-active wvp-pro.service 2>/dev/null || true)",
  "legacy_enabled=$(systemctl is-enabled wvp-pro.service 2>/dev/null || true)",
  "if [ \"$legacy_active\" = \"inactive\" ] && [ \"$legacy_enabled\" = \"disabled\" ]; then systemctl restart wvp-opengauss.service 2>&1; else exit 75; fi",
].join('; ');
const CHECK_NAMES = ['service', 'legacyService', 'listeners', 'datasource', 'database', 'logs'];
const MAX_POLL_ATTEMPTS = 15;
const DEFAULT_TIMEOUT_MS = 12000;
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

function legacyConflictStatus(status) {
  const conflict = publicStatus(status);
  conflict.status = 'unhealthy';
  conflict.ready = false;
  conflict.restartAllowed = false;
  conflict.checks.legacyService.healthy = false;
  conflict.checks.legacyService.summary = 'legacy conflict';
  return conflict;
}

async function withTimeout(operation, timeoutMs) {
  let timer;
  const work = Promise.resolve().then(operation).then(
    function (value) { return { type: 'value', value: value }; },
    function () { return { type: 'error' }; }
  );
  const timeout = new Promise(function (resolve) {
    timer = setTimeout(function () { resolve({ type: 'timeout' }); }, timeoutMs);
  });
  const result = await Promise.race([work, timeout]);
  clearTimeout(timer);
  return result;
}

function createWvpRuntimeOperations(deps) {
  const options = deps || {};
  if (typeof options.collect !== 'function' || typeof options.restartService !== 'function' || typeof options.sleep !== 'function') {
    throw new Error('collect, restartService and sleep are required');
  }
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  async function collectWithTimeout() {
    const result = await withTimeout(options.collect, timeoutMs);
    if (result.type !== 'value') return { runtime: unavailableRuntime(), timedOut: result.type === 'timeout' };
    return { runtime: publicRuntime(result.value), timedOut: false };
  }

  function restartTimeoutResult() {
    return { statusCode: 504, ok: false, restartCode: -1, status: unavailableRuntime().status };
  }

  async function readStatus() {
    return (await collectWithTimeout()).runtime;
  }

  async function restart() {
    const beforeResult = await collectWithTimeout();
    if (beforeResult.timedOut) return restartTimeoutResult();
    const before = beforeResult.runtime;
    if (!before.status.restartAllowed) {
      return { statusCode: 409, ok: false, restartCode: null, status: before.status };
    }

    const restartResult = await withTimeout(function () { return options.restartService(WVP_RESTART_COMMAND); }, timeoutMs);
    if (restartResult.type !== 'value') return restartTimeoutResult();
    const restartCode = safeCode(restartResult.value && restartResult.value.code);

    if (restartCode === LEGACY_CONFLICT_EXIT_CODE) {
      return { statusCode: 409, ok: false, restartCode: restartCode, status: legacyConflictStatus(before.status) };
    }

    if (restartCode !== 0) {
      const afterFailure = await collectWithTimeout();
      if (afterFailure.timedOut) return restartTimeoutResult();
      return { statusCode: 200, ok: false, restartCode: restartCode, status: afterFailure.runtime.status };
    }

    let after = null;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const sleepResult = await withTimeout(function () { return options.sleep(1000); }, timeoutMs);
      if (sleepResult.type !== 'value') return restartTimeoutResult();
      const poll = await collectWithTimeout();
      if (poll.timedOut) return restartTimeoutResult();
      after = poll.runtime;
      if (coreReady(after)) break;
    }
    return {
      statusCode: 200,
      ok: Boolean(after && coreReady(after)),
      restartCode: restartCode,
      status: (after || await readStatus()).status,
    };
  }

  return { readStatus: readStatus, restart: restart };
}

module.exports = {
  createWvpRuntimeOperations: createWvpRuntimeOperations,
};
