'use strict';

const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 10080;

function localStamp(now) {
  const date = new Date(now === undefined ? Date.now() : now);
  const pad = function (value) { return String(value).padStart(2, '0'); };
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function clampInterval(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, Math.floor(numeric)));
}

function normalizeConfig(value) {
  const source = value || {};
  return {
    enabled: Boolean(source.enabled),
    intervalMinutes: clampInterval(source.intervalMinutes),
    lastResult: source.lastResult || null,
  };
}

function createDockerScheduledRestart(options) {
  const opts = options || {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const setTimer = typeof opts.setTimeout === 'function' ? opts.setTimeout : setTimeout;
  const clearTimer = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : clearTimeout;
  const spawnProcess = typeof opts.spawn === 'function'
    ? opts.spawn
    : function () { return require('child_process').spawn.apply(require('child_process'), arguments); };
  const loadConfig = typeof opts.loadConfig === 'function' ? opts.loadConfig : function () { return {}; };
  const saveConfig = typeof opts.saveConfig === 'function' ? opts.saveConfig : function () {};
  const appendLog = typeof opts.appendLog === 'function' ? opts.appendLog : function () {};
  const beforeRestart = typeof opts.beforeRestart === 'function' ? opts.beforeRestart : function () {};
  const afterRestart = typeof opts.afterRestart === 'function' ? opts.afterRestart : function () {};

  let config = normalizeConfig(loadConfig());
  let timer = null;
  let deadlineMs = 0;
  let running = false;

  function persist() {
    saveConfig(Object.assign({}, config));
  }

  function cancelTimer(reason) {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
    deadlineMs = 0;
    appendLog('Docker 定时重启倒计时取消：' + (reason || ''));
  }

  function scheduleCountdown(reason) {
    cancelTimer('replaced');
    if (!config.enabled) return;
    const intervalSec = config.intervalMinutes * 60;
    deadlineMs = now() + intervalSec * 1000;
    appendLog('Docker 定时重启倒计时开始：' + config.intervalMinutes + ' 分钟，触发来源=' + (reason || 'unknown'));
    timer = setTimer(function () {
      timer = null;
      deadlineMs = 0;
      runRestart('countdown');
    }, intervalSec * 1000);
  }

  function resultFromError(trigger, startedAt, error) {
    return {
      ok: false,
      exitCode: null,
      trigger: trigger,
      startedAt: startedAt,
      finishedAt: localStamp(now()),
      stdout: '',
      stderr: 'spawn error: ' + error.message,
    };
  }

  function runRestart(trigger) {
    if (running) return Promise.resolve({ ok: false, message: 'already-running' });
    running = true;
    const startedAt = localStamp(now());
    appendLog('执行 systemctl restart docker（触发=' + trigger + '）');
    try { beforeRestart('docker-scheduled-restart:' + trigger); } catch (_error) {}

    return new Promise(function (resolve) {
      let child;
      try {
        child = spawnProcess('systemctl', ['restart', 'docker']);
      } catch (error) {
        running = false;
        const result = resultFromError(trigger, startedAt, error);
        config.lastResult = result;
        persist();
        appendLog('Docker 定时重启执行错误：' + error.message);
        try { afterRestart('docker-scheduled-restart:' + trigger + ':spawn-error'); } catch (_error) {}
        resolve(result);
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', function (buffer) { stdout += buffer.toString('utf8'); });
      }
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', function (buffer) { stderr += buffer.toString('utf8'); });
      }
      function finish(result, afterReason) {
        if (settled) return;
        settled = true;
        running = false;
        config.lastResult = result;
        persist();
        appendLog('Docker 定时重启执行完成 exit=' + result.exitCode + ' ok=' + result.ok);
        try { afterRestart(afterReason); } catch (_error) {}
        if (result.ok && config.enabled) {
          scheduleCountdown('restart-success');
          appendLog('Docker 定时重启成功，已安排下一轮倒计时');
        }
        resolve(result);
      }
      child.on('close', function (code) {
        finish({
          ok: code === 0,
          exitCode: code,
          trigger: trigger,
          startedAt: startedAt,
          finishedAt: localStamp(now()),
          stdout: stdout.slice(-2000),
          stderr: stderr.slice(-2000),
        }, 'docker-scheduled-restart:' + trigger + ':exit=' + code);
      });
      child.on('error', function (error) {
        finish(resultFromError(trigger, startedAt, error), 'docker-scheduled-restart:' + trigger + ':spawn-error');
      });
    });
  }

  function getState() {
    const remainingMs = deadlineMs ? Math.max(0, deadlineMs - now()) : 0;
    return {
      enabled: config.enabled,
      intervalMinutes: config.intervalMinutes,
      intervalSec: config.intervalMinutes * 60,
      counting: Boolean(timer),
      remainingSec: Math.ceil(remainingMs / 1000),
      running: running,
      nextRunAt: deadlineMs ? new Date(deadlineMs).toISOString() : null,
      lastResult: config.lastResult,
    };
  }

  function updateConfig(next) {
    const body = next || {};
    if (typeof body.enabled === 'boolean') config.enabled = body.enabled;
    if (body.intervalMinutes !== undefined) config.intervalMinutes = clampInterval(body.intervalMinutes);
    persist();
    if (config.enabled) scheduleCountdown('config-saved');
    else cancelTimer('config-disabled');
    return getState();
  }

  function cancel(reason) {
    cancelTimer(reason || 'user-cancel');
    return getState();
  }

  function restartCountdown() {
    scheduleCountdown('manual-restart');
    return getState();
  }

  function load() {
    config = normalizeConfig(loadConfig());
    if (config.enabled) scheduleCountdown('service-start');
    return getState();
  }

  return {
    getState: getState,
    updateConfig: updateConfig,
    cancel: cancel,
    restartCountdown: restartCountdown,
    trigger: function () {
      cancelTimer('manual-trigger');
      return runRestart('manual');
    },
    load: load,
    normalizeConfig: normalizeConfig,
    clampInterval: clampInterval,
  };
}

module.exports = {
  createDockerScheduledRestart: createDockerScheduledRestart,
  clampInterval: clampInterval,
  normalizeConfig: normalizeConfig,
};
