'use strict';

const DEFAULT_RETRY_DELAY_MS = 1000;

function errorMessage(error) {
  return error && error.message ? error.message : String(error || 'unknown error');
}

function defaultWait(delayMs) {
  return new Promise(function (resolve) {
    const timer = setTimeout(resolve, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

function configuredPorts(config) {
  const ports = config && Array.isArray(config.ports) ? config.ports : [];
  const comNum = Number(config && config.comNum);
  return ports.slice(0, Number.isInteger(comNum) && comNum > 0 ? comNum : ports.length);
}

function autoStartPortById(config, id) {
  return configuredPorts(config).find(function (port) { return Number(port.id) === Number(id) && port.autoStart === true; });
}

function retryAttempts(config) {
  const value = config && config.communication ? Number(config.communication.portInitAttempts) : 1;
  return Number.isInteger(value) && value > 0 ? value : 1;
}

async function startPortWithRetries(id, options) {
  const getConfig = options.getConfig;
  const startPort = options.startPort;
  const wait = options.wait || defaultWait;
  const retryDelayMs = Number.isFinite(Number(options.retryDelayMs)) ? Math.max(0, Number(options.retryDelayMs)) : DEFAULT_RETRY_DELAY_MS;
  let attempts = 0;
  let lastError = '';

  while (true) {
    const config = getConfig();
    if (!autoStartPortById(config, id)) return { id: id, state: 'stopped', action: 'disabled', attempts: attempts };
    const maxAttempts = retryAttempts(config);
    if (attempts >= maxAttempts) return { id: id, state: 'error', error: lastError, attempts: attempts };

    attempts += 1;
    try {
      const status = await startPort(id);
      return {
        id: id,
        state: status && status.state ? status.state : 'running',
        action: status && status.action ? status.action : 'started',
        attempts: attempts,
      };
    } catch (error) {
      lastError = errorMessage(error);
      if (attempts >= maxAttempts) return { id: id, state: 'error', error: lastError, attempts: attempts };
      if (typeof options.onRetry === 'function') {
        options.onRetry({ id: id, state: 'retrying', error: lastError, attempts: attempts, maxAttempts: maxAttempts });
      }
      await Promise.resolve(wait(retryDelayMs));
    }
  }
}

function startEnabledSerialBridges(options) {
  const getConfig = options && options.getConfig;
  if (typeof getConfig !== 'function' || typeof options.startPort !== 'function') {
    return Promise.reject(new Error('getConfig and startPort are required'));
  }
  const config = getConfig();
  const autoStartIds = configuredPorts(config).filter(function (port) { return port.autoStart === true; }).map(function (port) { return port.id; });
  return Promise.all(autoStartIds.map(function (id) { return startPortWithRetries(id, options); }));
}

module.exports = {
  DEFAULT_RETRY_DELAY_MS,
  startEnabledSerialBridges,
};
