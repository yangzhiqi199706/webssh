'use strict';

const WVP_RESTART_COMMAND = 'systemctl restart wvp-opengauss.service 2>&1';
const CHECK_NAMES = ['service', 'legacyService', 'listeners', 'datasource', 'database', 'logs'];
const MAX_POLL_ATTEMPTS = 15;

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
  const status = source.status === 'unavailable' ? 'unavailable' : (ready ? 'ready' : 'unhealthy');
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

function createWvpRuntimeOperations(deps) {
  const options = deps || {};
  if (typeof options.collect !== 'function' || typeof options.restartService !== 'function' || typeof options.sleep !== 'function') {
    throw new Error('collect, restartService and sleep are required');
  }

  async function readStatus() {
    try {
      return publicRuntime(await options.collect());
    } catch (_e) {
      return publicRuntime(null);
    }
  }

  async function restart() {
    const before = await readStatus();
    if (!before.status.restartAllowed) {
      return { statusCode: 409, ok: false, restartCode: null, status: before.status };
    }

    let restartCode = -1;
    try {
      restartCode = safeCode((await options.restartService(WVP_RESTART_COMMAND)).code);
    } catch (_e) {}

    if (restartCode !== 0) {
      const afterFailure = await readStatus();
      return { statusCode: 200, ok: false, restartCode: restartCode, status: afterFailure.status };
    }

    let after = null;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      await options.sleep(1000);
      after = await readStatus();
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
