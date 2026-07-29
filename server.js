const express = require('express');
const fs = require('fs');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const { createSshCommandRunner, registerWvpRuntimeRoutes } = require('./lib/dcim-wvp-runtime');
const wvpUtils = require('./lib/dcim-wvp');
const { spawn } = require('child_process');
const httpProxy = require('http-proxy');

const runSshCommand = createSshCommandRunner(Client);

function createDcimVideoDefaults() {
  return {
    apiBase: 'https://127.0.0.1:18080',
    username: 'admin',
    passwordHash: '',
    timeoutMs: 6000,
  };
}

function writeDcimVideoConfig(configPath, config, fileSystem, pathModule, tempSuffix) {
  const fileOps = fileSystem || fs;
  const pathOps = pathModule || require('path');
  const directory = pathOps.dirname(configPath);
  const suffix = tempSuffix || (Date.now() + '-' + Math.random().toString(16).slice(2));
  const tempPath = pathOps.join(directory, pathOps.basename(configPath) + '.tmp-' + suffix);
  const content = Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf8');
  let fd = null;
  let tempCreated = false;
  try {
    fileOps.mkdirSync(directory, { recursive: true });
    fd = fileOps.openSync(tempPath, 'wx', 0o600);
    tempCreated = true;
    let offset = 0;
    while (offset < content.length) {
      const written = fileOps.writeSync(fd, content, offset, content.length - offset);
      if (!written) throw new Error('配置临时文件写入不完整');
      offset += written;
    }
    if (typeof fileOps.fsyncSync === 'function') fileOps.fsyncSync(fd);
    fileOps.closeSync(fd);
    fd = null;
    fileOps.chmodSync(tempPath, 0o600);
    fileOps.renameSync(tempPath, configPath);
  } catch (error) {
    if (fd !== null) {
      try { fileOps.closeSync(fd); } catch (_e) {}
    }
    if (tempCreated) {
      try { fileOps.unlinkSync(tempPath); } catch (_e) {}
    }
    throw error;
  }
}

function dcimVideoRequestLabel(method, urlPath) {
  const pathname = String(urlPath || '').split('?')[0] || '/';
  return String(method || 'GET').toUpperCase() + ' ' + pathname;
}

function sanitizeDcimVideoSystemConfig(value) {
  let inputValue = value;
  if (typeof inputValue === 'string') {
    try { inputValue = JSON.parse(inputValue); }
    catch (_e) { return '***'; }
    if (!inputValue || typeof inputValue !== 'object') return '***';
  }
  const seen = new WeakSet();

  function isSensitiveKey(key) {
    const normalized = String(key || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    return normalized.indexOf('password') !== -1 || normalized === 'passwd' || normalized === 'pwd' ||
      normalized === 'pass' || normalized.indexOf('passphrase') !== -1 || normalized.indexOf('passcode') !== -1 ||
      normalized.indexOf('authpwd') !== -1 || normalized.indexOf('authpass') !== -1 ||
      normalized.indexOf('authkey') !== -1 || normalized.indexOf('authcode') !== -1 ||
      normalized.indexOf('accesskey') !== -1 || normalized.indexOf('clientsecret') !== -1 ||
      normalized.indexOf('clientkey') !== -1 ||
      normalized.indexOf('secret') !== -1 || normalized.indexOf('token') !== -1 ||
      normalized.indexOf('authorization') !== -1 || normalized.indexOf('privatekey') !== -1 ||
      normalized.indexOf('apikey') !== -1 || normalized.indexOf('credential') !== -1;
  }

  function defineSafeValue(output, key, value) {
    try {
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: value,
      });
    } catch (_e) {}
  }

  function safeJsonStringify(input) {
    try { return JSON.stringify(input); }
    catch (_e) { return '"***"'; }
  }

  function hasSensitiveTextAssignment(input) {
    const assignments = String(input).match(/(?:^|[^a-zA-Z0-9])([a-zA-Z][a-zA-Z0-9_-]*)\s*(?:=|:)\s*[^\s,;\]\[{}()]+/g) || [];
    return assignments.some(function (assignment) {
      const keyMatch = /([a-zA-Z][a-zA-Z0-9_-]*)\s*(?:=|:)/.exec(assignment);
      return keyMatch && isSensitiveKey(keyMatch[1]);
    });
  }

  function cloneAndRedact(input) {
    if (typeof input === 'string') {
      try {
        const parsed = JSON.parse(input);
        if (parsed && typeof parsed === 'object') return safeJsonStringify(cloneAndRedact(parsed));
      } catch (_e) {}
      return hasSensitiveTextAssignment(input) ? '***' : input;
    }
    if (input === null || typeof input === 'boolean' || typeof input === 'number') return input;
    if (!input || typeof input !== 'object') return '***';
    if (seen.has(input)) return '***';
    seen.add(input);

    try {
      const isArray = Array.isArray(input);
      const keys = Object.keys(input);
      const output = isArray ? [] : {};
      if (isArray) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
        const length = lengthDescriptor && lengthDescriptor.value;
        if (typeof length === 'number' && length >= 0 && length <= 4294967295 && Math.floor(length) === length) {
          output.length = length;
        }
      }

      keys.forEach(function (key) {
        let descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(input, key); }
        catch (_e) { descriptor = null; }
        const hasValue = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value');
        const safeValue = hasValue && !isSensitiveKey(key) ? cloneAndRedact(descriptor.value) : '***';
        defineSafeValue(output, key, safeValue);
      });
      return output;
    } catch (_e) {
      return '***';
    } finally {
      seen.delete(input);
    }
  }

  return cloneAndRedact(inputValue);
}

function registerVideoSystemConfigRoute(app, deps) {
  const options = deps || {};
  if (!app || typeof app.get !== 'function') throw new Error('Express app is required');
  if (typeof options.path !== 'string' || options.path.charAt(0) !== '/') throw new Error('path is required');
  if (typeof options.callWithAuth !== 'function') throw new Error('callWithAuth is required');
  if (typeof options.sanitizeSystemConfig !== 'function') throw new Error('sanitizeSystemConfig is required');

  function descriptorValue(input, key) {
    if (!input || typeof input !== 'object') return '***';
    try {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : '***';
    } catch (_e) {
      return '***';
    }
  }

  function configPayload(input) {
    if (!input || typeof input !== 'object') return input;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(input, 'data');
      return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : input;
    } catch (_e) {
      return input;
    }
  }

  app.get(options.path, async function (_req, res) {
    try {
      const r = await options.callWithAuth('GET', '/api/server/system/configInfo', null);
      const safeResponseData = options.sanitizeSystemConfig(descriptorValue(r, 'data'));
      if (descriptorValue(r, 'ok') !== true) {
        return res.json({ ok: false, message: '读取 WVP 配置失败', data: safeResponseData });
      }

      return res.json({ ok: true, data: configPayload(safeResponseData) });
    } catch (_e) {
      return res.json({ ok: false, message: '读取 WVP 配置失败', data: '***' });
    }
  });
}

function createDcimVideoSession() {
  let generation = 0;
  let cachedToken = '';
  let lastLoginAt = 0;
  let lastError = '';
  return {
    generation: function () { return generation; },
    isCurrent: function (requestGeneration) { return requestGeneration === generation; },
    token: function () { return cachedToken; },
    lastLoginAt: function () { return lastLoginAt; },
    lastError: function () { return lastError; },
    reset: function () {
      generation++;
      cachedToken = '';
      lastLoginAt = 0;
      lastError = '';
    },
    acceptLogin: function (requestGeneration, token, loginAt) {
      if (requestGeneration !== generation) return false;
      cachedToken = String(token || '');
      lastLoginAt = Number(loginAt) || Date.now();
      lastError = '';
      return true;
    },
    rejectLogin: function (requestGeneration, errorMessage) {
      if (requestGeneration !== generation) return false;
      cachedToken = '';
      lastError = String(errorMessage || '');
      return true;
    },
    setError: function (requestGeneration, errorMessage) {
      if (requestGeneration !== generation) return false;
      lastError = String(errorMessage || '');
      return true;
    },
  };
}

function createLiveStreamGenerationRegistry(options) {
  const settings = options || {};
  const configuredMaxEntries = Number(settings.maxEntries);
  const maxEntries = Number.isFinite(configuredMaxEntries)
    ? Math.max(1, Math.min(4096, Math.floor(configuredMaxEntries))) : 2048;
  const configuredMaxPendingEntries = Number(settings.maxPendingEntries);
  const maxPendingEntries = Number.isFinite(configuredMaxPendingEntries)
    ? Math.max(1, Math.min(4096, Math.floor(configuredMaxPendingEntries))) : maxEntries;
  const configuredMaxPendingPerKey = Number(settings.maxPendingPerKey);
  const defaultMaxPendingPerKey = Math.min(maxPendingEntries, Math.max(1, Math.min(64, Math.floor(maxPendingEntries / 2))));
  const maxPendingPerKey = Number.isFinite(configuredMaxPendingPerKey)
    ? Math.max(1, Math.min(maxPendingEntries, Math.floor(configuredMaxPendingPerKey)))
    : defaultMaxPendingPerKey;
  const instanceId = settings.instanceId ? String(settings.instanceId)
    : require('crypto').randomBytes(16).toString('hex');
  const entries = new Map();
  const queues = new Map();
  const pendingByKey = new Map();
  let totalPending = 0;
  let sequence = 0;

  function entryKey(source, deviceId, channelId) {
    return JSON.stringify([String(source || ''), String(deviceId || ''), String(channelId || '')]);
  }

  function pendingForKey(key) {
    return pendingByKey.get(key) || 0;
  }

  function canEnqueue(key) {
    return totalPending < maxPendingEntries && pendingForKey(key) < maxPendingPerKey;
  }

  function queueFullError() {
    const error = new Error('实时点播请求繁忙');
    error.code = 'LIVE_STREAM_QUEUE_FULL';
    return error;
  }

  function releasePending(key) {
    const pending = pendingForKey(key);
    if (pending <= 1) pendingByKey.delete(key);
    else pendingByKey.set(key, pending - 1);
    totalPending--;
  }

  function enqueue(key, operation) {
    if (!canEnqueue(key)) return Promise.reject(queueFullError());
    totalPending++;
    pendingByKey.set(key, pendingForKey(key) + 1);
    const previous = queues.get(key);
    let result;
    if (previous) {
      result = previous.then(function () {
        return operation();
      }, function () {
        return operation();
      });
    } else {
      try {
        result = Promise.resolve(operation());
      } catch (error) {
        result = Promise.reject(error);
      }
    }
    let tail = result.then(function (value) {
      releasePending(key);
      if (queues.get(key) === tail) queues.delete(key);
      return value;
    }, function () {
      releasePending(key);
      if (queues.get(key) === tail) queues.delete(key);
    });
    queues.set(key, tail);
    return result;
  }

  return {
    issue: function (source, deviceId, channelId) {
      const key = entryKey(source, deviceId, channelId);
      if (!entries.has(key) && entries.size >= maxEntries) return null;
      sequence++;
      if (!Number.isSafeInteger(sequence)) throw new Error('实时点播代次已耗尽');
      const generation = instanceId + ':' + sequence;
      entries.set(key, {
        generation: generation,
      });
      return generation;
    },
    current: function (source, deviceId, channelId) {
      const entry = entries.get(entryKey(source, deviceId, channelId));
      return entry ? entry.generation : null;
    },
    matches: function (source, deviceId, channelId, generation) {
      const entry = entries.get(entryKey(source, deviceId, channelId));
      if (!entry || entry.generation !== String(generation || '')) return false;
      return true;
    },
    clearIfCurrent: function (source, deviceId, channelId, generation) {
      const key = entryKey(source, deviceId, channelId);
      const entry = entries.get(key);
      if (!entry) return false;
      if (generation != null && entry.generation !== String(generation)) return false;
      entries.delete(key);
      return true;
    },
    enqueue: function (source, deviceId, channelId, operation) {
      if (typeof operation !== 'function') throw new Error('实时点播队列操作必须是函数');
      return enqueue(entryKey(source, deviceId, channelId), operation);
    },
    canEnqueue: function (source, deviceId, channelId) {
      return canEnqueue(entryKey(source, deviceId, channelId));
    },
    pendingFor: function (source, deviceId, channelId) {
      return pendingForKey(entryKey(source, deviceId, channelId));
    },
    pendingCount: function () {
      return totalPending;
    },
    size: function () {
      return entries.size;
    },
    queueSize: function () {
      return queues.size;
    },
  };
}

function registerLivePlaybackRoutes(app, deps) {
  const options = deps || {};
  if (!app || typeof app.post !== 'function') throw new Error('Express app is required');
  if (typeof options.source !== 'string' || !options.source) throw new Error('source is required');
  if (typeof options.pathPrefix !== 'string' || options.pathPrefix.charAt(0) !== '/') throw new Error('pathPrefix is required');
  if (typeof options.callWithAuth !== 'function') throw new Error('callWithAuth is required');
  if (typeof options.rewriteToProxy !== 'function') throw new Error('rewriteToProxy is required');
  if (!options.liveGenerations || typeof options.liveGenerations.issue !== 'function' ||
    typeof options.liveGenerations.current !== 'function' || typeof options.liveGenerations.clearIfCurrent !== 'function' ||
    typeof options.liveGenerations.enqueue !== 'function') {
    throw new Error('liveGenerations is required');
  }

  function requestedLiveGeneration(req) {
    const queryValue = req && req.query ? req.query.liveGeneration : '';
    const queryGeneration = Array.isArray(queryValue) ? queryValue[0] : queryValue;
    let headerGeneration = '';
    if (req && typeof req.get === 'function') {
      headerGeneration = req.get('x-live-generation') || req.get('live-generation') || '';
    } else if (req && req.headers) {
      headerGeneration = req.headers['x-live-generation'] || req.headers['live-generation'] || '';
    }
    return String(queryGeneration || headerGeneration || '').trim();
  }

  function queueCapacityResponse(res) {
    return res.status(503).json({ ok: false, status: 503, message: '实时点播请求繁忙，请稍后重试' });
  }

  function isQueueFullError(error) {
    return Boolean(error && error.code === 'LIVE_STREAM_QUEUE_FULL');
  }

  const source = options.source;
  const playPath = options.pathPrefix + '/play/:deviceId/:channelId';
  const stopPath = options.pathPrefix + '/play/stop/:deviceId/:channelId';

  app.post(playPath, async function (req, res) {
    const deviceId = String(req.params.deviceId || '');
    const channelId = String(req.params.channelId || '');
    if (typeof options.liveGenerations.canEnqueue === 'function' &&
      !options.liveGenerations.canEnqueue(source, deviceId, channelId)) {
      return queueCapacityResponse(res);
    }
    const liveGeneration = options.liveGenerations.issue(source, deviceId, channelId);
    if (!liveGeneration) {
      return res.status(503).json({ ok: false, status: 503, message: '实时点播容量已满，请先停止已有实时流' });
    }
    let r;
    try {
      r = await options.liveGenerations.enqueue(source, deviceId, channelId, async function () {
        const did = encodeURIComponent(deviceId);
        const cid = encodeURIComponent(channelId);
        const result = await options.callWithAuth('GET', '/api/play/start/' + did + '/' + cid, null);
        if (!result.ok || !result.data || result.data.code !== 0) {
          options.liveGenerations.clearIfCurrent(source, deviceId, channelId, liveGeneration);
        }
        return result;
      });
    } catch (error) {
      options.liveGenerations.clearIfCurrent(source, deviceId, channelId, liveGeneration);
      if (isQueueFullError(error)) return queueCapacityResponse(res);
      return res.status(502).json({ ok: false, status: 502, message: error.message || '上游起播失败' });
    }
    if (!r.ok || !r.data || r.data.code !== 0) {
      return res.json({ ok: false, status: r.status, message: (r.data && r.data.msg) || r.message || ('上游返回 ' + r.status), raw: r.data });
    }
    const data = r.data.data || {};
    const response = {
      ok: true,
      liveGeneration: liveGeneration,
      streamKey: (data.app || 'rtp') + '/' + (data.stream || ''),
      flvUrl: options.rewriteToProxy(data.flv),
      hlsUrl: options.rewriteToProxy(data.hls),
      ssrc: data.ssrc || '',
      app: data.app || 'rtp',
      stream: data.stream || '',
    };
    if (options.includeMediaServerId) response.mediaServerId = data.mediaServerId || '';
    return res.json(response);
  });

  app.post(stopPath, async function (req, res) {
    const deviceId = String(req.params.deviceId || '');
    const channelId = String(req.params.channelId || '');
    if (typeof options.liveGenerations.canEnqueue === 'function' &&
      !options.liveGenerations.canEnqueue(source, deviceId, channelId)) {
      return queueCapacityResponse(res);
    }
    const requestedGeneration = requestedLiveGeneration(req);
    const legacyGeneration = requestedGeneration ? null : options.liveGenerations.current(source, deviceId, channelId);
    let outcome;
    try {
      outcome = await options.liveGenerations.enqueue(source, deviceId, channelId, async function () {
        if (requestedGeneration) {
          const currentGeneration = options.liveGenerations.current(source, deviceId, channelId);
          if (currentGeneration && currentGeneration !== requestedGeneration) return { stale: true };
        }
        const did = encodeURIComponent(deviceId);
        const cid = encodeURIComponent(channelId);
        const r = await options.callWithAuth('GET', '/api/play/stop/' + did + '/' + cid, null);
        const ok = Boolean(r.ok && r.data && r.data.code === 0);
        if (ok && requestedGeneration) {
          options.liveGenerations.clearIfCurrent(source, deviceId, channelId, requestedGeneration);
        } else if (ok && legacyGeneration) {
          options.liveGenerations.clearIfCurrent(source, deviceId, channelId, legacyGeneration);
        }
        return { result: r };
      });
    } catch (error) {
      if (isQueueFullError(error)) return queueCapacityResponse(res);
      return res.status(502).json({ ok: false, status: 502, message: error.message || '上游停流失败' });
    }
    if (outcome.stale) return res.json({ ok: true, stale: true, message: '' });
    const r = outcome.result;
    const ok = Boolean(r.ok && r.data && r.data.code === 0);
    return res.json({ ok: ok, message: (r.data && r.data.msg) || r.message || '' });
  });
}

const liveStreamGenerations = createLiveStreamGenerationRegistry();

function registerDcimVideoConnectionRoutes(app, deps) {
  const options = deps || {};
  if (!app || typeof app.get !== 'function' || typeof app.put !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express app is required');
  }
  if (typeof options.getConfig !== 'function') throw new Error('getConfig is required');
  if (typeof options.setConfig !== 'function') throw new Error('setConfig is required');
  if (typeof options.writeConfig !== 'function') throw new Error('writeConfig is required');
  if (typeof options.resetSession !== 'function') throw new Error('resetSession is required');
  if (typeof options.isAuthed !== 'function') throw new Error('isAuthed is required');
  if (typeof options.loginDcim !== 'function') throw new Error('loginDcim is required');
  if (!options.wvpUtils || typeof options.wvpUtils.publicDcimVideoConfig !== 'function' ||
    typeof options.wvpUtils.mergeDcimVideoConfig !== 'function') {
    throw new Error('dcim WVP config utilities are required');
  }

  app.get('/api/dcim-video/connection-config', function (req, res) {
    if (!options.isAuthed(req)) return res.status(401).json({ ok: false, message: '请先登录' });
    res.json({ ok: true, config: options.wvpUtils.publicDcimVideoConfig(options.getConfig()) });
  });

  app.put('/api/dcim-video/connection-config', function (req, res) {
    if (!options.isAuthed(req)) return res.status(401).json({ ok: false, message: '请先登录' });
    const previousConfig = options.getConfig();
    let nextConfig;
    try {
      nextConfig = options.wvpUtils.mergeDcimVideoConfig(req.body || {}, previousConfig);
    } catch (_e) {
      return res.status(400).json({ ok: false, message: '连接配置无效' });
    }
    try {
      options.setConfig(nextConfig);
      options.writeConfig();
    } catch (_e) {
      options.setConfig(previousConfig);
      return res.status(500).json({ ok: false, message: '无法保存连接配置' });
    }
    options.resetSession();
    res.json({ ok: true, config: options.wvpUtils.publicDcimVideoConfig(nextConfig) });
  });

  app.post('/api/dcim-video/test-login', async function (req, res) {
    if (!options.isAuthed(req)) return res.status(401).json({ ok: false, message: '请先登录' });
    let ok = false;
    try {
      ok = await options.loginDcim();
    } catch (_e) {}
    res.status(ok ? 200 : 502).json({
      ok: ok,
      status: ok ? 200 : 502,
      message: ok ? 'WVP 登录成功' : 'WVP 登录失败，请检查账号或密码',
    });
  });
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const wssSerial = new WebSocket.Server({ noServer: true });
const wssTcp = new WebSocket.Server({ noServer: true });
const wssHa = new WebSocket.Server({ noServer: true });

// 统一的 upgrade 分发：按路径把连接交给对应的 WebSocket.Server
server.on('upgrade', function (request, socket, head) {
  const pathname = (request.url || '').split('?')[0];
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, function (ws) {
      wss.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/serial') {
    wssSerial.handleUpgrade(request, socket, head, function (ws) {
      wssSerial.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/tcp') {
    wssTcp.handleUpgrade(request, socket, head, function (ws) {
      wssTcp.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/ha') {
    wssHa.handleUpgrade(request, socket, head, function (ws) {
      wssHa.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// 保存当前已打开的串口设备 → 独占锁，防止一个串口被两个 WS 同时打开
const serialLocks = new Map();

// ===================== 协议助手反向代理 =====================
// 浏览器 -> Node(3010)/protocol/* -> Flask(127.0.0.1:5000)/protocol/*
// Flask 内部已经把所有路由挂在 /protocol 子路径下（PROTOCOL_PREFIX），所以
// 这里不剥前缀，直接转发即可。
const PROTOCOL_TARGET = process.env.PROTOCOL_TARGET || 'http://127.0.0.1:5000';
const protocolProxy = httpProxy.createProxyServer({
  target: PROTOCOL_TARGET,
  changeOrigin: false,
  ws: false,
  proxyTimeout: 120000,    // 大文件上传/Excel 解析可能耗时
  timeout: 120000,
});
protocolProxy.on('error', function (err, _req, res) {
  if (res && !res.headersSent) {
    try {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: false,
        msg: '协议助手服务未启动或无响应：' + err.message,
        target: PROTOCOL_TARGET,
      }));
    } catch (_) { /* ignore */ }
  }
});

// ===================== 浏览器登录门禁 =====================
// 仅拦截浏览器对 / 与 /index.html 的访问；/api/*、/ws*、/protocol/*、/health 全部放行，
// 这样外部自动化脚本和已经在调 API 的程序不受影响。
//
// 密码 = 服务器当天日期 YYYYMMDD（用服务器时间，避免客户端改时间绕过）
// 登录成功后发 token，token 在内存里维护过期时间。服务重启会丢失，需重登一次。
const AUTH_USER = 'admin';
const authTokens = new Map(); // token -> expireAtMs

function todayPassword() {
  const d = new Date();
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
}

function genToken() {
  // 32 字节随机十六进制串
  return require('crypto').randomBytes(32).toString('hex');
}

function reapTokens() {
  const now = Date.now();
  for (const [t, exp] of authTokens) {
    if (exp <= now) authTokens.delete(t);
  }
}

function isAuthed(req) {
  reapTokens();
  // 优先 cookie，兼容 ?token= 查询参数（页面跳转时使用）
  const cookie = String(req.headers.cookie || '');
  const m = /(?:^|;\s*)webssh_auth=([^;]+)/.exec(cookie);
  let token = m ? decodeURIComponent(m[1]) : '';
  if (!token && req.query && req.query.token) token = String(req.query.token);
  if (!token) return false;
  const exp = authTokens.get(token);
  return exp && exp > Date.now();
}

app.use(express.json({ limit: '16mb' }));

app.post('/api/auth/login', function (req, res) {
  const body = req.body || {};
  const user = String(body.user || '').trim();
  const pwd = String(body.password || '');
  let hours = Number(body.timeoutHours);
  if (!Number.isFinite(hours)) hours = 12;
  hours = Math.max(1, Math.min(720, Math.floor(hours))); // 1h ~ 30 天
  if (user !== AUTH_USER || pwd !== todayPassword()) {
    res.status(401).json({ ok: false, message: '用户名或密码错误' });
    return;
  }
  const token = genToken();
  const expireAt = Date.now() + hours * 3600 * 1000;
  authTokens.set(token, expireAt);
  // 同步设置 HttpOnly cookie，避免被页面 JS 读到。
  // SameSite=Lax + Path=/ 可覆盖所有同源页面；HTTP 场景不能加 Secure。
  res.setHeader('Set-Cookie',
    'webssh_auth=' + encodeURIComponent(token)
    + '; Path=/'
    + '; Expires=' + new Date(expireAt).toUTCString()
    + '; HttpOnly'
    + '; SameSite=Lax'
  );
  res.json({ ok: true, token: token, expireAt: expireAt, timeoutHours: hours });
});

app.get('/api/auth/check', function (req, res) {
  res.json({ ok: isAuthed(req) });
});

app.post('/api/auth/logout', function (req, res) {
  const cookie = String(req.headers.cookie || '');
  const m = /(?:^|;\s*)webssh_auth=([^;]+)/.exec(cookie);
  let token = m ? decodeURIComponent(m[1]) : '';
  if (!token && req.body && req.body.token) token = String(req.body.token);
  if (token) authTokens.delete(token);
  res.setHeader('Set-Cookie',
    'webssh_auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax');
  res.json({ ok: true });
});

// 注意：必须在 express.static 之前注册，否则 /protocol/static/... 会被本目录静态命中
// 用 app.all + 通配，而不是 app.use('/protocol', ...)。
// 因为 app.use(prefix, ...) 会从 req.url 剥掉 prefix，转发到 Flask 时就成了根路径，
// 导致 Flask 的 DispatcherMiddleware 把请求当成根路径兜底 404。
app.all(/^\/protocol(\/.*)?$/, function (req, res) {
  protocolProxy.web(req, res);
});

// 登录页（任何人可访问，没拦截）
app.get('/login', function (_req, res) {
  res.sendFile(require('path').join(__dirname, 'login.html'));
});

// 拦截浏览器对主页的访问：未登录就跳到 /login
// 注意只拦 GET 的 / 和 /index.html，其他 API/WS/静态资源都不动
app.get(['/', '/index.html'], function (req, res, next) {
  if (isAuthed(req)) return next();
  res.redirect(302, '/login');
});

app.use(express.static(__dirname));

app.get('/health', function (_req, res) {
  res.json({ ok: true });
});

// 列出服务器上可用的串口设备（/dev/ttyS* 和 /dev/ttyUSB*、/dev/ttyACM*）
// ?probe=1 时会真正尝试 open() 每个端口，分辨"物理存在"和"虚拟幽灵"
app.get('/api/serial/ports', function (req, res) {
  const doProbe = String(req.query.probe || '') === '1';
  const candidates = [];
  function collect(prefix) {
    try {
      const entries = fs.readdirSync('/dev');
      entries.forEach(function (name) {
        if (name.indexOf(prefix) === 0) {
          candidates.push('/dev/' + name);
        }
      });
    } catch (_err) {}
  }
  collect('ttyS');
  collect('ttyUSB');
  collect('ttyACM');
  candidates.sort(function (a, b) {
    const re = /^(.*?)(\d+)$/;
    const ma = re.exec(a);
    const mb = re.exec(b);
    if (ma && mb && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]);
    return a.localeCompare(b);
  });

  // 读 /proc/tty/driver/serial 获取 ttyS* 的 UART 类型（unknown 表示端口号存在但未接物理 UART）
  const uartTypes = {};
  try {
    const raw = fs.readFileSync('/proc/tty/driver/serial', 'utf8');
    raw.split('\n').forEach(function (line) {
      const m = /^\s*(\d+):\s+uart:(\S+)/.exec(line);
      if (m) uartTypes['/dev/ttyS' + m[1]] = m[2];
    });
  } catch (_err) {}

  function probeOpenable(devPath) {
    // 非阻塞打开一次，成功就返回 true；失败记原因
    try {
      const fd = fs.openSync(devPath, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
      fs.closeSync(fd);
      return { openable: true };
    } catch (err) {
      return { openable: false, reason: err.code || err.message };
    }
  }

  const ports = candidates.map(function (p) {
    const busy = serialLocks.has(p);
    const uart = uartTypes[p] || null; // 只有 ttyS* 会有
    const entry = {
      path: p,
      busy: busy,
      uartType: uart,               // 如 '16550A'、'unknown'、null（非 ttyS 或读取失败）
      kind: p.indexOf('/dev/ttyUSB') === 0 ? 'usb'
          : p.indexOf('/dev/ttyACM') === 0 ? 'acm'
          : 'builtin',
    };
    if (doProbe && !busy) {
      // probe 只对当前未占用的端口做，避免打扰正在通信的端口
      const r = probeOpenable(p);
      entry.openable = r.openable;
      if (!r.openable) entry.probeError = r.reason;
    }
    // ttyS* 且 uart=unknown 直接标记为物理不存在（无需 probe 也能判断）
    if (uart && uart.toLowerCase() === 'unknown') {
      entry.openable = false;
      if (!entry.probeError) entry.probeError = 'uart unknown';
    }
    return entry;
  });

  res.json({ ports: ports, probed: doProbe });
});

// ===== 大框架设置：IP 管理 =====
// 入口在 index.html 的设置弹窗「IP 管理」分页。这里通过用户填写的 SSH 凭据
// 连接目标机，读取/修改网卡 IPv4、网关、NetworkManager autoconnect。
app.post('/api/ip/info', function (req, res) {
  const body = req.body || {};
  const host = String(body.host || '').trim();
  const port = Number(body.port || 22) || 22;
  const user = String(body.user || '').trim();
  const password = String(body.password || '');
  const iface = String(body.interface || '').trim();
  if (!host || !user || !password) {
    res.status(400).json({ ok: false, message: '缺少 SSH 主机、用户名或密码' });
    return;
  }
  const script = [
    'set +e',
    'iface=""',
    'addr=""',
    'gw=""',
    'gwIface=""',
    'nmcli=0',
    'method=manual',
    'autoconnect=0',
    'conn=""',
    'dns=""',
    'routeMetric=""',
    'carrier=""',
    'operstate=""',
    'defaultGW=$(ip route show default 0.0.0.0/0 2>/dev/null | awk \'/default/ {gw=""; dev=""; for(i=1;i<=NF;i++){ if($i=="via"){gw=$(i+1)} if($i=="dev"){dev=$(i+1)} } if(gw && dev){print gw "|" dev; exit}}\')',
    'if [ -n "$defaultGW" ]; then gw="${defaultGW%%|*}"; gwIface="${defaultGW#*|}"; fi',
    'if command -v nmcli >/dev/null 2>&1; then nmcli=1; fi',
    'listIfaces() { if command -v ip >/dev/null 2>&1; then ip -o link show 2>/dev/null | awk -F": " \'$2 !~ /^lo(@|$)/ {split($2,a,"@"); print a[1]}\'; else ls /sys/class/net 2>/dev/null | awk \'$1!="lo"{print $1}\'; fi; }',
    'interfaces=$(for dev in $(listIfaces); do',
    '  [ -n "$dev" ] || continue',
    '  a=$(ip -4 -o addr show dev "$dev" scope global 2>/dev/null | awk \'NR==1{print $4}\')',
    '  c=$(cat "/sys/class/net/$dev/carrier" 2>/dev/null)',
    '  o=$(cat "/sys/class/net/$dev/operstate" 2>/dev/null)',
    '  cn=""',
    '  m=""',
    '  ac=0',
    '  d=""',
    '  g=""',
    '  rm=""',
    '  [ "$gwIface" = "$dev" ] && g="$gw"',
    '  if [ "$nmcli" = "1" ]; then',
    '    cn=$(nmcli -t -f GENERAL.CONNECTION device show "$dev" 2>/dev/null | sed -n "1p" | cut -d: -f2-)',
    '    if [ -z "$cn" ]; then cn=$(nmcli -t -f NAME,connection.interface-name connection show 2>/dev/null | awk -F: -v ifc="$dev" \'$2==ifc{print $1; exit}\'); fi',
    '    if [ -n "$cn" ]; then',
    '      ca=$(nmcli -t -f ipv4.addresses connection show "$cn" 2>/dev/null | sed -n "1p" | cut -d: -f2-)',
    '      [ -z "$a" ] && a="$ca"',
    '      cg=$(nmcli -t -f ipv4.gateway connection show "$cn" 2>/dev/null | sed -n "1p" | cut -d: -f2-)',
    '      [ -z "$g" ] && g="$cg"',
    '      m=$(nmcli -t -f ipv4.method connection show "$cn" 2>/dev/null | sed -n "1p" | cut -d: -f2-)',
    '      acv=$(nmcli -t -f connection.autoconnect connection show "$cn" 2>/dev/null | sed -n "1p" | cut -d: -f2-)',
    '      [ "$acv" = "yes" ] && ac=1',
    '      d=$(nmcli -t -f ipv4.dns connection show "$cn" 2>/dev/null | sed -n "1p" | cut -d: -f2-)',
    '      rm=$(nmcli -t -f ipv4.route-metric connection show "$cn" 2>/dev/null | sed -n "1p" | cut -d: -f2-)',
    '    fi',
    '  fi',
    '  printf "%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\\n" "$dev" "$a" "$c" "$o" "$cn" "$m" "$ac" "$d" "$g" "$rm"',
    'done)',
    'selectedIface=' + shellEscape(iface),
    "if [ -z \"$selectedIface\" ]; then selectedIface=$(printf \"%s\\n\" \"$interfaces\" | awk -F\"|\" 'NR==1{print $1}'); fi",
    'selectedLine=$(printf "%s\\n" "$interfaces" | awk -F"|" -v ifc="$selectedIface" \'$1==ifc{print; exit}\')',
    'if [ -n "$selectedLine" ]; then',
    '  iface=$(printf "%s" "$selectedLine" | cut -d"|" -f1)',
    '  addr=$(printf "%s" "$selectedLine" | cut -d"|" -f2)',
    '  carrier=$(printf "%s" "$selectedLine" | cut -d"|" -f3)',
    '  operstate=$(printf "%s" "$selectedLine" | cut -d"|" -f4)',
    '  conn=$(printf "%s" "$selectedLine" | cut -d"|" -f5)',
    '  method=$(printf "%s" "$selectedLine" | cut -d"|" -f6)',
    '  autoconnect=$(printf "%s" "$selectedLine" | cut -d"|" -f7)',
    '  dns=$(printf "%s" "$selectedLine" | cut -d"|" -f8)',
    '  gw=$(printf "%s" "$selectedLine" | cut -d"|" -f9)',
    '  routeMetric=$(printf "%s" "$selectedLine" | cut -d"|" -f10)',
    'fi',
    '[ -z "$method" ] && method=manual',
    '[ -z "$autoconnect" ] && autoconnect=0',
    'printf "%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n" "$iface" "$addr" "$gw" "$nmcli" "$method" "$autoconnect" "$conn" "$dns" "$carrier" "$operstate" "$routeMetric"',
    'printf "INTERFACES:\n"',
    'printf "%s\n" "$interfaces"',
  ].join('\n');
  sshExecCommand({ host: host, port: port, username: user, password: password }, script, function (err, result) {
    if (err) {
      res.status(500).json({ ok: false, message: 'SSH 连接失败：' + err.message });
      return;
    }
    const stdout = String(result.stdout || '');
    const lines = stdout.split(/\r?\n/).filter((item) => String(item || '').trim() !== '');
    const splitIndex = lines.indexOf('INTERFACES:');
    const ifaceLines = splitIndex >= 0 ? lines.slice(splitIndex + 1) : [];
    const summaryLine = lines[0] || '';
    const info = parseIpInfoLine(summaryLine);
    if (!info || !info.interface) {
      let reason = result.stderr || '未能从目标机读取网络接口信息';
      res.status(500).json({ ok: false, message: reason });
      return;
    }
    const interfaces = ifaceLines.map(function (line) {
      const parts = String(line || '').split('|');
      return {
        name: parts[0] || '',
        address: parts[1] || '',
        carrier: parts[2] || '',
        operstate: parts[3] || '',
        connectionName: parts[4] || '',
        configMode: parts[5] || '',
        autoConnect: parts[6] === '1',
        dns: parts[7] || '',
        gateway: parts[8] || '',
        routeMetric: parts[9] || '',
        role: roleFromRouteMetric(parts[9] || ''),
      };
    }).filter(function (item) {
      return item.name;
    });
    res.json({
      ok: true,
      interface: info.interface,
      selectedInterface: info.interface,
      ipAddress: info.ipAddress,
      netmask: info.netmask,
      gateway: info.gateway,
      nmcli: info.nmcli,
      configMode: info.configMode,
      autoConnect: info.autoConnect,
      connectionName: info.connectionName,
      dns: info.dns,
      carrier: info.carrier,
      operstate: info.operstate,
      routeMetric: info.routeMetric,
      role: info.role,
      interfaces: interfaces,
    });
  });
});

app.post('/api/ip/set', function (req, res) {
  const body = req.body || {};
  const host = String(body.host || '').trim();
  const port = Number(body.port || 22) || 22;
  const user = String(body.user || '').trim();
  const password = String(body.password || '');
  const iface = String(body.interface || '').trim();
  const connectionName = String(body.connectionName || '').trim();
  const mode = String(body.mode || 'manual').trim();
  const address = String(body.address || '').trim();
  const mask = String(body.mask || '').trim();
  const gateway = String(body.gateway || '').trim();
  const dnsEnabled = Boolean(body.dnsEnabled);
  const dns = String(body.dns || '').trim();
  const autoConnect = Boolean(body.autoConnect);
  const role = String(body.role || 'normal').trim();
  const routeMetric = routeMetricFromRole(role);
  if (!host || !user || !password || !iface) {
    res.status(400).json({ ok: false, message: '缺少 SSH 或网络接口参数' });
    return;
  }
  if (mode === 'manual' && (!address || !mask || !gateway)) {
    res.status(400).json({ ok: false, message: '手动模式下 IP、子网掩码和网关不能为空' });
    return;
  }
  const prefix = mask.indexOf('.') === -1 ? mask : '';
  const cmd = [];
  cmd.push('set -e');
  if (mode === 'auto') {
    cmd.push('if ! command -v nmcli >/dev/null 2>&1; then echo "ERROR|nmcli-unavailable"; exit 2; fi');
    cmd.push('newConn=' + (connectionName ? shellEscape(connectionName) : ''));
    cmd.push('fallbackConn=' + shellEscape(iface));
    cmd.push('conn=$(nmcli -t -f GENERAL.CONNECTION device show ' + shellEscape(iface) + ' 2>/dev/null | sed -n "1p" | cut -d: -f2)');
    cmd.push('if [ -z "$conn" ]; then conn=$(nmcli -t -f NAME,connection.interface-name connection show 2>/dev/null | awk -F: -v ifc=' + shellEscape(iface) + ' \'$2==ifc{print $1; exit}\'); fi');
    cmd.push('if [ -z "$conn" ] && [ -n "$newConn" ] && nmcli connection show "$newConn" >/dev/null 2>&1; then conn="$newConn"; fi');
    cmd.push('if [ -z "$conn" ]; then conn="$newConn"; [ -n "$conn" ] || conn="$fallbackConn"; nmcli connection add type ethernet ifname ' + shellEscape(iface) + ' con-name "$conn"; fi');
    cmd.push('if [ -n "$newConn" ] && [ "$newConn" != "$conn" ]; then nmcli connection modify "$conn" connection.id "$newConn"; conn="$newConn"; fi');
    cmd.push('nmcli connection modify "$conn" connection.interface-name ' + shellEscape(iface));
    cmd.push('nmcli connection modify "$conn" ipv4.method auto');
    cmd.push('if [ ' + (dnsEnabled ? '1' : '0') + ' -eq 1 ]; then nmcli connection modify "$conn" ipv4.ignore-auto-dns yes ipv4.dns ' + shellEscape(dns) + '; else nmcli connection modify "$conn" ipv4.ignore-auto-dns no ipv4.dns ""; fi');
    cmd.push('nmcli connection modify "$conn" connection.autoconnect ' + (autoConnect ? 'yes' : 'no'));
    cmd.push('nmcli connection modify "$conn" ipv4.route-metric ' + shellEscape(routeMetric));
    cmd.push('nmcli connection up "$conn"');
    cmd.push('echo "OK|auto"');
  } else {
    const cidr = prefix || maskToPrefix(mask);
    if (!cidr) {
      res.status(400).json({ ok: false, message: '无法识别子网掩码，请使用前缀长度或点分十进制格式' });
      return;
    }
    cmd.push('if ! command -v ip >/dev/null 2>&1; then echo "ERROR|ip-unavailable"; exit 2; fi');
    cmd.push('if command -v nmcli >/dev/null 2>&1; then');
    cmd.push('  newConn=' + (connectionName ? shellEscape(connectionName) : ''));
    cmd.push('  fallbackConn=' + shellEscape(iface));
    cmd.push('  conn=$(nmcli -t -f GENERAL.CONNECTION device show ' + shellEscape(iface) + ' 2>/dev/null | sed -n "1p" | cut -d: -f2)');
    cmd.push('  if [ -z "$conn" ]; then conn=$(nmcli -t -f NAME,connection.interface-name connection show 2>/dev/null | awk -F: -v ifc=' + shellEscape(iface) + ' \'$2==ifc{print $1; exit}\'); fi');
    cmd.push('  if [ -z "$conn" ] && [ -n "$newConn" ] && nmcli connection show "$newConn" >/dev/null 2>&1; then conn="$newConn"; fi');
    cmd.push('  if [ -z "$conn" ]; then conn="$newConn"; [ -n "$conn" ] || conn="$fallbackConn"; nmcli connection add type ethernet ifname ' + shellEscape(iface) + ' con-name "$conn"; fi');
    cmd.push('  if [ -n "$newConn" ] && [ "$newConn" != "$conn" ]; then nmcli connection modify "$conn" connection.id "$newConn"; conn="$newConn"; fi');
    cmd.push('  nmcli connection modify "$conn" connection.interface-name ' + shellEscape(iface));
    cmd.push('  nmcli connection modify "$conn" ipv4.method manual ipv4.addresses ' + shellEscape(address + '/' + cidr) + ' ipv4.gateway ' + shellEscape(gateway) + ' connection.autoconnect ' + (autoConnect ? 'yes' : 'no'));
    cmd.push('  if [ ' + (dnsEnabled ? '1' : '0') + ' -eq 1 ]; then nmcli connection modify "$conn" ipv4.ignore-auto-dns yes ipv4.dns ' + shellEscape(dns) + '; else nmcli connection modify "$conn" ipv4.ignore-auto-dns no ipv4.dns ""; fi');
    cmd.push('  nmcli connection modify "$conn" ipv4.route-metric ' + shellEscape(routeMetric));
    cmd.push('  nmcli connection up "$conn" || true');
    cmd.push('else');
    cmd.push('  ip link set dev ' + shellEscape(iface) + ' up');
    cmd.push('  ip addr flush dev ' + shellEscape(iface));
    cmd.push('  ip addr add ' + shellEscape(address + '/' + cidr) + ' dev ' + shellEscape(iface));
    cmd.push('  ip route replace default via ' + shellEscape(gateway) + ' dev ' + shellEscape(iface) + ' metric ' + shellEscape(routeMetric));
    cmd.push('fi');
    cmd.push('echo "OK|manual"');
  }
  sshExecCommand({ host: host, port: port, username: user, password: password }, cmd.join('\n'), function (err, result) {
    if (err) {
      res.status(500).json({ ok: false, message: 'SSH 连接失败：' + err.message });
      return;
    }
    const stdout = String(result.stdout || '');
    const stderr = String(result.stderr || '');
    if (stdout.indexOf('OK|') === -1) {
      const message = stderr || stdout || '远程命令执行失败';
      res.status(500).json({ ok: false, message: message });
      return;
    }
    res.json({ ok: true, message: '已应用远程网络配置' });
  });
});

app.post('/api/ip/restart', function (req, res) {
  const body = req.body || {};
  const host = String(body.host || '').trim();
  const port = Number(body.port || 22) || 22;
  const user = String(body.user || '').trim();
  const password = String(body.password || '');
  const iface = String(body.interface || '').trim();
  const connectionName = String(body.connectionName || '').trim();
  if (!host || !user || !password || !iface) {
    res.status(400).json({ ok: false, message: '缺少 SSH 或网络接口参数' });
    return;
  }
  const cmd = [
    'set -e',
    'iface=' + shellEscape(iface),
    'newConn=' + (connectionName ? shellEscape(connectionName) : ''),
    'if command -v nmcli >/dev/null 2>&1; then',
    '  conn=$(nmcli -t -f GENERAL.CONNECTION device show "$iface" 2>/dev/null | sed -n "1p" | cut -d: -f2)',
    '  if [ -z "$conn" ]; then conn=$(nmcli -t -f NAME,connection.interface-name connection show 2>/dev/null | awk -F: -v ifc="$iface" \'$2==ifc{print $1; exit}\'); fi',
    '  if [ -z "$conn" ] && [ -n "$newConn" ] && nmcli connection show "$newConn" >/dev/null 2>&1; then conn="$newConn"; fi',
    '  if [ -n "$conn" ] && [ -n "$newConn" ] && [ "$newConn" != "$conn" ]; then nmcli connection modify "$conn" connection.id "$newConn"; conn="$newConn"; fi',
    '  if [ -n "$conn" ]; then nmcli connection down "$conn" || true; nmcli connection up "$conn"; echo "OK|nmcli|$conn"; exit 0; fi',
    'fi',
    'if ! command -v ip >/dev/null 2>&1; then echo "ERROR|ip-unavailable"; exit 2; fi',
    'ip link set dev "$iface" down',
    'sleep 1',
    'ip link set dev "$iface" up',
    'echo "OK|ip|$iface"',
  ].join('\n');
  sshExecCommand({ host: host, port: port, username: user, password: password }, cmd, function (err, result) {
    if (err) {
      res.status(500).json({ ok: false, message: 'SSH 连接失败：' + err.message });
      return;
    }
    const stdout = String(result.stdout || '');
    const stderr = String(result.stderr || '');
    if (stdout.indexOf('OK|') === -1) {
      res.status(500).json({ ok: false, message: stderr || stdout || '远程命令执行失败' });
      return;
    }
    res.json({ ok: true, message: stdout.replace(/^OK\|/, '') });
  });
});

// ===== 大框架设置：时间 =====
// 通过 SSH 读取目标机系统时间 / BIOS 硬件时钟，并支持把浏览器主机时间或手动时间
// 写入目标机系统时间后执行 hwclock --systohc，避免服务器重启后时间回退。
app.post('/api/time/info', function (req, res) {
  const body = req.body || {};
  const host = String(body.host || '').trim();
  const port = Number(body.port || 22) || 22;
  const user = String(body.user || '').trim();
  const password = String(body.password || '');
  const clientEpochMs = Number(body.clientEpochMs || 0);
  if (!host || !user || !password) {
    res.status(400).json({ ok: false, message: '缺少 SSH 主机、用户名或密码' });
    return;
  }
  const script = [
    'set +e',
    'epoch=$(date +%s 2>/dev/null)',
    'text=$(date "+%Y-%m-%d %H:%M:%S %A %Z" 2>/dev/null)',
    'tz=$(timedatectl show -p Timezone --value 2>/dev/null)',
    '[ -n "$tz" ] || tz=$(date +%Z 2>/dev/null)',
    'ntp=$(timedatectl show -p NTP -p NTPSynchronized --value 2>/dev/null | paste -sd "/" -)',
    '[ -n "$ntp" ] || ntp="unknown"',
    'ntpService="unknown"',
    'ntpServers=""',
    'if command -v chronyc >/dev/null 2>&1 || [ -f /etc/chrony.conf ]; then',
    '  ntpService="chrony"',
    '  ntpServers=$(awk \'/^(server|pool)[[:space:]]+/ {print $2}\' /etc/chrony.conf 2>/dev/null | paste -sd " " -)',
    'elif command -v timedatectl >/dev/null 2>&1 || [ -f /etc/systemd/timesyncd.conf ]; then',
    '  ntpService="systemd-timesyncd"',
    '  ntpServers=$(awk -F= \'/^NTP=/ {print $2}\' /etc/systemd/timesyncd.conf 2>/dev/null | tail -1)',
    'elif [ -f /etc/ntp.conf ]; then',
    '  ntpService="ntpd"',
    '  ntpServers=$(awk \'/^(server|pool)[[:space:]]+/ {print $2}\' /etc/ntp.conf 2>/dev/null | paste -sd " " -)',
    'fi',
    'hw=$(hwclock --show 2>&1)',
    'printf "EPOCH|%s\\n" "$epoch"',
    'printf "TEXT|%s\\n" "$text"',
    'printf "TZ|%s\\n" "$tz"',
    'printf "NTP|%s\\n" "$ntp"',
    'printf "NTPSERVICE|%s\\n" "$ntpService"',
    'printf "NTPSERVERS|%s\\n" "$ntpServers"',
    'printf "HW|%s\\n" "$hw"',
  ].join('\n');
  sshExecCommand({ host: host, port: port, username: user, password: password }, script, function (err, result) {
    if (err) {
      res.status(500).json({ ok: false, message: 'SSH 连接失败：' + err.message });
      return;
    }
    res.json(buildTimeInfoResponse(result.stdout, clientEpochMs));
  });
});

app.post('/api/time/set', function (req, res) {
  const body = req.body || {};
  const host = String(body.host || '').trim();
  const port = Number(body.port || 22) || 22;
  const user = String(body.user || '').trim();
  const password = String(body.password || '');
  const datetime = String(body.datetime || '').trim();
  const clientEpochMs = Number(body.clientEpochMs || 0);
  if (!host || !user || !password) {
    res.status(400).json({ ok: false, message: '缺少 SSH 主机、用户名或密码' });
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(datetime)) {
    res.status(400).json({ ok: false, message: '时间格式无效，请使用 YYYY-MM-DD HH:mm:ss' });
    return;
  }
  const script = [
    'set -e',
    'target=' + shellEscape(datetime),
    'if command -v timedatectl >/dev/null 2>&1; then timedatectl set-ntp false >/dev/null 2>&1 || true; fi',
    'date -s "$target" >/dev/null',
    'if command -v hwclock >/dev/null 2>&1; then hwclock --systohc; else echo "ERROR|hwclock-unavailable"; exit 2; fi',
    'epoch=$(date +%s 2>/dev/null)',
    'text=$(date "+%Y-%m-%d %H:%M:%S %A %Z" 2>/dev/null)',
    'tz=$(timedatectl show -p Timezone --value 2>/dev/null)',
    '[ -n "$tz" ] || tz=$(date +%Z 2>/dev/null)',
    'ntp=$(timedatectl show -p NTP -p NTPSynchronized --value 2>/dev/null | paste -sd "/" -)',
    '[ -n "$ntp" ] || ntp="unknown"',
    'ntpService="unknown"',
    'ntpServers=""',
    'if command -v chronyc >/dev/null 2>&1 || [ -f /etc/chrony.conf ]; then',
    '  ntpService="chrony"',
    '  ntpServers=$(awk \'/^(server|pool)[[:space:]]+/ {print $2}\' /etc/chrony.conf 2>/dev/null | paste -sd " " -)',
    'elif command -v timedatectl >/dev/null 2>&1 || [ -f /etc/systemd/timesyncd.conf ]; then',
    '  ntpService="systemd-timesyncd"',
    '  ntpServers=$(awk -F= \'/^NTP=/ {print $2}\' /etc/systemd/timesyncd.conf 2>/dev/null | tail -1)',
    'elif [ -f /etc/ntp.conf ]; then',
    '  ntpService="ntpd"',
    '  ntpServers=$(awk \'/^(server|pool)[[:space:]]+/ {print $2}\' /etc/ntp.conf 2>/dev/null | paste -sd " " -)',
    'fi',
    'hw=$(hwclock --show 2>&1)',
    'printf "EPOCH|%s\\n" "$epoch"',
    'printf "TEXT|%s\\n" "$text"',
    'printf "TZ|%s\\n" "$tz"',
    'printf "NTP|%s\\n" "$ntp"',
    'printf "NTPSERVICE|%s\\n" "$ntpService"',
    'printf "NTPSERVERS|%s\\n" "$ntpServers"',
    'printf "HW|%s\\n" "$hw"',
  ].join('\n');
  sshExecCommand({ host: host, port: port, username: user, password: password }, script, function (err, result) {
    if (err) {
      res.status(500).json({ ok: false, message: 'SSH 连接失败：' + err.message });
      return;
    }
    if (result.code !== 0) {
      res.status(500).json({ ok: false, message: result.stderr || result.stdout || '远程时间设置失败' });
      return;
    }
    res.json(buildTimeInfoResponse(result.stdout, clientEpochMs));
  });
});

app.post('/api/time/ntp', function (req, res) {
  const body = req.body || {};
  const host = String(body.host || '').trim();
  const port = Number(body.port || 22) || 22;
  const user = String(body.user || '').trim();
  const password = String(body.password || '');
  const clientEpochMs = Number(body.clientEpochMs || 0);
  const servers = parseNtpServers(body.servers);
  if (!host || !user || !password) {
    res.status(400).json({ ok: false, message: '缺少 SSH 主机、用户名或密码' });
    return;
  }
  if (!servers.length) {
    res.status(400).json({ ok: false, message: 'NTP 时间服务器不能为空，且只能包含主机名、IP 或 IPv6 地址' });
    return;
  }
  const serverList = servers.join(' ');
  const chronyLines = servers.map(function (item) {
    return 'server ' + item + ' iburst';
  }).join('\n');
  const script = [
    'set -e',
    'servers=' + shellEscape(serverList),
    'chronyLines=' + shellEscape(chronyLines),
    'ntpService=""',
    'if command -v timedatectl >/dev/null 2>&1; then timedatectl set-ntp true >/dev/null 2>&1 || true; fi',
    'if command -v chronyc >/dev/null 2>&1 || [ -f /etc/chrony.conf ]; then',
    '  ntpService="chrony"',
    '  conf=/etc/chrony.conf',
    '  [ -f "$conf" ] || touch "$conf"',
    '  cp -a "$conf" "$conf.webssh.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true',
    '  tmp=$(mktemp)',
    '  awk \'$1!="server" && $1!="pool" {print}\' "$conf" > "$tmp"',
    '  printf "\\n# webssh managed NTP servers\\n%s\\n" "$chronyLines" >> "$tmp"',
    '  cat "$tmp" > "$conf"',
    '  rm -f "$tmp"',
    '  systemctl enable --now chronyd >/dev/null 2>&1 || systemctl enable --now chrony >/dev/null 2>&1 || true',
    '  systemctl restart chronyd >/dev/null 2>&1 || systemctl restart chrony >/dev/null 2>&1 || true',
    '  chronyc -a makestep >/dev/null 2>&1 || true',
    'elif command -v timedatectl >/dev/null 2>&1 || [ -d /etc/systemd ]; then',
    '  ntpService="systemd-timesyncd"',
    '  conf=/etc/systemd/timesyncd.conf',
    '  mkdir -p /etc/systemd',
    '  [ -f "$conf" ] || printf "[Time]\\n" > "$conf"',
    '  cp -a "$conf" "$conf.webssh.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true',
    '  tmp=$(mktemp)',
    '  awk -F= \'$1!="NTP" {print}\' "$conf" > "$tmp"',
    '  if ! grep -q "^\\[Time\\]" "$tmp"; then printf "[Time]\\n" >> "$tmp"; fi',
    '  printf "NTP=%s\\n" "$servers" >> "$tmp"',
    '  cat "$tmp" > "$conf"',
    '  rm -f "$tmp"',
    '  systemctl enable --now systemd-timesyncd >/dev/null 2>&1 || true',
    '  systemctl restart systemd-timesyncd >/dev/null 2>&1 || true',
    '  timedatectl set-ntp true >/dev/null 2>&1 || true',
    'elif [ -f /etc/ntp.conf ] || command -v ntpd >/dev/null 2>&1; then',
    '  ntpService="ntpd"',
    '  conf=/etc/ntp.conf',
    '  [ -f "$conf" ] || touch "$conf"',
    '  cp -a "$conf" "$conf.webssh.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true',
    '  tmp=$(mktemp)',
    '  awk \'$1!="server" && $1!="pool" {print}\' "$conf" > "$tmp"',
    '  for s in $servers; do printf "server %s iburst\\n" "$s" >> "$tmp"; done',
    '  cat "$tmp" > "$conf"',
    '  rm -f "$tmp"',
    '  systemctl enable --now ntpd >/dev/null 2>&1 || true',
    '  systemctl restart ntpd >/dev/null 2>&1 || true',
    'else',
    '  echo "ERROR|ntp-service-not-found"',
    '  exit 2',
    'fi',
    'sleep 1',
    'epoch=$(date +%s 2>/dev/null)',
    'text=$(date "+%Y-%m-%d %H:%M:%S %A %Z" 2>/dev/null)',
    'tz=$(timedatectl show -p Timezone --value 2>/dev/null)',
    '[ -n "$tz" ] || tz=$(date +%Z 2>/dev/null)',
    'ntp=$(timedatectl show -p NTP -p NTPSynchronized --value 2>/dev/null | paste -sd "/" -)',
    '[ -n "$ntp" ] || ntp="unknown"',
    'hw=$(hwclock --show 2>&1)',
    'printf "EPOCH|%s\\n" "$epoch"',
    'printf "TEXT|%s\\n" "$text"',
    'printf "TZ|%s\\n" "$tz"',
    'printf "NTP|%s\\n" "$ntp"',
    'printf "NTPSERVICE|%s\\n" "$ntpService"',
    'printf "NTPSERVERS|%s\\n" "$servers"',
    'printf "HW|%s\\n" "$hw"',
  ].join('\n');
  sshExecCommand({ host: host, port: port, username: user, password: password }, script, function (err, result) {
    if (err) {
      res.status(500).json({ ok: false, message: 'SSH 连接失败：' + err.message });
      return;
    }
    if (result.code !== 0) {
      res.status(500).json({ ok: false, message: result.stderr || result.stdout || '远程 NTP 配置失败' });
      return;
    }
    res.json(buildTimeInfoResponse(result.stdout, clientEpochMs));
  });
});

const demoConfig = {
  host: process.env.SSH_HOST || '127.0.0.1',
  port: Number(process.env.SSH_PORT || 22),
  username: process.env.SSH_USER || 'root',
  password: process.env.SSH_PASSWORD || '',
  privateKey: process.env.SSH_PRIVATE_KEY ? fs.readFileSync(process.env.SSH_PRIVATE_KEY) : undefined,
};

function shellEscape(value) {
  return "'" + String(value || '').replace(/'/g, "'\"'\"'") + "'";
}

function normalizeMask(value) {
  if (!value) return '';
  const text = String(value).trim();
  if (text.indexOf('.') !== -1) return text;
  const prefix = Number(text.replace(/^\/+/, ''));
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return '';
  const bits = '1'.repeat(prefix).padEnd(32, '0');
  return [0, 8, 16, 24].map(function (start) {
    return parseInt(bits.slice(start, start + 8), 2);
  }).join('.');
}

function maskToPrefix(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.indexOf('.') === -1) {
    const prefix = Number(text.replace(/^\/+/, ''));
    return Number.isFinite(prefix) ? String(prefix) : '';
  }
  const parts = text.split('.').map(function (item) { return Number(item); });
  if (parts.length !== 4 || parts.some(function (n) { return !Number.isFinite(n) || n < 0 || n > 255; })) return '';
  const bits = parts.map(function (n) { return ('00000000' + n.toString(2)).slice(-8); }).join('');
  if (!/^1*0*$/.test(bits)) return '';
  return String(bits.indexOf('0') === -1 ? 32 : bits.indexOf('0'));
}

function routeMetricFromRole(role) {
  if (role === 'primary') return '100';
  if (role === 'backup') return '500';
  return '300';
}

function roleFromRouteMetric(metric) {
  const value = Number(String(metric || '').trim());
  if (!Number.isFinite(value) || value <= 0) return 'normal';
  if (value <= 150) return 'primary';
  if (value >= 450) return 'backup';
  return 'normal';
}

function parseNtpServers(value) {
  const seen = new Set();
  return String(value || '')
    .split(/[\s,;]+/)
    .map(function (item) { return item.trim(); })
    .filter(Boolean)
    .filter(function (item) {
      if (item.length > 253) return false;
      if (!/^[A-Za-z0-9_.:-]+$/.test(item)) return false;
      if (item.indexOf('..') !== -1) return false;
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function parseIpInfoLine(line) {
  if (!line) return null;
  const parts = String(line || '').split('|');
  if (parts.length < 6) return null;
  let addr = parts[1] || '';
  let ipAddress = addr;
  let netmask = '';
  const slashIndex = addr.indexOf('/');
  if (slashIndex !== -1) {
    ipAddress = addr.slice(0, slashIndex);
    netmask = normalizeMask(addr.slice(slashIndex + 1));
  }
  return {
    interface: parts[0] || '',
    ipAddress: ipAddress,
    netmask: netmask,
    gateway: parts[2] || '',
    nmcli: parts[3] === '1',
    configMode: parts[4] || 'manual',
    autoConnect: parts[5] === '1',
    connectionName: parts[6] || '',
    dns: parts[7] || '',
    carrier: parts[8] || '',
    operstate: parts[9] || '',
    routeMetric: parts[10] || '',
    role: roleFromRouteMetric(parts[10] || ''),
  };
}

function buildTimeInfoResponse(stdout, clientEpochMs) {
  const info = {};
  String(stdout || '').split(/\r?\n/).forEach(function (line) {
    const idx = String(line || '').indexOf('|');
    if (idx === -1) return;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    info[key] = value;
  });
  const serverEpoch = Number(info.EPOCH || 0);
  const driftSeconds = serverEpoch && clientEpochMs ? Math.round(serverEpoch - (clientEpochMs / 1000)) : null;
  return {
    ok: true,
    serverEpoch: serverEpoch || null,
    serverText: info.TEXT || '',
    timezone: info.TZ || '',
    ntp: info.NTP || '',
    ntpService: info.NTPSERVICE || '',
    ntpServers: info.NTPSERVERS || '',
    hardwareClock: info.HW || '',
    driftSeconds: driftSeconds,
  };
}

function sshExecCommand(cfg, cmd, callback) {
  return runSshCommand(cfg, cmd, callback);
}

function remoteJoin(basePath, name) {
  if (!basePath || basePath === '/') return '/' + name;
  return basePath.replace(/\/+$/, '') + '/' + name;
}

function remoteDirname(targetPath) {
  if (!targetPath || targetPath === '/') return '/';
  const parts = String(targetPath).split('/').filter(Boolean);
  parts.pop();
  return parts.length ? '/' + parts.join('/') : '/';
}

function isValidRemoteName(name) {
  const trimmed = String(name || '').trim();
  return Boolean(trimmed) && trimmed.indexOf('/') === -1 && trimmed !== '.' && trimmed !== '..';
}

function fileTypeFromLongname(longname) {
  const value = longname || '';
  if (value.indexOf('d') === 0) return 'dir';
  if (value.indexOf('l') === 0) return 'link';
  return 'file';
}

function normalizeSftpEntry(basePath, item) {
  const attrs = item && item.attrs ? item.attrs : {};
  return {
    name: item.filename,
    fullPath: remoteJoin(basePath, item.filename),
    type: fileTypeFromLongname(item.longname),
    size: Number(attrs.size || 0),
    mtime: Number(attrs.mtime || 0),
  };
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(.*?);base64,(.*)$/);
  if (!match) {
    throw new Error('上传内容格式无效');
  }
  return Buffer.from(match[2], 'base64');
}

function detectMimeByName(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.txt') || lower.endsWith('.log') || lower.endsWith('.md')) return 'text/plain';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.html')) return 'text/html';
  if (lower.endsWith('.js')) return 'text/javascript';
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

function isProbablyTextFile(fileName) {
  const lower = String(fileName || '').toLowerCase();
  const editable = ['.txt', '.log', '.md', '.json', '.js', '.ts', '.html', '.css', '.xml', '.yml', '.yaml', '.sh', '.env', '.ini', '.conf', '.py'];
  return editable.some(function (suffix) {
    return lower.endsWith(suffix);
  });
}

function uploadBuffer(sftpClient, targetPath, buffer, callback) {
  const stream = sftpClient.createWriteStream(targetPath);
  let done = false;
  function finish(err) {
    if (done) return;
    done = true;
    callback(err || null);
  }

  stream.on('error', finish);
  stream.on('close', function () {
    finish(null);
  });
  stream.end(buffer);
}

function downloadBuffer(sftpClient, targetPath, callback) {
  const stream = sftpClient.createReadStream(targetPath);
  const chunks = [];
  let done = false;
  function finish(err, buffer) {
    if (done) return;
    done = true;
    callback(err || null, buffer);
  }

  stream.on('data', function (chunk) {
    chunks.push(Buffer.from(chunk));
  });
  stream.on('error', function (err) {
    finish(err);
  });
  stream.on('end', function () {
    finish(null, Buffer.concat(chunks));
  });
}

// 在已就绪的 ssh2 Client 上跑一条 shell 命令，收集 stdout / stderr / exit code
function runRemoteCommand(sshClient, cmd, callback) {
  let done = false;
  function finish(err, result) {
    if (done) return;
    done = true;
    callback(err || null, result);
  }
  try {
    sshClient.exec(cmd, function (err, stream) {
      if (err) { finish(err); return; }
      let stdout = '';
      let stderr = '';
      stream.on('data', function (data) { stdout += data.toString('utf8'); });
      stream.stderr.on('data', function (data) { stderr += data.toString('utf8'); });
      stream.on('close', function (code, signal) {
        finish(null, { code: typeof code === 'number' ? code : -1, signal: signal || null, stdout: stdout, stderr: stderr });
      });
      stream.on('error', function (e) { finish(e); });
    });
  } catch (e) {
    finish(e);
  }
}

// SNMP 一键部署：复用 ws 会话已有的 ssh2.Client + ensureSftp，把仓库里 snmp-bundle/ 的
// rpm 推到目标机 /root/webssh-snmp/，然后顺序执行：rpm 安装 → 写 snmpd.conf →
// SELinux 放行 → 开机自启 → 启动服务 → 验证。每一步把 stdout/stderr 通过
// ws 推回前端实时显示，最终发 snmp:done。
function runSnmpDeploy(payload, send, ssh, ensureSftp, sshReady) {
  const fs = require('fs');
  const path = require('path');
  const requestId = payload.requestId || '';
  const port = Number(payload.port) || 16161;

  function sendLog(streamKind, text) {
    if (!text) return;
    send('snmp:log', { requestId: requestId, stream: streamKind, text: String(text) });
  }
  function sendStep(text) {
    send('snmp:log', { requestId: requestId, stream: 'step', text: String(text) });
  }
  function done(ok, summary, err) {
    send('snmp:done', {
      requestId: requestId,
      ok: !!ok,
      summary: summary || '',
      message: err ? String(err.message || err) : '',
    });
  }

  if (!sshReady) {
    done(false, '', new Error('SSH 尚未就绪，请先连接主机再执行 SNMP 部署'));
    return;
  }

  const bundleDir = path.join(__dirname, 'snmp-bundle');
  let rpmFiles = [];
  try {
    rpmFiles = fs.readdirSync(bundleDir).filter(function (n) {
      return n.toLowerCase().endsWith('.rpm');
    }).sort();
  } catch (_e) {
    done(false, '', new Error('找不到 snmp-bundle 目录：' + bundleDir));
    return;
  }
  if (!rpmFiles.length) {
    done(false, '', new Error('snmp-bundle 目录里没有 rpm 文件'));
    return;
  }

  const remoteDir = '/root/webssh-snmp';

  function execRemote(cmd, opts) {
    const allowNonZero = !!(opts && opts.allowNonZero);
    return new Promise(function (resolve) {
      sendStep('$ ' + cmd);
      runRemoteCommand(ssh, cmd, function (err, result) {
        if (err) {
          sendLog('stderr', '执行异常：' + err.message + '\n');
          resolve({ code: -1, stdout: '', stderr: err.message });
          return;
        }
        if (result.stdout) sendLog('stdout', result.stdout);
        if (result.stderr) sendLog('stderr', result.stderr);
        if (result.code !== 0 && !allowNonZero) {
          sendLog('stderr', '\n[exit ' + result.code + ']\n');
        }
        resolve(result);
      });
    });
  }

  function sftpPut(remotePath, buffer, label) {
    return new Promise(function (resolve, reject) {
      ensureSftp(function (err, sftpClient) {
        if (err) return reject(err);
        sendStep((label || '上传') + ' → ' + remotePath + '（' + (buffer.length / 1024).toFixed(0) + ' KB）');
        uploadBuffer(sftpClient, remotePath, buffer, function (writeErr) {
          if (writeErr) return reject(writeErr);
          resolve();
        });
      });
    });
  }

  // snmpd.conf 写入策略：直接全量覆盖为最小可用配置（避免与已有 conf 中的 com2sec/group
  // /access 重名导致 snmpd 启动失败）。首次部署时把原 conf 备份到 .webssh.bak，便于回滚。
  // rocommunity public default 已经隐式生成 com2sec/group/access/view，无需再手写这些行。
  const confScript = [
    '#!/bin/bash',
    'set -e',
    'CONF=/etc/snmp/snmpd.conf',
    'if [ ! -f "$CONF" ]; then echo "缺少 $CONF，请确认 net-snmp 已安装" >&2; exit 1; fi',
    '[ -f "${CONF}.webssh.bak" ] || cp -a "$CONF" "${CONF}.webssh.bak"',
    'cat > "$CONF" <<\'__WEBSSH_SNMP_EOF__\'',
    '# Managed by webssh SNMP one-click deploy',
    '# 原 snmpd.conf 已备份到 /etc/snmp/snmpd.conf.webssh.bak（如需还原：mv 回去 + systemctl restart snmpd）',
    'agentAddress udp:' + port + ',tcp:' + port,
    'rocommunity public default',
    'syslocation "Beijing, China"',
    'syscontact admin@example.com',
    '__WEBSSH_SNMP_EOF__',
    'chmod 600 "$CONF"',
    'echo "snmpd.conf 已重写（端口 ' + port + '，原 conf 备份在 .webssh.bak）"',
  ].join('\n');

  (async function () {
    try {
      sendStep('开始部署 SNMP（端口 ' + port + '，将设置开机自启）');
      await execRemote('mkdir -p ' + remoteDir);

      // 上传 rpm
      for (let i = 0; i < rpmFiles.length; i++) {
        const name = rpmFiles[i];
        const buf = fs.readFileSync(path.join(bundleDir, name));
        await sftpPut(remoteDir + '/' + name, buf, '上传 rpm');
      }
      sendStep('已上传 ' + rpmFiles.length + ' 个 rpm 到 ' + remoteDir);

      // 上传配置脚本
      await sftpPut(remoteDir + '/_webssh_snmp_conf.sh', Buffer.from(confScript, 'utf8'), '上传 snmpd.conf 写入脚本');

      // 1. rpm 安装（已存在的包会非零退出，但只要 net-snmp 已就位就继续）
      const r1 = await execRemote('cd ' + remoteDir + ' && rpm -ivh *.rpm --nodeps --force', { allowNonZero: true });
      if (r1.code !== 0) {
        const q = await execRemote('rpm -q net-snmp', { allowNonZero: true });
        if (q.code !== 0) throw new Error('rpm 安装失败 (exit=' + r1.code + ')');
        sendStep('部分 rpm 提示已存在，net-snmp 已安装，继续');
      }

      // 2. 写 snmpd.conf
      await execRemote('bash ' + remoteDir + '/_webssh_snmp_conf.sh');

      // 3. SELinux 放行（无 semanage 自动跳过；端口已存在用 -m 修改）
      const semaUdp = 'command -v semanage >/dev/null 2>&1 && (semanage port -a -t snmp_port_t -p udp ' + port +
        ' 2>/dev/null || semanage port -m -t snmp_port_t -p udp ' + port + ' 2>/dev/null || true) || echo "semanage 未安装，跳过 SELinux 端口配置"';
      const semaTcp = 'command -v semanage >/dev/null 2>&1 && (semanage port -a -t snmp_port_t -p tcp ' + port +
        ' 2>/dev/null || semanage port -m -t snmp_port_t -p tcp ' + port + ' 2>/dev/null || true) || true';
      await execRemote(semaUdp, { allowNonZero: true });
      await execRemote(semaTcp, { allowNonZero: true });
      await execRemote('command -v semanage >/dev/null 2>&1 && semanage port -l 2>/dev/null | grep snmp_port_t || true', { allowNonZero: true });

      // 4. 开机自启
      await execRemote('systemctl enable snmpd', { allowNonZero: true });

      // 5. 重启服务（首次也等价于 start）
      await execRemote('systemctl restart snmpd');

      // 6. 验证
      const active = await execRemote('systemctl is-active snmpd', { allowNonZero: true });
      const enabled = await execRemote('systemctl is-enabled snmpd', { allowNonZero: true });
      await execRemote('ss -lnup 2>/dev/null | grep :' + port + ' || true', { allowNonZero: true });
      await execRemote('ss -lntp 2>/dev/null | grep :' + port + ' || true', { allowNonZero: true });

      const isActive = (active.stdout || '').trim() === 'active';
      const isEnabled = (enabled.stdout || '').trim() === 'enabled';
      const summary = 'snmpd: ' + (isActive ? '运行中' : '未运行') +
        ' ｜ 开机自启: ' + (isEnabled ? '已启用' : '未启用') +
        ' ｜ 端口: ' + port;
      sendStep((isActive ? '✅ ' : '⚠ ') + summary);
      done(isActive, summary);
    } catch (e) {
      sendStep('❌ 部署中断：' + (e.message || e));
      done(false, '', e);
    }
  })();
}

wss.on('connection', function (ws) {
  const ssh = new Client();
  let stream = null;
  let sftp = null;
  let sshReady = false;
  let lifetimeTimer = null; // 连接时长上限：到期后服务端主动断开
  let connectionHours = 0;

  function send(type, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: type, payload: payload }));
    } catch (_err) {
      // 发送失败不应传导到 pty，避免反压导致服务假死
    }
  }

  function ensureSftp(callback) {
    if (!sshReady) {
      callback(new Error('SSH 尚未就绪'));
      return;
    }
    if (sftp) {
      callback(null, sftp);
      return;
    }
    ssh.sftp(function (err, sftpStream) {
      if (err) {
        callback(err);
        return;
      }
      sftp = sftpStream;
      callback(null, sftp);
    });
  }

  ssh.on('ready', function () {
    sshReady = true;
    send('status', { state: 'connected' });
    // 连接时长上限：到期后由服务端主动断开，前端会清掉密码强制重输
    if (connectionHours > 0) {
      const ms = Math.min(connectionHours * 3600 * 1000, 0x7fffffff);
      lifetimeTimer = setTimeout(function () {
        send('error', { message: '连接时长已达 ' + connectionHours + ' 小时，已自动断开，请重新输入密码登录', code: 'lifetime_expired' });
        try { ssh.end(); } catch (_e) {}
        try { ws.close(); } catch (_e) {}
      }, ms);
    }
    ssh.shell({ term: 'xterm-color', cols: 120, rows: 30 }, function (err, shellStream) {
      if (err) {
        send('error', { message: err.message });
        ws.close();
        return;
      }

      stream = shellStream;

      // 背压保护：WebSocket 发送缓冲超过 4MB 时暂停 pty 流，避免 docker exec 之类瞬时大输出把内存和事件循环拖住
      const BACKPRESSURE_HIGH = 4 * 1024 * 1024;
      const BACKPRESSURE_LOW = 1 * 1024 * 1024;
      let paused = false;
      const backpressureTimer = setInterval(function () {
        if (!paused) return;
        if (ws.bufferedAmount <= BACKPRESSURE_LOW) {
          paused = false;
          try { shellStream.resume(); } catch (_err) {}
        }
      }, 200);
      shellStream.on('close', function () { clearInterval(backpressureTimer); });
      ws.on('close', function () {
        clearInterval(backpressureTimer);
        if (lifetimeTimer) { clearTimeout(lifetimeTimer); lifetimeTimer = null; }
      });

      shellStream.on('data', function (data) {
        send('output', { data: data.toString('utf8') });
        if (!paused && ws.bufferedAmount >= BACKPRESSURE_HIGH) {
          paused = true;
          try { shellStream.pause(); } catch (_err) {}
        }
      });

      shellStream.on('close', function () {
        send('status', { state: 'closed' });
        ws.close();
      });
    });
  });

  ssh.on('error', function (err) {
    send('error', { message: err.message });
    ws.close();
  });

  ws.on('message', function (raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch (_err) {
      return;
    }

    const payload = msg && msg.payload ? msg.payload : {};

    if (msg.type === 'connect') {
      const cfg = {
        host: payload.host || demoConfig.host,
        port: Number(payload.port || demoConfig.port),
        username: payload.user || demoConfig.username,
      };
      // 连接时长（小时）：0 = 不限制；上限 720h（30 天）
      let h = Number(payload.connectionHours);
      if (!Number.isFinite(h) || h < 0) h = 0;
      if (h > 720) h = 720;
      connectionHours = h;

      if (payload.auth === 'Password') {
        cfg.password = payload.password || demoConfig.password;
      } else if (payload.keyPath) {
        cfg.privateKey = fs.readFileSync(payload.keyPath);
      } else if (demoConfig.privateKey) {
        cfg.privateKey = demoConfig.privateKey;
      }

      send('status', { state: 'connecting' });
      ssh.connect(cfg);
      return;
    }

    if (msg.type === 'sftp:init') {
      ensureSftp(function (err) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'init',
            message: err.message,
          });
          return;
        }
        send('sftp:ready', {
          requestId: payload.requestId,
          cwd: '/var/www',
        });
      });
      return;
    }

    if (msg.type === 'sftp:list') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'list',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        const targetPath = payload.path || '/';
        sftpClient.readdir(targetPath, function (readErr, items) {
          if (readErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'list',
              path: targetPath,
              message: readErr.message,
            });
            return;
          }

          const entries = (items || []).map(function (item) {
            return normalizeSftpEntry(targetPath, item);
          }).sort(function (a, b) {
            if (a.type === 'dir' && b.type !== 'dir') return -1;
            if (a.type !== 'dir' && b.type === 'dir') return 1;
            return a.name.localeCompare(b.name, 'zh-CN');
          });

          send('sftp:list:result', {
            requestId: payload.requestId,
            path: targetPath,
            entries: entries,
          });
        });
      });
      return;
    }

    if (msg.type === 'sftp:upload') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'upload',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        try {
          const targetPath = payload.path;
          const fileName = payload.fileName || 'upload.bin';
          const buffer = dataUrlToBuffer(payload.content || '');
          uploadBuffer(sftpClient, targetPath, buffer, function (writeErr) {
            if (writeErr) {
              send('sftp:error', {
                requestId: payload.requestId,
                action: 'upload',
                path: targetPath,
                message: writeErr.message,
              });
              return;
            }
            send('sftp:upload:result', {
              requestId: payload.requestId,
              path: targetPath,
              fileName: fileName,
            });
          });
        } catch (uploadErr) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'upload',
            path: payload.path,
            message: uploadErr.message,
          });
        }
      });
      return;
    }

    if (msg.type === 'sftp:download') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'download',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        const targetPath = payload.path;
        const fileName = String(targetPath || '').split('/').filter(Boolean).pop() || 'download.bin';
        downloadBuffer(sftpClient, targetPath, function (readErr, buffer) {
          if (readErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'download',
              path: targetPath,
              message: readErr.message,
            });
            return;
          }

          send('sftp:download:result', {
            requestId: payload.requestId,
            path: targetPath,
            fileName: fileName,
            content: 'data:' + detectMimeByName(fileName) + ';base64,' + buffer.toString('base64'),
          });
        });
      });
      return;
    }

    if (msg.type === 'sftp:createFile') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'createFile',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        const targetPath = payload.path;
        const fileName = String(targetPath || '').split('/').filter(Boolean).pop() || '';
        if (!isValidRemoteName(fileName)) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'createFile',
            path: targetPath,
            message: '文件名无效',
          });
          return;
        }

        uploadBuffer(sftpClient, targetPath, Buffer.from(String(payload.content || ''), 'utf8'), function (writeErr) {
          if (writeErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'createFile',
              path: targetPath,
              message: writeErr.message,
            });
            return;
          }
          send('sftp:createFile:result', {
            requestId: payload.requestId,
            path: targetPath,
            fileName: fileName,
          });
        });
      });
      return;
    }

    if (msg.type === 'sftp:mkdir') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'mkdir',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        const targetPath = payload.path;
        const dirName = String(targetPath || '').split('/').filter(Boolean).pop() || '';
        if (!isValidRemoteName(dirName)) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'mkdir',
            path: targetPath,
            message: '文件夹名无效',
          });
          return;
        }

        sftpClient.mkdir(targetPath, function (mkdirErr) {
          if (mkdirErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'mkdir',
              path: targetPath,
              message: mkdirErr.message,
            });
            return;
          }
          send('sftp:mkdir:result', {
            requestId: payload.requestId,
            path: targetPath,
            dirName: dirName,
          });
        });
      });
      return;
    }

    if (msg.type === 'sftp:delete') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'delete',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        if (payload.entryType !== 'file') {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'delete',
            path: payload.path,
            message: '当前仅支持删除普通文件',
          });
          return;
        }

        sftpClient.unlink(payload.path, function (unlinkErr) {
          if (unlinkErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'delete',
              path: payload.path,
              message: unlinkErr.message,
            });
            return;
          }
          send('sftp:delete:result', {
            requestId: payload.requestId,
            path: payload.path,
          });
        });
      });
      return;
    }

    if (msg.type === 'sftp:rename') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'rename',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        const targetPath = payload.path;
        const newName = String(payload.newName || '').trim();
        if (!newName || newName.indexOf('/') > -1 || newName === '.' || newName === '..') {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'rename',
            path: targetPath,
            message: '新名称无效',
          });
          return;
        }

        const newPath = remoteJoin(remoteDirname(targetPath), newName);
        sftpClient.rename(targetPath, newPath, function (renameErr) {
          if (renameErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'rename',
              path: targetPath,
              message: renameErr.message,
            });
            return;
          }
          send('sftp:rename:result', {
            requestId: payload.requestId,
            path: targetPath,
            newPath: newPath,
            newName: newName,
          });
        });
      });
      return;
    }

    if (msg.type === 'sftp:readText') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'readText',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        const targetPath = payload.path;
        const fileName = String(targetPath || '').split('/').filter(Boolean).pop() || '';
        if (!isProbablyTextFile(fileName)) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'readText',
            path: targetPath,
            message: '当前仅支持编辑文本文件',
          });
          return;
        }

        downloadBuffer(sftpClient, targetPath, function (readErr, buffer) {
          if (readErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'readText',
              path: targetPath,
              message: readErr.message,
            });
            return;
          }
          if (buffer.length > 1024 * 1024) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'readText',
              path: targetPath,
              message: '文件过大，暂不支持在线编辑',
            });
            return;
          }
          send('sftp:readText:result', {
            requestId: payload.requestId,
            path: targetPath,
            content: buffer.toString('utf8'),
            encoding: 'utf8',
          });
        });
      });
      return;
    }

    if (msg.type === 'sftp:writeText') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'writeText',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        const targetPath = payload.path;
        const fileName = String(targetPath || '').split('/').filter(Boolean).pop() || '';
        if (!isProbablyTextFile(fileName)) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'writeText',
            path: targetPath,
            message: '当前仅支持编辑文本文件',
          });
          return;
        }

        const buffer = Buffer.from(String(payload.content || ''), 'utf8');
        uploadBuffer(sftpClient, targetPath, buffer, function (writeErr) {
          if (writeErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'writeText',
              path: targetPath,
              message: writeErr.message,
            });
            return;
          }
          send('sftp:writeText:result', {
            requestId: payload.requestId,
            path: targetPath,
          });
        });
      });
      return;
    }

    if (msg.type === 'snmp:deploy') {
      runSnmpDeploy(payload || {}, send, ssh, ensureSftp, sshReady);
      return;
    }

    if (!stream) return;

    if (msg.type === 'input' && typeof msg.data === 'string') {
      stream.write(msg.data);
      return;
    }

    if (msg.type === 'resize') {
      const cols = Number(msg.cols || 120);
      const rows = Number(msg.rows || 30);
      try {
        stream.setWindow(rows, cols, 0, 0);
      } catch (_err) {}
      return;
    }

    if (msg.type === 'signal') {
      try {
        stream.signal(msg.name);
      } catch (_err) {}
    }
  });

  ws.on('close', function () {
    sftp = null;
    sshReady = false;
    try {
      if (stream) stream.end();
    } catch (_err) {}
    try {
      ssh.end();
    } catch (_err) {}
  });
});

// ===================== 远程串口（WebSocket 桥接 /dev/ttyS*）=====================
//
// 协议：浏览器 ↔ /ws/serial
//   上行：{ type: 'open',  payload: { path, baudRate, dataBits, parity, stopBits } }
//         { type: 'input', data: '...' }       // 发送字节到串口（base64 或 utf8 字符串）
//         { type: 'close' }
//   下行：{ type: 'status', payload: { state, port, baudRate } }
//         { type: 'output', data: '...' }      // 从串口收到的字节（base64）
//         { type: 'error', payload: { message } }

function isValidDevicePath(p) {
  // 只允许打开 /dev/ttyS* 、/dev/ttyUSB* 、/dev/ttyACM*
  return typeof p === 'string' && /^\/dev\/tty(S|USB|ACM)\d+$/.test(p);
}

function normalizeBaud(b) {
  const n = Number(b);
  const allowed = [300, 600, 1200, 1800, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 500000, 921600, 1000000, 1500000, 2000000, 3000000];
  return allowed.indexOf(n) >= 0 ? n : 115200;
}

function buildSttyArgs(device, opts) {
  const args = ['-F', device, 'raw', '-echo', '-echoe', '-echok', '-echoctl', '-echoke'];
  args.push(String(normalizeBaud(opts.baudRate || 115200)));
  // data bits
  const dataBits = Number(opts.dataBits) === 7 ? 'cs7' : 'cs8';
  args.push(dataBits);
  // parity
  const parity = String(opts.parity || 'none').toLowerCase();
  if (parity === 'even') args.push('parenb', '-parodd');
  else if (parity === 'odd') args.push('parenb', 'parodd');
  else args.push('-parenb');
  // stop bits
  if (Number(opts.stopBits) === 2) args.push('cstopb');
  else args.push('-cstopb');
  // 流控：默认关闭
  args.push('-crtscts', '-ixon', '-ixoff');
  // 忽略 modem 控制线（没接 DCD 也能打开）
  args.push('clocal', '-hupcl');
  return args;
}

function runStty(device, opts) {
  return new Promise(function (resolve, reject) {
    const child = spawn('stty', buildSttyArgs(device, opts));
    let stderr = '';
    child.stderr.on('data', function (chunk) { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', function (code) {
      if (code === 0) resolve();
      else reject(new Error('stty 配置失败: ' + (stderr.trim() || ('exit ' + code))));
    });
  });
}

wssSerial.on('connection', function (ws) {
  let deviceStream = null;   // fs.ReadStream + .write
  let writeStream = null;
  let currentPath = null;

  function send(type, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: type, payload: payload }));
    } catch (_err) {
      // 发送失败不应传导到 pty，避免反压导致服务假死
    }
  }

  function closeDevice(reason) {
    if (currentPath) {
      serialLocks.delete(currentPath);
      currentPath = null;
    }
    try { if (deviceStream) deviceStream.destroy(); } catch (_err) {}
    try { if (writeStream) writeStream.end(); } catch (_err) {}
    deviceStream = null;
    writeStream = null;
    send('status', { state: 'closed', reason: reason || '' });
  }

  ws.on('message', function (raw) {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch (_err) { return; }
    const payload = msg && msg.payload ? msg.payload : {};

    if (msg.type === 'open') {
      const devPath = payload.path;
      if (!isValidDevicePath(devPath)) {
        send('error', { message: '无效的设备路径：' + devPath });
        return;
      }
      if (serialLocks.has(devPath)) {
        send('error', { message: devPath + ' 正被其他会话占用' });
        return;
      }
      if (!fs.existsSync(devPath)) {
        send('error', { message: '设备不存在：' + devPath });
        return;
      }

      // 先用 stty 配置，再打开文件描述符
      runStty(devPath, payload).then(function () {
        try {
          deviceStream = fs.createReadStream(devPath, { highWaterMark: 4096 });
          writeStream = fs.createWriteStream(devPath, { flags: 'r+' });
        } catch (err) {
          send('error', { message: '打开串口失败：' + err.message });
          closeDevice('open-failed');
          return;
        }
        currentPath = devPath;
        serialLocks.set(devPath, { since: Date.now() });

        deviceStream.on('data', function (chunk) {
          send('output', { data: chunk.toString('base64'), encoding: 'base64' });
        });
        deviceStream.on('error', function (err) {
          send('error', { message: '串口读取错误：' + err.message });
          closeDevice('read-error');
        });
        deviceStream.on('close', function () {
          closeDevice('device-closed');
        });
        writeStream.on('error', function (err) {
          send('error', { message: '串口写入错误：' + err.message });
        });

        send('status', {
          state: 'opened',
          port: devPath,
          baudRate: normalizeBaud(payload.baudRate || 115200),
        });
      }).catch(function (err) {
        send('error', { message: err.message });
      });
      return;
    }

    if (msg.type === 'input') {
      if (!writeStream) {
        send('error', { message: '串口未打开' });
        return;
      }
      let buf;
      if (payload.encoding === 'base64') {
        buf = Buffer.from(String(payload.data || ''), 'base64');
      } else {
        buf = Buffer.from(String(payload.data || msg.data || ''), 'utf8');
      }
      try { writeStream.write(buf); } catch (err) {
        send('error', { message: '写入失败：' + err.message });
      }
      return;
    }

    if (msg.type === 'close') {
      closeDevice('client-close');
      return;
    }
  });

  ws.on('close', function () {
    closeDevice('ws-close');
  });
});

// ===================== TCP 客户端桥接（浏览器 ↔ /ws/tcp ↔ 远端 TCP 服务）=====================
//
// 协议：浏览器 ↔ /ws/tcp
//   上行：{ type: 'open',  payload: { host, port, connectTimeoutMs? } }
//         { type: 'input', payload: { encoding: 'base64'|'utf8', data } }
//         { type: 'close' }
//   下行：{ type: 'status', payload: { state, host, port, remoteAddress?, reason? } }
//         { type: 'output', payload: { encoding: 'base64', data } }
//         { type: 'error',  payload: { message } }

function isValidTcpHost(h) {
  if (typeof h !== 'string') return false;
  const s = h.trim();
  if (!s || s.length > 253) return false;
  // 允许 IPv4 / IPv6 / 合法主机名；阻止明显异常字符
  return /^[A-Za-z0-9._:\-\[\]]+$/.test(s);
}

function normalizeTcpPort(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 65535 || Math.floor(n) !== n) return null;
  return n;
}

wssTcp.on('connection', function (ws) {
  let socket = null;
  let connectedTarget = null;

  function send(type, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: type, payload: payload }));
    } catch (_err) {}
  }

  function teardown(reason) {
    const prev = connectedTarget;
    connectedTarget = null;
    if (socket) {
      try { socket.destroy(); } catch (_err) {}
      socket = null;
    }
    if (prev) {
      send('status', { state: 'closed', host: prev.host, port: prev.port, reason: reason || '' });
    } else {
      send('status', { state: 'closed', reason: reason || '' });
    }
  }

  ws.on('message', function (raw) {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch (_err) { return; }
    const payload = msg && msg.payload ? msg.payload : {};

    if (msg.type === 'open') {
      if (socket) {
        send('error', { message: '连接已存在，请先关闭' });
        return;
      }
      const host = String(payload.host || '').trim();
      const port = normalizeTcpPort(payload.port);
      if (!isValidTcpHost(host)) {
        send('error', { message: '无效的主机地址：' + host });
        return;
      }
      if (port == null) {
        send('error', { message: '无效的端口号：' + payload.port });
        return;
      }
      const connectTimeoutMs = Math.max(500, Math.min(60000, Number(payload.connectTimeoutMs) || 5000));

      send('status', { state: 'connecting', host: host, port: port });

      socket = new net.Socket();
      socket.setNoDelay(true);
      let connectTimer = setTimeout(function () {
        if (socket && !connectedTarget) {
          send('error', { message: '连接超时' });
          teardown('timeout');
        }
      }, connectTimeoutMs);

      socket.on('connect', function () {
        clearTimeout(connectTimer);
        connectedTarget = { host: host, port: port };
        send('status', {
          state: 'opened',
          host: host,
          port: port,
          remoteAddress: socket.remoteAddress || '',
          remotePort: socket.remotePort || 0,
        });
      });

      socket.on('data', function (chunk) {
        send('output', { encoding: 'base64', data: chunk.toString('base64') });
      });

      socket.on('error', function (err) {
        clearTimeout(connectTimer);
        send('error', { message: 'TCP 错误：' + err.message });
      });

      socket.on('close', function (hadError) {
        clearTimeout(connectTimer);
        teardown(hadError ? 'transport-error' : 'remote-close');
      });

      try {
        socket.connect(port, host);
      } catch (err) {
        clearTimeout(connectTimer);
        send('error', { message: '发起连接失败：' + err.message });
        teardown('connect-failed');
      }
      return;
    }

    if (msg.type === 'input') {
      if (!socket || !connectedTarget) {
        send('error', { message: 'TCP 未连接' });
        return;
      }
      let buf;
      if (payload.encoding === 'base64') {
        buf = Buffer.from(String(payload.data || ''), 'base64');
      } else {
        buf = Buffer.from(String(payload.data || msg.data || ''), 'utf8');
      }
      if (!buf.length) return;
      try { socket.write(buf); } catch (err) {
        send('error', { message: '发送失败：' + err.message });
      }
      return;
    }

    if (msg.type === 'close') {
      teardown('client-close');
      return;
    }
  });

  ws.on('close', function () {
    teardown('ws-close');
  });
});

// ===== docker 自动重启模块 =====
// 目的：解决系统开机后 docker 偶发启动异常——服务起来时若启用，倒计时后本机执行 systemctl restart docker。
(function setupDockerRestart() {
  const path = require('path');

  const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'docker-restart.json');
  const CONFIG_PATH = process.env.DOCKER_RESTART_CONFIG || DEFAULT_CONFIG_PATH;
  const LOG_PATH = process.env.DOCKER_RESTART_LOG
    || path.join(__dirname, '..', 'logs', 'docker-restart.log');
  const MIN_SEC = 10;
  const MAX_SEC = 3600;

  const defaults = { enabled: false, countdownSec: 60, lastResult: null };
  let config = Object.assign({}, defaults);
  let timer = null;
  let deadlineMs = 0;
  let running = false;

  // 服务器本地时间字符串 "YYYY-MM-DD HH:mm:ss"，避免落盘/推给前端的是 UTC（Z 结尾）跟实际差 8 小时
  function localStamp(d) {
    d = d || new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function readConfig() {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      config = {
        enabled: Boolean(parsed.enabled),
        countdownSec: clampSec(Number(parsed.countdownSec) || defaults.countdownSec),
        lastResult: parsed.lastResult || null,
      };
    } catch (_err) {
      config = Object.assign({}, defaults);
    }
  }

  function writeConfig() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.error('[docker-restart] 写配置失败:', err.message);
    }
  }

  function clampSec(v) {
    if (!Number.isFinite(v)) return defaults.countdownSec;
    return Math.max(MIN_SEC, Math.min(MAX_SEC, Math.floor(v)));
  }

  function appendLog(line) {
    const stamp = localStamp();
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, `[${stamp}] ${line}\n`, 'utf8');
    } catch (_err) {}
  }

  function cancelTimer(reason) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      deadlineMs = 0;
      appendLog(`倒计时取消：${reason || ''}`.trim());
    }
  }

  function scheduleCountdown(reason) {
    cancelTimer('replaced');
    if (!config.enabled) return;
    const sec = config.countdownSec;
    deadlineMs = Date.now() + sec * 1000;
    appendLog(`倒计时开始：${sec}s，触发来源=${reason || 'unknown'}`);
    timer = setTimeout(function () {
      timer = null;
      deadlineMs = 0;
      runRestart('countdown');
    }, sec * 1000);
  }

  function runRestart(trigger) {
    if (running) return Promise.resolve({ ok: false, message: 'already-running' });
    running = true;
    const startedAt = localStamp();
    appendLog(`执行 systemctl restart docker（触发=${trigger}）`);
    // 重启 docker 必断 mysql 容器，先通知 sms-db 关池暂停重试，
    // exit 后再启动重试，让 UI 立刻能反映"已断开"，避免 polling 撞运气自愈期间状态错位。
    if (typeof global.__smsDbPrepareForRestart === 'function') {
      try { global.__smsDbPrepareForRestart('docker-restart:' + trigger); } catch (_e) {}
    }
    return new Promise(function (resolve) {
      const child = spawn('systemctl', ['restart', 'docker']);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', function (b) { stdout += b.toString('utf8'); });
      child.stderr.on('data', function (b) { stderr += b.toString('utf8'); });
      child.on('close', function (code) {
        running = false;
        const ok = code === 0;
        const finishedAt = localStamp();
        const result = {
          ok: ok,
          exitCode: code,
          trigger: trigger,
          startedAt: startedAt,
          finishedAt: finishedAt,
          stdout: stdout.slice(-2000),
          stderr: stderr.slice(-2000),
        };
        config.lastResult = result;
        writeConfig();
        appendLog(`执行完成 exit=${code} ok=${ok}`);
        if (typeof global.__smsDbRecover === 'function') {
          try { global.__smsDbRecover('docker-restart:' + trigger + ':exit=' + code); } catch (_e) {}
        }
        resolve(result);
      });
      child.on('error', function (err) {
        running = false;
        const result = {
          ok: false,
          exitCode: null,
          trigger: trigger,
          startedAt: startedAt,
          finishedAt: localStamp(),
          stdout: '',
          stderr: 'spawn error: ' + err.message,
        };
        config.lastResult = result;
        writeConfig();
        appendLog(`执行错误：${err.message}`);
        // spawn 失败也走恢复钩子，让 sms-db 至少把池重新拉起来（mysql 可能并未真的重启）
        if (typeof global.__smsDbRecover === 'function') {
          try { global.__smsDbRecover('docker-restart:' + trigger + ':spawn-error'); } catch (_e) {}
        }
        resolve(result);
      });
    });
  }

  function publicState() {
    const remainingMs = deadlineMs ? Math.max(0, deadlineMs - Date.now()) : 0;
    return {
      enabled: config.enabled,
      countdownSec: config.countdownSec,
      counting: Boolean(timer),
      remainingSec: Math.ceil(remainingMs / 1000),
      running: running,
      lastResult: config.lastResult,
    };
  }

  app.use(express.json({ limit: '16mb' }));

  app.get('/api/docker-restart/config', function (_req, res) {
    res.json(publicState());
  });

  app.put('/api/docker-restart/config', function (req, res) {
    const body = req.body || {};
    const prevEnabled = config.enabled;
    if (typeof body.enabled === 'boolean') config.enabled = body.enabled;
    if (body.countdownSec !== undefined) config.countdownSec = clampSec(Number(body.countdownSec));
    writeConfig();
    if (!config.enabled) {
      cancelTimer('config-disabled');
    } else if (!prevEnabled && config.enabled) {
      scheduleCountdown('config-enabled');
    }
    res.json(publicState());
  });

  app.post('/api/docker-restart/cancel', function (_req, res) {
    cancelTimer('user-cancel');
    res.json(publicState());
  });

  app.post('/api/docker-restart/trigger', function (_req, res) {
    cancelTimer('manual-trigger');
    runRestart('manual').then(function () { res.json(publicState()); });
  });

  app.post('/api/docker-restart/restart-countdown', function (_req, res) {
    scheduleCountdown('manual-restart');
    res.json(publicState());
  });

  app.get('/api/docker-restart/log', function (_req, res) {
    try {
      const raw = fs.readFileSync(LOG_PATH, 'utf8');
      const tail = raw.split('\n').slice(-200).join('\n');
      res.type('text/plain').send(tail);
    } catch (_err) {
      res.type('text/plain').send('');
    }
  });

  readConfig();
  if (config.enabled) scheduleCountdown('service-start');
  appendLog(`服务启动，enabled=${config.enabled} countdown=${config.countdownSec}s`);
})();

// ===== 信创短信猫 - 数据库连接模块 =====
// 目的：给"短信猫"功能提供一条可配置、可持久化、可开机自启的 MySQL 连接
(function setupSmsDb() {
  const path = require('path');
  let mysql;
  try { mysql = require('mysql2/promise'); } catch (_e) { mysql = null; }

  const CONFIG_DIR = path.join(__dirname, 'config');
  const CONFIG_PATH = process.env.SMS_DB_CONFIG || path.join(CONFIG_DIR, 'sms-db.json');
  const LOG_PATH = process.env.SMS_DB_LOG || path.join(__dirname, 'logs', 'sms-db.log');

  const defaults = {
    host: '127.0.0.1',
    port: 3306,
    database: '',
    user: '',
    password: '',
    autoStart: false, // 上次手动"连接成功"后置 true；手动"断开"后置 false
  };
  let cfg = Object.assign({}, defaults);
  let pool = null;
  let connected = false;
  let lastError = '';
  let lastConnectedAt = '';
  let lastAttempt = null; // 最近一次"连接"请求的参数（不含密码），不落盘

  function localStamp(d) {
    d = d || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, `[${localStamp()}] ${line}\n`, 'utf8');
    } catch (_e) {}
  }

  function readCfg() {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      cfg = Object.assign({}, defaults, parsed);
    } catch (_e) { cfg = Object.assign({}, defaults); }
  }

  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      // 密码在里面，尽量收紧权限；非 root 或 Windows 会忽略错误
      try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_e) {}
    } catch (err) {
      console.error('[sms-db] 写配置失败:', err.message);
    }
  }

  function publicStatus() {
    const display = lastAttempt || cfg;
    return {
      connected,
      autoStart: !!cfg.autoStart,
      host: display.host,
      port: display.port,
      user: display.user,
      database: display.database,
      lastError,
      lastConnectedAt,
      driverReady: !!mysql,
      autoRetrying: !!autoRetryTimer,
      autoRetryCount,
    };
  }

  async function closePool(reason) {
    if (pool) {
      const old = pool;
      pool = null;
      connected = false;
      try { await old.end(); } catch (_e) {}
      appendLog(`已断开：${reason || ''}`.trim());
    } else {
      connected = false;
    }
  }

  async function openPool(options) {
    if (!mysql) throw new Error('mysql2 驱动未安装');
    await closePool('reconnect');
    const p = mysql.createPool({
      host: options.host,
      port: Number(options.port) || 3306,
      user: options.user,
      password: options.password,
      database: options.database || undefined,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 8000,
    });
    // 立即拿一条连接做探活，失败就扔异常
    const conn = await p.getConnection();
    try { await conn.ping(); } finally { conn.release(); }
    pool = p;
    connected = true;
    lastError = '';
    lastConnectedAt = localStamp();
    return p;
  }

  // autoStart 后台重试：开机时 mysql 容器可能还没起来，
  // 一次连接失败不放弃，每 5s 复试一次，连上就停。
  // 手动 connect 成功 / disconnect 时也会停。
  const AUTO_RETRY_MS = 5000;
  let autoRetryTimer = null;
  let autoRetryCount = 0;
  function stopAutoRetry(reason) {
    if (autoRetryTimer) {
      clearInterval(autoRetryTimer);
      autoRetryTimer = null;
      if (autoRetryCount > 0) {
        appendLog(`后台重试停止（${reason || '-'}），共试 ${autoRetryCount} 次`);
      }
      autoRetryCount = 0;
    }
  }
  function startAutoRetry() {
    if (autoRetryTimer) return;
    autoRetryCount = 0;
    appendLog(`启用 autoStart 后台重试，每 ${AUTO_RETRY_MS / 1000}s 试一次`);
    autoRetryTimer = setInterval(async function () {
      // 退出条件：autoStart 已关 / 已经连上 / 配置不完整
      if (!cfg.autoStart) { stopAutoRetry('autoStart 已关'); return; }
      if (connected) { stopAutoRetry('已连接'); return; }
      if (!cfg.host || !cfg.user) { stopAutoRetry('配置不完整'); return; }
      autoRetryCount += 1;
      try {
        await openPool(cfg);
        appendLog(`重试第 ${autoRetryCount} 次连接成功：${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database || '-'}`);
        stopAutoRetry('连接成功');
      } catch (err) {
        lastError = err.message;
        // 默认不刷日志（避免每 5s 一行），每 12 次（约 1 分钟）写一次
        if (autoRetryCount === 1 || autoRetryCount % 12 === 0) {
          appendLog(`重试第 ${autoRetryCount} 次仍失败：${err.message}`);
        }
      }
    }, AUTO_RETRY_MS);
  }

  async function tryAutoStart() {
    if (!cfg.autoStart) { appendLog('未开启 autoStart，跳过自启'); return; }
    if (!cfg.host || !cfg.user) { appendLog('配置不完整，跳过自启'); return; }
    try {
      await openPool(cfg);
      appendLog(`自启成功：${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database || '-'}`);
    } catch (err) {
      lastError = err.message;
      appendLog(`自启失败：${err.message}（启用后台重试）`);
      startAutoRetry();
    }
  }

  app.get('/api/sms/db/status', function (_req, res) {
    res.json(publicStatus());
  });

  app.post('/api/sms/db/connect', async function (req, res) {
    const body = req.body || {};
    const host = String(body.host || '').trim() || defaults.host;
    const port = Number(body.port) || defaults.port;
    const user = String(body.user || '').trim();
    const password = String(body.password || '');
    const database = String(body.database || '').trim();
    // rememberPassword 默认 true（兼容老前端不传该字段）
    const rememberPassword = body.rememberPassword === undefined ? true : !!body.rememberPassword;
    if (!user) return res.status(400).json({ ok: false, message: '用户名不能为空' });
    if (!mysql) return res.status(500).json({ ok: false, message: 'mysql2 驱动未安装' });
    lastAttempt = { host, port, user, database };
    try {
      await openPool({ host, port, user, password, database });
      if (rememberPassword) {
        // 落盘：密码 + autoStart=true，开机自启
        cfg = Object.assign({}, cfg, { host, port, user, password, database, autoStart: true });
        writeCfg();
        appendLog(`手动连接成功（已记住密码）：${user}@${host}:${port}/${database || '-'}`);
      } else {
        // 不落盘：内存里保留连接参数（推送/查询会用到 host/user/database），但不写文件，
        // 同时显式清空磁盘上的旧密码并关闭 autoStart，防止重启后用旧密码自动连接
        cfg = Object.assign({}, cfg, { host, port, user, database, password: '', autoStart: false });
        writeCfg();
        // 但内存里要保留刚刚用过的密码，否则后台重试 / 推送复用池时拿不到密码
        cfg.password = password;
        appendLog(`手动连接成功（未记住密码，仅本会话有效）：${user}@${host}:${port}/${database || '-'}`);
      }
      stopAutoRetry('手动连接成功');
      res.json({ ok: true, status: publicStatus() });
    } catch (err) {
      lastError = err.message;
      appendLog(`手动连接失败：${err.message}（尝试 ${user}@${host}:${port}/${database || '-'}）`);
      res.status(500).json({ ok: false, message: err.message, status: publicStatus() });
    }
  });

  app.post('/api/sms/db/disconnect', async function (_req, res) {
    stopAutoRetry('手动断开');
    await closePool('manual-disconnect');
    cfg.autoStart = false;
    writeCfg();
    appendLog('手动断开，已关闭 autoStart');
    res.json({ ok: true, status: publicStatus() });
  });

  readCfg();
  tryAutoStart().catch(() => {});

  // 对外暴露一个只读入口，方便后续短信猫推送模块复用同一连接池
  global.__smsDbGetPool = function () { return pool; };

  // 运行期"连接坏了"的统一入口：监测模块、推送模块拿池查询时遇到网络级错误调用它。
  // 行为：关掉旧池 → 标记 lastError → 如果 autoStart 仍开着就启动后台重试。
  // 节流：1 秒内多个并发查询都报错时，只触发一次 close + retry，避免日志刷屏。
  let _lastBrokenAt = 0;
  global.__smsDbMarkBroken = function (reason) {
    const now = Date.now();
    if (now - _lastBrokenAt < 1000) return;
    _lastBrokenAt = now;
    if (!pool && !connected) {
      // 已经断了的状态，别重复 close，但要确保重试在跑
      if (cfg.autoStart && cfg.host && cfg.user) startAutoRetry();
      return;
    }
    appendLog(`运行期检测到连接异常：${reason || '-'}（关池并启用后台重试）`);
    closePool('runtime-broken: ' + (reason || '')).then(function () {
      lastError = String(reason || 'connection-broken');
      if (cfg.autoStart && cfg.host && cfg.user) startAutoRetry();
    }).catch(function () { /* close 不会抛 */ });
  };

  // docker 重启钩子：重启前主动关池 + 暂停重试，重启后启动重试。
  // 这两步不依赖 autoStart——业务有明确语义：重启 docker 必断 mysql。
  global.__smsDbPrepareForRestart = function (reason) {
    appendLog(`收到重启前钩子：${reason || '-'}（关池并暂停重试）`);
    stopAutoRetry('docker-restart-before');
    return closePool('docker-restart-before').catch(function () {});
  };
  global.__smsDbRecover = function (reason) {
    appendLog(`收到重启后钩子：${reason || '-'}（启动后台重试）`);
    if (!cfg.autoStart) {
      appendLog('autoStart 未开启，重启后跳过自动重连');
      return;
    }
    if (!cfg.host || !cfg.user) {
      appendLog('配置不完整，重启后跳过自动重连');
      return;
    }
    startAutoRetry();
  };
})();

// ===== 双机热备：SSH 长连接 + DB 池 + 3s 心跳 + WebSocket /ws/ha =====
(function setupHa() {
  const path = require('path');
  let mysql;
  try { mysql = require('mysql2/promise'); } catch (_e) { mysql = null; }

  const CONFIG_PATH = process.env.HA_CONFIG || path.join(__dirname, 'config', 'ha.json');
  const LOG_PATH = process.env.HA_LOG || path.join(__dirname, 'logs', 'ha.log');

  const defaults = {
    enabled: false,
    selfRole: 'primary', // primary | standby
    primary: {
      ssh: { host: '192.168.0.22', port: 22, user: 'root', password: '' },
      db:  { host: '192.168.0.22', port: 3306, database: '', user: '', password: '' },
    },
    standby: {
      ssh: { host: '192.168.0.50', port: 22, user: 'root', password: '' },
      db:  { host: '192.168.0.50', port: 3306, database: '', user: '', password: '' },
    },
    // 定时同步：仅 primary 角色 + 主备总开关启用时才会真的跑
    syncSchedule: {
      enabled: false,
      preset: 'daily-3am',                // daily-2am | daily-3am | weekly-sun-3am | custom
      cron: '0 3 * * *',                  // preset=custom 时使用
      skipIfPeerDown: true,                // 备机不可达时跳过本次
      applyStatusMinusOne: true,           // 同步后做 status=-1 假删除（与手动同步一致）
      lastRunAt: '',                       // 上次执行时间
      lastRunResult: '',                   // success | fail | skipped-peer-down | skipped-mutex
      lastRunError: '',
    },
    // 故障接管：仅 standby 角色 + 主备总开关启用时才会真的跑
    failover: {
      enabled: false,                      // 缓冲监测是否启用
      bufferSec: 30,                       // 缓冲时长（秒）
      bufferPreset: '30',                  // 10 | 30 | 60 | 120 | custom
      judgeMode: 'any',                    // any（任一端口不通就算）| both | ip-only
      consecutiveFails: 2,                 // 连续 N 次心跳失败才确认失联
      // 自动让位（已接管态下检测到主机回归 → 自动 reset 让业务回主机）
      autoYieldOnPeerRecover: true,        // 是否启用自动让位
      autoYieldConsecutive: 5,             // 接管态下连续 N 次心跳全通才触发自动让位（默认 5×3s=15s）
      cooldownSec: 60,                     // reset 后的冷却时长（秒）：期间不触发新一轮接管/让位，防震荡
      // 运行期状态
      takenOver: false,                    // 是否已接管（接管后置 true，运维重置才回 false）
      takenOverAt: '',                     // 接管成功时刻
      takenOverError: '',                  // 接管失败原因（最近一次）
      lastFailCount: 0,                    // 当前连续失败次数（监测中实时更新）
    },
    // 主机让位状态：仅 primary 角色被动维护，发现备机已接管时自动停 dcim
    yielded: {
      yieldedToStandby: false,             // 当前是否已让位给备机
      yieldedAt: '',
    },
  };

  function deepMerge(target, src) {
    const out = Object.assign({}, target);
    for (const k of Object.keys(src || {})) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
        out[k] = deepMerge(target[k] || {}, src[k]);
      } else {
        out[k] = src[k];
      }
    }
    return out;
  }

  let cfg = JSON.parse(JSON.stringify(defaults));

  // 状态机
  let pool = null;
  let dbConnected = false;
  let dbLastError = '';
  let dbLastConnectedAt = '';
  let dbAutoRetryTimer = null;
  let dbAutoRetryCount = 0;

  let sshClient = null;          // ssh2 Client 单例
  let sshStatus = 'idle';        // idle | connecting | connected | broken
  let sshLastError = '';
  let sshReconnectTimer = null;
  let sshReconnectDelay = 1000;  // 初始 1s，封顶 5s

  let heartbeatTimer = null;
  let heartbeatProbing = false;
  let lastHeartbeat = { ipOk: false, dbPortOk: false, ts: 0 };
  let lastBroadcastIpOk = null;
  let lastBroadcastDbOk = null;

  // ---------- 数据库同步任务状态 ----------
  // 仅当 selfRole=primary 时允许触发；任何时刻只允许 1 个同步任务在跑
  let syncRunning = false;
  let syncStep = '';            // 当前阶段，便于前端展示进度
  let syncStartedAt = '';
  let syncFinishedAt = '';
  let syncLastResult = '';      // success | fail | ''
  let syncLastError = '';
  const syncSteps = [];         // 本轮所有阶段记录，最多 50 条

  // 最近事件环形队列（用于新连入 ws 一次性下发 snapshot）
  const RECENT_EVENTS_MAX = 200;
  const recentEvents = [];

  // ---------- 工具函数 ----------
  function localStamp(d) {
    d = d || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, `[${localStamp()}] ${line}\n`, 'utf8');
    } catch (_e) {}
  }

  function readCfg() {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      cfg = deepMerge(defaults, parsed);
    } catch (_e) {
      cfg = JSON.parse(JSON.stringify(defaults));
    }
  }

  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_e) {}
    } catch (err) {
      console.error('[ha] 写配置失败:', err.message);
    }
  }

  // 隐藏密码用于响应
  function redactCfg(c) {
    const cp = JSON.parse(JSON.stringify(c));
    ['primary', 'standby'].forEach(function (k) {
      if (cp[k]) {
        if (cp[k].ssh) cp[k].ssh.password = cp[k].ssh.password ? '***' : '';
        if (cp[k].db)  cp[k].db.password  = cp[k].db.password  ? '***' : '';
      }
    });
    return cp;
  }

  // 计算"对端"配置：selfRole=primary 时对端是 standby，反之亦然
  function peerOf(cfgIn) {
    const c = cfgIn || cfg;
    return c.selfRole === 'primary' ? c.standby : c.primary;
  }

  function selfOf(cfgIn) {
    const c = cfgIn || cfg;
    return c.selfRole === 'primary' ? c.primary : c.standby;
  }

  // 推送给所有 /ws/ha 客户端
  function broadcast(obj) {
    let payload;
    try { payload = JSON.stringify(obj); } catch (_e) { return; }
    wssHa.clients.forEach(function (ws) {
      if (ws.readyState === 1) {
        try { ws.send(payload); } catch (_e) {}
      }
    });
  }

  function pushEvent(level, msg) {
    const ev = { level, msg, ts: localStamp() };
    recentEvents.push(ev);
    while (recentEvents.length > RECENT_EVENTS_MAX) recentEvents.shift();
    appendLog(`[${level}] ${msg}`);
    broadcast({ type: 'event', data: ev });
  }

  function publicStatus() {
    const peer = peerOf(cfg);
    return {
      enabled: !!cfg.enabled,
      selfRole: cfg.selfRole,
      peer: {
        sshHost: peer.ssh.host, sshPort: peer.ssh.port,
        dbHost:  peer.db.host,  dbPort:  peer.db.port,
        dbDatabase: peer.db.database, dbUser: peer.db.user,
      },
      ssh: { status: sshStatus, lastError: sshLastError },
      db:  {
        connected: dbConnected, lastError: dbLastError, lastConnectedAt: dbLastConnectedAt,
        autoRetrying: !!dbAutoRetryTimer, autoRetryCount: dbAutoRetryCount,
        driverReady: !!mysql,
      },
      heartbeat: lastHeartbeat,
      recentEvents: recentEvents.slice(-50),
      sync: {
        running: syncRunning,
        step: syncStep,
        startedAt: syncStartedAt,
        finishedAt: syncFinishedAt,
        lastResult: syncLastResult,
        lastError: syncLastError,
        steps: syncSteps.slice(-30),
        allowed: cfg.selfRole === 'primary',  // 仅主机可触发
        schedule: {
          enabled: !!(cfg.syncSchedule && cfg.syncSchedule.enabled),
          preset: (cfg.syncSchedule && cfg.syncSchedule.preset) || 'daily-3am',
          cron: effectiveCron(),
          customCron: (cfg.syncSchedule && cfg.syncSchedule.cron) || '0 3 * * *',
          skipIfPeerDown: cfg.syncSchedule ? !!cfg.syncSchedule.skipIfPeerDown : true,
          applyStatusMinusOne: cfg.syncSchedule ? !!cfg.syncSchedule.applyStatusMinusOne : true,
          lastRunAt: (cfg.syncSchedule && cfg.syncSchedule.lastRunAt) || '',
          lastRunResult: (cfg.syncSchedule && cfg.syncSchedule.lastRunResult) || '',
          lastRunError: (cfg.syncSchedule && cfg.syncSchedule.lastRunError) || '',
          nextRunAt: getNextRunAt(),
          running: !!scheduleTimer,
        },
      },
      failover: {
        enabled: !!(cfg.failover && cfg.failover.enabled),
        bufferSec: (cfg.failover && cfg.failover.bufferSec) || 30,
        bufferPreset: (cfg.failover && cfg.failover.bufferPreset) || '30',
        judgeMode: (cfg.failover && cfg.failover.judgeMode) || 'any',
        consecutiveFails: (cfg.failover && cfg.failover.consecutiveFails) || 2,
        autoYieldOnPeerRecover: cfg.failover ? !!cfg.failover.autoYieldOnPeerRecover : true,
        autoYieldConsecutive: (cfg.failover && cfg.failover.autoYieldConsecutive) || 5,
        cooldownSec: (cfg.failover && cfg.failover.cooldownSec != null) ? cfg.failover.cooldownSec : 60,
        cooldownRemainingSec: typeof failoverCooldownUntil !== 'undefined' && failoverCooldownUntil > Date.now()
          ? Math.ceil((failoverCooldownUntil - Date.now()) / 1000) : 0,
        takenOver: !!(cfg.failover && cfg.failover.takenOver),
        takenOverAt: (cfg.failover && cfg.failover.takenOverAt) || '',
        takenOverError: (cfg.failover && cfg.failover.takenOverError) || '',
        state: typeof failoverState !== 'undefined' ? failoverState : 'idle',
        failCount: typeof failoverFailCount !== 'undefined' ? failoverFailCount : 0,
        countdownSec: typeof failoverCountdownSec !== 'undefined' ? failoverCountdownSec : 0,
        running: typeof failoverCheckTimer !== 'undefined' && !!failoverCheckTimer,
        allowed: cfg.selfRole === 'standby' && cfg.enabled,
      },
      yielded: {
        yieldedToStandby: !!(cfg.yielded && cfg.yielded.yieldedToStandby),
        yieldedAt: (cfg.yielded && cfg.yielded.yieldedAt) || '',
        watchRunning: typeof peerWatchTimer !== 'undefined' && !!peerWatchTimer,
      },
    };
  }

  // ---------- cron 工具：匹配 + 计算下次触发时间 ----------
  // 仅支持 5 字段（分 时 日 月 周），每个字段支持 * / */N / a-b / 1,2,3 / 纯数字
  // 不支持 @reboot / @daily / L / W / # 等扩展语法（够用即可，不引入 cron-parser 依赖）
  const PRESET_TO_CRON = {
    'daily-2am': '0 2 * * *',
    'daily-3am': '0 3 * * *',
    'weekly-sun-3am': '0 3 * * 0',
  };

  function matchCronField(field, val, min, max) {
    if (field === '*') return true;
    if (field.includes(',')) {
      return field.split(',').some(function (p) { return matchCronField(p, val, min, max); });
    }
    const stepM = field.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (stepM) {
      const range = stepM[1], step = Number(stepM[2]);
      let lo = min, hi = max;
      if (range !== '*') {
        const rm = range.match(/^(\d+)(?:-(\d+))?$/);
        if (!rm) return false;
        lo = Number(rm[1]); hi = rm[2] ? Number(rm[2]) : max;
      }
      if (val < lo || val > hi) return false;
      return ((val - lo) % step) === 0;
    }
    const rangeM = field.match(/^(\d+)-(\d+)$/);
    if (rangeM) {
      const a = Number(rangeM[1]), b = Number(rangeM[2]);
      return val >= a && val <= b;
    }
    if (/^\d+$/.test(field)) return Number(field) === val;
    return false;
  }

  function cronMatch(expr, date) {
    const fields = String(expr || '').trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const checks = [
      [fields[0], date.getMinutes(),    0, 59],
      [fields[1], date.getHours(),      0, 23],
      [fields[2], date.getDate(),       1, 31],
      [fields[3], date.getMonth() + 1,  1, 12],
      [fields[4], date.getDay(),        0,  6],
    ];
    for (const [f, v, mn, mx] of checks) {
      if (!matchCronField(f, v, mn, mx)) return false;
    }
    return true;
  }

  // 从 from 时间点向后扫描，找下一次 cron 命中的「整分钟」时刻
  // 最多扫 7 天（10080 次循环），找不到返回 null
  function cronNext(expr, from) {
    if (!cronValid(expr)) return null;
    const t = new Date(from || Date.now());
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1); // 从下一分钟开始（本分钟可能已经触发过）
    for (let i = 0; i < 10080; i++) {
      if (cronMatch(expr, t)) return new Date(t);
      t.setMinutes(t.getMinutes() + 1);
    }
    return null;
  }

  function cronValid(expr) {
    const fields = String(expr || '').trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
    // 用一个不可能的 date 做语法检查（任意时间走一遍 matchField，看是否抛错）
    const sampleDate = new Date(2000, 0, 1, 0, 0, 0);
    const sampleVals = [0, 0, 1, 1, 6];
    try {
      for (let i = 0; i < 5; i++) {
        // matchCronField 不会抛错，但能识别非法语法返回 false
        // 我们只校验：字段非空 + 不含异常字符
        if (!/^[\d*\/,\-]+$/.test(fields[i])) return false;
      }
      return true;
    } catch (_e) { return false; }
  }

  function presetToCron(preset, customCron) {
    if (preset === 'custom') return customCron;
    return PRESET_TO_CRON[preset] || PRESET_TO_CRON['daily-3am'];
  }

  // ---------- 定时同步：调度器状态 ----------
  let scheduleTimer = null;
  let scheduleLastTriggerMinute = ''; // YYYY-MM-DDTHH:MM，避免 30s 双 tick 重复触发

  function effectiveCron() {
    const sch = cfg.syncSchedule || {};
    return presetToCron(sch.preset, sch.cron);
  }

  function getNextRunAt() {
    const sch = cfg.syncSchedule || {};
    if (!sch.enabled) return '';
    const expr = effectiveCron();
    if (!cronValid(expr)) return '';
    const next = cronNext(expr, new Date());
    return next ? localStamp(next) : '';
  }

  function startScheduleTimer() {
    if (scheduleTimer) return;
    appendLog('启动定时同步调度器（30s 一 tick）');
    scheduleTimer = setInterval(scheduleTick, 30000);
    // 启动时立刻 tick 一次（覆盖刚好整分钟启动的情况）
    setTimeout(scheduleTick, 1000);
  }
  function stopScheduleTimer(reason) {
    if (scheduleTimer) {
      clearInterval(scheduleTimer);
      scheduleTimer = null;
      appendLog(`停止定时同步调度器（${reason || '-'}）`);
    }
    scheduleLastTriggerMinute = '';
  }

  async function scheduleTick() {
    try {
      const sch = cfg.syncSchedule || {};
      if (!cfg.enabled) return;            // 主备总开关未启用
      if (!sch.enabled) return;            // 定时同步未启用
      if (cfg.selfRole !== 'primary') return; // 仅主机调度

      const now = new Date();
      const minuteKey = now.toISOString().slice(0, 16);
      if (minuteKey === scheduleLastTriggerMinute) return; // 这分钟已处理过

      const expr = effectiveCron();
      if (!cronMatch(expr, now)) return;

      scheduleLastTriggerMinute = minuteKey;

      // 跳过策略
      if (syncRunning) {
        sch.lastRunAt = localStamp();
        sch.lastRunResult = 'skipped-mutex';
        sch.lastRunError = '上次同步未结束';
        pushEvent('warn', '定时同步跳过：上次未结束');
        writeCfg();
        broadcastSnapshot();
        return;
      }
      if (sch.skipIfPeerDown && (!lastHeartbeat.ipOk || !lastHeartbeat.dbPortOk)) {
        sch.lastRunAt = localStamp();
        sch.lastRunResult = 'skipped-peer-down';
        sch.lastRunError = '对端不可达（IP 或 DB 端口）';
        pushEvent('warn', '定时同步跳过：对端不可达');
        writeCfg();
        broadcastSnapshot();
        return;
      }

      pushEvent('info', `定时同步触发（cron: ${expr}）`);
      try {
        await doSyncDb({ skipStatusUpdate: !sch.applyStatusMinusOne });
        sch.lastRunResult = 'success';
        sch.lastRunError = '';
      } catch (err) {
        sch.lastRunResult = 'fail';
        sch.lastRunError = err.message;
        // doSyncDb 内部已 pushEvent('error',...)，不重复推
      }
      sch.lastRunAt = localStamp();
      writeCfg();
      broadcastSnapshot();
    } catch (err) {
      appendLog(`scheduleTick 异常：${err.message}`);
    }
  }

  // ---------- 故障接管：状态机 + 监测循环（仅 standby）----------
  // 状态：idle / monitoring / counting-down / taking-over / taken-over / failed
  let failoverState = 'idle';
  let failoverFailCount = 0;
  let failoverCountdownSec = 0;          // 实时倒计时秒数
  let failoverCountdownTimer = null;     // 1s tick
  let failoverCheckTimer = null;         // 3s tick（与心跳同节奏）
  let failoverInProgress = false;        // 互斥锁：接管动作执行期间
  // 自动让位计数：接管态下连续 N 次心跳全通才触发
  let failoverPeerRecoverCount = 0;
  // 冷却时间戳：reset 完成后 60 秒内不再触发新一轮接管/让位，防震荡
  let failoverCooldownUntil = 0;

  function isPeerAlive() {
    const mode = (cfg.failover && cfg.failover.judgeMode) || 'any';
    const ipOk = !!lastHeartbeat.ipOk;
    const dbOk = !!lastHeartbeat.dbPortOk;
    if (mode === 'both') return ipOk && dbOk;        // 两个都通才算活
    if (mode === 'ip-only') return ipOk;             // 只看 IP
    return ipOk && dbOk;                             // any 模式：等价于"任一不通就算失联"
  }

  function isPeerAliveAny() {
    // judgeMode=any 的语义实现：任一通就视为活；只有都不通才视为失联
    const ipOk = !!lastHeartbeat.ipOk;
    const dbOk = !!lastHeartbeat.dbPortOk;
    return ipOk || dbOk;
  }

  function isPeerDownByMode() {
    const mode = (cfg.failover && cfg.failover.judgeMode) || 'any';
    const ipOk = !!lastHeartbeat.ipOk;
    const dbOk = !!lastHeartbeat.dbPortOk;
    if (mode === 'both') return !ipOk && !dbOk;       // 两个都不通才算失联
    if (mode === 'ip-only') return !ipOk;             // 只看 IP 不通
    return !ipOk || !dbOk;                            // any: 任一不通就算失联
  }

  function startFailoverCheckTimer() {
    if (failoverCheckTimer) return;
    appendLog('启动故障接管监测循环（3s 一 tick）');
    failoverCheckTimer = setInterval(failoverCheckTick, 3000);
    setTimeout(failoverCheckTick, 1500);
  }
  function stopFailoverCheckTimer(reason) {
    if (failoverCheckTimer) {
      clearInterval(failoverCheckTimer);
      failoverCheckTimer = null;
      appendLog(`停止故障接管监测循环（${reason || '-'}）`);
    }
    stopFailoverCountdown('check-timer-stopped');
    failoverFailCount = 0;
  }
  function startFailoverCountdown(initSec) {
    stopFailoverCountdown('restart');
    failoverCountdownSec = Number(initSec) || 30;
    failoverState = 'counting-down';
    pushEvent('warn', `主机失联，进入接管倒计时（${failoverCountdownSec}s）`);
    broadcastSnapshot();
    failoverCountdownTimer = setInterval(function () {
      failoverCountdownSec -= 1;
      if (failoverCountdownSec <= 0) {
        stopFailoverCountdown('zero');
        triggerFailover().catch(function () {});
      } else {
        // 每 5s 推一次进度，避免太密
        if (failoverCountdownSec % 5 === 0) broadcastSnapshot();
      }
    }, 1000);
  }
  function stopFailoverCountdown(reason) {
    if (failoverCountdownTimer) {
      clearInterval(failoverCountdownTimer);
      failoverCountdownTimer = null;
    }
    failoverCountdownSec = 0;
  }

  function failoverCheckTick() {
    try {
      const fo = cfg.failover || {};
      // 必备前提：本机为备机 + 总开关启用 + 缓冲启用
      if (!cfg.enabled || cfg.selfRole !== 'standby' || !fo.enabled) {
        if (failoverState !== 'idle' && failoverState !== 'taken-over') {
          failoverState = 'idle';
          stopFailoverCountdown('disabled');
          broadcastSnapshot();
        }
        return;
      }
      // 接管动作执行中：不并发
      if (failoverInProgress) return;

      // 已接管状态：检测主机端口恢复 → 自动让位
      // 关键时序：主机重启时 SSH 端口比业务 dcim 早 ~20s 上线
      //          只要备机感知到 SSH 或 DB 任一端口通就立即让位（先于主机的 dcim 自启）
      //          → 备机 stop dcim + status=-1 完成时主机的 dcim 还没起 → 0 撕裂
      if (failoverState === 'taken-over') {
        if (!fo.autoYieldOnPeerRecover) return; // 关掉了自动让位
        // SSH 或 DB 任一端口通就算"主机回归"
        const peerAlive = !!lastHeartbeat.ipOk || !!lastHeartbeat.dbPortOk;
        if (peerAlive) {
          failoverPeerRecoverCount += 1;
          const need = Math.max(1, Number(fo.autoYieldConsecutive) || 5);
          if (failoverPeerRecoverCount === 1 || failoverPeerRecoverCount === Math.floor(need / 2)) {
            pushEvent('info', `检测到主机端口恢复（${failoverPeerRecoverCount}/${need}），即将自动让位`);
            broadcastSnapshot();
          }
          if (failoverPeerRecoverCount >= need) {
            failoverPeerRecoverCount = 0;
            pushEvent('warn', '【自动让位】主机已回归，备机自动 UPDATE status=-1 + 停止 dcim 采集');
            doFailoverReset({ reason: 'auto-yield-on-peer-recover' }).catch(function (err) {
              pushEvent('error', '【自动让位】失败：' + err.message);
            });
          }
        } else {
          // 端口又不通了，重置计数
          if (failoverPeerRecoverCount > 0) {
            pushEvent('info', `主机端口又不通，自动让位计数已清零（之前 ${failoverPeerRecoverCount} 次）`);
            failoverPeerRecoverCount = 0;
          }
        }
        return;
      }

      // 冷却期：reset 完成后 60s 内不触发新一轮接管，防止主机恢复时震荡
      if (Date.now() < failoverCooldownUntil) return;

      const peerDown = isPeerDownByMode();
      const need = Math.max(1, Number(fo.consecutiveFails) || 2);

      if (peerDown) {
        failoverFailCount += 1;
        fo.lastFailCount = failoverFailCount;
        if (failoverState === 'monitoring' && failoverFailCount >= need) {
          // 达到连续失败次数 → 启动倒计时
          startFailoverCountdown(fo.bufferSec);
        }
      } else {
        // 主机恢复：失败计数清零；若在倒计时则重置
        if (failoverFailCount > 0) {
          pushEvent('info', `主机心跳恢复（之前累计失败 ${failoverFailCount} 次）`);
        }
        failoverFailCount = 0;
        fo.lastFailCount = 0;
        if (failoverState === 'counting-down') {
          stopFailoverCountdown('peer-recovered');
          failoverState = 'monitoring';
          pushEvent('info', '倒计时已重置');
          broadcastSnapshot();
        }
        if (failoverState === 'idle' && fo.enabled) {
          failoverState = 'monitoring';
        }
      }
    } catch (err) {
      appendLog(`failoverCheckTick 异常：${err.message}`);
    }
  }

  // ---------- 接管动作（doFailover）----------
  // 流程：dry-run 校验 → SSH 二次握手主机（脑裂防护）→ UPDATE status=1 → dcim restart
  async function triggerFailover() {
    if (failoverInProgress) return;
    if (failoverState === 'taken-over') return;
    failoverInProgress = true;
    failoverState = 'taking-over';
    broadcastSnapshot();

    const fo = cfg.failover;
    // 备机视角：自身是 standby，对端是 primary（也就是 cfg.primary）
    // 但接管要操作的是「本机」的 dcim 容器和 db
    const localDb = cfg.standby.db;       // 本机（备机）的 db
    const peerSshCfg = cfg.primary.ssh;   // 对端（主机）的 ssh，仅用于二次握手探测

    let localClient = null;
    try {
      pushEvent('error', '【接管】触发主机失联接管动作');

      // ---------- 1. 脑裂防护：再尝试 SSH 主机一次（深度探测）----------
      pushEvent('info', '【接管】1/5 尝试 SSH 握手主机（脑裂防护）');
      let primarySshAlive = false;
      try {
        const c = await Promise.race([
          newPeerSshClient(peerSshCfg),
          new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 8000); }),
        ]);
        primarySshAlive = true;
        try { c.end(); } catch (_e) {}
      } catch (_e) {
        primarySshAlive = false;
      }
      if (primarySshAlive) {
        // 主机其实活着 → 取消接管，回到监测态
        pushEvent('warn', '【接管】主机 SSH 握手成功，疑似网络分区，取消本次接管');
        failoverState = 'monitoring';
        failoverFailCount = 0;
        return;
      }
      pushEvent('info', '【接管】主机 SSH 握手仍失败，确认主机失联');

      // ---------- 2. 本地 SSH 连接（操作备机自己）----------
      // 备机是本机，理论上不需要 SSH 自己，但为了和接管脚本同构，统一走 ssh2 客户端
      // 用 cfg.standby.ssh 凭据连本机 127.0.0.1 也行，但更稳的是直接 spawn shell
      // 这里用一个简单的 spawn 来跑 docker exec
      pushEvent('info', '【接管】2/5 检查本机 dcim 容器');
      const psResult = await new Promise(function (resolve) {
        const proc = spawn('docker', ['ps', '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let so = '', se = '';
        proc.stdout.on('data', function (d) { so += d.toString('utf8'); });
        proc.stderr.on('data', function (d) { se += d.toString('utf8'); });
        proc.on('close', function (code) { resolve({ code, so, se }); });
        proc.on('error', function () { resolve({ code: -1, so: '', se: 'spawn-error' }); });
      });
      if (psResult.code !== 0 || !/(^|\n)dcim(\n|$)/.test(psResult.so)) {
        throw new Error('本机 dcim 容器未运行：' + (psResult.se || psResult.so).slice(0, 200));
      }

      // ---------- 3. 清空 dcim-alarmlist 表（接管前必做：避免备机基于陈旧告警重复推送/误处理） ----------
      pushEvent('info', '【接管】3/5 清空 dcim-alarmlist 表（DELETE）');
      const clearAlarmOut = await new Promise(function (resolve) {
        const args = [
          'exec', 'dcim', 'mysql',
          '-h', String(localDb.host || '127.0.0.1'),
          '-P', String(localDb.port || 3306),
          '-u', String(localDb.user || ''),
          '--password=' + String(localDb.password || ''),
          '-BN', '-e',
          'USE `' + localDb.database + '`; DELETE FROM `dcim-alarmlist`; SELECT ROW_COUNT() AS affected;',
        ];
        const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let so = '', se = '';
        proc.stdout.on('data', function (d) { so += d.toString('utf8'); });
        proc.stderr.on('data', function (d) { se += d.toString('utf8'); });
        proc.on('close', function (code) { resolve({ code, so, se }); });
        proc.on('error', function () { resolve({ code: -1, so: '', se: 'spawn-error' }); });
      });
      if (clearAlarmOut.code !== 0) {
        throw new Error('清空 dcim-alarmlist 失败 exit=' + clearAlarmOut.code + ': ' + (clearAlarmOut.se || clearAlarmOut.so).slice(0, 300));
      }
      const alarmAffected = (clearAlarmOut.so.trim().split('\n').filter(function (l) { return /^\d+$/.test(l.trim()); }).pop() || '0').trim();
      pushEvent('info', `【接管】dcim-alarmlist 已清空（affected=${alarmAffected}）`);

      // ---------- 4. UPDATE dcim-device.status=1 ----------
      pushEvent('info', '【接管】4/5 UPDATE dcim-device SET status=1');
      const updateOut = await new Promise(function (resolve) {
        const args = [
          'exec', 'dcim', 'mysql',
          '-h', String(localDb.host || '127.0.0.1'),
          '-P', String(localDb.port || 3306),
          '-u', String(localDb.user || ''),
          '--password=' + String(localDb.password || ''),
          '-BN', '-e',
          'USE `' + localDb.database + '`; UPDATE `dcim-device` SET status=1; SELECT ROW_COUNT() AS affected;',
        ];
        const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let so = '', se = '';
        proc.stdout.on('data', function (d) { so += d.toString('utf8'); });
        proc.stderr.on('data', function (d) { se += d.toString('utf8'); });
        proc.on('close', function (code) { resolve({ code, so, se }); });
        proc.on('error', function () { resolve({ code: -1, so: '', se: 'spawn-error' }); });
      });
      if (updateOut.code !== 0) {
        throw new Error('UPDATE 失败 exit=' + updateOut.code + ': ' + (updateOut.se || updateOut.so).slice(0, 300));
      }
      const affected = (updateOut.so.trim().split('\n').filter(function (l) { return /^\d+$/.test(l.trim()); }).pop() || '0').trim();
      pushEvent('info', `【接管】UPDATE 完成（affected=${affected}）`);

      // ---------- 5. 重启本机 dcim 采集 ----------
      pushEvent('info', '【接管】5/5 重启本机 dcim 采集（docker exec dcim systemctl restart dcim）');
      const restartOut = await new Promise(function (resolve) {
        const proc = spawn('docker', ['exec', 'dcim', 'systemctl', 'restart', 'dcim'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let so = '', se = '';
        proc.stdout.on('data', function (d) { so += d.toString('utf8'); });
        proc.stderr.on('data', function (d) { se += d.toString('utf8'); });
        proc.on('close', function (code) { resolve({ code, so, se }); });
        proc.on('error', function () { resolve({ code: -1, so: '', se: 'spawn-error' }); });
      });
      if (restartOut.code !== 0) {
        throw new Error('重启 dcim 失败 exit=' + restartOut.code + ': ' + (restartOut.se || restartOut.so).slice(0, 300));
      }

      // ---------- 5. 标记已接管 ----------
      fo.takenOver = true;
      fo.takenOverAt = localStamp();
      fo.takenOverError = '';
      failoverState = 'taken-over';
      writeCfg();
      pushEvent('error', `【接管】完成：备机已接管业务，请确认主机状态后点「重置接管状态」恢复`);
    } catch (err) {
      fo.takenOver = false;
      fo.takenOverError = err.message;
      failoverState = 'failed';
      writeCfg();
      pushEvent('error', '【接管】失败：' + err.message);
    } finally {
      if (localClient) { try { localClient.end(); } catch (_e) {} }
      failoverInProgress = false;
      broadcastSnapshot();
    }
  }

  // ---------- 接管重置（doFailoverReset）----------
  // 流程：UPDATE status=-1 → 停 dcim → 标记 takenOver=false → 回到 monitoring
  async function doFailoverReset(opts) {
    opts = opts || {};
    const isAuto = opts.reason === 'auto-yield-on-peer-recover';
    const reasonTag = isAuto ? '自动让位' : '重置';
    if (failoverInProgress) throw new Error('接管动作执行中，无法重置');
    if (cfg.selfRole !== 'standby') throw new Error('仅备机可重置接管状态');
    const fo = cfg.failover || {};
    if (!fo.takenOver) throw new Error('当前未处于接管状态，无需重置');

    failoverInProgress = true;
    try {
      pushEvent('info', `【${reasonTag}】1/2 UPDATE dcim-device SET status=-1`);
      const localDb = cfg.standby.db;
      const updateOut = await new Promise(function (resolve) {
        const args = [
          'exec', 'dcim', 'mysql',
          '-h', String(localDb.host || '127.0.0.1'),
          '-P', String(localDb.port || 3306),
          '-u', String(localDb.user || ''),
          '--password=' + String(localDb.password || ''),
          '-BN', '-e',
          'USE `' + localDb.database + '`; UPDATE `dcim-device` SET status=-1; SELECT ROW_COUNT() AS affected;',
        ];
        const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let so = '', se = '';
        proc.stdout.on('data', function (d) { so += d.toString('utf8'); });
        proc.stderr.on('data', function (d) { se += d.toString('utf8'); });
        proc.on('close', function (code) { resolve({ code, so, se }); });
        proc.on('error', function () { resolve({ code: -1, so: '', se: 'spawn-error' }); });
      });
      if (updateOut.code !== 0) {
        throw new Error('UPDATE 失败 exit=' + updateOut.code + ': ' + (updateOut.se || updateOut.so).slice(0, 300));
      }
      const affected = (updateOut.so.trim().split('\n').filter(function (l) { return /^\d+$/.test(l.trim()); }).pop() || '0').trim();
      pushEvent('info', `【${reasonTag}】UPDATE 完成（affected=${affected}）`);

      pushEvent('info', `【${reasonTag}】2/2 停止本机 dcim 采集`);
      const stopOut = await new Promise(function (resolve) {
        const proc = spawn('docker', ['exec', 'dcim', 'systemctl', 'stop', 'dcim'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let so = '', se = '';
        proc.stdout.on('data', function (d) { so += d.toString('utf8'); });
        proc.stderr.on('data', function (d) { se += d.toString('utf8'); });
        proc.on('close', function (code) { resolve({ code, so, se }); });
        proc.on('error', function () { resolve({ code: -1, so: '', se: 'spawn-error' }); });
      });
      if (stopOut.code !== 0) {
        throw new Error('停止 dcim 失败 exit=' + stopOut.code + ': ' + (stopOut.se || stopOut.so).slice(0, 300));
      }

      fo.takenOver = false;
      fo.takenOverAt = '';
      fo.takenOverError = '';
      failoverState = (cfg.enabled && cfg.selfRole === 'standby' && fo.enabled) ? 'monitoring' : 'idle';
      failoverFailCount = 0;
      failoverPeerRecoverCount = 0;
      // 冷却期：reset 完成后 N 秒内不再触发新一轮接管，防止主机抖动导致震荡
      const cooldownSec = Math.max(0, Number(fo.cooldownSec) || 60);
      failoverCooldownUntil = Date.now() + cooldownSec * 1000;
      writeCfg();
      pushEvent('info', `【${reasonTag}】完成：备机已让位（status=-1 + dcim 已停），主机将在 5s 内自动接回业务（${cooldownSec}s 冷却中，期间不再触发接管）`);
    } finally {
      failoverInProgress = false;
      broadcastSnapshot();
    }
  }



  // ---------- TCP 端口探测（IP / DB 端口）----------
  function tcpProbe(host, port, timeoutMs) {
    return new Promise(function (resolve) {
      if (!host || !port) return resolve(false);
      const sock = new net.Socket();
      let done = false;
      const finish = function (ok) {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch (_e) {}
        resolve(!!ok);
      };
      sock.setTimeout(timeoutMs || 1500);
      sock.once('connect', function () { finish(true); });
      sock.once('timeout', function () { finish(false); });
      sock.once('error',   function () { finish(false); });
      try { sock.connect(Number(port), String(host)); }
      catch (_e) { finish(false); }
    });
  }

  // ---------- DB 池：完整复刻 sms 子站的 openPool / closePool / startAutoRetry ----------
  const DB_AUTO_RETRY_MS = 5000;

  async function closeDbPool(reason) {
    if (pool) {
      const old = pool;
      pool = null;
      dbConnected = false;
      try { await old.end(); } catch (_e) {}
      appendLog(`DB 池关闭：${reason || ''}`.trim());
    } else {
      dbConnected = false;
    }
  }

  async function openDbPool(opts) {
    if (!mysql) throw new Error('mysql2 驱动未安装');
    await closeDbPool('reconnect');
    const p = mysql.createPool({
      host: opts.host,
      port: Number(opts.port) || 3306,
      user: opts.user,
      password: opts.password,
      database: opts.database || undefined,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 8000,
    });
    const conn = await p.getConnection();
    try { await conn.ping(); } finally { conn.release(); }
    pool = p;
    dbConnected = true;
    dbLastError = '';
    dbLastConnectedAt = localStamp();
    return p;
  }

  function stopDbAutoRetry(reason) {
    if (dbAutoRetryTimer) {
      clearTimeout(dbAutoRetryTimer);
      dbAutoRetryTimer = null;
      if (dbAutoRetryCount > 0) {
        appendLog(`DB 后台重试停止（${reason || '-'}），共试 ${dbAutoRetryCount} 次`);
      }
      dbAutoRetryCount = 0;
    }
  }
  // 渐进退避：5s × 3 → 15s × 5 → 60s 封顶；
  // 命中 MySQL Host blocked / Access denied 等\"硬错误\"直接跳到 60s，
  // 避免再次踩 max_connect_errors=100 阈值
  function pickDbRetryDelayMs(count, lastErrMsg) {
    const errs = String(lastErrMsg || '').toLowerCase();
    if (errs.includes('blocked because of many connection errors') || errs.includes('access denied')) return 60000;
    if (count < 3)  return 5000;
    if (count < 8)  return 15000;
    return 60000;
  }
  function startDbAutoRetry() {
    if (dbAutoRetryTimer) return;
    dbAutoRetryCount = 0;
    appendLog('启用 DB 后台重试（渐进退避：5s ×3 → 15s ×5 → 60s 封顶）');
    const tick = async function () {
      dbAutoRetryTimer = null;
      const peer = peerOf(cfg);
      if (!cfg.enabled) { stopDbAutoRetry('已关功能'); return; }
      if (dbConnected) { stopDbAutoRetry('已连接'); return; }
      if (!peer.db.host || !peer.db.user) { stopDbAutoRetry('配置不完整'); return; }
      dbAutoRetryCount += 1;
      try {
        await openDbPool(peer.db);
        appendLog(`DB 重试第 ${dbAutoRetryCount} 次成功：${peer.db.user}@${peer.db.host}:${peer.db.port}/${peer.db.database || '-'}`);
        pushEvent('info', `对端数据库已连通（${peer.db.host}:${peer.db.port}）`);
        stopDbAutoRetry('连接成功');
        return;
      } catch (err) {
        dbLastError = err.message;
        if (dbAutoRetryCount === 1 || dbAutoRetryCount % 6 === 0) {
          appendLog(`DB 重试第 ${dbAutoRetryCount} 次仍失败：${err.message}`);
        }
      }
      const next = pickDbRetryDelayMs(dbAutoRetryCount, dbLastError);
      dbAutoRetryTimer = setTimeout(tick, next);
    };
    dbAutoRetryTimer = setTimeout(tick, 5000);
  }

  async function tryStartDb() {
    if (!cfg.enabled) return;
    const peer = peerOf(cfg);
    if (!peer.db.host || !peer.db.user) {
      appendLog('DB 配置不完整，跳过自启');
      return;
    }
    try {
      await openDbPool(peer.db);
      appendLog(`DB 自启成功：${peer.db.user}@${peer.db.host}:${peer.db.port}/${peer.db.database || '-'}`);
      pushEvent('info', `对端数据库已连通（${peer.db.host}:${peer.db.port}）`);
    } catch (err) {
      dbLastError = err.message;
      appendLog(`DB 自启失败：${err.message}（启用后台重试）`);
      pushEvent('warn', `对端数据库连接失败：${err.message}`);
      startDbAutoRetry();
    }
  }

  // ---------- SSH 长连接：单例 + 断线重连 + ssh2 自带 keepalive ----------
  function clearSshReconnectTimer() {
    if (sshReconnectTimer) { clearTimeout(sshReconnectTimer); sshReconnectTimer = null; }
  }

  function closeSshClient(reason) {
    clearSshReconnectTimer();
    if (sshClient) {
      const old = sshClient;
      sshClient = null;
      try { old.removeAllListeners('error'); } catch (_e) {}
      try { old.removeAllListeners('close'); } catch (_e) {}
      try { old.end(); } catch (_e) {}
    }
    sshStatus = 'idle';
    if (reason) appendLog(`SSH 长连接关闭：${reason}`);
  }

  function scheduleSshReconnect(why) {
    if (!cfg.enabled) return;
    if (sshReconnectTimer) return;
    const delay = sshReconnectDelay;
    sshReconnectDelay = Math.min(5000, sshReconnectDelay + 1000);
    appendLog(`SSH 将在 ${delay}ms 后重连：${why || '-'}`);
    sshReconnectTimer = setTimeout(function () {
      sshReconnectTimer = null;
      connectSsh();
    }, delay);
  }

  function connectSsh() {
    if (!cfg.enabled) return;
    const peer = peerOf(cfg);
    if (!peer.ssh.host || !peer.ssh.user) {
      appendLog('SSH 配置不完整，跳过连接');
      return;
    }
    if (sshClient && (sshStatus === 'connected' || sshStatus === 'connecting')) return;

    sshStatus = 'connecting';
    sshLastError = '';
    appendLog(`SSH 开始连接：${peer.ssh.user}@${peer.ssh.host}:${peer.ssh.port}`);
    const c = new Client();
    sshClient = c;

    c.on('ready', function () {
      sshStatus = 'connected';
      sshReconnectDelay = 1000;
      pushEvent('info', `对端 SSH 已建立长连接（${peer.ssh.host}:${peer.ssh.port}）`);
      broadcastSnapshot();
    });
    c.on('error', function (err) {
      sshLastError = err && err.message || String(err);
      sshStatus = 'broken';
      pushEvent('error', `对端 SSH 出错：${sshLastError}`);
      try { c.end(); } catch (_e) {}
      if (sshClient === c) sshClient = null;
      scheduleSshReconnect(sshLastError);
      broadcastSnapshot();
    });
    c.on('close', function () {
      if (sshStatus === 'connected') {
        pushEvent('warn', '对端 SSH 长连接断开');
      }
      sshStatus = 'broken';
      if (sshClient === c) sshClient = null;
      scheduleSshReconnect('connection-closed');
      broadcastSnapshot();
    });

    try {
      c.connect({
        host: peer.ssh.host,
        port: Number(peer.ssh.port) || 22,
        username: peer.ssh.user,
        password: peer.ssh.password || '',
        readyTimeout: 8000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      });
    } catch (err) {
      sshLastError = err && err.message || String(err);
      sshStatus = 'broken';
      pushEvent('error', `对端 SSH 连接抛异常：${sshLastError}`);
      scheduleSshReconnect(sshLastError);
    }
  }

  function broadcastSnapshot() {
    broadcast({ type: 'snapshot', data: publicStatus() });
  }

  // ---------- 心跳：每 3 秒一轮，并发去重 ----------
  function startHeartbeat() {
    if (heartbeatTimer) return;
    appendLog('启动心跳调度（每 3s 一轮）');
    heartbeatTimer = setInterval(async function () {
      if (heartbeatProbing) return;
      if (!cfg.enabled) return;
      heartbeatProbing = true;
      try {
        const peer = peerOf(cfg);
        const [ipOk, dbPortOk] = await Promise.all([
          tcpProbe(peer.ssh.host, peer.ssh.port, 1500),
          tcpProbe(peer.db.host,  peer.db.port,  1500),
        ]);
        const ts = localStamp();
        lastHeartbeat = { ipOk, dbPortOk, ts };
        // 状态变化才推 event
        if (lastBroadcastIpOk !== ipOk) {
          if (lastBroadcastIpOk !== null) {
            pushEvent(ipOk ? 'info' : 'error',
              ipOk ? `对端 IP 已恢复（${peer.ssh.host}:${peer.ssh.port}）`
                   : `对端 IP 不通（${peer.ssh.host}:${peer.ssh.port}）`);
          }
          lastBroadcastIpOk = ipOk;
        }
        if (lastBroadcastDbOk !== dbPortOk) {
          if (lastBroadcastDbOk !== null) {
            pushEvent(dbPortOk ? 'info' : 'warn',
              dbPortOk ? `对端 DB 端口已恢复（${peer.db.host}:${peer.db.port}）`
                       : `对端 DB 端口不通（${peer.db.host}:${peer.db.port}）`);
          }
          lastBroadcastDbOk = dbPortOk;
        }
        // 每轮固定推 heartbeat（让前端可视化"后端还在跑"）
        broadcast({ type: 'heartbeat', data: lastHeartbeat });
      } catch (err) {
        appendLog(`心跳异常：${err.message}`);
      } finally {
        heartbeatProbing = false;
      }
    }, 3000);
  }
  function stopHeartbeat(reason) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      appendLog(`停止心跳调度（${reason || '-'}）`);
    }
    lastBroadcastIpOk = null;
    lastBroadcastDbOk = null;
  }

  // ---------- 总开关：enable / disable ----------
  async function applyEnabled() {
    if (cfg.enabled) {
      pushEvent('info', `双机热备已启用（角色：${cfg.selfRole === 'primary' ? '主机' : '备机'}）`);
      connectSsh();
      tryStartDb().catch(function () {});
      startHeartbeat();
      // 定时同步只在 primary 跑（备机不调度，避免双触发）
      if (cfg.selfRole === 'primary' && cfg.syncSchedule && cfg.syncSchedule.enabled) {
        startScheduleTimer();
      } else {
        stopScheduleTimer('non-primary or disabled');
      }
      // 故障接管监测仅在 standby 跑
      if (cfg.selfRole === 'standby' && cfg.failover && cfg.failover.enabled) {
        if (!cfg.failover.takenOver) {
          failoverState = 'monitoring';
          failoverFailCount = 0;
        } else {
          failoverState = 'taken-over';
        }
        startFailoverCheckTimer();
      } else {
        stopFailoverCheckTimer('non-standby or disabled');
        if (cfg.failover && !cfg.failover.takenOver) failoverState = 'idle';
      }
      // 主机被动监测备机接管状态（仅 primary）
      if (cfg.selfRole === 'primary') {
        startPeerWatchTimer();
      } else {
        stopPeerWatchTimer('non-primary');
      }
    } else {
      pushEvent('info', '双机热备已停用');
      stopHeartbeat('disabled');
      stopDbAutoRetry('disabled');
      await closeDbPool('disabled');
      closeSshClient('disabled');
      stopScheduleTimer('ha disabled');
      stopFailoverCheckTimer('ha disabled');
      stopPeerWatchTimer('ha disabled');
    }
    // enabled / selfRole 等顶层状态变了，主动推一次 snapshot，让所有 ws 客户端立刻刷新
    broadcastSnapshot();
  }

  // ---------- REST API ----------
  app.get('/api/ha/config', function (_req, res) {
    res.json({ ok: true, config: redactCfg(cfg) });
  });

  // PUT /api/ha/config
  // body 中：密码字段为 '***' 表示"保留原值"；空串表示"清空"；其他值表示"覆盖"
  app.put('/api/ha/config', async function (req, res) {
    const body = req.body || {};
    const next = {
      enabled: !!body.enabled,
      selfRole: body.selfRole === 'standby' ? 'standby' : 'primary',
      primary: { ssh: {}, db: {} },
      standby: { ssh: {}, db: {} },
    };
    function pickPair(side) {
      const incoming = body[side] || {};
      const oldSide  = cfg[side] || defaults[side];
      ['ssh', 'db'].forEach(function (kind) {
        const incomingKind = incoming[kind] || {};
        const oldKind      = oldSide[kind] || {};
        const merged = Object.assign({}, oldKind, {
          host: String(incomingKind.host == null ? oldKind.host : incomingKind.host).trim(),
          port: Number(incomingKind.port) || oldKind.port,
          user: String(incomingKind.user == null ? oldKind.user : incomingKind.user).trim(),
        });
        if (kind === 'db') {
          merged.database = String(incomingKind.database == null ? (oldKind.database || '') : incomingKind.database).trim();
        }
        // 密码：'***' 保留旧值，否则用新值
        if (incomingKind.password === undefined || incomingKind.password === '***') {
          merged.password = oldKind.password || '';
        } else {
          merged.password = String(incomingKind.password);
        }
        next[side][kind] = merged;
      });
    }
    pickPair('primary');
    pickPair('standby');

    // 保留原有的 syncSchedule（只有 PUT /api/ha/sync-schedule 可改它）
    next.syncSchedule = cfg.syncSchedule || JSON.parse(JSON.stringify(defaults.syncSchedule));
    // 保留原有的 failover（只有 PUT /api/ha/failover 可改它，takenOver 等运行期状态也保持）
    next.failover = cfg.failover || JSON.parse(JSON.stringify(defaults.failover));
    next.yielded = cfg.yielded || JSON.parse(JSON.stringify(defaults.yielded));

    cfg = next;
    writeCfg();
    pushEvent('info', '配置已更新，重置心跳与连接');

    // 重置：先全停，再按新配置启动
    stopHeartbeat('config-changed');
    stopDbAutoRetry('config-changed');
    await closeDbPool('config-changed');
    closeSshClient('config-changed');

    await applyEnabled();
    res.json({ ok: true, config: redactCfg(cfg), status: publicStatus() });
  });

  app.get('/api/ha/status', function (_req, res) {
    res.json({ ok: true, status: publicStatus() });
  });

  // 临时探测 SSH 凭证（不落盘）
  // 密码字段：'***' 或省略 → 沿用 cfg 里已落盘的密码（需要 body.side='primary'|'standby'）
  app.post('/api/ha/test/ssh', function (req, res) {
    const b = req.body || {};
    const host = String(b.host || '').trim();
    const port = Number(b.port) || 22;
    const user = String(b.user || '').trim();
    let password = String(b.password == null ? '' : b.password);
    if (password === '' || password === '***') {
      const side = b.side === 'standby' ? 'standby' : (b.side === 'primary' ? 'primary' : null);
      if (!side) {
        return res.status(400).json({ ok: false, message: '密码为空时必须指定 side=primary|standby 以使用已保存密码' });
      }
      password = String((cfg[side] && cfg[side].ssh && cfg[side].ssh.password) || '');
      if (!password) {
        return res.status(400).json({ ok: false, message: `${side === 'primary' ? '主' : '备'}服务器尚未保存 SSH 密码，请在密码框中输入后再测试` });
      }
    }
    if (!host || !user) return res.status(400).json({ ok: false, message: 'host/user 必填' });
    const c = new Client();
    let done = false;
    const finish = function (ok, msg) {
      if (done) return;
      done = true;
      try { c.end(); } catch (_e) {}
      res.json({ ok, message: msg || '' });
    };
    c.on('ready', function () { finish(true, '连接成功'); });
    c.on('error', function (err) { finish(false, err && err.message || String(err)); });
    setTimeout(function () { finish(false, '连接超时'); }, 8000);
    try {
      c.connect({ host, port, username: user, password, readyTimeout: 6000 });
    } catch (err) {
      finish(false, err.message);
    }
  });

  // 临时探测 DB 凭证（不落盘）
  // 密码字段：'***' 或省略 → 沿用 cfg 里已落盘的密码（需要 body.side='primary'|'standby'）
  app.post('/api/ha/test/db', async function (req, res) {
    if (!mysql) return res.status(500).json({ ok: false, message: 'mysql2 驱动未安装' });
    const b = req.body || {};
    const host = String(b.host || '').trim();
    const port = Number(b.port) || 3306;
    const user = String(b.user || '').trim();
    let password = String(b.password == null ? '' : b.password);
    if (password === '' || password === '***') {
      const side = b.side === 'standby' ? 'standby' : (b.side === 'primary' ? 'primary' : null);
      if (!side) {
        return res.status(400).json({ ok: false, message: '密码为空时必须指定 side=primary|standby 以使用已保存密码' });
      }
      password = String((cfg[side] && cfg[side].db && cfg[side].db.password) || '');
      if (!password) {
        return res.status(400).json({ ok: false, message: `${side === 'primary' ? '主' : '备'}服务器尚未保存 DB 密码，请在密码框中输入后再测试` });
      }
    }
    const database = String(b.database || '').trim();
    if (!host || !user) return res.status(400).json({ ok: false, message: 'host/user 必填' });
    let p = null;
    try {
      p = mysql.createPool({
        host, port, user, password, database: database || undefined,
        waitForConnections: true, connectionLimit: 1, queueLimit: 0, connectTimeout: 6000,
      });
      const conn = await p.getConnection();
      try { await conn.ping(); } finally { conn.release(); }
      res.json({ ok: true, message: '连接成功' });
    } catch (err) {
      res.json({ ok: false, message: err.message });
    } finally {
      if (p) { try { await p.end(); } catch (_e) {} }
    }
  });

  // 手动重启：重置 SSH 长连接 + DB 池
  app.post('/api/ha/restart', async function (_req, res) {
    if (!cfg.enabled) {
      return res.json({ ok: false, message: '总开关未启用，无需重启' });
    }
    appendLog('收到 /api/ha/restart：重置 SSH + DB');
    pushEvent('info', '手动重置 SSH 与 DB 连接');
    stopDbAutoRetry('manual-restart');
    await closeDbPool('manual-restart');
    closeSshClient('manual-restart');
    setTimeout(function () { applyEnabled().catch(function () {}); }, 200);
    res.json({ ok: true, status: publicStatus() });
  });

  // ---------- 数据库同步：主 22 → 备 50 ----------
  // 流程（用户需求字面）：
  //   1. SSH 进入备机 → docker exec dcim systemctl stop dcim 停采集
  //   2. SSH 进入备机 → 备份当前 dcim 库（gzip dump，写在备机 /opt/webssh/logs/）
  //   3. 在备机容器内执行 UPDATE `dcim-device` SET status=-1
  //   4. 主机上 mysqldump 整个 dcim 库（用 cfg.primary.db 凭据），通过 SSH 通道流到备机的 mysql
  //   5. 不自动重启采集；前端提示用户在备机手动 systemctl start dcim
  //
  // 安全约束：
  //   - 仅当 selfRole === 'primary' 时允许触发
  //   - 任意时刻只允许 1 个同步任务（syncRunning 互斥锁）
  //   - 全部步骤都要 push event 到 ws，前端实时可见
  //   - 任何步骤失败：记录、推 error、退出（不回滚已停的 dcim 服务）

  function recordSyncStep(name, status, msg) {
    const step = { name: name, status: status, msg: msg || '', ts: localStamp() };
    syncSteps.push(step);
    while (syncSteps.length > 50) syncSteps.shift();
    syncStep = name + (status === 'doing' ? '...' : '');
    const lvl = status === 'fail' ? 'error' : (status === 'done' ? 'info' : 'info');
    pushEvent(lvl, `[同步] ${name}：${status === 'doing' ? '执行中' : status === 'done' ? '完成' : '失败'}` + (msg ? '（' + msg + '）' : ''));
    broadcastSnapshot();
  }

  // 在备机上 SSH 执行单条命令；返回 { code, stdout, stderr }
  function peerExec(client, cmd, timeoutMs) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const finish = function (err, val) {
        if (done) return;
        done = true;
        if (err) reject(err); else resolve(val);
      };
      const t = setTimeout(function () { finish(new Error('SSH 命令超时: ' + cmd.slice(0, 80))); }, timeoutMs || 60000);
      client.exec(cmd, function (err, stream) {
        if (err) { clearTimeout(t); return finish(err); }
        let so = '', se = '';
        stream.on('close', function (code) {
          clearTimeout(t);
          finish(null, { code: code, stdout: so, stderr: se });
        }).on('data', function (d) { so += d.toString('utf8'); })
          .stderr.on('data', function (d) { se += d.toString('utf8'); });
      });
    });
  }

  // 把本地一段内容当 stdin 流到对端命令（用于 mysqldump | ssh ... | mysql 模式）
  function peerExecPipe(client, cmd, stdinStream, timeoutMs) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const finish = function (err, val) {
        if (done) return;
        done = true;
        if (err) reject(err); else resolve(val);
      };
      const t = setTimeout(function () { finish(new Error('SSH pipe 超时: ' + cmd.slice(0, 80))); }, timeoutMs || 600000);
      client.exec(cmd, function (err, stream) {
        if (err) { clearTimeout(t); return finish(err); }
        let so = '', se = '';
        stream.on('close', function (code) {
          clearTimeout(t);
          finish(null, { code: code, stdout: so, stderr: se });
        }).on('data', function (d) { so += d.toString('utf8'); })
          .stderr.on('data', function (d) { se += d.toString('utf8'); });
        stdinStream.on('error', function (e) { clearTimeout(t); finish(e); });
        stdinStream.pipe(stream);
      });
    });
  }

  // 用 child_process.spawn 跑 mysqldump，把 stdout 当 readable stream 返回
  // 关键：走 docker exec dcim mysqldump 而不是宿主机 mysqldump
  //   原因：宿主机系统用的是 MariaDB 10.3 mysqldump，跟 MySQL 5.7 不兼容
  //         （MariaDB mysqldump 不会自动跳过 STORED 生成列的 INSERT，导致灌库时报
  //          ERROR 3105 "value specified for generated column ... is not allowed"）
  //         dcim 容器内的 mysqldump 5.7.39 跟主库版本完全一致，会正确处理生成列
  function spawnLocalDump(dbCfg) {
    const args = [
      'exec', 'dcim', 'mysqldump',
      '-h', String(dbCfg.host || '127.0.0.1'),
      '-P', String(dbCfg.port || 3306),
      '-u', String(dbCfg.user || ''),
      '--password=' + String(dbCfg.password || ''),
      '--single-transaction',
      '--quick',
      '--routines',
      '--triggers',
      '--events',
      '--hex-blob',
      // dcim 业务用户通常没 PROCESS 权限，避免 mysqldump 默认尝试 dump tablespace 元数据时 1227 报错
      '--no-tablespaces',
      '--default-character-set=utf8mb4',
      String(dbCfg.database || ''),
    ];
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrBuf = '';
    proc.stderr.on('data', function (d) { stderrBuf += d.toString('utf8'); });
    proc.on('error', function (err) { stderrBuf += 'spawn error: ' + err.message; });
    return { proc: proc, stream: proc.stdout, getStderr: function () { return stderrBuf; } };
  }

  // 建一个一次性 SSH 客户端（本任务专用，不复用心跳的 sshClient——避免互相污染）
  function newPeerSshClient(sshCfg) {
    return new Promise(function (resolve, reject) {
      const c = new Client();
      let done = false;
      const finish = function (err, val) {
        if (done) return;
        done = true;
        if (err) reject(err); else resolve(val);
      };
      c.on('ready', function () { finish(null, c); });
      c.on('error', function (err) { finish(err); });
      try {
        c.connect({
          host: sshCfg.host,
          port: Number(sshCfg.port) || 22,
          username: sshCfg.user,
          password: sshCfg.password || '',
          readyTimeout: 12000,
          keepaliveInterval: 10000,
        });
      } catch (err) { finish(err); }
    });
  }

  async function doSyncDb(opts) {
    opts = opts || {};
    const skipStatusUpdate = !!opts.skipStatusUpdate;
    if (cfg.selfRole !== 'primary') throw new Error('仅当本机角色为「主机」时可触发同步');
    if (syncRunning) throw new Error('已有同步任务在执行');
    if (!cfg.enabled) throw new Error('总开关未启用');
    const peerSsh = cfg.standby.ssh;
    const localDb = cfg.primary.db;
    const peerDb  = cfg.standby.db;
    if (!peerSsh.host || !peerSsh.user) throw new Error('备机 SSH 配置不完整');
    if (!localDb.host || !localDb.user || !localDb.database) throw new Error('主机 DB 配置不完整');
    if (!peerDb.host  || !peerDb.user  || !peerDb.database)  throw new Error('备机 DB 配置不完整');

    // 同步互斥：备机如果已经接管业务，主机灌库会冲掉接管期间的新数据 → 拒绝同步
    try {
      const peerStatus = await fetchPeerStatus(peerSsh.host, PEER_WATCH_PORT, 4000);
      if (peerStatus && peerStatus.ok && peerStatus.status && peerStatus.status.failover && peerStatus.status.failover.takenOver) {
        throw new Error('备机当前处于「已接管」状态，主机同步已被锁定。请先到备机点「重置接管状态」恢复后再同步');
      }
    } catch (err) {
      // 网络异常不阻断同步（备机如果不可达，本来就该 sync）；只有明确读到 takenOver=true 才拒绝
      if (/已接管/.test(err.message)) throw err;
    }

    syncRunning = true;
    syncStartedAt = localStamp();
    syncFinishedAt = '';
    syncLastResult = '';
    syncLastError = '';
    syncSteps.length = 0;
    pushEvent('info', '开始数据库同步：主 → 备');
    broadcastSnapshot();

    let peerClient = null;
    try {
      // ----- 0. 建立到备机的一次性 SSH -----
      recordSyncStep('SSH 连接备机', 'doing');
      peerClient = await newPeerSshClient(peerSsh);
      recordSyncStep('SSH 连接备机', 'done', `${peerSsh.user}@${peerSsh.host}:${peerSsh.port}`);

      // ----- 1. 停采集：docker exec dcim systemctl stop dcim -----
      recordSyncStep('停止备机采集 (docker exec dcim systemctl stop dcim)', 'doing');
      let r = await peerExec(peerClient, 'docker exec dcim systemctl stop dcim 2>&1', 30000);
      if (r.code !== 0) throw new Error(`stop dcim 失败 exit=${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`);
      recordSyncStep('停止备机采集', 'done');

      // ----- 2. 备份备机当前 dcim 库 -----
      const stamp2 = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      const bakPath = `/opt/webssh/logs/ha-sync-bak-${stamp2}.sql.gz`;
      recordSyncStep(`备份备机 dcim 库 → ${bakPath}`, 'doing');
      // 在备机宿主机上 mysqldump（备机宿主机有 mysql 客户端）
      const dumpCmd =
        `mysqldump -h ${peerDb.host} -P ${peerDb.port} -u ${peerDb.user} ` +
        `--password=${peerDb.password || ''} --single-transaction --quick ` +
        `--routines --triggers --events --hex-blob --default-character-set=utf8mb4 ` +
        `${peerDb.database} | gzip -c > ${bakPath} && echo BAK_OK && ls -lh ${bakPath}`;
      r = await peerExec(peerClient, dumpCmd, 600000);
      if (r.code !== 0 || !/BAK_OK/.test(r.stdout)) {
        throw new Error(`备份失败 exit=${r.code}: ${(r.stderr || r.stdout).slice(0, 300)}`);
      }
      recordSyncStep('备份备机 dcim 库', 'done', r.stdout.split('\n').filter(Boolean).pop());

      // ----- 3. 主机 mysqldump | ssh peer "mysql ..." -----
      // 顺序说明：先灌库再 UPDATE。
      //   灌库会把 dcim-device 表 DROP+CREATE+INSERT 整体覆盖（包含主库真实 status 值），
      //   所以 UPDATE 必须在灌库之后执行，才能让备机最终的 status 全为 -1。
      recordSyncStep('主→备 灌库（mysqldump | ssh peer mysql）', 'doing');
      // 关键：sed 过滤掉 dump 里的 DEFINER 子句
      //   场景：主库的视图 / 触发器 / 存储过程 / 事件被 mysqldump 写成
      //         CREATE DEFINER=`root`@`localhost` ... 形式
      //         备机的 dcim 用户没 SUPER 权限，无法把 DEFINER 设为 root，导入时报 1227
      //   做法：剥掉 DEFINER 子句 → 备机自动用当前用户（dcim）当 DEFINER
      //   覆盖三种写法：DEFINER=`x`@`y` / DEFINER='x'@'y' / DEFINER=x@y
      const stripDefinerSed = `sed -E 's/DEFINER=\`[^\`]*\`@\`[^\`]*\`[[:space:]]*//g; s/DEFINER='\\''[^'\\'']*'\\''@'\\''[^'\\'']*'\\''[[:space:]]*//g; s/DEFINER=[^[:space:]]+[[:space:]]+//g; s/SQL SECURITY DEFINER/SQL SECURITY INVOKER/g'`;
      const importCmd =
        `${stripDefinerSed} | ` +
        `mysql -h ${peerDb.host} -P ${peerDb.port} -u ${peerDb.user} ` +
        `--password=${peerDb.password || ''} --default-character-set=utf8mb4 ` +
        `${peerDb.database}`;
      const dump = spawnLocalDump(localDb);
      const importResult = await peerExecPipe(peerClient, importCmd, dump.stream, 1800000); // 30 分钟
      // mysqldump 进程结束码（如果失败 stderr 里会有"Got error"）
      const dumpStderr = dump.getStderr();
      try { dump.proc.kill('SIGTERM'); } catch (_e) {}
      if (importResult.code !== 0) {
        throw new Error(`灌库 mysql 端 exit=${importResult.code}: ${(importResult.stderr || '').slice(0, 300)}`);
      }
      if (dumpStderr && /error/i.test(dumpStderr) && !/Using a password/i.test(dumpStderr)) {
        throw new Error(`mysqldump 报错: ${dumpStderr.slice(0, 300)}`);
      }
      recordSyncStep('主→备 灌库', 'done', '完成');

      // ----- 4. 备机容器内 UPDATE dcim-device.status = -1（必须在灌库后执行）-----
      // 默认必做（与手动同步一致）。skipStatusUpdate=true 时跳过（仅供未来 / 测试用）
      if (skipStatusUpdate) {
        recordSyncStep('备机 UPDATE dcim-device.status=-1', 'done', '已按选项跳过');
      } else {
        recordSyncStep('备机容器内 UPDATE `dcim-device` SET status=-1', 'doing');
        // 注意：表名 dcim-device 含连字符，必须用反引号转义
        const updateSql = "USE \\`" + peerDb.database + "\\`; UPDATE \\`dcim-device\\` SET status=-1; SELECT ROW_COUNT() AS affected;";
        const updateCmd =
          `docker exec dcim mysql -h ${peerDb.host} -P ${peerDb.port} -u ${peerDb.user} ` +
          `--password=${peerDb.password || ''} -BN -e "${updateSql}" 2>&1`;
        r = await peerExec(peerClient, updateCmd, 60000);
        if (r.code !== 0) throw new Error(`UPDATE 失败 exit=${r.code}: ${(r.stderr || r.stdout).slice(0, 300)}`);
        const affectedMatch = (r.stdout.trim().split('\n').filter(function (l) { return /^\d+$/.test(l.trim()); }).pop() || '').trim();
        recordSyncStep('备机 UPDATE dcim-device.status=-1', 'done', `affected=${affectedMatch}`);
      }

      // ----- 5. 完成 -----
      syncLastResult = 'success';
      syncStep = '已完成（请到备机手动 docker exec dcim systemctl start dcim 启动采集）';
      pushEvent('info', '同步完成。请到备机手动启动 dcim 采集（备份: ' + bakPath + '）');
    } catch (err) {
      syncLastResult = 'fail';
      syncLastError = err.message;
      pushEvent('error', '同步失败：' + err.message);
      recordSyncStep(syncStep || '失败', 'fail', err.message);
      throw err;
    } finally {
      if (peerClient) { try { peerClient.end(); } catch (_e) {} }
      syncRunning = false;
      syncFinishedAt = localStamp();
      broadcastSnapshot();
    }
  }

  app.post('/api/ha/sync', function (req, res) {
    if (cfg.selfRole !== 'primary') return res.status(400).json({ ok: false, message: '仅主机可触发同步' });
    if (!cfg.enabled) return res.status(400).json({ ok: false, message: '总开关未启用' });
    if (syncRunning) return res.status(409).json({ ok: false, message: '已有同步任务在执行' });
    // 立即返回 202，任务异步跑
    doSyncDb().catch(function () {}); // 错误已在内部记录
    res.status(202).json({ ok: true, message: '同步任务已启动，状态请看 /api/ha/status' });
  });

  // ---------- 定时同步：调度配置读写 ----------
  app.get('/api/ha/sync-schedule', function (_req, res) {
    const sch = cfg.syncSchedule || {};
    res.json({
      ok: true,
      data: {
        enabled: !!sch.enabled,
        preset: sch.preset || 'daily-3am',
        cron: effectiveCron(),
        customCron: sch.cron || '0 3 * * *',
        skipIfPeerDown: sch.skipIfPeerDown !== false,
        applyStatusMinusOne: sch.applyStatusMinusOne !== false,
        lastRunAt: sch.lastRunAt || '',
        lastRunResult: sch.lastRunResult || '',
        lastRunError: sch.lastRunError || '',
        nextRunAt: getNextRunAt(),
        running: !!scheduleTimer,
        allowed: cfg.selfRole === 'primary' && cfg.enabled,
        presets: Object.keys(PRESET_TO_CRON).concat(['custom']),
      },
    });
  });

  app.put('/api/ha/sync-schedule', function (req, res) {
    const b = req.body || {};
    // 校验 preset
    const validPresets = Object.keys(PRESET_TO_CRON).concat(['custom']);
    const preset = validPresets.indexOf(b.preset) >= 0 ? b.preset : 'daily-3am';
    let customCron = String(b.cron == null ? '' : b.cron).trim();
    if (preset === 'custom') {
      if (!customCron) return res.status(400).json({ ok: false, message: '自定义 cron 不能为空' });
      if (!cronValid(customCron)) return res.status(400).json({ ok: false, message: 'cron 表达式格式不合法（仅支持 5 字段：分 时 日 月 周）' });
    } else {
      // 非 custom 时也保留 customCron（用户切回 custom 时还能找回）
      if (customCron && !cronValid(customCron)) customCron = '0 3 * * *';
      if (!customCron) customCron = '0 3 * * *';
    }
    const next = {
      enabled: !!b.enabled,
      preset,
      cron: customCron,
      skipIfPeerDown: b.skipIfPeerDown !== false,
      applyStatusMinusOne: b.applyStatusMinusOne !== false,
      // 历史记录字段不被前端覆盖，保留原值
      lastRunAt: (cfg.syncSchedule && cfg.syncSchedule.lastRunAt) || '',
      lastRunResult: (cfg.syncSchedule && cfg.syncSchedule.lastRunResult) || '',
      lastRunError: (cfg.syncSchedule && cfg.syncSchedule.lastRunError) || '',
    };
    cfg.syncSchedule = next;
    writeCfg();
    pushEvent('info', `定时同步配置已更新：enabled=${next.enabled} cron=${effectiveCron()}`);

    // 立刻按新配置启停调度器
    stopScheduleTimer('config-changed');
    if (cfg.enabled && cfg.selfRole === 'primary' && next.enabled) {
      startScheduleTimer();
    }
    broadcastSnapshot();
    res.json({ ok: true, data: { ...next, cron: effectiveCron(), customCron, nextRunAt: getNextRunAt(), running: !!scheduleTimer } });
  });

  // ---------- 主机端被动逻辑：监听备机接管状态，自动停/启 dcim ----------
  // 流程：
  //   每 5s 通过 HTTP 查备机 http://<peer>:<port>/api/ha/status
  //   读出 status.failover.takenOver
  //   若 takenOver=true 且本机未让位 → docker exec dcim systemctl stop dcim + 标记 yielded=true
  //   若 takenOver=false 且本机已让位 → docker exec dcim systemctl start dcim + 标记 yielded=false
  let peerWatchTimer = null;
  let peerWatchInProgress = false;
  const PEER_WATCH_PORT = Number(process.env.HA_PEER_WATCH_PORT || 3010);

  function fetchPeerStatus(host, port, timeoutMs) {
    return new Promise(function (resolve) {
      const req = http.get({ host, port, path: '/api/ha/status', timeout: timeoutMs || 4000 }, function (resp) {
        let buf = '';
        resp.on('data', function (d) { buf += d.toString('utf8'); });
        resp.on('end', function () {
          try { resolve(JSON.parse(buf)); }
          catch (_e) { resolve(null); }
        });
      });
      req.on('error', function () { resolve(null); });
      req.on('timeout', function () { try { req.destroy(); } catch (_e) {} resolve(null); });
    });
  }

  function execDockerSimple(args, timeoutMs) {
    return new Promise(function (resolve) {
      const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let so = '', se = '';
      const t = setTimeout(function () { try { proc.kill('SIGTERM'); } catch (_e) {} }, timeoutMs || 30000);
      proc.stdout.on('data', function (d) { so += d.toString('utf8'); });
      proc.stderr.on('data', function (d) { se += d.toString('utf8'); });
      proc.on('close', function (code) { clearTimeout(t); resolve({ code, so, se }); });
      proc.on('error', function () { clearTimeout(t); resolve({ code: -1, so: '', se: 'spawn-error' }); });
    });
  }

  async function peerWatchTick() {
    if (peerWatchInProgress) return;
    peerWatchInProgress = true;
    try {
      if (!cfg.enabled || cfg.selfRole !== 'primary') return;
      const peerHost = cfg.standby && cfg.standby.ssh && cfg.standby.ssh.host;
      if (!peerHost) return;
      const peerStatus = await fetchPeerStatus(peerHost, PEER_WATCH_PORT, 4000);
      if (!peerStatus || !peerStatus.ok || !peerStatus.status) return;
      const peerFo = peerStatus.status.failover || {};
      const peerTakenOver = !!peerFo.takenOver;

      if (!cfg.yielded) cfg.yielded = JSON.parse(JSON.stringify(defaults.yielded));
      const wasYielded = !!cfg.yielded.yieldedToStandby;

      if (peerTakenOver && !wasYielded) {
        // 备机已接管 → 主机让位
        pushEvent('error', '【让位】备机已接管业务，本机自动停止 dcim 采集');
        const r = await execDockerSimple(['exec', 'dcim', 'systemctl', 'stop', 'dcim'], 30000);
        if (r.code === 0) {
          cfg.yielded.yieldedToStandby = true;
          cfg.yielded.yieldedAt = localStamp();
          writeCfg();
          pushEvent('warn', '【让位】完成：本机 dcim 已停止，业务运行在备机');
        } else {
          pushEvent('error', '【让位】停止 dcim 失败：' + ((r.se || r.so) || '').slice(0, 200));
        }
        broadcastSnapshot();
      } else if (!peerTakenOver && wasYielded) {
        // 备机已重置 → 主机收回
        pushEvent('info', '【收回】备机已重置接管状态，本机自动启动 dcim 采集');
        const r = await execDockerSimple(['exec', 'dcim', 'systemctl', 'start', 'dcim'], 30000);
        if (r.code === 0) {
          cfg.yielded.yieldedToStandby = false;
          cfg.yielded.yieldedAt = '';
          writeCfg();
          pushEvent('info', '【收回】完成：本机 dcim 已重新启动');
        } else {
          pushEvent('error', '【收回】启动 dcim 失败：' + ((r.se || r.so) || '').slice(0, 200));
        }
        broadcastSnapshot();
      }
    } catch (err) {
      // 静默：网络异常等不刷屏
    } finally {
      peerWatchInProgress = false;
    }
  }

  function startPeerWatchTimer() {
    if (peerWatchTimer) return;
    appendLog('启动主机被动监测循环（5s 查备机接管状态）');
    peerWatchTimer = setInterval(peerWatchTick, 5000);
    setTimeout(peerWatchTick, 2000);
  }
  function stopPeerWatchTimer(reason) {
    if (peerWatchTimer) {
      clearInterval(peerWatchTimer);
      peerWatchTimer = null;
      appendLog(`停止主机被动监测循环（${reason || '-'}）`);
    }
  }

  // ---------- 故障接管：REST 路由 ----------
  app.get('/api/ha/failover', function (_req, res) {
    const fo = cfg.failover || {};
    res.json({
      ok: true,
      data: {
        enabled: !!fo.enabled,
        bufferSec: Number(fo.bufferSec) || 30,
        bufferPreset: fo.bufferPreset || '30',
        judgeMode: fo.judgeMode || 'any',
        consecutiveFails: Number(fo.consecutiveFails) || 2,
        autoYieldOnPeerRecover: !!fo.autoYieldOnPeerRecover,
        autoYieldConsecutive: Number(fo.autoYieldConsecutive) || 5,
        cooldownSec: fo.cooldownSec != null ? Number(fo.cooldownSec) : 60,
        cooldownRemainingSec: failoverCooldownUntil > Date.now()
          ? Math.ceil((failoverCooldownUntil - Date.now()) / 1000) : 0,
        peerRecoverCount: failoverPeerRecoverCount,
        takenOver: !!fo.takenOver,
        takenOverAt: fo.takenOverAt || '',
        takenOverError: fo.takenOverError || '',
        state: failoverState,
        failCount: failoverFailCount,
        countdownSec: failoverCountdownSec,
        allowed: cfg.selfRole === 'standby' && cfg.enabled,
      },
    });
  });

  app.put('/api/ha/failover', function (req, res) {
    const b = req.body || {};
    const fo = cfg.failover || JSON.parse(JSON.stringify(defaults.failover));
    const before = !!fo.enabled;
    fo.enabled = !!b.enabled;
    if (b.bufferSec !== undefined) {
      const sec = Number(b.bufferSec);
      if (!(sec >= 5 && sec <= 3600)) {
        return res.status(400).json({ ok: false, message: 'bufferSec 必须在 5-3600 之间' });
      }
      fo.bufferSec = sec;
    }
    if (b.bufferPreset !== undefined) fo.bufferPreset = String(b.bufferPreset);
    if (b.judgeMode !== undefined) {
      const m = String(b.judgeMode);
      if (['any', 'both', 'ip-only'].indexOf(m) < 0) {
        return res.status(400).json({ ok: false, message: 'judgeMode 必须是 any/both/ip-only' });
      }
      fo.judgeMode = m;
    }
    if (b.consecutiveFails !== undefined) {
      const n = Number(b.consecutiveFails);
      if (!(n >= 1 && n <= 20)) {
        return res.status(400).json({ ok: false, message: 'consecutiveFails 必须在 1-20 之间' });
      }
      fo.consecutiveFails = n;
    }
    if (b.autoYieldOnPeerRecover !== undefined) {
      fo.autoYieldOnPeerRecover = !!b.autoYieldOnPeerRecover;
    }
    if (b.autoYieldConsecutive !== undefined) {
      const n = Number(b.autoYieldConsecutive);
      if (!(n >= 1 && n <= 60)) {
        return res.status(400).json({ ok: false, message: 'autoYieldConsecutive 必须在 1-60 之间' });
      }
      fo.autoYieldConsecutive = n;
    }
    if (b.cooldownSec !== undefined) {
      const n = Number(b.cooldownSec);
      if (!(n >= 0 && n <= 3600)) {
        return res.status(400).json({ ok: false, message: 'cooldownSec 必须在 0-3600 之间' });
      }
      fo.cooldownSec = n;
    }
    cfg.failover = fo;
    writeCfg();
    pushEvent('info', `故障接管配置已更新：enabled=${fo.enabled} buffer=${fo.bufferSec}s judge=${fo.judgeMode} consecutive=${fo.consecutiveFails} autoYield=${fo.autoYieldOnPeerRecover}/${fo.autoYieldConsecutive} cooldown=${fo.cooldownSec}s`);

    // 启停监测循环（仅 standby + 总开关启用时启动）
    if (cfg.enabled && cfg.selfRole === 'standby' && fo.enabled) {
      if (!fo.takenOver) {
        failoverState = 'monitoring';
        failoverFailCount = 0;
      }
      startFailoverCheckTimer();
    } else {
      stopFailoverCheckTimer('config-changed');
      if (!fo.takenOver) failoverState = 'idle';
    }
    broadcastSnapshot();
    res.json({ ok: true, data: { ...fo, state: failoverState, allowed: cfg.selfRole === 'standby' && cfg.enabled } });
  });

  // 立即停止缓冲监测（不影响已接管状态）
  app.post('/api/ha/failover/stop', function (_req, res) {
    if (!cfg.failover) cfg.failover = JSON.parse(JSON.stringify(defaults.failover));
    cfg.failover.enabled = false;
    writeCfg();
    stopFailoverCheckTimer('manual-stop');
    if (!cfg.failover.takenOver) failoverState = 'idle';
    pushEvent('info', '故障接管监测已停止');
    broadcastSnapshot();
    res.json({ ok: true, data: { state: failoverState } });
  });

  // 重置接管状态：UPDATE status=-1 + 停 dcim
  app.post('/api/ha/failover/reset', async function (_req, res) {
    try {
      await doFailoverReset();
      res.json({ ok: true, message: '已重置接管状态' });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // dry-run 测试：检查接管命令是否能跑通（不真接管）
  // 1) docker ps 看 dcim 容器存在
  // 2) docker exec dcim mysql ... -e "EXPLAIN UPDATE..."（仅校验权限和连通性）
  // 3) 不真重启 dcim
  app.post('/api/ha/failover/test', async function (_req, res) {
    if (cfg.selfRole !== 'standby') return res.status(400).json({ ok: false, message: '仅备机可测试接管' });
    const localDb = cfg.standby.db;
    const checks = { dockerPs: '', mysqlConn: '', updateGrant: '', deleteGrant: '' };
    try {
      // step1: docker ps，确认 dcim 容器存在
      const ps = await execDockerSimple(['ps', '--format', '{{.Names}}'], 15000);
      checks.dockerPs = (ps.code === 0 && /(^|\n)dcim(\n|$)/.test(ps.so))
        ? 'OK'
        : ('FAIL: ' + ((ps.se || ps.so) || 'docker 不可用').slice(0, 200));

      // step2: mysql 连通 + 能 SELECT
      const m = await execDockerSimple([
        'exec', 'dcim', 'mysql',
        '-h', String(localDb.host || '127.0.0.1'),
        '-P', String(localDb.port || 3306),
        '-u', String(localDb.user || ''),
        '--password=' + String(localDb.password || ''),
        '-BN', '-e',
        'USE `' + localDb.database + '`; SELECT COUNT(*) FROM `dcim-device`;',
      ], 15000);
      checks.mysqlConn = (m.code === 0) ? 'OK' : ('FAIL: ' + ((m.se || m.so) || '').slice(0, 200));

      // step3: SHOW GRANTS 看 UPDATE 权限
      const g = await execDockerSimple([
        'exec', 'dcim', 'mysql',
        '-h', String(localDb.host || '127.0.0.1'),
        '-P', String(localDb.port || 3306),
        '-u', String(localDb.user || ''),
        '--password=' + String(localDb.password || ''),
        '-BN', '-e', 'SHOW GRANTS FOR CURRENT_USER();',
      ], 15000);
      if (g.code === 0) {
        const hasUpdate = /\bUPDATE\b|\bALL PRIVILEGES\b/i.test(g.so);
        const hasDelete = /\bDELETE\b|\bALL PRIVILEGES\b/i.test(g.so);
        checks.updateGrant = hasUpdate ? 'OK' : ('FAIL: 当前用户没有 UPDATE 权限\n' + g.so.slice(0, 300));
        checks.deleteGrant = hasDelete ? 'OK' : ('FAIL: 当前用户没有 DELETE 权限（清空 dcim-alarmlist 需要）\n' + g.so.slice(0, 300));
      } else {
        checks.updateGrant = 'FAIL: ' + ((g.se || g.so) || '').slice(0, 200);
        checks.deleteGrant = 'FAIL: ' + ((g.se || g.so) || '').slice(0, 200);
      }

      const allOk = checks.dockerPs === 'OK' && checks.mysqlConn === 'OK' && checks.updateGrant === 'OK' && checks.deleteGrant === 'OK';
      res.json({
        ok: allOk,
        data: checks,
        message: allOk ? '所有校验通过，接管命令应能正常执行' : '部分校验失败，请检查',
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message, data: checks });
    }
  });


  // ---------- MySQL 连接保护调优（max_connect_errors）----------
  // 探测：经 SSH 进对端容器查 mysqld 当前 max_connect_errors 在线值 + my.cnf 落盘值
  // 目标容器名 / cnf 路径 / 重启命令 走可覆盖的 env，默认匹配当前部署
  const TUNE_CONTAINER = process.env.HA_TUNE_CONTAINER || 'dcim';
  const TUNE_CNF_PATH  = process.env.HA_TUNE_CNF_PATH  || '/etc/my.cnf';
  const TUNE_TARGET    = Number(process.env.HA_TUNE_TARGET || 100000);

  // sed 模板：替换 max_connect_errors 一行；如果 my.cnf 里没有这一行，则在 [mysqld] 段后追加
  function buildTuneSed(targetVal) {
    // 1) 已存在该行：替换
    // 2) 不存在：在 [mysqld] 后追加（用 awk 处理更稳）
    return [
      `if grep -qE '^[[:space:]]*max_connect_errors[[:space:]]*=' ${TUNE_CNF_PATH}; then`,
      `  sed -i -E 's/^[[:space:]]*max_connect_errors[[:space:]]*=[[:space:]]*[0-9]+/max_connect_errors = ${targetVal}/' ${TUNE_CNF_PATH};`,
      `else`,
      `  awk 'BEGIN{done=0} /^\\[mysqld\\]/&&!done{print;print "max_connect_errors = ${targetVal}";done=1;next} {print}' ${TUNE_CNF_PATH} > ${TUNE_CNF_PATH}.new && mv ${TUNE_CNF_PATH}.new ${TUNE_CNF_PATH};`,
      `fi`,
    ].join(' ');
  }

  // 探一端的 mysqld：在线值 + my.cnf 落盘值
  async function probeMysqlVar(sshCfg, dbCfg) {
    const c = await newPeerSshClient(sshCfg);
    try {
      // 在线值（用 dcim 用户，普通账号也能 SHOW VARIABLES）
      const q1 = `docker exec ${TUNE_CONTAINER} mysql -u${dbCfg.user} --password=${dbCfg.password || ''} -BN -e "SHOW VARIABLES LIKE 'max_connect_errors';" 2>&1 | tail -1 | awk '{print $2}'`;
      let r = await peerExec(c, q1, 15000);
      const live = (r.stdout || '').trim().split('\n').filter(function (l) { return /^\d+$/.test(l); }).pop() || '';
      // 落盘值
      const q2 = `docker exec ${TUNE_CONTAINER} sh -c "grep -E '^[[:space:]]*max_connect_errors[[:space:]]*=' ${TUNE_CNF_PATH} 2>/dev/null | tail -1 | awk -F= '{gsub(/[[:space:]]/,\\"\\"); print \\$2}'" 2>&1`;
      r = await peerExec(c, q2, 10000);
      const onDisk = (r.stdout || '').trim().split('\n').filter(function (l) { return /^\d+$/.test(l); }).pop() || '';
      return { ok: true, live: live ? Number(live) : null, onDisk: onDisk ? Number(onDisk) : null };
    } catch (err) {
      return { ok: false, message: err.message };
    } finally {
      try { c.end(); } catch (_e) {}
    }
  }

  app.get('/api/ha/mysql-vars', async function (_req, res) {
    if (!cfg.enabled) return res.status(400).json({ ok: false, message: '总开关未启用' });
    const out = { target: TUNE_TARGET };
    out.primary = await probeMysqlVar(cfg.primary.ssh, cfg.primary.db);
    out.standby = await probeMysqlVar(cfg.standby.ssh, cfg.standby.db);
    res.json({ ok: true, data: out });
  });

  // 调优单端：备份 my.cnf → sed/awk 改写 → 重启 mysqld → 校验在线值
  // restart=false 时只改文件不重启（生效要等下次自然重启）
  let tuneRunning = false;
  async function tuneOneSide(label, sshCfg, dbCfg, doRestart) {
    const c = await newPeerSshClient(sshCfg);
    try {
      const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      const bak = `${TUNE_CNF_PATH}.bak-${stamp}`;
      pushEvent('info', `[调优 ${label}] 备份 my.cnf → ${bak}`);
      let r = await peerExec(c, `docker exec ${TUNE_CONTAINER} cp ${TUNE_CNF_PATH} ${bak} && docker exec ${TUNE_CONTAINER} ls -l ${bak}`, 15000);
      if (r.code !== 0) throw new Error(`备份失败: ${(r.stderr || r.stdout).slice(0, 200)}`);

      pushEvent('info', `[调优 ${label}] 改写 max_connect_errors = ${TUNE_TARGET}`);
      const sedScript = buildTuneSed(TUNE_TARGET);
      r = await peerExec(c, `docker exec ${TUNE_CONTAINER} sh -c "${sedScript.replace(/"/g, '\\"')}"`, 15000);
      if (r.code !== 0) throw new Error(`改写失败: ${(r.stderr || r.stdout).slice(0, 200)}`);

      // 校验落盘
      r = await peerExec(c, `docker exec ${TUNE_CONTAINER} grep -E '^[[:space:]]*max_connect_errors' ${TUNE_CNF_PATH}`, 10000);
      const onDisk = (r.stdout || '').trim();
      if (!onDisk.includes(String(TUNE_TARGET))) throw new Error(`落盘校验失败: ${onDisk}`);
      pushEvent('info', `[调优 ${label}] 落盘校验通过：${onDisk}`);

      if (!doRestart) {
        pushEvent('info', `[调优 ${label}] 跳过重启（下次 mysqld 自然重启后生效）`);
        return { ok: true, restarted: false, onDisk: onDisk, bak: bak };
      }

      pushEvent('warn', `[调优 ${label}] 重启 mysqld（dcim 业务会断 1-3s）`);
      r = await peerExec(c, `docker exec ${TUNE_CONTAINER} systemctl restart mysqld`, 60000);
      if (r.code !== 0) throw new Error(`重启 mysqld 失败 exit=${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`);

      // 等 5s 让 mysqld 起来
      await new Promise(function (rs) { setTimeout(rs, 5000); });
      // 在线值校验
      const checkCmd = `docker exec ${TUNE_CONTAINER} mysql -u${dbCfg.user} --password=${dbCfg.password || ''} -BN -e "SHOW VARIABLES LIKE 'max_connect_errors';" 2>&1 | tail -1 | awk '{print $2}'`;
      r = await peerExec(c, checkCmd, 15000);
      const live = (r.stdout || '').trim().split('\n').filter(function (l) { return /^\d+$/.test(l); }).pop() || '';
      if (Number(live) !== TUNE_TARGET) throw new Error(`mysqld 在线值仍是 ${live || '(空)'}, 期望 ${TUNE_TARGET}`);
      pushEvent('info', `[调优 ${label}] mysqld 在线值已生效：max_connect_errors=${live}`);
      return { ok: true, restarted: true, live: Number(live), bak: bak };
    } finally {
      try { c.end(); } catch (_e) {}
    }
  }

  app.post('/api/ha/tune-mysql', async function (req, res) {
    if (!cfg.enabled) return res.status(400).json({ ok: false, message: '总开关未启用' });
    if (tuneRunning) return res.status(409).json({ ok: false, message: '已有调优任务在执行' });
    const body = req.body || {};
    const side = body.side === 'primary' || body.side === 'standby' || body.side === 'both' ? body.side : 'both';
    const restart = body.restart !== false;  // 默认重启

    tuneRunning = true;
    pushEvent('info', `开始 MySQL 调优：side=${side} restart=${restart} target=${TUNE_TARGET}`);
    const result = { side: side, restart: restart, target: TUNE_TARGET };
    try {
      if (side === 'primary' || side === 'both') {
        result.primary = await tuneOneSide('主机', cfg.primary.ssh, cfg.primary.db, restart);
      }
      if (side === 'standby' || side === 'both') {
        result.standby = await tuneOneSide('备机', cfg.standby.ssh, cfg.standby.db, restart);
      }
      pushEvent('info', `MySQL 调优完成：side=${side}`);
      res.json({ ok: true, result: result });
    } catch (err) {
      pushEvent('error', `MySQL 调优失败：${err.message}`);
      res.status(500).json({ ok: false, message: err.message, result: result });
    } finally {
      tuneRunning = false;
    }
  });

  // ---------- WebSocket /ws/ha ----------
  wssHa.on('connection', function (ws) {
    // 新连接立刻推一次全量快照
    try { ws.send(JSON.stringify({ type: 'snapshot', data: publicStatus() })); } catch (_e) {}
    ws.on('message', function (raw) {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (_e) { return; }
      if (msg && msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch (_e) {}
      }
    });
    ws.on('error', function () {});
  });

  // ---------- 自启 ----------
  readCfg();
  appendLog(`服务启动，enabled=${cfg.enabled}, selfRole=${cfg.selfRole}`);
  if (cfg.enabled) {
    // 异步启动，避免阻塞 server.js 主流程
    setTimeout(function () { applyEnabled().catch(function (err) {
      appendLog(`自启失败：${err.message}`);
    }); }, 1000);
  }
})();

// ===== 信创短信猫 - 数据库监测「新告警提示」 =====
(function setupSmsMonitor() {
  const path = require('path');

  const CONFIG_PATH = process.env.SMS_MONITOR_CONFIG
    || path.join(__dirname, 'config', 'sms-monitor.json');
  const LOG_PATH = process.env.SMS_MONITOR_LOG
    || path.join(__dirname, 'logs', 'sms-monitor.log');

  const TABLE = 'dcim-alarmlist';
  const MIN_INTERVAL = 1;
  const MAX_INTERVAL = 3600;
  const MAX_BUFFER = 500;
  // 新告警插入后 TextMessage 会由另一个进程异步填充。
  // NotifyModeID > 0 路径通常 2-3 秒填好；NotifyModeID = 0 路径（兜底分支）经验上更慢。
  // 两个上限都做成可配置，保留 30 / 120 作为安全默认值。
  const MAX_PENDING_SEC = 30;       // NotifyModeID>0 路径默认上限
  const MAX_PENDING_SEC_MODE0 = 120; // NotifyModeID=0 路径默认上限（更宽容）
  const MIN_PENDING_SEC = 5;
  const MAX_PENDING_SEC_LIMIT = 600;

  const defaults = {
    enabled: true,
    intervalSec: 3,
    bufferSize: 200,
    maxPendingSec: MAX_PENDING_SEC,
    maxPendingSecMode0: MAX_PENDING_SEC_MODE0,
  };
  let cfg = Object.assign({}, defaults);
  let timer = null;
  let polling = false;
  let lastSeenId = 0;
  let alarmBuffer = [];        // [{ clientId, row }]
  let nextClientId = 1;
  // 等待 TextMessage 填充的新告警：Map<id, { firstSeenMs, row }>
  let pendingAlarms = new Map();
  // 告警解除：按 CancelTime 增量，不看 id（同一条 id 被 UPDATE）
  let lastCancelMs = 0;        // 时间戳毫秒，作为游标
  let cancelBuffer = [];       // [{ clientId, row }]
  let nextCancelClientId = 1;
  let totalCancelled = 0;
  let lastError = '';
  let lastPollAt = '';
  let totalFetched = 0;
  // 新告警事件订阅：alarmBuffer 真正落入一条时回调，给短信猫推送模块用
  const alarmListeners = [];
  function notifyAlarmListeners(row) {
    for (const fn of alarmListeners) {
      try { fn(row); } catch (err) { appendLog(`listener 异常：${err.message}`); }
    }
  }
  global.__smsMonitorAddAlarmListener = function (fn) {
    if (typeof fn === 'function' && alarmListeners.indexOf(fn) === -1) {
      alarmListeners.push(fn);
    }
  };
  // 告警解除事件订阅：cancelBuffer 真正落入一条时回调
  const cancelListeners = [];
  function notifyCancelListeners(row) {
    for (const fn of cancelListeners) {
      try { fn(row); } catch (err) { appendLog(`cancel-listener 异常：${err.message}`); }
    }
  }
  global.__smsMonitorAddCancelListener = function (fn) {
    if (typeof fn === 'function' && cancelListeners.indexOf(fn) === -1) {
      cancelListeners.push(fn);
    }
  };

  function localStamp(d) {
    d = d || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, `[${localStamp()}] ${line}\n`, 'utf8');
    } catch (_e) {}
  }
  function clamp(v, min, max, dft) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dft;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }
  function readCfg() {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      cfg = {
        enabled: Boolean(parsed.enabled),
        intervalSec: clamp(parsed.intervalSec, MIN_INTERVAL, MAX_INTERVAL, defaults.intervalSec),
        bufferSize: clamp(parsed.bufferSize, 10, MAX_BUFFER, defaults.bufferSize),
        maxPendingSec: clamp(parsed.maxPendingSec, MIN_PENDING_SEC, MAX_PENDING_SEC_LIMIT, defaults.maxPendingSec),
        maxPendingSecMode0: clamp(parsed.maxPendingSecMode0, MIN_PENDING_SEC, MAX_PENDING_SEC_LIMIT, defaults.maxPendingSecMode0),
      };
    } catch (_e) {
      cfg = Object.assign({}, defaults);
    }
  }
  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.error('[sms-monitor] 写配置失败:', err.message);
    }
  }
  function getPool() {
    return typeof global.__smsDbGetPool === 'function' ? global.__smsDbGetPool() : null;
  }

  async function initLastSeenId() {
    const pool = getPool();
    if (!pool) return;
    try {
      const [rows] = await pool.query('SELECT COALESCE(MAX(id),0) AS maxId FROM `' + TABLE + '`');
      lastSeenId = Number(rows[0] && rows[0].maxId) || 0;
      // 同时把 CancelTime 游标对齐到当前最大值，避免首次把历史解除全部当成新事件
      const [c] = await pool.query('SELECT MAX(CancelTime) AS maxT FROM `' + TABLE + '` WHERE CancelTime IS NOT NULL');
      const maxT = c[0] && c[0].maxT;
      lastCancelMs = maxT ? new Date(maxT).getTime() : 0;
      appendLog(`初始化 lastSeenId=${lastSeenId} lastCancelMs=${lastCancelMs}`);
    } catch (err) {
      lastError = err.message;
      appendLog(`初始化失败：${err.message}`);
      if (isConnectionError(err) && typeof global.__smsDbMarkBroken === 'function') {
        global.__smsDbMarkBroken('monitor-init: ' + (err.code || err.message));
      }
    }
  }

  async function pollOnce() {
    if (polling) return;
    const pool = getPool();
    if (!pool) { lastError = '数据库未连接'; return; }
    polling = true;
    try {
      if (lastSeenId === 0 && lastCancelMs === 0) await initLastSeenId();

      // 1) 新告警：id > lastSeenId，但 TextMessage 可能稍后由其它进程填充，
      //    所以 TextMessage 为空时先入 pending，等下次轮询再查。
      const [rows] = await pool.query(
        'SELECT * FROM `' + TABLE + '` WHERE id > ? ORDER BY id ASC LIMIT 200',
        [lastSeenId]
      );
      lastPollAt = localStamp();
      if (rows && rows.length) {
        const nowMs = Date.now();
        for (const row of rows) {
          const text = row.TextMessage;
          if (text != null && String(text).trim() !== '') {
            alarmBuffer.push({ clientId: nextClientId++, row });
            notifyAlarmListeners(row);
          } else {
            pendingAlarms.set(Number(row.id), { firstSeenMs: nowMs, row });
          }
          if (Number(row.id) > lastSeenId) lastSeenId = Number(row.id);
        }
        totalFetched += rows.length;
        appendLog(`新增 ${rows.length} 条，lastSeenId=${lastSeenId}，其中 pending=${pendingAlarms.size}`);
      }

      // 1.5) 复查 pending：TextMessage 已填或超时则 flush 进 alarmBuffer
      // 超时阈值按当前 pending 行的 NotifyModeID 决定：>0 走 maxPendingSec，=0 走 maxPendingSecMode0
      if (pendingAlarms.size) {
        const ids = Array.from(pendingAlarms.keys());
        const placeholders = ids.map(function () { return '?'; }).join(',');
        const [fresh] = await pool.query(
          'SELECT * FROM `' + TABLE + '` WHERE id IN (' + placeholders + ')',
          ids
        );
        const byId = new Map();
        (fresh || []).forEach(function (r) { byId.set(Number(r.id), r); });
        const nowMs = Date.now();
        for (const id of ids) {
          const p = pendingAlarms.get(id);
          const latest = byId.get(id) || p.row;
          const text = latest.TextMessage;
          const filled = text != null && String(text).trim() !== '';
          const modeId = Number(latest && latest.NotifyModeID);
          const isModeZero = !Number.isFinite(modeId) || modeId <= 0;
          const limitSec = isModeZero ? cfg.maxPendingSecMode0 : cfg.maxPendingSec;
          const timeout = (nowMs - p.firstSeenMs) / 1000 >= limitSec;
          if (filled || timeout) {
            alarmBuffer.push({ clientId: nextClientId++, row: latest });
            notifyAlarmListeners(latest);
            pendingAlarms.delete(id);
            if (timeout && !filled) {
              appendLog(`id=${id} 等待 TextMessage 超时 ${limitSec}s（NotifyModeID=${isModeZero ? 0 : modeId}），兜底放行`);
            }
          }
        }
      }
      if (alarmBuffer.length > cfg.bufferSize) {
        alarmBuffer = alarmBuffer.slice(-cfg.bufferSize);
      }

      // 2) 告警解除：CancelTime > lastCancelMs
      const cursorDate = lastCancelMs > 0 ? new Date(lastCancelMs) : new Date(0);
      const [cancels] = await pool.query(
        'SELECT * FROM `' + TABLE + '` WHERE CancelTime IS NOT NULL AND CancelTime > ? ORDER BY CancelTime ASC LIMIT 200',
        [cursorDate]
      );
      if (cancels && cancels.length) {
        for (const row of cancels) {
          const t = row.CancelTime ? new Date(row.CancelTime).getTime() : 0;
          // 防御：游标相等时跳过（mysql2 的 > 已能排除相等，这里多一层保险）
          if (t && t <= lastCancelMs) continue;
          cancelBuffer.push({ clientId: nextCancelClientId++, row });
          notifyCancelListeners(row);
          if (t > lastCancelMs) lastCancelMs = t;
        }
        if (cancelBuffer.length > cfg.bufferSize) {
          cancelBuffer = cancelBuffer.slice(-cfg.bufferSize);
        }
        totalCancelled += cancels.length;
        appendLog(`解除 ${cancels.length} 条，lastCancelMs=${lastCancelMs}`);
      }

      lastError = '';
    } catch (err) {
      lastError = err.message;
      appendLog(`轮询失败：${err.message}`);
      if (isConnectionError(err) && typeof global.__smsDbMarkBroken === 'function') {
        global.__smsDbMarkBroken('monitor: ' + (err.code || err.message));
      }
    } finally {
      polling = false;
    }
  }

  // 网络级 / 协议级错误：mysql2 一旦命中这些 code，池里那条 socket 已经废了。
  // ECONNREFUSED：docker 重启窗口期连不上 3306
  // PROTOCOL_CONNECTION_LOST / ECONNRESET：连接已建立但被对端踢
  // ETIMEDOUT / EHOSTUNREACH / ENOTFOUND：网络/DNS 异常
  // ER_ACCESS_DENIED_ERROR / 语法错误等业务错误不重连，避免错误的密码导致死循环
  function isConnectionError(err) {
    if (!err) return false;
    const code = String(err.code || '').toUpperCase();
    if (code === 'ER_ACCESS_DENIED_ERROR') return false;
    if (['ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ECONNRESET',
         'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND'].indexOf(code) >= 0) return true;
    const msg = String(err.message || '').toLowerCase();
    return msg.indexOf('pool is closed') >= 0
      || msg.indexOf('connect etimedout') >= 0
      || msg.indexOf('connection lost') >= 0;
  }

  function scheduleTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    if (!cfg.enabled) return;
    const ms = Math.max(MIN_INTERVAL * 1000, cfg.intervalSec * 1000);
    timer = setInterval(() => { pollOnce().catch(() => {}); }, ms);
  }

  function publicState() {
    return {
      enabled: cfg.enabled,
      intervalSec: cfg.intervalSec,
      bufferSize: cfg.bufferSize,
      maxPendingSec: cfg.maxPendingSec,
      maxPendingSecMode0: cfg.maxPendingSecMode0,
      lastSeenId: lastSeenId,
      bufferCount: alarmBuffer.length,
      pendingCount: pendingAlarms.size,
      totalFetched: totalFetched,
      lastCancelMs: lastCancelMs,
      cancelBufferCount: cancelBuffer.length,
      totalCancelled: totalCancelled,
      lastPollAt: lastPollAt,
      lastError: lastError,
      dbConnected: !!getPool(),
      table: TABLE,
    };
  }

  app.get('/api/sms/monitor/config', function (_req, res) {
    res.json(publicState());
  });

  app.put('/api/sms/monitor/config', function (req, res) {
    const body = req.body || {};
    if ('enabled' in body) cfg.enabled = Boolean(body.enabled);
    if ('intervalSec' in body) cfg.intervalSec = clamp(body.intervalSec, MIN_INTERVAL, MAX_INTERVAL, cfg.intervalSec);
    if ('bufferSize' in body) cfg.bufferSize = clamp(body.bufferSize, 10, MAX_BUFFER, cfg.bufferSize);
    if ('maxPendingSec' in body) cfg.maxPendingSec = clamp(body.maxPendingSec, MIN_PENDING_SEC, MAX_PENDING_SEC_LIMIT, cfg.maxPendingSec);
    if ('maxPendingSecMode0' in body) cfg.maxPendingSecMode0 = clamp(body.maxPendingSecMode0, MIN_PENDING_SEC, MAX_PENDING_SEC_LIMIT, cfg.maxPendingSecMode0);
    writeCfg();
    scheduleTimer();
    appendLog(`配置更新 enabled=${cfg.enabled} interval=${cfg.intervalSec}s buffer=${cfg.bufferSize} maxPendingSec=${cfg.maxPendingSec} maxPendingSecMode0=${cfg.maxPendingSecMode0}`);
    res.json(publicState());
  });

  app.get('/api/sms/monitor/recent', function (req, res) {
    const sinceClientId = Number(req.query.sinceClientId) || 0;
    const items = alarmBuffer.filter(function (e) { return e.clientId > sinceClientId; });
    const lastClientId = alarmBuffer.length
      ? alarmBuffer[alarmBuffer.length - 1].clientId
      : sinceClientId;
    res.json({ state: publicState(), items: items, lastClientId: lastClientId });
  });

  app.get('/api/sms/monitor/cancels', function (req, res) {
    const sinceClientId = Number(req.query.sinceClientId) || 0;
    const items = cancelBuffer.filter(function (e) { return e.clientId > sinceClientId; });
    const lastClientId = cancelBuffer.length
      ? cancelBuffer[cancelBuffer.length - 1].clientId
      : sinceClientId;
    res.json({ state: publicState(), items: items, lastClientId: lastClientId });
  });

  app.post('/api/sms/monitor/clear', function (req, res) {
    const scope = String((req.query && req.query.scope) || 'all');
    if (scope === 'all' || scope === 'alarms') alarmBuffer = [];
    if (scope === 'all' || scope === 'cancels') cancelBuffer = [];
    res.json(publicState());
  });

  readCfg();
  setTimeout(function () {
    initLastSeenId().catch(() => {});
    scheduleTimer();
    if (cfg.enabled) pollOnce().catch(() => {});
    appendLog(`服务启动：enabled=${cfg.enabled} interval=${cfg.intervalSec}s`);
  }, 1500);
})();

// ===== 信创短信猫 - 推送模块（HTTP API） =====
// 协议：
//  POST {gateway}/cgi-bin/NoticePush  推送通知（短信/电话/全部）
//  POST {gateway}/cgi-bin/NoticeResults  根据 id 列表查询发送结果
//  GET  {gateway}{simStatusPath}  查询 SIM 卡状态（默认 /cgi-bin/SystemStatusSnapshot）
(function setupSmsPush() {
  const path = require('path');
  const crypto = require('crypto');

  const CONFIG_PATH = process.env.SMS_PUSH_CONFIG
    || path.join(__dirname, 'config', 'sms-push.json');
  const LOG_PATH = process.env.SMS_PUSH_LOG
    || path.join(__dirname, 'logs', 'sms-push.log');

  const MAX_HISTORY = 500;
  const PERSON_TABLE = 'dcim-person';
  const NOTIFY_MODE_TABLE = 'dcim-alarmnotifymode';
  const DEFAULT_PATHS = {
    push: '/cgi-bin/NoticePush',
    results: '/cgi-bin/NoticeResults',
    sim: '/cgi-bin/SystemStatusSnapshot',
  };

  const defaults = {
    enabled: false,                         // 推送总开关
    autoPushOnAlarm: false,                 // 是否随新告警自动推送
    autoPushOnCancel: false,                // 是否随告警解除自动推送
    gatewayHost: '192.168.50.199',          // 短信网关 IP
    gatewayPort: 8791,                      // HTTP API 端口
    pushPath: DEFAULT_PATHS.push,
    resultsPath: DEFAULT_PATHS.results,
    simStatusPath: DEFAULT_PATHS.sim,
    type: 'SMS',                            // 手动发送的默认类型；自动推送由 alarmnotifymode 决定
    encoding: 'UTF-8',                      // 'UTF-8' | 'ANSI'
    httpTimeoutMs: 8000,                    // 请求超时
    autoQueryResultIntervalSec: 30,         // 后台周期查询结果
  };

  // ===== 多品牌驱动注册表 =====
  // 每个 driver 提供：name 显示名 / capabilities 能力声明 / defaults 默认参数
  // 以及 callPush(pcfg, payload) / callResults(pcfg, ids) / callSimStatus(pcfg) 的具体实现
  // capabilities.sim=false → 前端隐藏 SIM 卡相关 UI
  // capabilities.results=false → 后台不启动结果轮询
  // 实现还没接入的品牌请把方法保留为 throw new Error('暂未接入...')，UI 层会兜底
  const DRIVERS = {
    xinchuang: {
      name: '信创短信猫',
      capabilities: { sim: true, results: true },
      defaults: defaults,
      // 三个 call 方法在原 callPush/callResults/callSimStatus 函数内联，
      // 这里通过同名包装统一入口，避免大幅改造原代码
      callPush: null, callResults: null, callSimStatus: null,
    },
    // HBOS 医疗云短信平台：走 HTTP POST + App-Key，无 SIM / 无结果轮询
    // 端点：POST http://open-gyfy.cfuture.shop/kapi/gw-api/hbos-business-thirdparty-integration/standard/base/notify/sms
    hbos: {
      name: 'HBOS 医疗云短信平台',
      capabilities: { sim: false, results: false },
      defaults: {
        enabled: false,
        autoPushOnAlarm: false,
        autoPushOnCancel: false,
        gatewayHost: 'open-gyfy.cfuture.shop',
        gatewayPort: 80,
        pushPath: '/kapi/gw-api/hbos-business-thirdparty-integration/standard/base/notify/sms',
        type: 'SMS',
        encoding: 'UTF-8',
        httpTimeoutMs: 8000,
        // HBOS 专有字段
        appKey: 'ak-Z0U7k56rmbIng7U4YOU17yAr',
        templateCode: 'appletSms',
        senderJobNumber: 'ZZJ0001',
        orgId: '20389001',
      },
      callPush: null,
      callResults: function () { throw new Error('HBOS 短信平台不提供结果查询接口'); },
      callSimStatus: function () { throw new Error('HBOS 短信平台无 SIM 卡'); },
    },
    // 占位品牌：UI 能选，但后端尚未实现，调用时给出友好错误
    rixin: {
      name: '日新短信猫（占位）',
      capabilities: { sim: false, results: false },
      defaults: { enabled: false, gatewayHost: '', gatewayPort: 0, type: 'SMS', encoding: 'UTF-8', httpTimeoutMs: 8000 },
      callPush: function () { throw new Error('日新短信猫暂未接入'); },
      callResults: function () { throw new Error('日新短信猫暂未接入'); },
      callSimStatus: function () { throw new Error('日新短信猫暂未接入'); },
    },
  };
  function listBrands() {
    return Object.keys(DRIVERS).map(function (k) {
      return { key: k, name: DRIVERS[k].name, capabilities: Object.assign({}, DRIVERS[k].capabilities) };
    });
  }
  function brandKeyOrFallback(k) {
    return DRIVERS[k] ? k : 'xinchuang';
  }

  // cfgRoot 是磁盘上的整体配置：{ brand, brands: { xinchuang: {...}, rixin: {...} } }
  // cfg 始终是 cfgRoot.brands[cfgRoot.brand] 的引用，让原有所有 cfg.X 读写零改造
  let cfgRoot = { brand: 'xinchuang', brands: { xinchuang: Object.assign({}, defaults) } };
  let cfg = cfgRoot.brands.xinchuang;

  // 发送历史：每条 {id, stime, type, to, text, status, ackTime, error, source}
  // source: 'manual' | 'auto'
  let history = [];
  let resultsTimer = null;
  let lastError = '';
  let totalSent = 0;
  let totalFailed = 0;

  function localStamp(d) {
    d = d || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, `[${localStamp()}] ${line}\n`, 'utf8');
    } catch (_e) {}
  }
  function isoZ(d) {
    return (d || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  function genId() {
    // 协议示例 32 位无连字符（如 bceb32ae1f1611f08b3902b910fcb41e），保持兼容
    return crypto.randomBytes(16).toString('hex');
  }
  function clamp(v, min, max, dft) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dft;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }
  function sanitizeRecipients(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const it of arr) {
      const s = String(it == null ? '' : it).trim();
      if (s && /^[0-9+#*\-]{3,32}$/.test(s) && out.indexOf(s) === -1) out.push(s);
    }
    return out;
  }
  function sanitizeIds(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const it of arr) {
      const n = Number(it);
      if (Number.isFinite(n) && n > 0 && out.indexOf(n) === -1) out.push(Math.floor(n));
    }
    return out;
  }
  function getDbPool() {
    return typeof global.__smsDbGetPool === 'function' ? global.__smsDbGetPool() : null;
  }
  // 列出 dcim-person 全部记录（id / 姓名 / 手机号 / GroupId）— 前端"收件人"按钮的只读视图
  async function listPersons() {
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    const [rows] = await pool.query(
      'SELECT id, PersonName, PersonPhone, GroupId FROM `' + PERSON_TABLE + '` ORDER BY id ASC'
    );
    return rows || [];
  }
  // 按 id 数组实时查库，返回 [{id, name, phone}]
  async function resolveRecipientsByIds(ids) {
    const list = sanitizeIds(ids);
    if (!list.length) return [];
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    const placeholders = list.map(function () { return '?'; }).join(',');
    const [rows] = await pool.query(
      'SELECT id, PersonName, PersonPhone FROM `' + PERSON_TABLE + '`'
      + ' WHERE id IN (' + placeholders + ')',
      list
    );
    const out = [];
    for (const r of rows || []) {
      const phone = String(r.PersonPhone == null ? '' : r.PersonPhone).trim();
      if (phone) out.push({ id: r.id, name: r.PersonName, phone: phone });
    }
    return out;
  }
  // 按告警的 NotifyModeID 解析推送目标：
  //   1) 查 alarmnotifymode 拿 PhoneNotify / SMSNotify / UserID
  //   2) UserID 可能是单值或逗号分隔，按 GroupId 模糊匹配 dcim-person
  //      person.GroupId 实际样本是 ",1," 这种前后带逗号包围的格式，
  //      所以匹配条件统一加 ',' 包围两侧再 LIKE，兼容单值和 CSV
  // 返回 { mode, phoneNotify, smsNotify, userIds: string[], persons: [{id,name,phone,groupId}] }
  // mode === null 表示 alarmnotifymode 里没有匹配
  async function resolveByNotifyMode(modeId) {
    const id = Number(modeId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    const [rows] = await pool.query(
      'SELECT id, AlarmName, PhoneNotify, SMSNotify, UserID FROM `' + NOTIFY_MODE_TABLE + '` WHERE id = ?',
      [id]
    );
    const mode = rows && rows[0];
    if (!mode) return null;
    return resolvePersonsFromMode(mode);
  }

  // 兜底：当 NotifyModeID=0 时按 (AlarmType, DevId) 反查 alarmnotifymode 取首条
  // 返回结构与 resolveByNotifyMode 一致；未命中返回 null
  async function resolveByAlarmTypeDev(alarmType, devId) {
    if (alarmType == null || devId == null) return null;
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    const [rows] = await pool.query(
      'SELECT id, AlarmName, PhoneNotify, SMSNotify, UserID FROM `' + NOTIFY_MODE_TABLE + '`'
      + ' WHERE AlarmType = ? AND DevId = ? AND status = 1'
      + ' ORDER BY id ASC LIMIT 1',
      [alarmType, devId]
    );
    const mode = rows && rows[0];
    if (!mode) return null;
    return resolvePersonsFromMode(mode);
  }

  // 私有：拿到 alarmnotifymode 行后解析 PhoneNotify / SMSNotify / UserID + 联表查 person
  // 这是 resolveByNotifyMode 和 resolveByAlarmTypeDev 共享的核心逻辑，独立维护避免漂移
  async function resolvePersonsFromMode(mode) {
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    const phoneNotify = Number(mode.PhoneNotify) === 1;
    const smsNotify = Number(mode.SMSNotify) === 1;
    const userIdRaw = String(mode.UserID == null ? '' : mode.UserID).trim();
    const userIds = userIdRaw
      ? userIdRaw.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; })
      : [];
    let persons = [];
    if (userIds.length) {
      // 用 OR + LIKE，兼容 person.GroupId = ",1,2," 这类多组场景
      const where = userIds.map(function () {
        return "CONCAT(',', `GroupId`, ',') LIKE CONCAT('%,', ?, ',%')";
      }).join(' OR ');
      const [pRows] = await pool.query(
        'SELECT id, PersonName, PersonPhone, GroupId FROM `' + PERSON_TABLE + '`'
        + ' WHERE PersonPhone IS NOT NULL AND PersonPhone <> \'\' AND (' + where + ')'
        + ' ORDER BY id ASC',
        userIds
      );
      const seen = new Set();
      for (const r of pRows || []) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const phone = String(r.PersonPhone == null ? '' : r.PersonPhone).trim();
        if (!phone) continue;
        persons.push({ id: r.id, name: r.PersonName, phone: phone, groupId: r.GroupId });
      }
    }
    return {
      mode: { id: mode.id, alarmName: mode.AlarmName, phoneNotify: phoneNotify, smsNotify: smsNotify, userId: userIdRaw },
      phoneNotify: phoneNotify,
      smsNotify: smsNotify,
      userIds: userIds,
      persons: persons,
    };
  }
  // 把单个品牌的扁平参数 normalize 一遍：填默认 + clamp 越界值
  function normalizeBrandCfg(brandKey, raw) {
    const drv = DRIVERS[brandKey] || DRIVERS.xinchuang;
    const dft = drv.defaults || defaults;
    const merged = Object.assign({}, dft, raw || {});
    if ('gatewayPort' in merged) merged.gatewayPort = clamp(merged.gatewayPort, 1, 65535, dft.gatewayPort || 8791);
    if ('httpTimeoutMs' in merged) merged.httpTimeoutMs = clamp(merged.httpTimeoutMs, 1000, 60000, dft.httpTimeoutMs || 8000);
    if ('autoQueryResultIntervalSec' in merged) {
      merged.autoQueryResultIntervalSec = clamp(merged.autoQueryResultIntervalSec, 5, 600, dft.autoQueryResultIntervalSec || 30);
    }
    if (brandKey === 'xinchuang') {
      merged.pushPath = merged.pushPath || DEFAULT_PATHS.push;
      merged.resultsPath = merged.resultsPath || DEFAULT_PATHS.results;
      merged.simStatusPath = merged.simStatusPath || DEFAULT_PATHS.sim;
    }
    if (brandKey === 'hbos') {
      merged.pushPath = merged.pushPath || dft.pushPath || '/';
      merged.appKey = String(merged.appKey || dft.appKey || '').trim();
      merged.templateCode = String(merged.templateCode || dft.templateCode || 'appletSms').trim();
      merged.senderJobNumber = String(merged.senderJobNumber || dft.senderJobNumber || 'ZZJ0001').trim();
      merged.orgId = String(merged.orgId || dft.orgId || '').trim();
    }
    merged.enabled = !!merged.enabled;
    merged.autoPushOnAlarm = !!merged.autoPushOnAlarm;
    merged.autoPushOnCancel = !!merged.autoPushOnCancel;
    delete merged.recipients;
    delete merged.recipientIds;
    return merged;
  }

  // 强制单品牌互斥：当某品牌 enabled=true 时，把其他品牌的 enabled 一律置 false
  function enforceSingleEnabled(activeKey) {
    Object.keys(cfgRoot.brands).forEach(function (k) {
      if (k !== activeKey && cfgRoot.brands[k]) cfgRoot.brands[k].enabled = false;
    });
  }
  // 把 cfg 引用切到目标品牌，确保后续所有 cfg.X 读到的是新品牌的参数
  function activateBrand(brandKey) {
    const key = brandKeyOrFallback(brandKey);
    if (!cfgRoot.brands[key]) cfgRoot.brands[key] = normalizeBrandCfg(key, {});
    cfgRoot.brand = key;
    cfg = cfgRoot.brands[key];
    return key;
  }

  function readCfg() {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      // 兼容三种写法：① 新结构 { brand, brands:{} }；② 老的扁平结构（迁移到 xinchuang）；③ 文件不存在
      if (parsed && parsed.brands && typeof parsed.brands === 'object') {
        cfgRoot = { brand: brandKeyOrFallback(parsed.brand), brands: {} };
        Object.keys(parsed.brands).forEach(function (k) {
          if (DRIVERS[k]) cfgRoot.brands[k] = normalizeBrandCfg(k, parsed.brands[k]);
        });
        if (!cfgRoot.brands[cfgRoot.brand]) cfgRoot.brands[cfgRoot.brand] = normalizeBrandCfg(cfgRoot.brand, {});
      } else if (parsed && typeof parsed === 'object') {
        // 旧扁平配置：整体迁移到 xinchuang
        cfgRoot = { brand: 'xinchuang', brands: { xinchuang: normalizeBrandCfg('xinchuang', parsed) } };
        appendLog('检测到旧版扁平配置，已迁移到 brands.xinchuang');
      }
    } catch (_e) {
      cfgRoot = { brand: 'xinchuang', brands: { xinchuang: normalizeBrandCfg('xinchuang', {}) } };
    }
    activateBrand(cfgRoot.brand);
    enforceSingleEnabled(cfgRoot.brand);
  }
  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfgRoot, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.error('[sms-push] 写配置失败:', err.message);
    }
  }
  function pushHistory(entry) {
    history.push(entry);
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  }
  function findHistoryById(id) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].id === id) return history[i];
    }
    return null;
  }

  // 通用 HTTP 请求（无外部依赖，只用 node:http）
  function httpRequest(opts, body) {
    return new Promise(function (resolve, reject) {
      const req = http.request({
        host: opts.host,
        port: opts.port,
        path: opts.path,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        timeout: opts.timeout || 8000,
      }, function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          const buf = Buffer.concat(chunks);
          resolve({ statusCode: res.statusCode, headers: res.headers, body: buf });
        });
      });
      req.on('error', reject);
      req.on('timeout', function () {
        req.destroy(new Error('请求超时 ' + (opts.timeout || 8000) + 'ms'));
      });
      if (body != null) req.write(body);
      req.end();
    });
  }

  // ===== 信创品牌的真实实现：填回 DRIVERS.xinchuang 的 callXxx =====
  // 参数 pcfg 是该品牌当前的配置对象（不是全局 cfg），便于将来同时对多个品牌发起调用
  DRIVERS.xinchuang.callPush = async function (pcfg, payload) {
    if (!pcfg.gatewayHost) throw new Error('网关 IP 未配置');
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    return httpRequest({
      host: pcfg.gatewayHost, port: pcfg.gatewayPort,
      path: pcfg.pushPath || DEFAULT_PATHS.push, method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length },
      timeout: pcfg.httpTimeoutMs,
    }, data);
  };
  DRIVERS.xinchuang.callResults = async function (pcfg, ids) {
    if (!pcfg.gatewayHost) throw new Error('网关 IP 未配置');
    const data = Buffer.from(JSON.stringify(ids), 'utf8');
    return httpRequest({
      host: pcfg.gatewayHost, port: pcfg.gatewayPort,
      path: pcfg.resultsPath || DEFAULT_PATHS.results, method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length },
      timeout: pcfg.httpTimeoutMs,
    }, data);
  };
  DRIVERS.xinchuang.callSimStatus = async function (pcfg) {
    if (!pcfg.gatewayHost) throw new Error('网关 IP 未配置');
    return httpRequest({
      host: pcfg.gatewayHost, port: pcfg.gatewayPort,
      path: pcfg.simStatusPath || DEFAULT_PATHS.sim, method: 'GET',
      timeout: pcfg.httpTimeoutMs,
    });
  };

  // ===== HBOS 医疗云平台实现 =====
  // 把通用 payload {id[], to[], text, type, encoding} 转成 HBOS 的 msgContentList 结构，
  // 走 App-Key 鉴权，把 HBOS 的 {success, data[]} 响应改写成 {reply:'OK'/'FAIL: ...'} 兼容 sendOne 的解析
  DRIVERS.hbos.callPush = async function (pcfg, payload) {
    if (!pcfg.gatewayHost) throw new Error('HBOS 服务器地址未配置');
    if (!pcfg.appKey) throw new Error('App-Key 未配置');
    if (!pcfg.orgId) throw new Error('机构 ID (orgId) 未配置');
    const to = Array.isArray(payload.to) ? payload.to : [];
    if (!to.length) throw new Error('收件人为空');
    const msgContentList = to.map(function (num) {
      return {
        smsReceiverType: 3,                 // 3 = 手机号（协议固定）
        smsReceiverNo: String(num),
        smsParams: { content: String(payload.text == null ? '' : payload.text) },
      };
    });
    const reqBody = {
      templateCode: pcfg.templateCode || 'appletSms',
      senderJobNumber: pcfg.senderJobNumber || 'ZZJ0001',
      orgId: String(pcfg.orgId),
      msgContentList: msgContentList,
    };
    const data = Buffer.from(JSON.stringify(reqBody), 'utf8');
    const resp = await httpRequest({
      host: pcfg.gatewayHost,
      port: pcfg.gatewayPort || 80,
      path: pcfg.pushPath || '/kapi/gw-api/hbos-business-thirdparty-integration/standard/base/notify/sms',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': data.length,
        'App-Key': pcfg.appKey,
        'Accept': 'application/json',
      },
      timeout: pcfg.httpTimeoutMs || 8000,
    }, data);
    // 解析响应并翻译成 sendOne 期望的 {reply} 形态
    const parsed = parseJsonSafe(resp.body);
    const httpOk = resp.statusCode >= 200 && resp.statusCode < 300;
    let synthetic;
    if (httpOk && parsed && parsed.success === true) {
      const items = Array.isArray(parsed.data) ? parsed.data : [];
      const failed = items.filter(function (it) { return it && it.sendSuccess === false; });
      if (failed.length === 0) {
        synthetic = { reply: 'OK', raw: parsed };
      } else {
        const detail = failed.map(function (it) {
          return (it.smsReceiverNo || '?') + ' ' + (it.resultMessage || '发送失败');
        }).join('; ');
        synthetic = { reply: 'FAIL: ' + detail, raw: parsed };
      }
    } else if (parsed) {
      synthetic = { reply: 'FAIL: ' + (parsed.message || ('code=' + parsed.code)), raw: parsed };
    } else {
      // 非 JSON 响应原样透传，让 sendOne 报 HTTP 层错误
      return resp;
    }
    return {
      statusCode: resp.statusCode,
      headers: resp.headers,
      body: Buffer.from(JSON.stringify(synthetic), 'utf8'),
    };
  };

  // 通用入口：把当前激活品牌的 driver call 出去；新品牌只需补 DRIVERS.xxx.callXxx 即可
  function activeDriver() {
    return DRIVERS[cfgRoot.brand] || DRIVERS.xinchuang;
  }
  async function callPush(payload) {
    const drv = activeDriver();
    if (typeof drv.callPush !== 'function') throw new Error(drv.name + ' 暂未实现 callPush');
    return drv.callPush(cfg, payload);
  }
  async function callResults(ids) {
    const drv = activeDriver();
    if (typeof drv.callResults !== 'function') throw new Error(drv.name + ' 暂未实现 callResults');
    return drv.callResults(cfg, ids);
  }
  async function callSimStatus() {
    const drv = activeDriver();
    if (!drv.capabilities || !drv.capabilities.sim) throw new Error(drv.name + ' 不支持 SIM 卡查询');
    if (typeof drv.callSimStatus !== 'function') throw new Error(drv.name + ' 暂未实现 callSimStatus');
    return drv.callSimStatus(cfg);
  }

  function parseJsonSafe(buf) {
    try { return JSON.parse(buf.toString('utf8')); } catch (_e) { return null; }
  }

  // 推送一条消息：{to[]?, recipientIds[]?, persons[]?, text, type, encoding} → 写入 history，返回 entry
  // 号码来源优先级：to（直接传入手机号） > recipientIds（按 person.id 查库） > persons（自动推送已解析好的列表）
  // input.persons 用于自动推送：listener 已经按 NotifyModeID → alarmnotifymode → person 解析过，
  //   直接把 [{id,name,phone,groupId}] 传进来，sendOne 取里面的 phone 当 to，并把整份 persons 写进 history。
  async function sendOne(input, source) {
    let to = sanitizeRecipients(input.to);
    let resolvedPersons = Array.isArray(input.persons) ? input.persons.slice() : [];
    if (!to.length) {
      if (input.recipientIds && input.recipientIds.length) {
        resolvedPersons = await resolveRecipientsByIds(input.recipientIds);
        to = resolvedPersons.map(function (p) { return p.phone; });
      } else if (resolvedPersons.length) {
        to = resolvedPersons
          .map(function (p) { return String(p && p.phone || '').trim(); })
          .filter(function (s) { return s.length > 0; });
        to = sanitizeRecipients(to);
      }
    }
    if (!to.length) throw new Error('收件人为空');
    const text = String(input.text == null ? '' : input.text).trim();
    if (!text) throw new Error('内容为空');
    const type = ['SMS', 'Call', 'All'].indexOf(input.type) >= 0 ? input.type : cfg.type;
    const encoding = ['UTF-8', 'ANSI'].indexOf(input.encoding) >= 0 ? input.encoding : cfg.encoding;
    // 协议要求：id 数组长度 == to 数组长度（每个号一个独立 id），否则网关报
    // "The number of phone numbers is not equal to the number of IDs."
    const ids = to.map(function () { return genId(); });
    const id = String(input.id || ids[0]);
    if (input.id) ids[0] = id;            // 调用方指定了 id 时让首个 id 与 entry.id 对齐
    const stime = isoZ();
    const payload = { stime: stime, id: ids, type: type, to: to, text: text, encoding: encoding };
    const entry = {
      id: id, ids: ids, stime: stime, type: type, to: to, text: text, encoding: encoding,
      status: '发送中', ackTime: '', error: '',
      source: source || 'manual',
      gateway: cfg.gatewayHost + ':' + cfg.gatewayPort,
      persons: resolvedPersons,
    };
    pushHistory(entry);
    try {
      const resp = await callPush(payload);
      const bodyText = resp.body.toString('utf8').trim();
      // 解析网关 reply：HTTP 200 不代表业务成功，还要看 body.reply 是不是 "OK"
      let replyText = '';
      try {
        const parsed = JSON.parse(bodyText);
        if (parsed && typeof parsed === 'object' && 'reply' in parsed) {
          replyText = String(parsed.reply || '').trim();
        }
      } catch (_e) { /* 非 JSON 时按 raw 处理 */ }
      const httpOk = resp.statusCode >= 200 && resp.statusCode < 300;
      const replyOk = httpOk && (replyText === 'OK' || replyText.toLowerCase() === 'ok' || (!replyText && bodyText.toLowerCase() === 'ok'));
      if (replyOk) {
        entry.status = '已下发';
        totalSent += 1;
        appendLog(`下发成功 id=${id} to=${to.join(',')} type=${type} resp=${bodyText.slice(0, 100)}`);
      } else if (httpOk) {
        // HTTP 200 但 reply 不是 OK：业务级失败（短信猫未初始化 / 号码与 id 不匹配 等）
        entry.status = '网关拒绝';
        entry.error = '网关 reply: ' + (replyText || bodyText.slice(0, 200));
        totalFailed += 1;
        appendLog(`网关拒绝 id=${id} to=${to.join(',')} reply=${replyText || bodyText.slice(0, 100)}`);
      } else {
        entry.status = '下发失败';
        entry.error = 'HTTP ' + resp.statusCode + ' ' + bodyText.slice(0, 200);
        totalFailed += 1;
        appendLog(`下发失败 id=${id} ${entry.error}`);
      }
    } catch (err) {
      entry.status = '下发失败';
      entry.error = err.message;
      totalFailed += 1;
      appendLog(`下发异常 id=${id} ${err.message}`);
      throw err;
    }
    return entry;
  }

  // 批量查询：取 history 里 status 为"发送中"或"已下发"且未拿到 ackTime 的最近 N 条
  async function refreshResults(ids) {
    let target = Array.isArray(ids) ? ids.slice(0) : null;
    if (!target) {
      target = history
        .filter(function (e) { return !e.ackTime && e.status !== '下发失败'; })
        .slice(-50)
        .map(function (e) { return e.id; });
    }
    if (!target.length) return { updated: 0, list: [] };
    const resp = await callResults(target);
    const list = parseJsonSafe(resp.body) || [];
    let updated = 0;
    for (const item of list) {
      if (!item || !item.id) continue;
      const e = findHistoryById(item.id);
      if (!e) continue;
      let changed = false;
      if (item.status && item.status !== e.status) { e.status = item.status; changed = true; }
      if (item.ackTime && item.ackTime !== e.ackTime) { e.ackTime = item.ackTime; changed = true; }
      if (item.stime && item.stime !== e.stime) { e.stime = item.stime; }
      if (changed) updated += 1;
    }
    return { updated: updated, list: list, queried: target };
  }

  function scheduleResultsTimer() {
    if (resultsTimer) { clearInterval(resultsTimer); resultsTimer = null; }
    if (!cfg.enabled) return;
    // 没有结果回执能力的品牌不开启轮询
    const drv = activeDriver();
    if (!drv.capabilities || !drv.capabilities.results) return;
    const ms = Math.max(5000, cfg.autoQueryResultIntervalSec * 1000);
    resultsTimer = setInterval(function () {
      refreshResults().catch(function (err) { lastError = err.message; });
    }, ms);
  }

  function publicState() {
    const drv = activeDriver();
    const state = {
      // 当前激活品牌
      brand: cfgRoot.brand,
      brandName: drv.name,
      capabilities: Object.assign({}, drv.capabilities),
      brands: listBrands(),    // [{key, name, capabilities}]
      // 当前激活品牌的所有参数
      enabled: cfg.enabled,
      autoPushOnAlarm: !!cfg.autoPushOnAlarm,
      autoPushOnCancel: !!cfg.autoPushOnCancel,
      gatewayHost: cfg.gatewayHost,
      gatewayPort: cfg.gatewayPort,
      pushPath: cfg.pushPath,
      resultsPath: cfg.resultsPath,
      simStatusPath: cfg.simStatusPath,
      type: cfg.type,
      encoding: cfg.encoding,
      httpTimeoutMs: cfg.httpTimeoutMs,
      autoQueryResultIntervalSec: cfg.autoQueryResultIntervalSec,
      // 全局
      historyCount: history.length,
      totalSent: totalSent,
      totalFailed: totalFailed,
      lastError: lastError,
      dbConnected: !!getDbPool(),
      recipientResolver: 'NotifyModeID -> dcim-alarmnotifymode -> dcim-person',
    };
    // HBOS 专有字段（App-Key 只回显掩码，实际值前端可继续保存不覆盖）
    if (cfgRoot.brand === 'hbos') {
      state.appKey = cfg.appKey || '';
      state.templateCode = cfg.templateCode || '';
      state.senderJobNumber = cfg.senderJobNumber || '';
      state.orgId = cfg.orgId || '';
    }
    return state;
  }

  // 订阅 monitor 模块的新告警事件，开关打开时按 NotifyModeID 自动解析收件人后推送
  // NotifyModeID > 0 走原路径；NotifyModeID = 0 时按 (AlarmType, DevId) 兜底反查 alarmnotifymode 首条
  if (typeof global.__smsMonitorAddAlarmListener === 'function') {
    global.__smsMonitorAddAlarmListener(function (row) {
      if (!cfg.enabled || !cfg.autoPushOnAlarm) return;
      const alarmId = row && row.id;
      const modeId = Number(row && row.NotifyModeID);
      const alarmType = row && row.AlarmType;
      const devId = row && row.DevId;
      (async function () {
        try {
          let resolved;
          if (Number.isFinite(modeId) && modeId > 0) {
            resolved = await resolveByNotifyMode(modeId);
            if (!resolved) {
              appendLog(`告警 #${alarmId} 跳过：alarmnotifymode 无 id=${modeId}`);
              return;
            }
          } else {
            // NotifyModeID=0 兜底：按 AlarmType + DevId 反查
            if (alarmType == null || devId == null) {
              appendLog(`告警 #${alarmId} 跳过：NotifyModeID=0 且 AlarmType/DevId 缺失`);
              return;
            }
            resolved = await resolveByAlarmTypeDev(alarmType, devId);
            if (!resolved) {
              appendLog(`告警 #${alarmId} 跳过：NotifyModeID=0，alarmnotifymode 无 AlarmType=${alarmType}+DevId=${devId} 匹配`);
              return;
            }
            appendLog(`告警 #${alarmId} 走兜底分支：NotifyModeID=0 → AlarmType=${alarmType}+DevId=${devId} → mode #${resolved.mode.id}`);
          }
          const phoneNotify = resolved.phoneNotify;
          const smsNotify = resolved.smsNotify;
          if (!phoneNotify && !smsNotify) {
            appendLog(`告警 #${alarmId} 跳过：mode=${resolved.mode.id} PhoneNotify=0 SMSNotify=0`);
            return;
          }
          if (!resolved.persons.length) {
            appendLog(`告警 #${alarmId} 跳过：mode=${resolved.mode.id} UserID=${resolved.mode.userId || '空'} 未匹配到任何 person`);
            return;
          }
          const text = (row && row.TextMessage && String(row.TextMessage).trim())
            || ('告警 #' + (alarmId != null ? alarmId : '-'));
          // 协议 type：电话+短信都开 → All；只开电话 → Call；只开短信 → SMS
          let type;
          if (phoneNotify && smsNotify) type = 'All';
          else if (phoneNotify) type = 'Call';
          else type = 'SMS';
          await sendOne({
            persons: resolved.persons,
            text: text,
            type: type,
            encoding: cfg.encoding,
          }, 'auto');
        } catch (err) {
          lastError = err.message;
          appendLog(`告警 #${alarmId} 自动推送失败：${err.message}`);
        }
      })();
    });
  }

  // 订阅 monitor 模块的告警解除事件，开关打开时按 NotifyModeID 自动推送"解除"消息
  // NotifyModeID > 0 走原路径；NotifyModeID = 0 时按 (AlarmType, DevId) 兜底反查 alarmnotifymode 首条
  if (typeof global.__smsMonitorAddCancelListener === 'function') {
    global.__smsMonitorAddCancelListener(function (row) {
      if (!cfg.enabled || !cfg.autoPushOnCancel) return;
      const alarmId = row && row.id;
      const modeId = Number(row && row.NotifyModeID);
      const alarmType = row && row.AlarmType;
      const devId = row && row.DevId;
      (async function () {
        try {
          let resolved;
          if (Number.isFinite(modeId) && modeId > 0) {
            resolved = await resolveByNotifyMode(modeId);
            if (!resolved) {
              appendLog(`解除 #${alarmId} 跳过：alarmnotifymode 无 id=${modeId}`);
              return;
            }
          } else {
            // NotifyModeID=0 兜底：按 AlarmType + DevId 反查
            if (alarmType == null || devId == null) {
              appendLog(`解除 #${alarmId} 跳过：NotifyModeID=0 且 AlarmType/DevId 缺失`);
              return;
            }
            resolved = await resolveByAlarmTypeDev(alarmType, devId);
            if (!resolved) {
              appendLog(`解除 #${alarmId} 跳过：NotifyModeID=0，alarmnotifymode 无 AlarmType=${alarmType}+DevId=${devId} 匹配`);
              return;
            }
            appendLog(`解除 #${alarmId} 走兜底分支：NotifyModeID=0 → AlarmType=${alarmType}+DevId=${devId} → mode #${resolved.mode.id}`);
          }
          const phoneNotify = resolved.phoneNotify;
          const smsNotify = resolved.smsNotify;
          if (!phoneNotify && !smsNotify) {
            appendLog(`解除 #${alarmId} 跳过：mode=${resolved.mode.id} PhoneNotify=0 SMSNotify=0`);
            return;
          }
          if (!resolved.persons.length) {
            appendLog(`解除 #${alarmId} 跳过：mode=${resolved.mode.id} UserID=${resolved.mode.userId || '空'} 未匹配到任何 person`);
            return;
          }
          const baseText = (row && row.TextMessage && String(row.TextMessage).trim())
            || ('告警 #' + (alarmId != null ? alarmId : '-'));
          const cancelTime = row && row.CancelTime
            ? new Date(row.CancelTime).toLocaleString('zh-CN', { hour12: false })
            : '';
          const text = '【告警解除】' + baseText + (cancelTime ? '（解除时间 ' + cancelTime + '）' : '');
          // 协议 type：电话+短信都开 → All；只开电话 → Call；只开短信 → SMS
          let type;
          if (phoneNotify && smsNotify) type = 'All';
          else if (phoneNotify) type = 'Call';
          else type = 'SMS';
          await sendOne({
            persons: resolved.persons,
            text: text,
            type: type,
            encoding: cfg.encoding,
          }, 'auto-cancel');
        } catch (err) {
          lastError = err.message;
          appendLog(`解除 #${alarmId} 自动推送失败：${err.message}`);
        }
      })();
    });
  }

  // ===== HTTP 接口 =====
  app.get('/api/sms/push/config', function (_req, res) {
    res.json(publicState());
  });

  app.put('/api/sms/push/config', function (req, res) {
    const body = req.body || {};
    // 允许 PUT 同时切换品牌：body.brand 指定要修改的品牌 key（默认改激活品牌）
    const targetKey = body.brand && DRIVERS[body.brand] ? body.brand : cfgRoot.brand;
    if (!cfgRoot.brands[targetKey]) cfgRoot.brands[targetKey] = normalizeBrandCfg(targetKey, {});
    const target = cfgRoot.brands[targetKey];
    const dft = (DRIVERS[targetKey].defaults) || defaults;

    if ('enabled' in body) target.enabled = !!body.enabled;
    if ('autoPushOnAlarm' in body) target.autoPushOnAlarm = !!body.autoPushOnAlarm;
    if ('autoPushOnCancel' in body) target.autoPushOnCancel = !!body.autoPushOnCancel;
    if ('gatewayHost' in body) target.gatewayHost = String(body.gatewayHost || '').trim() || target.gatewayHost;
    if ('gatewayPort' in body) target.gatewayPort = clamp(body.gatewayPort, 1, 65535, target.gatewayPort);
    if ('pushPath' in body) target.pushPath = String(body.pushPath || dft.pushPath || DEFAULT_PATHS.push).trim() || (dft.pushPath || DEFAULT_PATHS.push);
    if ('resultsPath' in body) target.resultsPath = String(body.resultsPath || dft.resultsPath || DEFAULT_PATHS.results).trim() || (dft.resultsPath || DEFAULT_PATHS.results);
    if ('simStatusPath' in body) target.simStatusPath = String(body.simStatusPath || dft.simStatusPath || DEFAULT_PATHS.sim).trim() || (dft.simStatusPath || DEFAULT_PATHS.sim);
    if ('type' in body && ['SMS', 'Call', 'All'].indexOf(body.type) >= 0) target.type = body.type;
    if ('encoding' in body && ['UTF-8', 'ANSI'].indexOf(body.encoding) >= 0) target.encoding = body.encoding;
    if ('httpTimeoutMs' in body) target.httpTimeoutMs = clamp(body.httpTimeoutMs, 1000, 60000, target.httpTimeoutMs);
    if ('autoQueryResultIntervalSec' in body) {
      target.autoQueryResultIntervalSec = clamp(body.autoQueryResultIntervalSec, 5, 600, target.autoQueryResultIntervalSec);
    }
    // HBOS 专有字段
    if (targetKey === 'hbos') {
      if ('appKey' in body) target.appKey = String(body.appKey || '').trim();
      if ('templateCode' in body) target.templateCode = String(body.templateCode || 'appletSms').trim() || 'appletSms';
      if ('senderJobNumber' in body) target.senderJobNumber = String(body.senderJobNumber || 'ZZJ0001').trim() || 'ZZJ0001';
      if ('orgId' in body) target.orgId = String(body.orgId || '').trim();
    }
    // 互斥：如果 PUT 把某个品牌 enabled 置 true，把其他品牌全部置 false
    if (target.enabled) enforceSingleEnabled(targetKey);

    writeCfg();
    scheduleResultsTimer();
    appendLog(`配置更新[${targetKey}] enabled=${target.enabled} autoPush=${target.autoPushOnAlarm} autoCancel=${target.autoPushOnCancel} gw=${target.gatewayHost}:${target.gatewayPort}`);
    res.json(publicState());
  });

  // 列出全部支持的品牌（含 capabilities，前端做能力开关）
  app.get('/api/sms/push/brands', function (_req, res) {
    res.json({ ok: true, brand: cfgRoot.brand, brands: listBrands() });
  });

  // 切换激活品牌：参数已并存，不强制关闭其他品牌的 enabled。
  // 互斥仍由 PUT 接口 + readCfg 启动时保证：任何时候真正发送的只可能是 cfgRoot.brand 这一个。
  app.post('/api/sms/push/brand', function (req, res) {
    const body = req.body || {};
    const want = String(body.brand || '');
    if (!DRIVERS[want]) return res.status(400).json({ ok: false, message: '未知品牌：' + want });
    activateBrand(want);
    writeCfg();
    scheduleResultsTimer();
    appendLog(`切换品牌 → ${want}（其他品牌参数保留）`);
    res.json({ ok: true, state: publicState() });
  });

  // 列出 dcim-person（前端"收件人"按钮的只读视图，仅供查看，不再用于推送配置）
  app.get('/api/sms/push/persons', async function (_req, res) {
    try {
      const list = await listPersons();
      res.json({
        ok: true,
        items: list.map(function (r) {
          return { id: r.id, name: r.PersonName, phone: r.PersonPhone, groupId: r.GroupId };
        }),
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // 调试接口：给一个 NotifyModeID，返回 alarmnotifymode 行 + 解析出的 person 列表，
  // 前端"收件人"弹窗里可以输入 modeId 直观验证联表是否正确
  app.get('/api/sms/push/resolve-mode', async function (req, res) {
    const id = Number(req.query && req.query.id);
    try {
      const resolved = await resolveByNotifyMode(id);
      if (!resolved) return res.status(404).json({ ok: false, message: 'alarmnotifymode 无 id=' + id });
      res.json({ ok: true, resolved: resolved });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.post('/api/sms/push/send', async function (req, res) {
    const body = req.body || {};
    try {
      const entry = await sendOne({
        to: body.to,
        recipientIds: body.recipientIds,
        text: body.text,
        type: body.type,
        encoding: body.encoding,
        id: body.id,
      }, 'manual');
      res.json({ ok: true, entry: entry, state: publicState() });
    } catch (err) {
      lastError = err.message;
      res.status(500).json({ ok: false, message: err.message, state: publicState() });
    }
  });

  app.get('/api/sms/push/history', function (req, res) {
    const limit = clamp(req.query.limit, 1, MAX_HISTORY, 100);
    res.json({
      state: publicState(),
      items: history.slice(-limit).reverse(),
    });
  });

  app.post('/api/sms/push/refresh-results', async function (req, res) {
    const body = req.body || {};
    try {
      const r = await refreshResults(Array.isArray(body.ids) ? body.ids : null);
      res.json({ ok: true, updated: r.updated, queried: r.queried, raw: r.list });
    } catch (err) {
      lastError = err.message;
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.get('/api/sms/push/sim-status', async function (_req, res) {
    try {
      const resp = await callSimStatus();
      const json = parseJsonSafe(resp.body);
      res.json({
        ok: resp.statusCode >= 200 && resp.statusCode < 300,
        statusCode: resp.statusCode,
        json: json,
        raw: resp.body.toString('utf8'),
      });
    } catch (err) {
      lastError = err.message;
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.post('/api/sms/push/clear-history', function (_req, res) {
    history = [];
    res.json(publicState());
  });

  readCfg();
  scheduleResultsTimer();
  appendLog(`服务启动：enabled=${cfg.enabled} autoPush=${cfg.autoPushOnAlarm} autoCancel=${cfg.autoPushOnCancel} gw=${cfg.gatewayHost}:${cfg.gatewayPort}`);

  // 暴露给「定时短信」等模块复用：直接走同一条 sendOne 链路（含历史落库 + 网关回执解析）
  global.__smsPushSendOne = sendOne;
  global.__smsPushIsEnabled = function () { return !!cfg.enabled; };
})();

// ===== 信创短信猫 - 定时短信（整点短信）=====
// 数据源：dcim 库 dcim-alarmparam 表（单例 id=1）
//   SmsOnhourAlarm    1=开启整点短信 0=关闭
//   SmsContent        1=告警数量 2=详细告警 3=定制内容 4=参数（本期仅实现 3）
//   SmsCustomContent  定制内容文本
//   SmsTargetPhone    收件人手机号（/ , ; 空格 任意分隔均可）
//   SmsTime           小时数列表 "16" 或 "15,16"
//   LastSmsAlarmTime  上次成功发送时间（防重写回此列）
//
// 调度：每 60s 跑一次。
//   命中条件 = SmsOnhourAlarm==1 且 当前小时 ∈ SmsTime 且 LastSmsAlarmTime 距今 > 50 分钟
//   防重写回：sendOne 成功后 UPDATE LastSmsAlarmTime = NOW()
(function setupScheduledSms() {
  const path = require('path');
  const TABLE = 'dcim-alarmparam';
  const LOG_PATH = process.env.SMS_SCHEDULED_LOG
    || path.join(__dirname, 'logs', 'sms-scheduled.log');
  const POLL_MS = 60 * 1000;
  // 防重策略：按"整点小时"比对，而不是按分钟数。
  // 触发条件：当前小时 ∈ SmsTime 且 LastSmsAlarmTime 的整点小时 ≠ 当前小时（或日期不同）
  // 好处：手动触发 / 改系统时间 等扰动 LastSmsAlarmTime 都不会污染下一个整点

  let timer = null;
  let lastError = '';
  let lastTickAt = '';
  let lastSendAt = '';
  let totalSent = 0;
  let totalFailed = 0;
  // 最近调度记录环形缓冲：每条 { at, kind, fired, checks, error, entryId }
  // kind: 'tick' | 'manual'，checks 数组逐项给出预检结果（详见 evaluateGuards）
  const RECENT_LIMIT = 50;
  let recent = [];

  function localStamp(d) {
    d = d || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, `[${localStamp()}] ${line}\n`, 'utf8');
    } catch (_e) {}
  }
  function getDbPool() {
    return typeof global.__smsDbGetPool === 'function' ? global.__smsDbGetPool() : null;
  }
  function parseHours(raw) {
    return String(raw || '')
      .split(/[\s,，;；/]+/)
      .map(function (s) { return Number(String(s).trim()); })
      .filter(function (n) { return Number.isInteger(n) && n >= 0 && n <= 23; });
  }
  function parsePhones(raw) {
    return String(raw || '')
      .split(/[\s,，;；/]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  // 把"是否该发"的判定拆成多项明细，前端能逐项 ✓✗ 展示
  // SmsContent=2（详细告警）时多一项"区间内有新告警"预检
  // 返回 { allOk, checks: [{key, label, ok, detail}] }
  // 注意：可能查库（type=2 时），故为 async
  async function evaluateGuards(row, nowDate) {
    const now = nowDate || new Date();
    const nowH = now.getHours();
    const hourList = parseHours(row.SmsTime);
    const enabled = Number(row.SmsOnhourAlarm) === 1;
    const lastDate = row.LastSmsAlarmTime ? new Date(row.LastSmsAlarmTime) : null;
    let alreadySentThisHour = false;
    let lastHourLabel = '';
    if (lastDate && !isNaN(lastDate.getTime())) {
      lastHourLabel = lastDate.getFullYear() + '-' + String(lastDate.getMonth() + 1).padStart(2, '0')
        + '-' + String(lastDate.getDate()).padStart(2, '0') + ' ' + String(lastDate.getHours()).padStart(2, '0') + '时';
      alreadySentThisHour = lastDate.getFullYear() === now.getFullYear()
        && lastDate.getMonth() === now.getMonth()
        && lastDate.getDate() === now.getDate()
        && lastDate.getHours() === nowH;
    }
    const phones = parsePhones(row.SmsTargetPhone);
    const checks = [
      {
        key: 'enabled',
        label: '总开关 SmsOnhourAlarm=1',
        ok: enabled,
        detail: enabled ? '已开启' : '关闭中（数据库 SmsOnhourAlarm=' + row.SmsOnhourAlarm + '）',
      },
      {
        key: 'phones',
        label: 'SmsTargetPhone 至少 1 个号码',
        ok: phones.length > 0,
        detail: phones.length ? '解析出 ' + phones.length + ' 个：' + phones.join(' / ') : '原值="' + (row.SmsTargetPhone || '') + '"',
      },
      {
        key: 'hour',
        label: '当前小时 ∈ SmsTime',
        ok: hourList.length > 0 && hourList.indexOf(nowH) >= 0,
        detail: hourList.length
          ? '当前 ' + nowH + ' 时，SmsTime=[' + hourList.join(',') + ']'
          : 'SmsTime 解析为空（原值="' + (row.SmsTime || '') + '"）',
      },
      {
        key: 'hourDedup',
        label: '本整点尚未发送过',
        ok: !alreadySentThisHour,
        detail: lastDate
          ? (alreadySentThisHour ? '已在 ' + lastHourLabel + ' 发过' : '上次发送在 ' + lastHourLabel + '，与当前整点不同')
          : '尚未发送过',
      },
    ];

    // SmsContent=2 详细告警：还要看"上次发送以来 dcim-alarmlist 是否有新增"
    // 没有新增就不发，避免发"本时段无告警"这种废话
    if (Number(row.SmsContent) === 2) {
      let hasNew = false;
      let newDetail = '';
      try {
        const result = await fetchNewAlarmsSince(row.LastSmsAlarmTime, 1);
        hasNew = result.total > 0;
        newDetail = hasNew
          ? '区间内新增 ' + result.total + ' 条告警'
          : '区间内无新增告警，将跳过本次发送';
      } catch (err) {
        newDetail = '查询失败：' + err.message;
      }
      checks.push({
        key: 'hasNewAlarms',
        label: '区间内有新增告警（仅 SmsContent=2 需要）',
        ok: hasNew,
        detail: newDetail,
      });
    }

    const allOk = checks.every(function (c) { return c.ok; });
    return { allOk: allOk, checks: checks };
  }

  // 算下次预计触发时间：在所有未来 SmsTime 小时点里找到第一个未在该自然小时发过的整点
  function nextExpected(row) {
    const enabled = Number(row.SmsOnhourAlarm) === 1;
    const hourList = parseHours(row.SmsTime);
    if (!enabled) return { iso: null, label: '-', reason: '总开关关闭' };
    if (!hourList.length) return { iso: null, label: '-', reason: 'SmsTime 解析为空' };
    const lastDate = row.LastSmsAlarmTime ? new Date(row.LastSmsAlarmTime) : null;
    const sortedH = hourList.slice().sort(function (a, b) { return a - b; });
    const now = new Date();
    for (let d = 0; d < 8; d += 1) {
      for (const h of sortedH) {
        const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, h, 0, 0, 0);
        if (candidate.getTime() <= now.getTime()) continue;
        // 同自然小时去重：候选时间点与上次发送处于同一年月日时则跳过（实际不会出现，因为 candidate 是未来）
        if (lastDate
          && lastDate.getFullYear() === candidate.getFullYear()
          && lastDate.getMonth() === candidate.getMonth()
          && lastDate.getDate() === candidate.getDate()
          && lastDate.getHours() === candidate.getHours()) continue;
        return { iso: candidate.toISOString(), label: localStamp(candidate), reason: '' };
      }
    }
    return { iso: null, label: '-', reason: '7 天内无满足条件的时间点' };
  }

  function pushRecent(rec) {
    rec.at = localStamp();
    recent.push(rec);
    if (recent.length > RECENT_LIMIT) recent = recent.slice(-RECENT_LIMIT);
  }

  // 读 dcim-alarmparam 单例（id=1）
  async function readParam() {
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    const [rows] = await pool.query(
      'SELECT id, SmsOnhourAlarm, SmsContent, SmsCustomContent, SmsTargetPhone, SmsTime, SmsParamId, LastSmsAlarmTime '
      + 'FROM `' + TABLE + '` ORDER BY id ASC LIMIT 1'
    );
    if (!rows || !rows.length) throw new Error(TABLE + ' 表为空，无可用配置');
    return rows[0];
  }

  // 统计今日告警条数：返回 { total, unresolved, resolved }
  // 按 dcim-alarmlist.create_time 落在今天的所有 status=1 的行计数；CancelTime IS NULL 视为未解除
  async function countTodayAlarms() {
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    const sql = 'SELECT '
      + 'COUNT(*) AS total, '
      + 'SUM(CASE WHEN CancelTime IS NULL THEN 1 ELSE 0 END) AS unresolved, '
      + 'SUM(CASE WHEN CancelTime IS NOT NULL THEN 1 ELSE 0 END) AS resolved '
      + 'FROM `dcim-alarmlist` '
      + 'WHERE DATE(create_time) = CURDATE() AND status = 1';
    const [rows] = await pool.query(sql);
    const r = (rows && rows[0]) || {};
    return {
      total: Number(r.total) || 0,
      unresolved: Number(r.unresolved) || 0,
      resolved: Number(r.resolved) || 0,
    };
  }

  // SmsContent=2 用：拉"上次发送之后新增"的告警列表
  // 入参：lastSmsAlarmTime（可能是 Date / ISO 字符串 / null）
  // 出参：{ total, items: [{id, level, text, time}] }，items 取最早的 limit 条（按 id ASC）
  // lastSmsAlarmTime 为 null 时退化为今天 00:00 起，避免首次启用时全表扫
  async function fetchNewAlarmsSince(lastSmsAlarmTime, limit) {
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    let cursor;
    if (lastSmsAlarmTime) {
      cursor = new Date(lastSmsAlarmTime);
      if (isNaN(cursor.getTime())) cursor = null;
    }
    if (!cursor) {
      const today = new Date();
      cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
    }
    // 一条 SQL 拿 total + 列表，避免两次往返。先 COUNT，再 SELECT 顶 N 条。
    const [cntRows] = await pool.query(
      'SELECT COUNT(*) AS total FROM `dcim-alarmlist` WHERE create_time > ? AND status = 1',
      [cursor]
    );
    const total = Number(cntRows[0] && cntRows[0].total) || 0;
    if (total === 0) return { total: 0, items: [], cursor: cursor };
    const [rows] = await pool.query(
      'SELECT id, AlarmLevel, TextMessage, create_time '
      + 'FROM `dcim-alarmlist` WHERE create_time > ? AND status = 1 '
      + 'ORDER BY id ASC LIMIT ?',
      [cursor, Number(limit) || 5]
    );
    const items = (rows || []).map(function (r) {
      return {
        id: r.id,
        level: r.AlarmLevel,
        text: String(r.TextMessage == null ? '' : r.TextMessage).trim(),
        time: r.create_time,
      };
    });
    return { total: total, items: items, cursor: cursor };
  }

  // SmsContent=4 用：解析 SmsParamId（JSON 数组 [{id, paramKey}, ...]），
  // 按 dcim-paramcollectvalview 的 (DevId=id, AlarmKey=paramKey) 联合定位行，
  // 从 LastReceiveData（Python dict 字符串："{'温度': '333.3(℃)', '湿度': '0.0(%)'}"）里抠出对应 paramKey 的值。
  // 查不到的项静默跳过；返回 [{ devId, deviceName, paramKey, value }]
  async function fetchParamValues(smsParamIdRaw) {
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    let list;
    try {
      list = JSON.parse(String(smsParamIdRaw || '[]'));
    } catch (_e) {
      list = [];
    }
    if (!Array.isArray(list) || !list.length) return [];

    // 一次性把所有需要的 (DevId, AlarmKey) 行拉回来，避免逐条查
    const devIds = Array.from(new Set(list.map(function (it) { return Number(it && it.id); })
      .filter(function (n) { return Number.isInteger(n) && n > 0; })));
    if (!devIds.length) return [];
    const placeholders = devIds.map(function () { return '?'; }).join(',');
    const [rows] = await pool.query(
      'SELECT DevId, AlarmKey, DeviceName, LastReceiveData '
      + 'FROM `dcim-paramcollectvalview` '
      + 'WHERE DevId IN (' + placeholders + ') AND status = 1',
      devIds
    );
    // 按 (DevId, AlarmKey) 建索引：同一设备下不同 AlarmKey 的行其 LastReceiveData 通常一样，
    // 但严格按行匹配能避免歧义
    const idx = new Map();
    (rows || []).forEach(function (r) {
      const key = String(r.DevId) + '|' + String(r.AlarmKey || '');
      idx.set(key, r);
    });

    // Python dict 风格 → JS：单引号转双引号，再 JSON.parse
    function parsePyDict(raw) {
      if (raw == null) return null;
      const s = String(raw).trim();
      if (!s) return null;
      try { return JSON.parse(s.replace(/'/g, '"')); } catch (_e) { return null; }
    }

    const out = [];
    for (const it of list) {
      const devId = Number(it && it.id);
      const paramKey = String(it && it.paramKey || '').trim();
      if (!Number.isInteger(devId) || devId <= 0 || !paramKey) continue;
      // 先按 (devId, paramKey) 精确找；如果同设备多行但 AlarmKey 不一样，退化为该设备任一行
      let hit = idx.get(devId + '|' + paramKey);
      if (!hit) {
        for (const r of (rows || [])) {
          if (Number(r.DevId) === devId) { hit = r; break; }
        }
      }
      if (!hit) continue;       // 静默跳过：库里没有这个 DevId
      const dict = parsePyDict(hit.LastReceiveData);
      if (!dict || !(paramKey in dict)) continue;   // 静默跳过：dict 里没这个 paramKey
      out.push({
        devId: devId,
        deviceName: String(hit.DeviceName || '').trim() || ('设备#' + devId),
        paramKey: paramKey,
        value: String(dict[paramKey]),
      });
    }
    return out;
  }

  // 按 SmsContent 类型生成短信文本
  // 1 = 告警数量  2 = 详细告警  3 = 定制内容  4 = 参数
  async function buildContent(row) {
    const type = Number(row.SmsContent);
    const pad = function (n) { return String(n).padStart(2, '0'); };
    const now = new Date();
    const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
      + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());

    if (type === 1) {
      const cnt = await countTodayAlarms();
      return '《整点告警通报》截至' + stamp + ','
        + '今日告警' + cnt.total + '条，'
        + '未解除告警' + cnt.unresolved + '条，'
        + '已解除告警' + cnt.resolved + '条。';
    }

    if (type === 2) {
      const result = await fetchNewAlarmsSince(row.LastSmsAlarmTime, 5);
      if (result.total === 0) {
        // 实际上 evaluateGuards 已经在调度路径里把"无新告警"挡掉了，
        // 走到这里只可能是手动触发（skipGuard）或者 preview 接口
        return '《整点告警通报》截至' + stamp + '，本时段无新增告警。';
      }
      // 单条短信：抬头 + 最多 5 条 + 末尾折叠提示
      const head = '《整点告警通报》截至' + stamp + '，本时段新增告警 ' + result.total + ' 条：';
      const lines = result.items.map(function (it, idx) {
        // TextMessage 已含设备/区域/类型/等级/时间/当前值等关键字段，直接用
        const text = it.text || ('告警 #' + it.id);
        return (idx + 1) + '.' + text;
      });
      let body = lines.join('；');
      if (result.total > result.items.length) {
        body += '；…还有 ' + (result.total - result.items.length) + ' 条';
      }
      return head + body + '。';
    }

    if (type === 4) {
      const items = await fetchParamValues(row.SmsParamId);
      if (!items.length) {
        // SmsParamId 为空 / JSON 格式坏 / 全部查不到 → 兜底文案
        return '《整点参数报告》截至' + stamp + '，本时段参数查询为空。';
      }
      // 拼成「设备名-参数名=值」用「; 」分隔
      const body = items.map(function (it) {
        return it.deviceName + '-' + it.paramKey + '=' + it.value;
      }).join('; ');
      return '《整点参数报告》截至' + stamp + '：' + body + '。';
    }

    // 默认（含 type=3 / 未实现的类型）走定制内容
    const text = String(row.SmsCustomContent || '').trim();
    if (!text) {
      throw new Error(type === 3
        ? 'SmsCustomContent 为空（请先在 system-parameter-sms 页面填写定制内容）'
        : 'SmsContent=' + type + ' 暂未实现，且 SmsCustomContent 为空');
    }
    return text;
  }

  // 实际发送：复用 push 模块的 sendOne，写入 history，记 source=scheduled
  async function doSend(row, trigger) {
    const phones = parsePhones(row.SmsTargetPhone);
    if (!phones.length) throw new Error('SmsTargetPhone 为空');
    if (typeof global.__smsPushSendOne !== 'function') {
      throw new Error('短信推送模块未加载');
    }
    if (typeof global.__smsPushIsEnabled === 'function' && !global.__smsPushIsEnabled()) {
      throw new Error('推送总开关已关闭（请先在「推送设置」中开启）');
    }
    const text = await buildContent(row);
    return global.__smsPushSendOne({
      to: phones,
      text: text,
      type: 'SMS',
    }, 'scheduled-' + (trigger || 'tick'));
  }

  // 写回 LastSmsAlarmTime = NOW()
  async function writeBack() {
    const pool = getDbPool();
    if (!pool) return;
    try {
      await pool.query(
        'UPDATE `' + TABLE + '` SET LastSmsAlarmTime = NOW() WHERE id = 1'
      );
    } catch (err) {
      appendLog(`写回 LastSmsAlarmTime 失败：${err.message}`);
    }
  }

  // 一次调度评估：判定条件 + 必要时发送
  // skipGuard=true 表示手动触发，不看 SmsOnhourAlarm/SmsTime/防重，强行发一条
  async function evaluateAndMaybeSend(trigger, skipGuard) {
    lastTickAt = localStamp();
    let row;
    try {
      row = await readParam();
    } catch (err) {
      pushRecent({ kind: trigger, fired: false, error: '读参数失败：' + err.message, checks: [] });
      throw err;
    }
    const guards = await evaluateGuards(row);
    if (!skipGuard && !guards.allOk) {
      const failed = guards.checks.filter(function (c) { return !c.ok; });
      pushRecent({
        kind: trigger,
        fired: false,
        skipped: true,
        reason: failed.map(function (c) { return c.label; }).join(' / '),
        checks: guards.checks,
      });
      return { fired: false, checks: guards.checks };
    }

    let entry;
    try {
      entry = await doSend(row, trigger);
    } catch (err) {
      pushRecent({
        kind: trigger,
        fired: false,
        error: err.message,
        checks: guards.checks,
        skipGuard: !!skipGuard,
      });
      throw err;
    }
    await writeBack();
    totalSent += 1;
    lastSendAt = localStamp();
    pushRecent({
      kind: trigger,
      fired: true,
      skipGuard: !!skipGuard,
      entryId: entry && entry.id,
      to: (entry && entry.to) || [],
      checks: guards.checks,
    });
    appendLog(`${skipGuard ? '手动触发' : '整点触发'} 已下发 id=${entry && entry.id} to=${(entry && entry.to || []).join(',')}`);
    return { fired: true, entry: entry, checks: guards.checks };
  }

  function scheduleTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    timer = setInterval(function () {
      evaluateAndMaybeSend('tick', false).then(function () {
        lastError = '';
      }).catch(function (err) {
        lastError = err.message;
        appendLog(`tick 失败：${err.message}`);
      });
    }, POLL_MS);
  }

  function publicState() {
    return {
      pollMs: POLL_MS,
      dedupStrategy: 'same-hour',
      lastTickAt: lastTickAt,
      lastSendAt: lastSendAt,
      lastError: lastError,
      totalSent: totalSent,
      totalFailed: totalFailed,
    };
  }

  // ===== HTTP 接口 =====
  // GET：返回 dcim-alarmparam 当前快照 + 调度状态 + 4 项预检明细 + 下次预计触发时间
  app.get('/api/sms/scheduled/config', async function (_req, res) {
    try {
      const row = await readParam();
      const guards = await evaluateGuards(row);
      const next = nextExpected(row);
      // 预览文本：如果生成失败（比如 SmsContent=1 时 DB 查询失败），不让整个接口挂掉，
      // 把错误信息塞进 preview 字段让前端能展示
      let preview = '';
      let previewError = '';
      try {
        preview = await buildContent(row);
      } catch (err) {
        previewError = err.message;
      }
      res.json({
        ok: true,
        param: {
          id: row.id,
          SmsOnhourAlarm: row.SmsOnhourAlarm,
          SmsContent: row.SmsContent,
          SmsCustomContent: row.SmsCustomContent || '',
          SmsTargetPhone: row.SmsTargetPhone || '',
          SmsTime: row.SmsTime || '',
          LastSmsAlarmTime: row.LastSmsAlarmTime,
          parsedHours: parseHours(row.SmsTime),
          parsedPhones: parsePhones(row.SmsTargetPhone),
        },
        guards: guards,
        next: next,
        preview: preview,
        previewError: previewError,
        state: publicState(),
        currentHour: new Date().getHours(),
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // GET：最近 N 条调度记录（默认全量返回，按时间倒序）
  app.get('/api/sms/scheduled/recent', function (_req, res) {
    res.json({ ok: true, items: recent.slice().reverse() });
  });

  // POST：手动触发一次（不看开关、不看小时、不看防重间隔）
  app.post('/api/sms/scheduled/trigger', async function (_req, res) {
    try {
      const r = await evaluateAndMaybeSend('manual', true);
      res.json({ ok: true, fired: r.fired, entry: r.entry, state: publicState() });
    } catch (err) {
      totalFailed += 1;
      lastError = err.message;
      appendLog(`手动触发失败：${err.message}`);
      res.status(500).json({ ok: false, message: err.message, state: publicState() });
    }
  });

  scheduleTimer();
  appendLog(`定时短信调度启动：每 ${POLL_MS / 1000}s 评估一次，按整点小时去重`);
})();

// ===== 协议转换：8082 接口可视化调用 =====
// 浏览器 → /api/proto-conv/* → Node https → 8082（自签名 OK，cookieJar 维持会话，401 自动续登）
(function setupProtoConv() {
  const path = require('path');
  const https = require('https');
  const httpMod = require('http');
  let mysql2;
  try { mysql2 = require('mysql2/promise'); } catch (_e) { mysql2 = null; }

  const CONFIG_PATH = process.env.PROTOCONV_CONFIG || path.join(__dirname, 'config', 'proto-conv.json');
  const LOG_PATH = process.env.PROTOCONV_LOG || path.join(__dirname, 'logs', 'proto-conv.log');

  const defaults = {
    baseUrl: 'https://192.168.0.50:8082',
    userName: 'admin',
    passWord: 'admin',
    userLsh: '1',
    timeoutMs: 8000,
    pathMap: {},
    // 可选：dcim 数据库直查区域名（兜底，因 GetNewAllAreasKey 接口在某些 dcim 版本返回不全）
    dcimDb: {
      host: '', port: 3333, user: '', password: '', database: 'dcim',
    },
  };

  function deepMerge(target, src) {
    const out = Object.assign({}, target);
    for (const k of Object.keys(src || {})) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
        out[k] = deepMerge(target[k] || {}, src[k]);
      } else {
        out[k] = src[k];
      }
    }
    return out;
  }

  let cfg = JSON.parse(JSON.stringify(defaults));
  function readCfg() {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = deepMerge(defaults, raw);
    } catch (_e) {
      cfg = JSON.parse(JSON.stringify(defaults));
    }
  }
  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_e) {}
    } catch (err) {
      console.error('[proto-conv] 写配置失败:', err.message);
    }
  }
  function redactCfg() {
    const db = cfg.dcimDb || {};
    return {
      baseUrl: cfg.baseUrl,
      userName: cfg.userName,
      passWord: '***',
      hasPassword: !!(cfg.passWord && cfg.passWord !== ''),
      userLsh: cfg.userLsh,
      timeoutMs: cfg.timeoutMs,
      pathMap: cfg.pathMap || {},
      dcimDb: {
        host: db.host || '',
        port: db.port || 3333,
        user: db.user || '',
        password: '***',
        hasPassword: !!(db.password && db.password !== ''),
        database: db.database || 'dcim',
      },
    };
  }
  readCfg();

  function localStamp() {
    const d = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, '[' + localStamp() + '] ' + line + '\n', 'utf8');
    } catch (_e) {}
  }

  // cookie jar：baseUrl -> "k=v; k2=v2"
  const cookieJar = new Map();
  const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
  const httpAgent = new httpMod.Agent({ keepAlive: true });

  function pickAgent(urlObj) {
    return urlObj.protocol === 'https:' ? httpsAgent : httpAgent;
  }
  function pickModule(urlObj) {
    return urlObj.protocol === 'https:' ? https : httpMod;
  }

  function mergeSetCookie(baseUrl, setCookieArr) {
    if (!Array.isArray(setCookieArr) || !setCookieArr.length) return;
    const cur = cookieJar.get(baseUrl) || '';
    const dict = {};
    cur.split(';').forEach(function (s) {
      const t = s.trim();
      if (!t) return;
      const i = t.indexOf('=');
      if (i > 0) dict[t.slice(0, i)] = t.slice(i + 1);
    });
    setCookieArr.forEach(function (s) {
      const head = String(s || '').split(';')[0].trim();
      const i = head.indexOf('=');
      if (i > 0) dict[head.slice(0, i)] = head.slice(i + 1);
    });
    const merged = Object.keys(dict).map(function (k) { return k + '=' + dict[k]; }).join('; ');
    cookieJar.set(baseUrl, merged);
  }

  function callUpstream(opts) {
    // opts: { key, method, body, query, pathOverride, retried }
    return new Promise(function (resolve) {
      let urlObj;
      try {
        const explicitPath = opts.pathOverride || (cfg.pathMap && cfg.pathMap[opts.key]) || ('/' + opts.key);
        urlObj = new URL(explicitPath, cfg.baseUrl);
      } catch (e) {
        return resolve({ ok: false, status: 0, message: 'URL 构造失败：' + e.message });
      }
      if (opts.method === 'GET' && opts.query && typeof opts.query === 'object') {
        Object.keys(opts.query).forEach(function (k) {
          if (opts.query[k] != null && opts.query[k] !== '') {
            urlObj.searchParams.set(k, String(opts.query[k]));
          }
        });
      }

      const buf = (opts.method === 'GET' || opts.body == null)
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(opts.body || {}), 'utf8');

      const headers = { 'cookie': cookieJar.get(cfg.baseUrl) || '' };
      if (opts.method !== 'GET') {
        headers['content-type'] = 'application/json;charset=utf-8';
        headers['content-length'] = buf.length;
      }

      const reqOptions = {
        method: opts.method,
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + (urlObj.search || ''),
        agent: pickAgent(urlObj),
        timeout: cfg.timeoutMs || 8000,
        headers: headers,
      };

      const req = pickModule(urlObj).request(reqOptions, function (res) {
        const sc = res.headers['set-cookie'];
        if (sc) mergeSetCookie(cfg.baseUrl, sc);
        const chunks = [];
        res.on('data', function (d) { chunks.push(d); });
        res.on('end', async function () {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(text); } catch (_e) { data = text; }
          // 401 自动续登一次（LoginKey 自身不重试）
          if (res.statusCode === 401 && !opts.retried && opts.key !== 'LoginKey') {
            appendLog('401 重试，先调 LoginKey 续登 key=' + opts.key);
            await loginUpstream();
            return resolve(await callUpstream(Object.assign({}, opts, { retried: true })));
          }
          appendLog(opts.method + ' ' + opts.key + ' status=' + res.statusCode +
            ' bodyLen=' + (text ? text.length : 0));
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, data: data });
        });
      });
      req.on('timeout', function () {
        try { req.destroy(new Error('timeout ' + (cfg.timeoutMs || 8000) + 'ms')); } catch (_e) {}
      });
      req.on('error', function (err) {
        appendLog('请求异常 key=' + opts.key + ' err=' + err.message);
        resolve({ ok: false, status: 0, message: err.message });
      });
      if (buf.length) req.write(buf);
      req.end();
    });
  }

  async function loginUpstream() {
    const body = {
      userName: Buffer.from(cfg.userName || '', 'utf8').toString('base64'),
      passWord: Buffer.from(cfg.passWord || '', 'utf8').toString('base64'),
    };
    const r = await callUpstream({ key: 'LoginKey', method: 'POST', body: body, retried: true });
    appendLog('[login] ok=' + r.ok + ' status=' + r.status);
    return r;
  }

  // ===== 路由 =====
  app.get('/api/proto-conv/config', function (_req, res) {
    res.json({ ok: true, config: redactCfg() });
  });

  app.put('/api/proto-conv/config', function (req, res) {
    const b = req.body || {};
    const next = JSON.parse(JSON.stringify(cfg));
    if (typeof b.baseUrl === 'string')  next.baseUrl  = b.baseUrl.trim();
    if (typeof b.userName === 'string') next.userName = b.userName.trim();
    if (typeof b.userLsh === 'string')  next.userLsh  = b.userLsh.trim();
    if (b.timeoutMs != null) next.timeoutMs = Math.max(1000, Math.min(120000, Number(b.timeoutMs) || 8000));
    if (b.pathMap && typeof b.pathMap === 'object' && !Array.isArray(b.pathMap)) {
      next.pathMap = b.pathMap;
    }
    if (typeof b.passWord === 'string' && b.passWord !== '' && b.passWord !== '***') {
      next.passWord = b.passWord;
    }
    // dcimDb 可选配置
    if (b.dcimDb && typeof b.dcimDb === 'object') {
      next.dcimDb = next.dcimDb || {};
      if (typeof b.dcimDb.host === 'string')     next.dcimDb.host = b.dcimDb.host.trim();
      if (b.dcimDb.port != null)                 next.dcimDb.port = Math.max(1, Math.min(65535, Number(b.dcimDb.port) || 3333));
      if (typeof b.dcimDb.user === 'string')     next.dcimDb.user = b.dcimDb.user.trim();
      if (typeof b.dcimDb.database === 'string') next.dcimDb.database = b.dcimDb.database.trim() || 'dcim';
      if (typeof b.dcimDb.password === 'string' && b.dcimDb.password !== '' && b.dcimDb.password !== '***') {
        next.dcimDb.password = b.dcimDb.password;
      }
    }
    if (!next.baseUrl) return res.status(400).json({ ok: false, message: 'baseUrl 必填' });
    if (!next.userName) return res.status(400).json({ ok: false, message: 'userName 必填' });
    try { new URL(next.baseUrl); }
    catch (e) { return res.status(400).json({ ok: false, message: 'baseUrl 非法：' + e.message }); }

    cfg = next;
    writeCfg();
    cookieJar.delete(cfg.baseUrl); // 配置变更，旧 cookie 作废
    appendLog('配置已更新 baseUrl=' + cfg.baseUrl + ' user=' + cfg.userName);
    res.json({ ok: true, config: redactCfg() });
  });

  app.post('/api/proto-conv/login', async function (_req, res) {
    try {
      const r = await loginUpstream();
      // dcim 后端登录成功通常返回 true / { ok:true } / { UserLsh:... } 等几种
      let userLsh = null;
      if (r.data && typeof r.data === 'object') {
        userLsh = r.data.UserLsh || r.data.userLsh || r.data.userlsh || null;
        if (userLsh != null) {
          cfg.userLsh = String(userLsh);
          writeCfg();
        }
      }
      res.json({ ok: r.ok, status: r.status, data: r.data, message: r.message || '', userLsh: userLsh });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.post('/api/proto-conv/test-connection', async function (_req, res) {
    let urlObj;
    try { urlObj = new URL(cfg.baseUrl); }
    catch (e) { return res.json({ ok: false, message: 'baseUrl 非法：' + e.message }); }

    const port = Number(urlObj.port) || (urlObj.protocol === 'https:' ? 443 : 80);
    const sock = net.createConnection({ host: urlObj.hostname, port: port });
    let done = false;
    const finish = function (ok, message) {
      if (done) return; done = true;
      try { sock.destroy(); } catch (_e) {}
      res.json({ ok: ok, message: message });
    };
    sock.setTimeout(5000);
    sock.on('connect', function () { finish(true, urlObj.hostname + ':' + port + ' TCP 连通'); });
    sock.on('timeout', function () { finish(false, urlObj.hostname + ':' + port + ' 连接超时'); });
    sock.on('error', function (err) { finish(false, urlObj.hostname + ':' + port + ' ' + err.message); });
  });

  // 直连 dcim 数据库读 dcim-area 表，作为 Zonesubno → Zonesubname 的兜底（GetNewAllAreasKey 接口在某些 dcim 版本返回不全）
  app.get('/api/proto-conv/area-map', async function (_req, res) {
    const db = cfg.dcimDb || {};
    if (!db.host || !db.user || !db.password) {
      return res.json({ ok: true, source: 'none', map: {}, message: 'dcim 数据库未配置' });
    }
    if (!mysql2) {
      return res.json({ ok: false, source: 'none', map: {}, message: 'mysql2 模块未安装' });
    }
    let conn;
    try {
      conn = await mysql2.createConnection({
        host: db.host, port: Number(db.port) || 3333,
        user: db.user, password: db.password,
        database: db.database || 'dcim',
        connectTimeout: 5000,
      });
      const [rows] = await conn.query('SELECT id, AreaName FROM `dcim-area` WHERE status=1 ORDER BY id');
      const map = {};
      rows.forEach(function (r) { map[String(r.id)] = String(r.AreaName == null ? '' : r.AreaName); });
      appendLog('area-map: 从 dcim-area 表读到 ' + rows.length + ' 个区域');
      res.json({ ok: true, source: 'db', map: map, count: rows.length });
    } catch (e) {
      appendLog('area-map: dcim 数据库查询失败 ' + e.message);
      res.json({ ok: false, source: 'db', map: {}, message: e.message });
    } finally {
      try { if (conn) await conn.end(); } catch (_e) {}
    }
  });

  app.post('/api/proto-conv/invoke', async function (req, res) {
    const b = req.body || {};
    const key = String(b.key || '').trim();
    if (!key) return res.status(400).json({ ok: false, message: 'key 必填' });
    const method = (String(b.method || 'POST').toUpperCase() === 'GET') ? 'GET' : 'POST';
    let body = b.body;
    if (body && typeof body === 'object' && cfg.userLsh) {
      // UserLsh 字段为空时，自动用全局 userLsh 兜底
      if (Object.prototype.hasOwnProperty.call(body, 'UserLsh') &&
          (body.UserLsh === '' || body.UserLsh == null)) {
        body.UserLsh = cfg.userLsh;
      }
    }
    let query = b.query;
    if (query && typeof query === 'object' && cfg.userLsh) {
      if (Object.prototype.hasOwnProperty.call(query, 'UserLsh') &&
          (query.UserLsh === '' || query.UserLsh == null)) {
        query.UserLsh = cfg.userLsh;
      }
    }
    try {
      const r = await callUpstream({
        key: key,
        method: method,
        body: body,
        query: query,
        pathOverride: b.pathOverride || null,
      });
      res.json(r);
    } catch (err) {
      res.status(500).json({ ok: false, status: 0, message: err.message });
    }
  });

  appendLog('协议转换模块就绪 baseUrl=' + cfg.baseUrl + ' user=' + cfg.userName);

  // 暴露给同进程内其他子模块（如 setupModbusBridge）共享 dcim 会话
  global.__protoConv = {
    callUpstream: callUpstream,
    loginUpstream: loginUpstream,
    getCfg: function () { return cfg; },
    appendLog: appendLog,
  };
})();

// ===== 协议转换 → Modbus TCP 转发 =====
// 把 GetDeviceByGroupKey 的设备实时数据（DeviceStatus + 每参数 CurValue + Status）
// 转换成 Modbus TCP holding registers，对外提供给第三方 SCADA / Modbus master。
// 紧凑布局：每设备 1 + 3N 寄存器（DeviceStatus INT16 + 每参数 CurValue FLOAT32BE + Status INT16）
(function setupModbusBridge() {
  const path = require('path');
  let Modbus;
  try { Modbus = require('jsmodbus'); }
  catch (_e) { console.error('[modbus] jsmodbus 未安装，Modbus 转发功能不可用'); return; }

  const CONFIG_PATH = process.env.MODBUS_CONFIG || path.join(__dirname, 'config', 'proto-conv-modbus.json');
  const LOG_PATH = process.env.MODBUS_LOG || path.join(__dirname, 'logs', 'proto-conv-modbus.log');

  const defaults = {
    enabled: false,
    port: 5020,
    pollIntervalSec: 5,
    selectedDevices: [],
  };

  let cfg = JSON.parse(JSON.stringify(defaults));
  function readCfg() {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = Object.assign({}, defaults, raw);
      if (!Array.isArray(cfg.selectedDevices)) cfg.selectedDevices = [];
    } catch (_e) {
      cfg = JSON.parse(JSON.stringify(defaults));
    }
  }
  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_e) {}
    } catch (err) { console.error('[modbus] 写配置失败:', err.message); }
  }
  readCfg();

  function localStamp() {
    const d = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, '[' + localStamp() + '] ' + line + '\n', 'utf8');
    } catch (_e) {}
  }

  // 运行时
  let netServer = null;
  let mbServer = null;
  let holding = null;
  let mappingTable = []; // [{deviceId, deviceName, kind, paraName, addr, len, type, unit}]
  let pollTimer = null;
  let polling = false;
  const status = {
    running: false,
    port: 0,
    deviceCount: 0,
    regCount: 0,
    dataRegCount: 0,
    controlBaseAddr: 0,
    controlRegCount: 0,
    lastPollAt: '',
    lastError: '',
    missingDevices: [],
  };

  // ----- 寄存器映射构建 -----
  // 数据段（来自 selectedDevices）从 Reg[0] 起紧凑排列
  // 控制段（来自 global.__modbusControl 注册的命令）固定从 Reg[60000] 起，与数据段地址解耦
  const CONTROL_BASE_ADDR = 60000;
  function buildMapping() {
    mappingTable = [];
    let addr = 0;
    (cfg.selectedDevices || []).forEach(function (dev) {
      const params = Array.isArray(dev.params) ? dev.params : [];
      mappingTable.push({
        segment: 'data',
        deviceId: dev.deviceId, deviceName: dev.deviceName,
        kind: 'DeviceStatus', paraName: '', addr: addr, len: 1, type: 'INT16', unit: '',
      });
      addr += 1;
      params.forEach(function (p) {
        mappingTable.push({
          segment: 'data',
          deviceId: dev.deviceId, deviceName: dev.deviceName,
          kind: 'CurValue', paraName: p.paraName || '', addr: addr, len: 2, type: 'FLOAT32 BE', unit: p.unit || '',
        });
        addr += 2;
      });
    });
    const dataRegEnd = addr; // 数据段结束位置

    // 控制段：固定起始地址 60000
    const ctrlList = (global.__modbusControl && global.__modbusControl.getCommands())
      ? global.__modbusControl.getCommands() : [];
    ctrlList.forEach(function (c, idx) {
      mappingTable.push({
        segment: 'control',
        deviceId: c.deviceId, deviceName: c.deviceName,
        kind: 'ControlTrigger', paraName: c.commandName || '',
        addr: CONTROL_BASE_ADDR + idx, len: 1, type: 'INT16',
        unit: '',
        controlId: c.controlId, controlIndex: idx,
      });
    });

    status.dataRegCount = dataRegEnd;
    status.controlBaseAddr = CONTROL_BASE_ADDR;
    status.controlRegCount = ctrlList.length;
    // 总 buffer 大小：覆盖到 max(数据段末尾, 控制段末尾)
    return Math.max(dataRegEnd, CONTROL_BASE_ADDR + ctrlList.length);
  }

  function regsForDevice(dev) {
    const n = (dev.params || []).length;
    return 1 + 2 * n;
  }

  function writeInt16(buf, regAddr, val) {
    const v = (Number.isFinite(val) ? Math.max(-32768, Math.min(32767, val | 0)) : -1);
    if ((regAddr + 1) * 2 > buf.length) return;
    buf.writeInt16BE(v, regAddr * 2);
  }
  function writeFloat32BE(buf, regAddr, val) {
    if (typeof val !== 'number' || !Number.isFinite(val)) val = NaN;
    if ((regAddr + 2) * 2 > buf.length) return;
    buf.writeFloatBE(val, regAddr * 2);
  }
  function parseFloatLoose(s) {
    if (s == null) return NaN;
    const t = String(s).trim();
    if (t === '' || t === '--' || t === 'NaN' || t === 'null') return NaN;
    const v = parseFloat(t);
    return Number.isFinite(v) ? v : NaN;
  }
  function parseDeviceStatus(s) {
    if (s == null) return -1;
    const t = String(s).trim();
    if (t === '1') return 1;
    if (t === '0') return 0;
    const v = parseInt(t, 10);
    return Number.isInteger(v) ? v : -1;
  }

  // ----- 启停 -----
  function stopServer() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (mbServer) { try { mbServer = null; } catch (_e) {} }
    if (netServer) {
      try { netServer.close(); } catch (_e) {}
      netServer = null;
    }
    status.running = false;
    status.port = 0;
    appendLog('Modbus server stopped');
  }

  function startServer() {
    if (netServer) stopServer();
    const ctrlEnabled = !!(global.__modbusControl && global.__modbusControl.isEnabled && global.__modbusControl.isEnabled());
    // 任一模块启用即启动 server（共享同一端口）
    if (!cfg.enabled && !ctrlEnabled) return;
    const hasData = Array.isArray(cfg.selectedDevices) && cfg.selectedDevices.length > 0;
    const hasCtrl = ctrlEnabled && global.__modbusControl.getCommands().length > 0;
    if (!hasData && !hasCtrl) {
      status.lastError = '未选择设备且无控制命令';
      appendLog('启动失败：未选择设备且无控制命令');
      return;
    }
    const totalReg = buildMapping();
    if (totalReg <= 0) {
      status.lastError = '寄存器映射为空';
      return;
    }
    holding = Buffer.alloc(Math.max(totalReg, 1) * 2);
    netServer = new net.Server();
    try {
      mbServer = new Modbus.server.TCP(netServer, { holding: holding });
    } catch (e) {
      status.lastError = '构造 Modbus server 失败：' + e.message;
      appendLog(status.lastError);
      return;
    }

    // 监听 master FC=06 / FC=16 写入：地址落在控制段（addr >= CONTROL_BASE_ADDR）就调控制模块
    mbServer.on('postWriteSingleRegister', function (req) {
      try {
        const addr = req && req.body && req.body.address;
        const val = req && req.body && req.body.value;
        if (typeof addr !== 'number' || typeof val !== 'number') return;
        if (addr < CONTROL_BASE_ADDR) return; // 数据段 / 保留段写入忽略
        const ctrlIdx = addr - CONTROL_BASE_ADDR;
        if (global.__modbusControl && global.__modbusControl.handleWrite) {
          global.__modbusControl.handleWrite(ctrlIdx, val, addr, holding);
        }
      } catch (e) {
        appendLog('postWriteSingleRegister 异常: ' + e.message);
      }
    });

    netServer.on('error', function (err) {
      status.lastError = err.message;
      status.running = false;
      appendLog('netServer error: ' + err.message);
    });
    netServer.listen(cfg.port, '0.0.0.0', function () {
      status.running = true;
      status.port = cfg.port;
      status.regCount = totalReg;
      status.deviceCount = cfg.selectedDevices.length;
      status.lastError = '';
      appendLog('Modbus TCP server listening on 0.0.0.0:' + cfg.port +
        ' devices=' + status.deviceCount + ' dataReg=' + status.dataRegCount +
        ' controlReg=' + status.controlRegCount + ' total=' + totalReg);
      schedulePoll();
    });
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    if (!cfg.enabled || !status.running) return;
    // 没有数据设备时跳过轮询（仅控制功能不需要 dcim 周期拉取）
    if (!Array.isArray(cfg.selectedDevices) || cfg.selectedDevices.length === 0) return;
    const tick = async function () {
      if (polling) {
        pollTimer = setTimeout(tick, 1000);
        return;
      }
      polling = true;
      try {
        await pollOnce();
        status.lastError = '';
      } catch (e) {
        status.lastError = e.message;
        appendLog('poll err: ' + e.message);
      } finally {
        status.lastPollAt = localStamp();
        polling = false;
        if (cfg.enabled && status.running) {
          pollTimer = setTimeout(tick, Math.max(1, cfg.pollIntervalSec || 5) * 1000);
        }
      }
    };
    pollTimer = setTimeout(tick, 100);
  }

  async function pollOnce() {
    const helper = global.__protoConv;
    if (!helper || !helper.callUpstream) throw new Error('proto-conv 模块未就绪');
    // 按 groupId 分组：同一组所有设备一次接口拿全
    const byGroup = {};
    (cfg.selectedDevices || []).forEach(function (d) {
      const gid = String(d.groupId == null ? '' : d.groupId);
      if (!gid) return;
      (byGroup[gid] = byGroup[gid] || []).push(d);
    });
    const groupIds = Object.keys(byGroup);
    if (groupIds.length === 0) return;

    const userLsh = (helper.getCfg() && helper.getCfg().userLsh) || '1';
    const fetchedById = {}; // deviceId -> upstream device row
    for (const gid of groupIds) {
      let r;
      try {
        r = await helper.callUpstream({
          key: 'GetDeviceByGroupKey',
          method: 'POST',
          body: { UserLsh: userLsh, GroupId: gid },
        });
      } catch (e) {
        appendLog('GroupId=' + gid + ' 拉取异常 ' + e.message);
        continue;
      }
      if (!r || !r.ok || !r.data) {
        appendLog('GroupId=' + gid + ' 响应异常 status=' + (r && r.status));
        continue;
      }
      const list = (r.data && r.data.data) || [];
      list.forEach(function (dev) {
        if (dev && dev.DeviceId != null) {
          fetchedById[String(dev.DeviceId)] = dev;
        }
      });
    }

    // 按 mappingTable 写 holding buffer
    const missing = [];
    (cfg.selectedDevices || []).forEach(function (selDev) {
      const did = String(selDev.deviceId);
      const upDev = fetchedById[did];
      const baseAddr = devBaseAddr(selDev.deviceId);
      if (baseAddr < 0) return;
      if (!upDev) {
        // 接口里没返回这个设备 → DeviceStatus = -1，参数全 NaN/-1
        missing.push(selDev.deviceName);
        writeInt16(holding, baseAddr, -1);
        let off = baseAddr + 1;
        (selDev.params || []).forEach(function () {
          writeFloat32BE(holding, off, NaN); off += 2;
        });
        return;
      }
      writeInt16(holding, baseAddr, parseDeviceStatus(upDev.DeviceStatus));
      // 把上游 ParaList 按 paraName 索引
      const upParas = {};
      (upDev.ParaList || []).forEach(function (p) {
        if (p && p.ParaName != null) upParas[String(p.ParaName)] = p;
      });
      let off = baseAddr + 1;
      (selDev.params || []).forEach(function (sp) {
        const up = upParas[sp.paraName];
        const cur = up ? parseFloatLoose(up.CurValue) : NaN;
        writeFloat32BE(holding, off, cur); off += 2;
      });
    });
    status.missingDevices = missing;
    // 通知 SNMP 模块把最新数据同步到 OID 树
    if (global.__snmp && global.__snmp.syncFromHolding) {
      try { global.__snmp.syncFromHolding(); } catch (_e) {}
    }
    // 通知 IEC104 模块刷新点表时间戳（实际推送由周期定时器承担）
    if (global.__iec104 && global.__iec104.syncFromHolding) {
      try { global.__iec104.syncFromHolding(); } catch (_e) {}
    }
  }

  function devBaseAddr(deviceId) {
    let addr = 0;
    const sel = cfg.selectedDevices || [];
    for (let i = 0; i < sel.length; i++) {
      if (String(sel[i].deviceId) === String(deviceId)) return addr;
      addr += regsForDevice(sel[i]);
    }
    return -1;
  }

  // ----- 路由 -----
  app.get('/api/proto-conv/modbus/config', function (_req, res) {
    res.json({ ok: true, config: cfg, status: status });
  });

  app.put('/api/proto-conv/modbus/config', function (req, res) {
    const b = req.body || {};
    const next = JSON.parse(JSON.stringify(cfg));
    if (typeof b.enabled === 'boolean') next.enabled = b.enabled;
    if (b.port != null) {
      const p = Number(b.port) | 0;
      if (p < 1 || p > 65535) return res.status(400).json({ ok: false, message: 'port 范围 1-65535' });
      next.port = p;
    }
    if (b.pollIntervalSec != null) {
      const s = Number(b.pollIntervalSec) | 0;
      if (s < 1 || s > 60) return res.status(400).json({ ok: false, message: 'pollIntervalSec 范围 1-60' });
      next.pollIntervalSec = s;
    }
    if (Array.isArray(b.selectedDevices)) {
      // 验证寄存器总数 ≤ 59000（控制段固定从 60000 起，留出余量避免重叠）
      let totalReg = 0;
      b.selectedDevices.forEach(function (d) {
        if (!d || !d.deviceId) return;
        totalReg += 1 + 2 * ((d.params || []).length);
      });
      if (totalReg > 59000) {
        return res.status(400).json({ ok: false, message: '数据段寄存器总数 ' + totalReg + ' 超过 59000 上限（控制段固定从 60000 起）' });
      }
      next.selectedDevices = b.selectedDevices.map(function (d) {
        return {
          deviceId: String(d.deviceId == null ? '' : d.deviceId),
          deviceName: String(d.deviceName == null ? '' : d.deviceName),
          groupId: String(d.groupId == null ? '' : d.groupId),
          groupName: String(d.groupName == null ? '' : d.groupName),
          zonesubno: String(d.zonesubno == null ? '' : d.zonesubno),
          zonesubname: String(d.zonesubname == null ? '' : d.zonesubname),
          params: Array.isArray(d.params) ? d.params.map(function (p) {
            return {
              paraName: String(p.paraName == null ? '' : p.paraName),
              unit: String(p.unit == null ? '' : p.unit),
              dataType: String(p.dataType == null ? '' : p.dataType),
            };
          }) : [],
        };
      });
    }

    cfg = next;
    writeCfg();
    appendLog('配置已更新 enabled=' + cfg.enabled + ' port=' + cfg.port +
      ' poll=' + cfg.pollIntervalSec + 's devices=' + cfg.selectedDevices.length);
    // 自动重启 server
    stopServer();
    if (cfg.enabled) startServer();
    // 通知 SNMP 重建 OID 树（设备列表变了，SNMP 那边的 oidList 也要跟着变）
    if (global.__snmp && global.__snmp.rebuild) {
      try { global.__snmp.rebuild(); } catch (_e) {}
    }
    // 通知 IEC104 重建点表（设备列表变了，IOA 也要重新分配）
    if (global.__iec104 && global.__iec104.rebuild) {
      try { global.__iec104.rebuild(); } catch (_e) {}
    }
    res.json({ ok: true, config: cfg, status: status });
  });

  app.post('/api/proto-conv/modbus/start', function (_req, res) {
    cfg.enabled = true; writeCfg();
    stopServer(); startServer();
    res.json({ ok: status.running, status: status, message: status.lastError || '' });
  });

  app.post('/api/proto-conv/modbus/stop', function (_req, res) {
    cfg.enabled = false; writeCfg();
    stopServer();
    res.json({ ok: true, status: status });
  });

  app.get('/api/proto-conv/modbus/status', function (_req, res) {
    res.json({
      ok: true,
      status: Object.assign({}, status, { enabled: !!cfg.enabled }),
      mappingCount: mappingTable.length,
    });
  });

  app.get('/api/proto-conv/modbus/map.csv', function (_req, res) {
    if (!mappingTable.length) buildMapping();
    const lines = ['设备ID,设备名称,字段,参数名,寄存器地址,长度,数据类型,单位'];
    mappingTable.forEach(function (m) {
      // 范围地址（如 1-2）会被 Excel 识别成日期，用 ="..." 公式语法强制文本格式
      const addrStr = m.len === 1
        ? String(m.addr)
        : '="' + m.addr + '-' + (m.addr + m.len - 1) + '"';
      const csvEsc = function (s) {
        s = String(s == null ? '' : s);
        if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      };
      lines.push([
        csvEsc(m.deviceId), csvEsc(m.deviceName), csvEsc(m.kind), csvEsc(m.paraName),
        csvEsc(addrStr), csvEsc(m.len), csvEsc(m.type), csvEsc(m.unit),
      ].join(','));
    });
    const buf = Buffer.from('﻿' + lines.join('\r\n'), 'utf8'); // BOM 让 Excel 识别 UTF-8
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="modbus-map.csv"');
    res.end(buf);
  });

  // 启动后如果已启用（或控制模块已启用），自动起 server
  setTimeout(function () {
    const ctrlEnabled = !!(global.__modbusControl && global.__modbusControl.isEnabled && global.__modbusControl.isEnabled());
    if (cfg.enabled || ctrlEnabled) {
      try { startServer(); } catch (e) { appendLog('自启失败：' + e.message); }
    }
    appendLog('Modbus 转发模块就绪 enabled=' + cfg.enabled + ' port=' + cfg.port +
      ' devices=' + (cfg.selectedDevices || []).length + ' ctrlEnabled=' + ctrlEnabled);
  }, 800);

  // 暴露给控制转换 / SNMP 等子模块共享数据
  global.__modbus = {
    rebuild: function () {
      try { stopServer(); startServer(); } catch (_e) {}
    },
    getStatus: function () { return status; },
    getHolding: function () { return holding; },
    getDataRegCount: function () { return status.dataRegCount || 0; },
    getPort: function () { return cfg.port; },
    getCfg: function () { return cfg; },               // SNMP 同步需要 selectedDevices
    getMapping: function () { return mappingTable; },  // SNMP 用映射反查 holding 地址
  };
})();

// ===== 协议转换 → Modbus TCP 控制转换 =====
// 共用数据推送的 5020 server（不再独立监听）；控制段紧接数据段后面排列
// master 用 FC=06 写 value=1 到映射地址 → 后端触发 SendControlCommandKey 下发到 dcim
(function setupModbusControlBridge() {
  const path = require('path');

  const CONFIG_PATH = process.env.MODBUS_CTRL_CONFIG || path.join(__dirname, 'config', 'proto-conv-modbus-control.json');
  const LOG_PATH = process.env.MODBUS_CTRL_LOG || path.join(__dirname, 'logs', 'proto-conv-modbus-control.log');

  const defaults = {
    enabled: false,
    debounceSec: 2,
    selectedCommands: [],
  };

  let cfg = JSON.parse(JSON.stringify(defaults));
  function readCfg() {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = Object.assign({}, defaults, raw);
      if (!Array.isArray(cfg.selectedCommands)) cfg.selectedCommands = [];
    } catch (_e) {
      cfg = JSON.parse(JSON.stringify(defaults));
    }
    // 去掉历史遗留字段
    delete cfg.port;
  }
  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      const out = { enabled: !!cfg.enabled, debounceSec: cfg.debounceSec || 2, selectedCommands: cfg.selectedCommands || [] };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
      try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_e) {}
    } catch (err) { console.error('[modbus-ctrl] 写配置失败:', err.message); }
  }
  readCfg();

  function localStamp() {
    const d = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, '[' + localStamp() + '] ' + line + '\n', 'utf8');
    } catch (_e) {}
  }

  // 运行时
  const lastFireMs = new Map();
  const recentFires = [];
  const status = {
    commandCount: 0,
    totalFires: 0,
    debouncedCount: 0,
    lastFireAt: '',
    lastError: '',
  };

  // ----- 触发处理（由 setupModbusBridge 在 master 写入控制段时调用）-----
  // ctrlIdx: 控制段内索引（从 0 开始）；fullAddr: 在 holding 里的真实地址；holding: data 模块的 holding buffer
  function handleWrite(ctrlIdx, val, fullAddr, holding) {
    try {
      if (val !== 1) {
        appendLog('ignore addr=' + fullAddr + ' val=' + val + '（非 1 写入）');
        return;
      }
      const cmd = (cfg.selectedCommands || [])[ctrlIdx];
      if (!cmd) {
        appendLog('ignore addr=' + fullAddr + '（控制段索引 ' + ctrlIdx + ' 越界）');
        return;
      }
      // 边沿清 0
      if (holding && (fullAddr * 2 + 2) <= holding.length) {
        holding.writeUInt16BE(0, fullAddr * 2);
      }
      // 去重
      const now = Date.now();
      const last = lastFireMs.get(cmd.controlId) || 0;
      if (now - last < (cfg.debounceSec || 2) * 1000) {
        status.debouncedCount += 1;
        appendLog('DEBOUNCE addr=' + fullAddr + ' controlId=' + cmd.controlId);
        return;
      }
      lastFireMs.set(cmd.controlId, now);
      fireControl(cmd, fullAddr).catch(function (e) {
        appendLog('fireControl 异常: ' + e.message);
      });
    } catch (e) {
      appendLog('handleWrite 异常: ' + e.message);
    }
  }

  async function fireControl(cmd, addr) {
    const helper = global.__protoConv;
    if (!helper || !helper.callUpstream) {
      appendLog('FIRE addr=' + addr + ' fail: proto-conv 模块未就绪');
      pushFire({ addr: addr, cmd: cmd, ok: false, status: 0, message: 'proto-conv 模块未就绪' });
      return;
    }
    const userLsh = (helper.getCfg() && helper.getCfg().userLsh) || '1';
    let r;
    try {
      r = await helper.callUpstream({
        key: 'SendControlCommandKey',
        method: 'POST',
        body: { UserLsh: userLsh, DeviceId: cmd.deviceId, controlId: cmd.controlId },
      });
    } catch (e) {
      r = { ok: false, status: 0, message: e.message };
    }
    pushFire({ addr: addr, cmd: cmd, ok: !!r.ok, status: r.status, message: r.message || '' });
    appendLog('FIRE addr=' + addr + ' devId=' + cmd.deviceId +
      ' controlId=' + cmd.controlId + ' ok=' + r.ok + ' httpStatus=' + r.status);
  }

  function pushFire(rec) {
    status.totalFires += 1;
    status.lastFireAt = localStamp();
    recentFires.unshift({
      ts: status.lastFireAt,
      addr: rec.addr,
      deviceId: rec.cmd.deviceId,
      deviceName: rec.cmd.deviceName,
      controlId: rec.cmd.controlId,
      commandName: rec.cmd.commandName,
      ok: rec.ok,
      httpStatus: rec.status || 0,
      message: rec.message || '',
    });
    if (recentFires.length > 20) recentFires.pop();
  }

  // status 聚合：合并自身 + setupModbusBridge 的 server 状态
  function aggregateStatus() {
    const dataStat = (global.__modbus && global.__modbus.getStatus && global.__modbus.getStatus()) || {};
    return Object.assign({}, status, {
      enabled: !!cfg.enabled,
      running: !!dataStat.running,
      port: dataStat.port || 0,
      commandCount: (cfg.selectedCommands || []).length,
      controlBaseAddr: dataStat.controlBaseAddr || 0,
    });
  }

  // ----- 路由 -----
  app.get('/api/proto-conv/modbus-control/config', function (_req, res) {
    res.json({ ok: true, config: cfg, status: aggregateStatus(), recentFires: recentFires });
  });

  app.put('/api/proto-conv/modbus-control/config', function (req, res) {
    const b = req.body || {};
    const next = JSON.parse(JSON.stringify(cfg));
    if (typeof b.enabled === 'boolean') next.enabled = b.enabled;
    if (b.debounceSec != null) {
      const s = Number(b.debounceSec) | 0;
      if (s < 0 || s > 60) return res.status(400).json({ ok: false, message: 'debounceSec 范围 0-60' });
      next.debounceSec = s;
    }
    if (Array.isArray(b.selectedCommands)) {
      // 控制段地址空间：60000..65535，最多 5500 个命令
      if (b.selectedCommands.length > 5500) {
        return res.status(400).json({ ok: false, message: '命令总数 ' + b.selectedCommands.length + ' 超过 5500 上限（控制段地址空间 60000..65535）' });
      }
      next.selectedCommands = b.selectedCommands.map(function (d) {
        return {
          deviceId: String(d.deviceId == null ? '' : d.deviceId),
          deviceName: String(d.deviceName == null ? '' : d.deviceName),
          controlId: String(d.controlId == null ? '' : d.controlId),
          commandName: String(d.commandName == null ? '' : d.commandName),
          groupId: String(d.groupId == null ? '' : d.groupId),
          groupName: String(d.groupName == null ? '' : d.groupName),
          zonesubno: String(d.zonesubno == null ? '' : d.zonesubno),
          zonesubname: String(d.zonesubname == null ? '' : d.zonesubname),
        };
      });
    }
    cfg = next;
    writeCfg();
    appendLog('配置已更新 enabled=' + cfg.enabled +
      ' debounce=' + cfg.debounceSec + 's commands=' + cfg.selectedCommands.length);
    // 通知 setupModbusBridge 重建 holding 大小 + 重新映射控制段
    if (global.__modbus && global.__modbus.rebuild) global.__modbus.rebuild();
    // 通知 SNMP 重建 OID 树（控制项变了，控制段 OID 也要跟着变）
    if (global.__snmp && global.__snmp.rebuild) global.__snmp.rebuild();
    res.json({ ok: true, config: cfg, status: aggregateStatus() });
  });

  app.post('/api/proto-conv/modbus-control/start', function (_req, res) {
    cfg.enabled = true; writeCfg();
    if (global.__modbus && global.__modbus.rebuild) global.__modbus.rebuild();
    if (global.__snmp && global.__snmp.rebuild) global.__snmp.rebuild();
    res.json({ ok: true, status: aggregateStatus(), message: status.lastError || '' });
  });

  app.post('/api/proto-conv/modbus-control/stop', function (_req, res) {
    cfg.enabled = false; writeCfg();
    if (global.__modbus && global.__modbus.rebuild) global.__modbus.rebuild();
    if (global.__snmp && global.__snmp.rebuild) global.__snmp.rebuild();
    res.json({ ok: true, status: aggregateStatus() });
  });

  app.get('/api/proto-conv/modbus-control/status', function (_req, res) {
    res.json({ ok: true, status: aggregateStatus(), recentFires: recentFires });
  });

  app.get('/api/proto-conv/modbus-control/map.csv', function (_req, res) {
    const dataStat = (global.__modbus && global.__modbus.getStatus && global.__modbus.getStatus()) || {};
    const baseAddr = dataStat.controlBaseAddr || 0;
    const lines = ['序号,寄存器地址,区域,分组,设备名称,控制项名称,controlId,DeviceId'];
    const csvEsc = function (s) {
      s = String(s == null ? '' : s);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    (cfg.selectedCommands || []).forEach(function (c, i) {
      lines.push([
        csvEsc(i + 1), csvEsc(baseAddr + i),
        csvEsc(c.zonesubname), csvEsc(c.groupName),
        csvEsc(c.deviceName), csvEsc(c.commandName),
        csvEsc(c.controlId), csvEsc(c.deviceId),
      ].join(','));
    });
    const buf = Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="modbus-control-map.csv"');
    res.end(buf);
  });

  // 暴露给 setupModbusBridge 使用
  global.__modbusControl = {
    isEnabled: function () { return !!cfg.enabled; },
    getCommands: function () { return cfg.selectedCommands || []; },
    getDebounceSec: function () { return cfg.debounceSec || 2; },
    handleWrite: handleWrite,
    getStatus: function () { return status; },
  };

  appendLog('Modbus 控制转换模块就绪 enabled=' + cfg.enabled +
    ' commands=' + (cfg.selectedCommands || []).length);
})();

// ===== 协议转换 → SNMP v2c 转发 =====
// 把 dcim 设备数据 + 控制项暴露成 SNMP OID 树
// 数据来源复用 setupModbusBridge.cfg.selectedDevices；控制 SET 复用 setupModbusControlBridge.handleWrite
// 数据更新由 setupModbusBridge.pollOnce 末尾调 global.__snmp.syncFromHolding() 触发
(function setupSnmpAgent() {
  const path = require('path');
  let snmp;
  try { snmp = require('net-snmp'); }
  catch (_e) { console.error('[snmp] net-snmp 未安装，SNMP 转发功能不可用'); return; }

  const ENTERPRISE = '1.3.6.1.4.1.99999';
  const CONFIG_PATH = process.env.SNMP_CONFIG || path.join(__dirname, 'config', 'proto-conv-snmp.json');
  const LOG_PATH = process.env.SNMP_LOG || path.join(__dirname, 'logs', 'proto-conv-snmp.log');

  const defaults = {
    enabled: false,
    port: 16162,
    readCommunity: 'public',
    writeCommunity: 'private',
    enableSet: true,
    ipWhitelist: [],
  };

  let cfg = JSON.parse(JSON.stringify(defaults));
  function readCfg() {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = Object.assign({}, defaults, raw);
      if (!Array.isArray(cfg.ipWhitelist)) cfg.ipWhitelist = [];
    } catch (_e) {
      cfg = JSON.parse(JSON.stringify(defaults));
    }
  }
  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_e) {}
    } catch (err) { console.error('[snmp] 写配置失败:', err.message); }
  }
  readCfg();

  function localStamp() {
    const d = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, '[' + localStamp() + '] ' + line + '\n', 'utf8');
    } catch (_e) {}
  }

  // 运行时
  let agent = null;
  let mib = null;
  let oidList = []; // [{ oid, type:'Integer'|'OctetString', kind, deviceId, deviceName, paraName, unit, controlIndex? }]
  const status = {
    running: false,
    port: 0,
    oidCount: 0,
    deviceCount: 0,
    commandCount: 0,
    setCount: 0,
    lastSyncAt: '',
    lastSetAt: '',
    lastError: '',
  };

  function provName(oid) { return 'oid_' + oid.replace(/\./g, '_'); }

  // ----- OID 树构建 -----
  function buildOidTree() {
    oidList = [];
    const mbCfg = (global.__modbus && global.__modbus.getCfg && global.__modbus.getCfg()) || {};
    const ctrlCmds = (global.__modbusControl && global.__modbusControl.getCommands && global.__modbusControl.getCommands()) || [];
    const devices = mbCfg.selectedDevices || [];

    devices.forEach(function (dev, di) {
      const idx = di + 1;
      oidList.push({
        oid: ENTERPRISE + '.1.' + idx + '.0.0',
        type: 'Integer', kind: 'DeviceStatus',
        deviceId: dev.deviceId, deviceName: dev.deviceName, paraName: '',
      });
      (dev.params || []).forEach(function (p, pi) {
        const pidx = pi + 1;
        // 数值缩放：开关量保持原值（×1，整数），模拟量 ×100（保留 2 位小数 → INTEGER）
        const dataType = String(p.dataType == null ? '' : p.dataType);
        const scale = (dataType === '开关量') ? 1 : 100;
        oidList.push({
          oid: ENTERPRISE + '.1.' + idx + '.2.' + pidx + '.0',
          type: 'Integer', kind: scale === 1 ? 'CurValue' : 'CurValueX' + scale,
          deviceId: dev.deviceId, deviceName: dev.deviceName,
          paraName: p.paraName, unit: p.unit || '',
          dataType: dataType, scale: scale,
        });
      });
    });
    ctrlCmds.forEach(function (c, ci) {
      const idx = ci + 1;
      oidList.push({
        oid: ENTERPRISE + '.2.' + idx + '.0',
        type: 'Integer', kind: 'ControlTrigger',
        deviceId: c.deviceId, deviceName: c.deviceName,
        paraName: c.commandName, controlId: c.controlId, controlIndex: idx,
      });
    });
    status.oidCount = oidList.length;
    status.deviceCount = devices.length;
    status.commandCount = ctrlCmds.length;
  }

  // ----- 启停 -----
  function stopAgent() {
    if (agent) {
      try { agent.close(); } catch (_e) {}
      agent = null;
      mib = null;
    }
    status.running = false;
    status.port = 0;
    appendLog('SNMP agent stopped');
  }

  function startAgent() {
    if (agent) stopAgent();
    if (!cfg.enabled) return;
    buildOidTree();
    if (oidList.length === 0) {
      status.lastError = '无可暴露的 OID（未在 Modbus 转发选设备 + 未在 Modbus 控制转换选命令）';
      appendLog('启动失败：' + status.lastError);
      return;
    }

    try {
      agent = snmp.createAgent({
        port: cfg.port, address: '0.0.0.0', transport: 'udp4',
        disableAuthorization: false,
        accessControlModelType: snmp.AccessControlModelType.Simple,
      }, function (err, data) {
        if (err) {
          status.lastError = err.message;
          appendLog('agent error: ' + err.message);
          return;
        }
        // IP 白名单（应用层兜底，正式靠防火墙）
        if (cfg.ipWhitelist && cfg.ipWhitelist.length) {
          const srcIp = data && data.rinfo && data.rinfo.address;
          if (cfg.ipWhitelist.indexOf(srcIp) < 0) {
            appendLog('IP 拦截 src=' + srcIp);
            return; // 不回包
          }
        }
      }, snmp.createMib());
    } catch (e) {
      status.lastError = '构造 SNMP agent 失败：' + e.message;
      appendLog(status.lastError);
      return;
    }

    // community + 权限（注意：addCommunity 默认 ReadOnly，必须 setCommunityAccess 覆盖）
    const auth = agent.getAuthorizer();
    auth.addCommunity(cfg.readCommunity);
    if (cfg.enableSet && cfg.writeCommunity && cfg.writeCommunity !== cfg.readCommunity) {
      auth.addCommunity(cfg.writeCommunity);
      auth.getAccessControlModel().setCommunityAccess(cfg.writeCommunity, snmp.AccessLevel.ReadWrite);
    }

    mib = agent.getMib();
    oidList.forEach(function (item) {
      const provOid = item.oid.replace(/\.0$/, '');
      const name = provName(item.oid);

      if (item.kind === 'ControlTrigger') {
        if (!cfg.enableSet) return; // 关 SET 时不注册控制 OID
        mib.registerProvider({
          name: name,
          type: snmp.MibProviderType.Scalar,
          oid: provOid,
          scalarType: snmp.ObjectType.Integer,
          maxAccess: snmp.MaxAccess['read-write'],
          handler: function (req) {
            try {
              if (req.operation === snmp.PduType.SetRequest) {
                const v = req.setValue;
                status.lastSetAt = localStamp();
                status.setCount += 1;
                appendLog('SET oid=' + item.oid + ' value=' + v + ' commandName=' + item.paraName);
                if (v === 1 && global.__modbusControl && global.__modbusControl.handleWrite) {
                  // 复用 modbus 控制的 handleWrite：addr 用 -1 表示来自 SNMP
                  global.__modbusControl.handleWrite(item.controlIndex - 1, 1, -1, null);
                }
              }
            } catch (e) { appendLog('SET handler 异常: ' + e.message); }
            req.done();
          },
        });
        mib.setScalarValue(name, 0);
      } else {
        const isInt = item.type === 'Integer';
        mib.registerProvider({
          name: name,
          type: snmp.MibProviderType.Scalar,
          oid: provOid,
          scalarType: isInt ? snmp.ObjectType.Integer : snmp.ObjectType.OctetString,
          maxAccess: snmp.MaxAccess['read-only'],
        });
        const initVal = isInt ? 0
          : (item.kind === 'DeviceName' ? (item.deviceName || '') : (item.paraName || ''));
        mib.setScalarValue(name, initVal);
      }
    });

    status.running = true;
    status.port = cfg.port;
    status.lastError = '';
    appendLog('SNMP agent listening on udp/' + cfg.port + ' oids=' + oidList.length +
      ' devices=' + status.deviceCount + ' controls=' + status.commandCount);
    syncFromHolding();
  }

  // ----- 数据同步（被 setupModbusBridge.pollOnce 末尾调用）-----
  function syncFromHolding() {
    if (!agent || !mib) return;
    const holding = global.__modbus && global.__modbus.getHolding && global.__modbus.getHolding();
    const mapping = global.__modbus && global.__modbus.getMapping && global.__modbus.getMapping();
    const mbCfg = global.__modbus && global.__modbus.getCfg && global.__modbus.getCfg();
    if (!holding || !mapping || !mbCfg) return;

    // 按 deviceId 把 mapping 数据段条目分组，便于关联到 OID 索引
    const dataByDevice = {};
    mapping.forEach(function (m) {
      if (m.segment !== 'data') return;
      (dataByDevice[m.deviceId] = dataByDevice[m.deviceId] || []).push(m);
    });

    (mbCfg.selectedDevices || []).forEach(function (dev, di) {
      const idx = di + 1;
      const items = dataByDevice[dev.deviceId] || [];
      items.forEach(function (m) {
        if (m.kind === 'DeviceStatus') {
          if ((m.addr + 1) * 2 > holding.length) return;
          const v = holding.readInt16BE(m.addr * 2);
          setOidInt(ENTERPRISE + '.1.' + idx + '.0.0', v);
        } else if (m.kind === 'CurValue') {
          if ((m.addr + 2) * 2 > holding.length) return;
          const f = holding.readFloatBE(m.addr * 2);
          // 通过 paraName 反查在 dev.params 里的下标，再按 dataType 决定缩放
          const pi = (dev.params || []).findIndex(function (p) { return p.paraName === m.paraName; });
          if (pi < 0) return;
          const param = dev.params[pi];
          const dataType = String(param.dataType == null ? '' : param.dataType);
          const scale = (dataType === '开关量') ? 1 : 100;
          const intVal = Number.isFinite(f) ? Math.round(f * scale) : -1;
          setOidInt(ENTERPRISE + '.1.' + idx + '.2.' + (pi + 1) + '.0', intVal);
        }
      });
    });
    status.lastSyncAt = localStamp();
  }
  function setOidInt(oid, val) {
    if (!mib) return;
    const name = provName(oid);
    try {
      const clamped = Math.max(-2147483648, Math.min(2147483647, val | 0));
      mib.setScalarValue(name, clamped);
    } catch (_e) {}
  }

  // ----- 状态聚合 -----
  function aggregateStatus() {
    return Object.assign({}, status, { enabled: !!cfg.enabled });
  }

  // ----- 路由 -----
  app.get('/api/proto-conv/snmp/config', function (_req, res) {
    res.json({ ok: true, config: cfg, status: aggregateStatus() });
  });

  app.put('/api/proto-conv/snmp/config', function (req, res) {
    const b = req.body || {};
    const next = JSON.parse(JSON.stringify(cfg));
    if (typeof b.enabled === 'boolean') next.enabled = b.enabled;
    if (typeof b.enableSet === 'boolean') next.enableSet = b.enableSet;
    if (b.port != null) {
      const p = Number(b.port) | 0;
      if (p < 1 || p > 65535) return res.status(400).json({ ok: false, message: 'port 范围 1-65535' });
      next.port = p;
    }
    if (typeof b.readCommunity === 'string') next.readCommunity = b.readCommunity.trim() || 'public';
    if (typeof b.writeCommunity === 'string') next.writeCommunity = b.writeCommunity.trim() || 'private';
    if (Array.isArray(b.ipWhitelist)) {
      next.ipWhitelist = b.ipWhitelist
        .map(function (s) { return String(s == null ? '' : s).trim(); })
        .filter(Boolean);
    }
    cfg = next;
    writeCfg();
    appendLog('配置已更新 enabled=' + cfg.enabled + ' port=' + cfg.port +
      ' read=' + cfg.readCommunity + ' write=' + cfg.writeCommunity +
      ' enableSet=' + cfg.enableSet + ' whitelist=' + cfg.ipWhitelist.length);
    stopAgent();
    if (cfg.enabled) startAgent();
    res.json({ ok: true, config: cfg, status: aggregateStatus() });
  });

  app.post('/api/proto-conv/snmp/start', function (_req, res) {
    cfg.enabled = true; writeCfg();
    stopAgent(); startAgent();
    res.json({ ok: status.running, status: aggregateStatus(), message: status.lastError || '' });
  });

  app.post('/api/proto-conv/snmp/stop', function (_req, res) {
    cfg.enabled = false; writeCfg();
    stopAgent();
    res.json({ ok: true, status: aggregateStatus() });
  });

  app.get('/api/proto-conv/snmp/status', function (_req, res) {
    res.json({ ok: true, status: aggregateStatus() });
  });

  app.get('/api/proto-conv/snmp/map.csv', function (_req, res) {
    // 总是基于当前 modbus.selectedDevices 重建，避免 modbus 改了设备但 SNMP CSV 还显示旧的
    buildOidTree();
    const lines = ['OID,类型,字段,设备名称,参数名,单位,数据类型,缩放,controlId'];
    const csvEsc = function (s) {
      s = String(s == null ? '' : s);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    oidList.forEach(function (o) {
      lines.push([
        csvEsc(o.oid), csvEsc(o.type), csvEsc(o.kind),
        csvEsc(o.deviceName), csvEsc(o.paraName), csvEsc(o.unit || ''),
        csvEsc(o.dataType || ''), csvEsc(o.scale == null ? '' : ('×' + o.scale)),
        csvEsc(o.controlId || ''),
      ].join(','));
    });
    const buf = Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="snmp-oid-map.csv"');
    res.end(buf);
  });

  // 自启（等 modbus / modbusControl 先就绪）
  setTimeout(function () {
    if (cfg.enabled) {
      try { startAgent(); } catch (e) { appendLog('自启失败: ' + e.message); }
    }
    appendLog('SNMP 模块就绪 enabled=' + cfg.enabled + ' port=' + cfg.port);
  }, 1200);

  global.__snmp = {
    syncFromHolding: syncFromHolding,
    isEnabled: function () { return !!cfg.enabled; },
    rebuild: function () {
      try { stopAgent(); if (cfg.enabled) startAgent(); } catch (_e) {}
    },
  };
})();

// ===== 防火墙管理模块（firewalld）=====
// 目的：在设置面板里给运维同事提供 1panel 风格的防火墙管理：
//   - 端口规则：允许/禁止 端口（支持指定源 IP，accept 走 --add-port，deny / 带源 IP 走 rich-rule）
//   - 端口转发：本机端口转到本机/远端的另一端口（--add-forward-port）
//   - IP 规则：黑/白名单（rich-rule address accept/drop）
//   - 状态总控：firewalld 服务的 active 状态、开启/关闭/重启、ICMP 禁 ping 开关
// 所有改动均使用 --permanent + --reload，重启不丢失。仅支持 firewalld（目标机 Kylin V10 默认就是它）。
(function setupFirewall() {
  const path = require('path');
  const LOG_PATH = process.env.FIREWALL_LOG || path.join(__dirname, '..', 'logs', 'firewall.log');
  const DEFAULT_ZONE = process.env.FIREWALL_ZONE || 'public';

  function localStamp(d) {
    d = d || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, `[${localStamp()}] ${line}\n`, 'utf8');
    } catch (_e) {}
  }

  // 不走 shell，所有参数当成 argv 数组传，避免命令注入
  function run(cmd, args, opts) {
    return new Promise(function (resolve) {
      const child = spawn(cmd, args || [], opts || {});
      let stdout = '', stderr = '';
      child.stdout && child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
      child.stderr && child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
      child.on('close', (code) => resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
      child.on('error', (err) => resolve({ ok: false, code: null, stdout: '', stderr: 'spawn error: ' + err.message }));
    });
  }
  function fwcmd(args) { return run('firewall-cmd', args); }
  function systemctl(args) { return run('systemctl', args); }

  function isLinux() { return process.platform === 'linux'; }

  // 校验输入：端口号(单端口/范围)、协议、IPv4/IPv6 地址
  const PROTO_RE = /^(tcp|udp)$/;
  const PORT_RE = /^\d{1,5}(-\d{1,5})?$/;
  // 简单 IP 校验：允许 v4 / v4-CIDR / v6 / v6-CIDR；不要求严格 RFC，挡掉明显非法字符即可
  const IP_RE = /^[0-9a-fA-F.:/]+$/;

  function validPort(p) {
    if (!PORT_RE.test(String(p))) return false;
    const parts = String(p).split('-').map(Number);
    return parts.every((n) => n >= 1 && n <= 65535) && (parts.length === 1 || parts[0] <= parts[1]);
  }
  function validProto(p) { return PROTO_RE.test(String(p || '').toLowerCase()); }
  function validIp(s) {
    if (!s) return false;
    if (!IP_RE.test(String(s))) return false;
    return String(s).length <= 64;
  }

  async function getStatus() {
    if (!isLinux()) {
      return { available: false, reason: 'only firewalld on Linux is supported', platform: process.platform };
    }
    const installed = await run('which', ['firewall-cmd']);
    if (!installed.ok) {
      return { available: false, reason: 'firewall-cmd not installed' };
    }
    const active = await systemctl(['is-active', 'firewalld']);
    const enabled = await systemctl(['is-enabled', 'firewalld']);
    const versionRes = await fwcmd(['--version']);
    const stateRes = await fwcmd(['--state']);
    // 默认 zone（用于显示，不阻塞主流程）
    const defZoneRes = await fwcmd(['--get-default-zone']);
    // ICMP block：返回 yes / no
    const icmpRes = active.ok ? await fwcmd(['--zone=' + DEFAULT_ZONE, '--query-icmp-block=echo-request']) : { ok: false, stdout: '' };
    return {
      available: true,
      installed: true,
      activeRaw: (active.stdout || '').trim(),
      enabledRaw: (enabled.stdout || '').trim(),
      running: stateRes.ok && /^running$/i.test(stateRes.stdout || ''),
      version: (versionRes.stdout || '').trim(),
      defaultZone: (defZoneRes.stdout || DEFAULT_ZONE).trim() || DEFAULT_ZONE,
      zone: DEFAULT_ZONE,
      // 注意：--query-icmp-block 命中是 exit=0，未命中是 exit=1，stdout 也会是 yes/no
      icmpBlocked: icmpRes.ok || /^yes$/i.test(icmpRes.stdout || ''),
    };
  }

  // 端口规则：先把 firewall-cmd --list-ports / --list-rich-rules 都解一遍，合并成 [{proto, port, strategy, address, description, source: 'ports'|'rich'}]
  function parseRichRules(text) {
    if (!text) return [];
    return text.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  // rich-rule 端口形式：rule family="ipv4" [source address="x"] port port="80" protocol="tcp" accept|drop|reject
  function parsePortRichRule(line) {
    const m = line.match(/^rule\s+family="(ipv4|ipv6)"(?:\s+source\s+address="([^"]+)")?\s+port\s+port="([^"]+)"\s+protocol="(tcp|udp)"\s+(accept|drop|reject)\s*$/);
    if (!m) return null;
    return {
      family: m[1],
      address: m[2] || '',
      port: m[3],
      protocol: m[4],
      action: m[5],
    };
  }
  // forward-port rich-rule：rule family="ipv4" forward-port port="80" protocol="tcp" to-port="8080" [to-addr="..."]
  function parseForwardRichRule(line) {
    const m = line.match(/^rule\s+family="(ipv4|ipv6)"\s+forward-port\s+port="([^"]+)"\s+protocol="(tcp|udp)"\s+to-port="([^"]+)"(?:\s+to-addr="([^"]+)")?\s*$/);
    if (!m) return null;
    return { family: m[1], srcPort: m[2], protocol: m[3], dstPort: m[4], dstAddr: m[5] || '' };
  }
  // address rich-rule：rule family="ipv4" source address="x.x.x.x" accept|drop
  function parseAddressRichRule(line) {
    const m = line.match(/^rule\s+family="(ipv4|ipv6)"\s+source\s+address="([^"]+)"\s+(accept|drop|reject)\s*$/);
    if (!m) return null;
    return { family: m[1], address: m[2], action: m[3] };
  }

  async function listPortRules() {
    const rules = [];
    const ports = await fwcmd(['--zone=' + DEFAULT_ZONE, '--list-ports']);
    if (ports.ok && ports.stdout) {
      ports.stdout.split(/\s+/).filter(Boolean).forEach(function (item) {
        const m = item.match(/^(\d+(?:-\d+)?)\/(tcp|udp)$/);
        if (m) rules.push({ id: 'port:' + item, port: m[1], protocol: m[2], strategy: 'accept', address: '', source: 'ports' });
      });
    }
    const rich = await fwcmd(['--zone=' + DEFAULT_ZONE, '--list-rich-rules']);
    if (rich.ok && rich.stdout) {
      parseRichRules(rich.stdout).forEach(function (line) {
        const p = parsePortRichRule(line);
        if (p) {
          rules.push({
            id: 'rich:' + line,
            port: p.port,
            protocol: p.protocol,
            strategy: p.action === 'accept' ? 'accept' : 'drop',
            address: p.address,
            family: p.family,
            source: 'rich',
            raw: line,
          });
        }
      });
    }
    return rules;
  }

  async function listForwardRules() {
    const rules = [];
    const fwd = await fwcmd(['--zone=' + DEFAULT_ZONE, '--list-forward-ports']);
    if (fwd.ok && fwd.stdout) {
      // 输出形如：port=80:proto=tcp:toport=8080:toaddr=
      fwd.stdout.split('\n').map((s) => s.trim()).filter(Boolean).forEach(function (line) {
        const obj = {};
        line.split(':').forEach(function (kv) {
          const i = kv.indexOf('=');
          if (i > 0) obj[kv.slice(0, i)] = kv.slice(i + 1);
        });
        if (obj.port && obj.proto && obj.toport) {
          rules.push({
            id: 'fwd:' + line,
            srcPort: obj.port,
            protocol: obj.proto,
            dstPort: obj.toport,
            dstAddr: obj.toaddr || '',
            source: 'forward-ports',
          });
        }
      });
    }
    // forward 也可能写成 rich-rule，一并解析
    const rich = await fwcmd(['--zone=' + DEFAULT_ZONE, '--list-rich-rules']);
    if (rich.ok && rich.stdout) {
      parseRichRules(rich.stdout).forEach(function (line) {
        const f = parseForwardRichRule(line);
        if (f) rules.push({
          id: 'rich:' + line,
          srcPort: f.srcPort,
          protocol: f.protocol,
          dstPort: f.dstPort,
          dstAddr: f.dstAddr,
          family: f.family,
          source: 'rich',
          raw: line,
        });
      });
    }
    return rules;
  }

  async function listAddressRules() {
    const rules = [];
    const rich = await fwcmd(['--zone=' + DEFAULT_ZONE, '--list-rich-rules']);
    if (rich.ok && rich.stdout) {
      parseRichRules(rich.stdout).forEach(function (line) {
        const a = parseAddressRichRule(line);
        if (a) rules.push({
          id: 'rich:' + line,
          address: a.address,
          family: a.family,
          strategy: a.action === 'accept' ? 'accept' : 'drop',
          source: 'rich',
          raw: line,
        });
      });
    }
    return rules;
  }

  async function reload() {
    const r = await fwcmd(['--reload']);
    return r;
  }

  app.use(express.json({ limit: '16mb' }));

  // 总状态
  app.get('/api/firewall/status', async function (_req, res) {
    try {
      const st = await getStatus();
      res.json(st);
    } catch (err) {
      res.status(500).json({ available: false, error: err.message });
    }
  });

  // 服务总控：start / stop / restart / enable / disable
  app.post('/api/firewall/service', async function (req, res) {
    if (!isLinux()) return res.status(400).json({ ok: false, message: '仅支持 Linux firewalld' });
    const action = String((req.body && req.body.action) || '').toLowerCase();
    if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) {
      return res.status(400).json({ ok: false, message: 'unknown action' });
    }
    const r = await systemctl([action, 'firewalld']);
    appendLog(`service ${action}: ok=${r.ok} stderr=${r.stderr}`);
    res.json({ ok: r.ok, message: r.ok ? `已${action} firewalld` : (r.stderr || r.stdout) });
  });

  // 配置 ping 拦截
  app.post('/api/firewall/icmp', async function (req, res) {
    if (!isLinux()) return res.status(400).json({ ok: false, message: '仅支持 Linux firewalld' });
    const block = !!(req.body && req.body.block);
    const sub = block ? '--add-icmp-block=echo-request' : '--remove-icmp-block=echo-request';
    const r = await fwcmd(['--zone=' + DEFAULT_ZONE, '--permanent', sub]);
    if (!r.ok) return res.json({ ok: false, message: r.stderr || r.stdout });
    const reloaded = await reload();
    appendLog(`icmp block=${block}: ok=${r.ok} reload=${reloaded.ok}`);
    res.json({ ok: reloaded.ok, message: reloaded.ok ? '已应用' : (reloaded.stderr || '') });
  });

  // 端口规则
  app.get('/api/firewall/ports', async function (_req, res) {
    if (!isLinux()) return res.json({ ok: false, available: false, items: [] });
    try { res.json({ ok: true, items: await listPortRules() }); }
    catch (err) { res.status(500).json({ ok: false, message: err.message }); }
  });

  app.post('/api/firewall/ports', async function (req, res) {
    if (!isLinux()) return res.status(400).json({ ok: false, message: '仅支持 Linux firewalld' });
    const body = req.body || {};
    const port = String(body.port || '').trim();
    const protocol = String(body.protocol || 'tcp').toLowerCase();
    const strategy = String(body.strategy || 'accept').toLowerCase(); // accept | drop
    const address = String(body.address || '').trim();
    if (!validPort(port)) return res.status(400).json({ ok: false, message: '端口非法' });
    if (!validProto(protocol)) return res.status(400).json({ ok: false, message: '协议非法' });
    if (!['accept', 'drop'].includes(strategy)) return res.status(400).json({ ok: false, message: '策略非法' });
    if (address && !validIp(address)) return res.status(400).json({ ok: false, message: '源 IP 非法' });

    let r;
    if (!address && strategy === 'accept') {
      // 简单端口放行 → --add-port
      r = await fwcmd(['--zone=' + DEFAULT_ZONE, '--permanent', `--add-port=${port}/${protocol}`]);
    } else {
      // 带源 IP 或拒绝策略 → rich-rule
      const family = address.includes(':') ? 'ipv6' : 'ipv4';
      const parts = ['rule', `family="${family}"`];
      if (address) parts.push(`source address="${address}"`);
      parts.push('port', `port="${port}"`, `protocol="${protocol}"`, strategy);
      const rule = parts.join(' ');
      r = await fwcmd(['--zone=' + DEFAULT_ZONE, '--permanent', `--add-rich-rule=${rule}`]);
    }
    if (!r.ok) return res.json({ ok: false, message: r.stderr || r.stdout });
    const reloaded = await reload();
    appendLog(`port add ${strategy} ${port}/${protocol} addr=${address}: ok=${reloaded.ok}`);
    res.json({ ok: reloaded.ok, message: reloaded.ok ? '已应用' : (reloaded.stderr || '') });
  });

  app.delete('/api/firewall/ports', async function (req, res) {
    if (!isLinux()) return res.status(400).json({ ok: false, message: '仅支持 Linux firewalld' });
    const body = req.body || {};
    const id = String(body.id || '');
    let r;
    if (id.startsWith('port:')) {
      const item = id.slice(5);
      const m = item.match(/^(\d+(?:-\d+)?)\/(tcp|udp)$/);
      if (!m) return res.status(400).json({ ok: false, message: 'id 非法' });
      r = await fwcmd(['--zone=' + DEFAULT_ZONE, '--permanent', `--remove-port=${m[1]}/${m[2]}`]);
    } else if (id.startsWith('rich:')) {
      const rule = id.slice(5);
      // 二次校验：必须是端口型 rich-rule，避免被串改成乱删
      if (!parsePortRichRule(rule)) return res.status(400).json({ ok: false, message: 'rich-rule 非端口规则' });
      r = await fwcmd(['--zone=' + DEFAULT_ZONE, '--permanent', `--remove-rich-rule=${rule}`]);
    } else {
      return res.status(400).json({ ok: false, message: 'id 非法' });
    }
    if (!r.ok) return res.json({ ok: false, message: r.stderr || r.stdout });
    const reloaded = await reload();
    appendLog(`port remove ${id}: ok=${reloaded.ok}`);
    res.json({ ok: reloaded.ok, message: reloaded.ok ? '已删除' : (reloaded.stderr || '') });
  });

  // 端口转发
  app.get('/api/firewall/forwards', async function (_req, res) {
    if (!isLinux()) return res.json({ ok: false, available: false, items: [] });
    try { res.json({ ok: true, items: await listForwardRules() }); }
    catch (err) { res.status(500).json({ ok: false, message: err.message }); }
  });

  app.post('/api/firewall/forwards', async function (req, res) {
    if (!isLinux()) return res.status(400).json({ ok: false, message: '仅支持 Linux firewalld' });
    const body = req.body || {};
    const srcPort = String(body.srcPort || '').trim();
    const dstPort = String(body.dstPort || '').trim();
    const protocol = String(body.protocol || 'tcp').toLowerCase();
    const dstAddr = String(body.dstAddr || '').trim();
    if (!validPort(srcPort)) return res.status(400).json({ ok: false, message: '源端口非法' });
    if (!validPort(dstPort)) return res.status(400).json({ ok: false, message: '目标端口非法' });
    if (!validProto(protocol)) return res.status(400).json({ ok: false, message: '协议非法' });
    if (dstAddr && !validIp(dstAddr)) return res.status(400).json({ ok: false, message: '目标 IP 非法' });

    let arg = `--add-forward-port=port=${srcPort}:proto=${protocol}:toport=${dstPort}`;
    if (dstAddr) arg += `:toaddr=${dstAddr}`;
    const r = await fwcmd(['--zone=' + DEFAULT_ZONE, '--permanent', arg]);
    if (!r.ok) return res.json({ ok: false, message: r.stderr || r.stdout });
    const reloaded = await reload();
    appendLog(`forward add ${srcPort}/${protocol} -> ${dstAddr || 'localhost'}:${dstPort}: ok=${reloaded.ok}`);
    res.json({ ok: reloaded.ok, message: reloaded.ok ? '已应用' : (reloaded.stderr || '') });
  });

  app.delete('/api/firewall/forwards', async function (req, res) {
    if (!isLinux()) return res.status(400).json({ ok: false, message: '仅支持 Linux firewalld' });
    const body = req.body || {};
    const id = String(body.id || '');
    let r;
    if (id.startsWith('fwd:')) {
      const line = id.slice(4);
      // 复用入参解析，反向构造 --remove-forward-port=...
      const obj = {};
      line.split(':').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) obj[kv.slice(0, i)] = kv.slice(i + 1); });
      if (!obj.port || !obj.proto || !obj.toport) return res.status(400).json({ ok: false, message: 'id 非法' });
      let arg = `--remove-forward-port=port=${obj.port}:proto=${obj.proto}:toport=${obj.toport}`;
      if (obj.toaddr) arg += `:toaddr=${obj.toaddr}`;
      r = await fwcmd(['--zone=' + DEFAULT_ZONE, '--permanent', arg]);
    } else if (id.startsWith('rich:')) {
      const rule = id.slice(5);
      if (!parseForwardRichRule(rule)) return res.status(400).json({ ok: false, message: 'rich-rule 非转发规则' });
      r = await fwcmd(['--zone=' + DEFAULT_ZONE, '--permanent', `--remove-rich-rule=${rule}`]);
    } else {
      return res.status(400).json({ ok: false, message: 'id 非法' });
    }
    if (!r.ok) return res.json({ ok: false, message: r.stderr || r.stdout });
    const reloaded = await reload();
    appendLog(`forward remove ${id}: ok=${reloaded.ok}`);
    res.json({ ok: reloaded.ok, message: reloaded.ok ? '已删除' : (reloaded.stderr || '') });
  });

  // IP 规则
  app.get('/api/firewall/addresses', async function (_req, res) {
    if (!isLinux()) return res.json({ ok: false, available: false, items: [] });
    try { res.json({ ok: true, items: await listAddressRules() }); }
    catch (err) { res.status(500).json({ ok: false, message: err.message }); }
  });

  app.post('/api/firewall/addresses', async function (req, res) {
    if (!isLinux()) return res.status(400).json({ ok: false, message: '仅支持 Linux firewalld' });
    const body = req.body || {};
    const address = String(body.address || '').trim();
    const strategy = String(body.strategy || 'drop').toLowerCase();
    if (!validIp(address)) return res.status(400).json({ ok: false, message: 'IP 非法' });
    if (!['accept', 'drop'].includes(strategy)) return res.status(400).json({ ok: false, message: '策略非法' });
    const family = address.includes(':') ? 'ipv6' : 'ipv4';
    const rule = `rule family="${family}" source address="${address}" ${strategy}`;
    const r = await fwcmd(['--zone=' + DEFAULT_ZONE, '--permanent', `--add-rich-rule=${rule}`]);
    if (!r.ok) return res.json({ ok: false, message: r.stderr || r.stdout });
    const reloaded = await reload();
    appendLog(`address add ${strategy} ${address}: ok=${reloaded.ok}`);
    res.json({ ok: reloaded.ok, message: reloaded.ok ? '已应用' : (reloaded.stderr || '') });
  });

  app.delete('/api/firewall/addresses', async function (req, res) {
    if (!isLinux()) return res.status(400).json({ ok: false, message: '仅支持 Linux firewalld' });
    const body = req.body || {};
    const id = String(body.id || '');
    if (!id.startsWith('rich:')) return res.status(400).json({ ok: false, message: 'id 非法' });
    const rule = id.slice(5);
    if (!parseAddressRichRule(rule)) return res.status(400).json({ ok: false, message: 'rich-rule 非地址规则' });
    const r = await fwcmd(['--zone=' + DEFAULT_ZONE, '--permanent', `--remove-rich-rule=${rule}`]);
    if (!r.ok) return res.json({ ok: false, message: r.stderr || r.stdout });
    const reloaded = await reload();
    appendLog(`address remove ${id}: ok=${reloaded.ok}`);
    res.json({ ok: reloaded.ok, message: reloaded.ok ? '已删除' : (reloaded.stderr || '') });
  });

  appendLog(`firewall API ready, zone=${DEFAULT_ZONE}, platform=${process.platform}`);
})();

// ===================== 视频监控（GB/T 28181 + ZLMediaKit） =====================
// 浏览器 → /api/video/* → 本 IIFE → ZLM HTTP API (127.0.0.1:8000)
// 浏览器 → /media/*     → 本 IIFE 反代 → ZLM HTTP-FLV (127.0.0.1:18080)
// ZLM 注册/上线/下线/流就绪 webhook → /api/video/zlm/webhook
(function setupVideo28181() {
  const path = require('path');
  const httpMod = require('http');

  const CONFIG_PATH = process.env.VIDEO_CONFIG || path.join(__dirname, 'config', 'video-28181.json');
  const LOG_PATH = process.env.VIDEO_LOG || path.join(__dirname, 'logs', 'video-28181.log');
  const DEVICES_CACHE_PATH = process.env.VIDEO_DEVICES_CACHE || path.join(__dirname, 'config', 'video-devices.json');
  const VIDEO_DISABLED = process.env.VIDEO_DISABLED === '1';

  const defaults = {
    sip: {
      serverId: '34020000002000000001',
      serverDomain: '3402000000',
      localPort: 5060,
      transport: 'UDP',
      authPwd: '12345678',
      keepaliveInterval: 60,
      keepaliveTimeout: 3,
      registerExpires: 3600,
      protocolVersion: 'GB/T28181-2016',
      streamIndex: 'main',
      whitelist: [],
    },
    zlm: {
      apiBase: 'http://127.0.0.1:8000',
      secret: '',
      publicHost: '',
    },
  };

  function deepMerge(target, src) {
    const out = Object.assign({}, target);
    for (const k of Object.keys(src || {})) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
        out[k] = deepMerge(target[k] || {}, src[k]);
      } else {
        out[k] = src[k];
      }
    }
    return out;
  }

  let cfg = JSON.parse(JSON.stringify(defaults));
  // devices: { <deviceId>: { online, lastKeepalive, ip, port, name, channels:[{id,name,manufacturer,parentId,status}] } }
  let devices = {};
  // streamRegistry: streamKey -> { mode, deviceId, channelId, ssrc, startedAt }
  const streamRegistry = new Map();

  function readCfg() {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = deepMerge(defaults, raw);
    } catch (_e) {
      cfg = JSON.parse(JSON.stringify(defaults));
    }
  }
  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_e) {}
    } catch (err) {
      console.error('[video] 写配置失败:', err.message);
    }
  }
  function readDevices() {
    try {
      devices = JSON.parse(fs.readFileSync(DEVICES_CACHE_PATH, 'utf8')) || {};
    } catch (_e) { devices = {}; }
  }
  function writeDevices() {
    try {
      fs.mkdirSync(path.dirname(DEVICES_CACHE_PATH), { recursive: true });
      fs.writeFileSync(DEVICES_CACHE_PATH, JSON.stringify(devices, null, 2) + '\n', 'utf8');
    } catch (_e) {}
  }
  function redactCfg() {
    return {
      sip: {
        serverId: cfg.sip.serverId,
        serverDomain: cfg.sip.serverDomain,
        localPort: cfg.sip.localPort,
        transport: cfg.sip.transport,
        authPwd: '***',
        hasAuthPwd: !!cfg.sip.authPwd,
        keepaliveInterval: cfg.sip.keepaliveInterval,
        keepaliveTimeout: cfg.sip.keepaliveTimeout,
        registerExpires: cfg.sip.registerExpires,
        protocolVersion: cfg.sip.protocolVersion,
        streamIndex: cfg.sip.streamIndex,
        whitelist: cfg.sip.whitelist || [],
      },
      zlm: {
        apiBase: cfg.zlm.apiBase,
        secret: '***',
        hasSecret: !!cfg.zlm.secret,
        publicHost: cfg.zlm.publicHost || '',
      },
    };
  }

  readCfg();
  readDevices();

  function localStamp() {
    const d = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, '[' + localStamp() + '] ' + line + '\n', 'utf8');
    } catch (_e) {}
  }

  // ---------- ZLM HTTP API 调用 ----------
  const zlmAgent = new httpMod.Agent({ keepAlive: true });
  let lastError = '';
  let lastApiSuccessAt = 0;

  function zlmCall(apiName, query) {
    return new Promise(function (resolve) {
      if (VIDEO_DISABLED) {
        return resolve({ ok: false, status: 0, message: '已设 VIDEO_DISABLED=1' });
      }
      let urlObj;
      try {
        urlObj = new URL('/index/api/' + apiName, cfg.zlm.apiBase);
      } catch (e) {
        return resolve({ ok: false, status: 0, message: 'URL 构造失败：' + e.message });
      }
      urlObj.searchParams.set('secret', cfg.zlm.secret || '');
      if (query && typeof query === 'object') {
        Object.keys(query).forEach(function (k) {
          if (query[k] != null && query[k] !== '') urlObj.searchParams.set(k, String(query[k]));
        });
      }
      const reqOptions = {
        method: 'GET',
        hostname: urlObj.hostname,
        port: urlObj.port || 80,
        path: urlObj.pathname + (urlObj.search || ''),
        agent: zlmAgent,
        timeout: 6000,
      };
      const req = httpMod.request(reqOptions, function (res) {
        const chunks = [];
        res.on('data', function (d) { chunks.push(d); });
        res.on('end', function () {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(text); } catch (_e) { data = text; }
          const ok = res.statusCode >= 200 && res.statusCode < 400;
          if (ok) lastApiSuccessAt = Date.now();
          resolve({ ok: ok, status: res.statusCode, data: data });
        });
      });
      req.on('timeout', function () { try { req.destroy(new Error('timeout 6000ms')); } catch (_e) {} });
      req.on('error', function (err) {
        lastError = 'ZLM ' + apiName + ': ' + err.message;
        resolve({ ok: false, status: 0, message: err.message });
      });
      req.end();
    });
  }

  // ---------- ssrc 申请：实时 0F + 5 位序号；回放 0M + 5 位 ----------
  let ssrcSeq = 1;
  function nextSsrc(mode) {
    const prefix = mode === 'playback' ? '0M' : '0F';
    const dom = String(cfg.sip.serverDomain || '0000000000').slice(3, 8) || '00000';
    const seq = String(ssrcSeq++ % 99999).padStart(5, '0');
    return prefix + dom.slice(-3) + seq; // 10 位
  }
  function streamKeyFor(deviceId, channelId, ssrc, mode) {
    if (mode === 'playback') return deviceId + '_' + channelId + '_' + ssrc;
    return deviceId + '_' + channelId;
  }
  function flvUrlFor(streamKey) {
    // 浏览器同源走 /media/* 反代到 ZLM 18080；ZLM 默认 app=rtp
    return '/media/rtp/' + encodeURIComponent(streamKey) + '.live.flv';
  }

  // ---------- ZLM 配置热同步 ----------
  async function pushSipToZlm() {
    const params = {
      'gb28181.serverId': cfg.sip.serverId,
      'gb28181.serverDomain': cfg.sip.serverDomain,
      'gb28181.serverPort': cfg.sip.localPort,
      'gb28181.authPwd': cfg.sip.authPwd,
      'gb28181.keepaliveInterval': cfg.sip.keepaliveInterval,
      'gb28181.keepaliveExpires': cfg.sip.keepaliveTimeout,
    };
    const r = await zlmCall('setServerConfig', params);
    appendLog('setServerConfig ok=' + r.ok + ' status=' + r.status);
    return r;
  }

  // ---------- SSE 推送给前端 ----------
  const sseClients = new Set();
  function sseSend(payload) {
    const text = 'data: ' + JSON.stringify(payload) + '\n\n';
    for (const res of sseClients) {
      try { res.write(text); } catch (_e) {}
    }
  }

  // ---------- /api/video/* 路由 ----------
  app.get('/api/video/config', function (_req, res) {
    res.json({ ok: true, config: redactCfg() });
  });

  app.put('/api/video/config', async function (req, res) {
    const body = req.body || {};
    const sipIn = body.sip || {};
    const zlmIn = body.zlm || {};
    const oldPort = cfg.sip.localPort;
    // sip 字段
    const sipKeys = ['serverId', 'serverDomain', 'localPort', 'transport', 'protocolVersion',
      'streamIndex', 'keepaliveInterval', 'keepaliveTimeout', 'registerExpires'];
    sipKeys.forEach(function (k) { if (sipIn[k] !== undefined) cfg.sip[k] = sipIn[k]; });
    if (Array.isArray(sipIn.whitelist)) cfg.sip.whitelist = sipIn.whitelist.map(String);
    if (sipIn.authPwd !== undefined && String(sipIn.authPwd) !== '' && sipIn.authPwd !== '***') {
      cfg.sip.authPwd = String(sipIn.authPwd);
    }
    // zlm 字段
    if (zlmIn.apiBase !== undefined) cfg.zlm.apiBase = String(zlmIn.apiBase || '');
    if (zlmIn.secret !== undefined && String(zlmIn.secret) !== '' && zlmIn.secret !== '***') {
      cfg.zlm.secret = String(zlmIn.secret);
    }
    if (zlmIn.publicHost !== undefined) cfg.zlm.publicHost = String(zlmIn.publicHost || '');

    writeCfg();
    appendLog('config updated');

    let needRestart = oldPort !== cfg.sip.localPort;
    if (!needRestart) await pushSipToZlm();
    res.json({ ok: true, config: redactCfg(), needRestart: needRestart });
  });

  app.get('/api/video/devices', function (_req, res) {
    res.json({ ok: true, devices: devices });
  });

  app.post('/api/video/devices/refresh', async function (req, res) {
    const body = req.body || {};
    const targets = body.deviceId ? [String(body.deviceId)] : Object.keys(devices);
    if (!targets.length) return res.json({ ok: true, message: '尚无已注册设备' });
    let okCount = 0;
    for (const id of targets) {
      const r = await zlmCall('gb28181_query_catalog', { device_id: id });
      if (r.ok) okCount++;
    }
    appendLog('catalog refresh: ' + okCount + '/' + targets.length);
    res.json({ ok: true, requested: targets.length, succeeded: okCount });
  });

  app.post('/api/video/play', async function (req, res) {
    const body = req.body || {};
    const deviceId = String(body.deviceId || '').trim();
    const channelId = String(body.channelId || '').trim();
    if (!deviceId || !channelId) return res.status(400).json({ ok: false, message: 'deviceId/channelId 必填' });
    const ssrc = nextSsrc('live');
    const r = await zlmCall('gb28181_invite_stream_play', {
      ssrc: ssrc, device_id: deviceId, channel_id: channelId,
    });
    if (!r.ok) {
      appendLog('play fail device=' + deviceId + ' ch=' + channelId + ' status=' + r.status + ' msg=' + (r.message || ''));
      return res.json({ ok: false, message: r.message || ('ZLM 返回 ' + r.status), data: r.data });
    }
    const streamKey = streamKeyFor(deviceId, channelId, ssrc, 'live');
    streamRegistry.set(streamKey, { mode: 'live', deviceId: deviceId, channelId: channelId, ssrc: ssrc, startedAt: Date.now() });
    const flvUrl = flvUrlFor(streamKey);
    appendLog('play ok device=' + deviceId + ' ch=' + channelId + ' ssrc=' + ssrc + ' streamKey=' + streamKey);
    res.json({ ok: true, streamKey: streamKey, flvUrl: flvUrl, ssrc: ssrc });
  });

  app.post('/api/video/playback', async function (req, res) {
    const body = req.body || {};
    const deviceId = String(body.deviceId || '').trim();
    const channelId = String(body.channelId || '').trim();
    const start = Number(body.start);
    const end = Number(body.end);
    if (!deviceId || !channelId) return res.status(400).json({ ok: false, message: 'deviceId/channelId 必填' });
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      return res.status(400).json({ ok: false, message: 'start/end 不合法（Unix 秒）' });
    }
    const ssrc = nextSsrc('playback');
    const r = await zlmCall('gb28181_invite_stream_play_back', {
      device_id: deviceId, channel_id: channelId, start_time: start, end_time: end, ssrc: ssrc,
    });
    if (!r.ok) {
      appendLog('playback fail device=' + deviceId + ' ch=' + channelId + ' status=' + r.status + ' msg=' + (r.message || ''));
      return res.json({ ok: false, message: r.message || ('ZLM 返回 ' + r.status), data: r.data });
    }
    const streamKey = streamKeyFor(deviceId, channelId, ssrc, 'playback');
    streamRegistry.set(streamKey, { mode: 'playback', deviceId: deviceId, channelId: channelId, ssrc: ssrc, startedAt: Date.now() });
    const flvUrl = flvUrlFor(streamKey);
    appendLog('playback ok device=' + deviceId + ' ch=' + channelId + ' ssrc=' + ssrc + ' [' + start + ',' + end + ']');
    res.json({ ok: true, streamKey: streamKey, flvUrl: flvUrl, ssrc: ssrc });
  });

  app.post('/api/video/playback/control', async function (req, res) {
    const body = req.body || {};
    const streamKey = String(body.streamKey || '').trim();
    const action = String(body.action || '').trim();
    const meta = streamRegistry.get(streamKey);
    if (!meta || meta.mode !== 'playback') {
      return res.status(400).json({ ok: false, message: '该流不是回放模式或不存在' });
    }
    if (!/^(play|pause|fastforward|seek)$/.test(action)) {
      return res.status(400).json({ ok: false, message: 'action 不合法' });
    }
    const q = { device_id: meta.deviceId, channel_id: meta.channelId, action: action };
    if (body.speed != null) q.speed = Number(body.speed) || 1;
    if (body.seek != null) q.seek = Number(body.seek) || 0;
    const r = await zlmCall('gb28181_play_back_control', q);
    appendLog('playback control ' + action + ' streamKey=' + streamKey + ' ok=' + r.ok);
    res.json({ ok: r.ok, message: r.ok ? '已执行' : (r.message || ('ZLM 返回 ' + r.status)) });
  });

  app.post('/api/video/stop', async function (req, res) {
    const body = req.body || {};
    const streamKey = String(body.streamKey || '').trim();
    const meta = streamRegistry.get(streamKey);
    if (!meta) return res.json({ ok: true, message: '未找到该流（可能已停止）' });
    const r = await zlmCall('gb28181_close_stream', {
      device_id: meta.deviceId, channel_id: meta.channelId,
    });
    streamRegistry.delete(streamKey);
    appendLog('stop streamKey=' + streamKey + ' ok=' + r.ok);
    res.json({ ok: true, message: r.ok ? '已关闭' : '已从注册表移除' });
  });

  app.post('/api/video/zlm/webhook', function (req, res) {
    const event = String((req.query && req.query.event) || '').trim();
    const body = req.body || {};
    try {
      if (event === 'on_server_keepalive' || event === 'keepalive') {
        // ZLM 自身心跳，记录最后存活时间
      } else if (event === 'on_publish' || event === 'publish') {
        // 流准备发布
      } else if (event === 'on_play' || event === 'play') {
        // 有人在拉流（authentication 钩子）
      } else if (event === 'on_stream_changed' || event === 'stream_changed') {
        const regist = !!body.regist;
        const streamId = String(body.stream || '');
        appendLog('stream_changed stream=' + streamId + ' regist=' + regist);
        sseSend({ type: regist ? 'stream-up' : 'stream-down', stream: streamId, deviceId: body.params || '' });
      } else if (event === 'on_stream_none_reader' || event === 'stream_none_reader') {
        const streamId = String(body.stream || '');
        appendLog('none_reader stream=' + streamId + '，自动 close');
        // 异步发起关流
        (async function () {
          for (const [k, m] of streamRegistry.entries()) {
            if (k === streamId || streamId.indexOf(k) === 0) {
              await zlmCall('gb28181_close_stream', { device_id: m.deviceId, channel_id: m.channelId });
              streamRegistry.delete(k);
            }
          }
        })();
      } else if (event === 'on_send_rtp_stopped' || event === 'send_rtp_stopped') {
        appendLog('send_rtp_stopped ssrc=' + (body.ssrc || ''));
      } else if (event === 'on_rtp_server_timeout' || event === 'rtp_server_timeout') {
        appendLog('rtp_server_timeout ssrc=' + (body.ssrc || ''));
      } else if (event === 'on_device_status' || event === 'device_status') {
        const id = String(body.deviceId || body.device_id || '');
        if (id) {
          devices[id] = devices[id] || { channels: [] };
          devices[id].online = body.alive !== false;
          devices[id].lastKeepalive = Date.now();
          if (body.ip) devices[id].ip = body.ip;
          if (body.port) devices[id].port = body.port;
          writeDevices();
          sseSend({ type: devices[id].online ? 'device-online' : 'device-offline', deviceId: id });
        }
      } else if (event === 'on_catalog' || event === 'catalog') {
        const id = String(body.deviceId || body.device_id || '');
        const list = Array.isArray(body.channels) ? body.channels : [];
        if (id) {
          devices[id] = devices[id] || { online: true, channels: [] };
          devices[id].channels = list.map(function (c) {
            return {
              id: String(c.deviceId || c.id || ''),
              name: String(c.name || c.deviceName || ''),
              manufacturer: c.manufacturer || '',
              parentId: c.parentId || '',
              status: c.status || c.online === false ? 'OFF' : 'ON',
            };
          }).filter(function (c) { return c.id; });
          writeDevices();
          sseSend({ type: 'catalog-updated', deviceId: id, count: devices[id].channels.length });
        }
      }
    } catch (e) {
      appendLog('webhook handler error: ' + e.message);
    }
    // ZLM 期望返回 { code: 0, msg: 'success' }
    res.json({ code: 0, msg: 'success' });
  });

  app.get('/api/video/events', function (req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':\n\n');
    sseClients.add(res);
    const heartbeat = setInterval(function () { try { res.write(':\n\n'); } catch (_e) {} }, 15000);
    req.on('close', function () {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  app.get('/api/video/status', async function (_req, res) {
    let mediaserverRunning = false;
    let zlmReachable = false;
    let zlmVersion = '';
    if (process.platform === 'linux') {
      try {
        await new Promise(function (resolve) {
          const child = spawn('systemctl', ['is-active', 'webssh-mediaserver']);
          let out = '';
          child.stdout && child.stdout.on('data', function (b) { out += b.toString('utf8'); });
          child.on('close', function () {
            mediaserverRunning = out.trim() === 'active';
            resolve();
          });
          child.on('error', function () { resolve(); });
        });
      } catch (_e) {}
    } else {
      mediaserverRunning = false;
    }
    if (!VIDEO_DISABLED) {
      const r = await zlmCall('getServerConfig', {});
      zlmReachable = r.ok;
      if (r.ok && r.data && r.data.data) {
        const d = Array.isArray(r.data.data) ? r.data.data[0] : r.data.data;
        zlmVersion = (d && (d['general.version'] || d['mediaServerId'])) || '';
      }
    }
    res.json({
      ok: true,
      mediaserverRunning: mediaserverRunning,
      zlmReachable: zlmReachable,
      zlmVersion: zlmVersion,
      videoDisabled: VIDEO_DISABLED,
      deviceCount: Object.keys(devices).length,
      onlineDeviceCount: Object.values(devices).filter(function (d) { return d.online; }).length,
      streamCount: streamRegistry.size,
      lastApiSuccessAt: lastApiSuccessAt,
      lastError: lastError,
      sip: { localPort: cfg.sip.localPort, transport: cfg.sip.transport, serverId: cfg.sip.serverId },
    });
  });

  app.post('/api/video/ptz', function (_req, res) {
    res.status(501).json({ ok: false, message: 'PTZ 暂未实现，预留 ZLM gb28181_ptz_control 锚点' });
  });

  // ---------- /media/* 反代到 ZLM HTTP-FLV ----------
  let zlmFlvTarget = 'http://127.0.0.1:18080';
  try {
    const u = new URL(cfg.zlm.apiBase || 'http://127.0.0.1:8000');
    // ZLM HTTP-FLV 端口默认 80/18080，与 API 端口可能不同；用 publicHost 覆盖
    if (cfg.zlm.publicHost) zlmFlvTarget = cfg.zlm.publicHost;
    else zlmFlvTarget = u.protocol + '//' + u.hostname + ':18080';
  } catch (_e) {}

  const mediaProxy = httpProxy.createProxyServer({
    target: zlmFlvTarget,
    changeOrigin: false,
    ws: false,
    proxyTimeout: 60000,
    timeout: 60000,
  });
  mediaProxy.on('error', function (err, _req, res2) {
    if (res2 && !res2.headersSent) {
      try {
        res2.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res2.end(JSON.stringify({ ok: false, msg: '媒体服务未启动或无响应：' + err.message, target: zlmFlvTarget }));
      } catch (_e) {}
    }
  });

  app.all(/^\/media(\/.*)?$/, function (req, res) {
    // 把 /media 前缀剥掉转发，ZLM 的流路径是 /rtp/<streamKey>.live.flv
    req.url = req.url.replace(/^\/media/, '') || '/';
    mediaProxy.web(req, res);
  });

  if (!VIDEO_DISABLED) {
    // 启动后异步把 SIP 配置推一遍到 ZLM（即使未注入也不阻塞）
    setTimeout(function () {
      pushSipToZlm().catch(function () {});
    }, 1500);
  }

  appendLog('video-28181 ready (disabled=' + VIDEO_DISABLED + ', flvTarget=' + zlmFlvTarget + ')');
})();

// ===================== dcim 视频监控反代（绕过 8086 反代缺失）=====================
// 背景：dcim 容器 8086 HTTPS 站点 (donghuan-camera-list.html / donghuan-camera-setting.html)
// 调用前端相对路径 api/... 但 Apache vhost 没把 /api/* 反代到 dcim wvp 18080，
// 导致点击「监控设备」「国标28181服务器配置」后页面空白。
// 这里 webssh 后端代理 dcim wvp 18080 (HTTPS, 自签证书)，自动用 admin hash 登录拿
// access-token，401 自动续登。前端 video/ 子站直接调 /api/dcim-video/* 拿数据渲染。
(function setupDcimVideo() {
  const path = require('path');
  const https = require('https');

  const CONFIG_PATH = process.env.DCIM_VIDEO_CONFIG || path.join(__dirname, 'config', 'dcim-video.json');
  const LOG_PATH = process.env.DCIM_VIDEO_LOG || path.join(__dirname, 'logs', 'dcim-video.log');
  // 录像机回放通常需要约 10 秒完成 SIP INVITE、RTP 收流与媒体流注册。
  const DEFAULT_TIMEOUT_MS = 30000;

  const defaults = createDcimVideoDefaults();

  let cfg = JSON.parse(JSON.stringify(defaults));
  function readCfg() {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = Object.assign({}, defaults, raw);
    } catch (_e) { cfg = JSON.parse(JSON.stringify(defaults)); }
  }
  function writeCfg() {
    try {
      writeDcimVideoConfig(CONFIG_PATH, cfg, fs, path);
    } catch (e) {
      console.error('[dcim-video] 写配置失败:', e.message);
      throw e;
    }
  }
  readCfg();

  function localStamp() {
    const d = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, '[' + localStamp() + '] ' + line + '\n', 'utf8');
    } catch (_e) {}
  }

  // dcim wvp 自签证书 + keepAlive
  const dcimAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

  const session = createDcimVideoSession();

  function dcimRequest(method, urlPath, headers, body, requestGeneration, requestConfig) {
    return new Promise(function (resolve) {
      const activeGeneration = requestGeneration == null ? session.generation() : requestGeneration;
      const activeConfig = requestConfig || cfg;
      let urlObj;
      try { urlObj = new URL(urlPath, activeConfig.apiBase); }
      catch (e) { return resolve({ ok: false, status: 0, message: 'URL 构造失败：' + e.message }); }
      const buf = body ? Buffer.from(body, 'utf8') : Buffer.alloc(0);
      const reqOptions = {
        method: method,
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + (urlObj.search || ''),
        agent: dcimAgent,
        timeout: activeConfig.timeoutMs || DEFAULT_TIMEOUT_MS,
        headers: Object.assign({}, headers || {}),
      };
      if (buf.length) {
        reqOptions.headers['content-type'] = reqOptions.headers['content-type'] || 'application/json;charset=utf-8';
        reqOptions.headers['content-length'] = buf.length;
      }
      const req = https.request(reqOptions, function (res) {
        const chunks = [];
        res.on('data', function (d) { chunks.push(d); });
        res.on('end', function () {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(text); } catch (_e) { data = text; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, data: data });
        });
      });
      req.on('timeout', function () {
        try { req.destroy(new Error('timeout ' + (activeConfig.timeoutMs || DEFAULT_TIMEOUT_MS) + 'ms')); } catch (_e) {}
      });
      req.on('error', function (err) {
        session.setError(activeGeneration, dcimVideoRequestLabel(method, urlPath) + ': ' + err.message);
        resolve({ ok: false, status: 0, message: err.message });
      });
      if (buf.length) req.write(buf);
      req.end();
    });
  }

  async function loginDcim() {
    const loginGeneration = session.generation();
    const loginConfig = cfg;
    const u = '/api/user/login?username=' + encodeURIComponent(loginConfig.username)
      + '&password=' + encodeURIComponent(loginConfig.passwordHash);
    const r = await dcimRequest('GET', u, {}, null, loginGeneration, loginConfig);
    if (!session.isCurrent(loginGeneration)) return false;
    if (r.ok && r.data && r.data.code === 0 && r.data.data && r.data.data.accessToken) {
      const token = r.data.data.accessToken;
      if (session.acceptLogin(loginGeneration, token, Date.now())) {
        appendLog('login ok, token len=' + String(token).length);
        return true;
      }
      return false;
    }
    const errorMessage = 'login failed: status=' + r.status + ' code=' + (r.data && r.data.code);
    if (session.rejectLogin(loginGeneration, errorMessage)) appendLog(errorMessage);
    return false;
  }

  registerDcimVideoConnectionRoutes(app, {
    getConfig: function () { return cfg; },
    setConfig: function (nextConfig) { cfg = nextConfig; },
    writeConfig: writeCfg,
    resetSession: session.reset,
    isAuthed: isAuthed,
    loginDcim: loginDcim,
    wvpUtils: wvpUtils,
  });

  async function callWithAuth(method, urlPath, body) {
    const requestGeneration = session.generation();
    const requestConfig = cfg;
    if (!session.token()) { await loginDcim(); }
    if (!session.isCurrent(requestGeneration)) {
      return { ok: false, status: 409, message: '连接配置已更新' };
    }
    let r = await dcimRequest(method, urlPath, { 'access-token': session.token() }, body, requestGeneration, requestConfig);
    if (!session.isCurrent(requestGeneration)) return r;
    // 401 自动续登一次
    if (r.status === 401 || (r.data && r.data.code === -1) || (r.data && r.data.code === -2)) {
      const ok = await loginDcim();
      if (ok && session.isCurrent(requestGeneration)) {
        r = await dcimRequest(method, urlPath, { 'access-token': session.token() }, body, requestGeneration, requestConfig);
      }
    }
    appendLog(method + ' ' + urlPath + ' -> status=' + r.status);
    return r;
  }

  // ---------- /api/dcim-video/* 路由 ----------
  app.get('/api/dcim-video/status', async function (_req, res) {
    const cfgInfo = {
      apiBase: cfg.apiBase, username: cfg.username,
      hasPasswordHash: !!cfg.passwordHash, timeoutMs: cfg.timeoutMs,
    };
    const r = await callWithAuth('GET', '/api/server/version', null);
    res.json({
      ok: true,
      reachable: r.ok,
      status: r.status,
      version: (r.ok && r.data && r.data.data && r.data.data.version) || '',
      hasToken: !!session.token(),
      lastLoginAt: session.lastLoginAt(),
      lastError: session.lastError(),
      config: cfgInfo,
    });
  });

  registerVideoSystemConfigRoute(app, {
    path: '/api/dcim-video/config',
    callWithAuth: callWithAuth,
    sanitizeSystemConfig: sanitizeDcimVideoSystemConfig,
  });

  app.get('/api/dcim-video/devices', async function (req, res) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const count = Math.min(200, Math.max(1, parseInt(req.query.count, 10) || 50));
    const u = '/api/device/query/devices?page=' + page + '&count=' + count;
    const r = await callWithAuth('GET', u, null);
    if (!r.ok) return res.json({ ok: false, message: r.message || ('上游返回 ' + r.status), data: r.data });
    const d = (r.data && r.data.data) || {};
    res.json({ ok: true, total: d.total || 0, list: d.list || [] });
  });

  app.get('/api/dcim-video/channels', async function (req, res) {
    const deviceId = String(req.query.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ ok: false, message: 'deviceId 必填' });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const count = Math.min(500, Math.max(1, parseInt(req.query.count, 10) || 100));
    const u = '/api/device/query/devices/' + encodeURIComponent(deviceId) + '/channels?page=' + page + '&count=' + count;
    const r = await callWithAuth('GET', u, null);
    if (!r.ok) return res.json({ ok: false, message: r.message || ('上游返回 ' + r.status), data: r.data });
    const d = (r.data && r.data.data) || {};
    res.json({ ok: true, total: d.total || 0, list: d.list || [] });
  });

  app.post('/api/dcim-video/sync-device', async function (req, res) {
    const body = req.body || {};
    const deviceId = String(body.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ ok: false, message: 'deviceId 必填' });
    const u = '/api/device/query/devices/' + encodeURIComponent(deviceId) + '/sync';
    const r = await callWithAuth('GET', u, null);
    res.json({ ok: r.ok, status: r.status, data: r.data });
  });

  // ---------- dcim 那套的 实时点播 / 回放 ----------
  // wvp 返回的 flv URL 形如 http://192.168.0.22[:80]/rtp/xxx.live.flv
  // 改写成 /media-dcim/rtp/xxx.live.flv，让浏览器同源走 webssh 反代
  function rewriteToDcimProxy(url) {
    if (!url) return '';
    return String(url).replace(/^(https?:)?\/\/[^/]+/, '/media-dcim');
  }

  registerLivePlaybackRoutes(app, {
    source: 'dcim',
    pathPrefix: '/api/dcim-video',
    liveGenerations: liveStreamGenerations,
    callWithAuth: callWithAuth,
    rewriteToProxy: rewriteToDcimProxy,
  });

  app.post('/api/dcim-video/playback/start/:deviceId/:channelId', async function (req, res) {
    const did = encodeURIComponent(req.params.deviceId || '');
    const cid = encodeURIComponent(req.params.channelId || '');
    const startTime = String((req.body && req.body.startTime) || req.query.startTime || '');
    const endTime = String((req.body && req.body.endTime) || req.query.endTime || '');
    if (!startTime || !endTime) return res.status(400).json({ ok: false, message: 'startTime/endTime 必填' });
    const u = '/api/playback/start/' + did + '/' + cid + '?startTime=' + encodeURIComponent(startTime) + '&endTime=' + encodeURIComponent(endTime);
    const r = await callWithAuth('GET', u, null);
    if (!r.ok || !r.data || r.data.code !== 0) {
      return res.json({ ok: false, status: r.status, message: (r.data && r.data.msg) || r.message || ('上游返回 ' + r.status), raw: r.data });
    }
    const d = r.data.data || {};
    res.json({
      ok: true,
      streamKey: (d.app || 'rtp') + '/' + (d.stream || ''),
      flvUrl: rewriteToDcimProxy(d.flv),
      hlsUrl: rewriteToDcimProxy(d.hls),
      ssrc: d.ssrc || '', app: d.app || 'rtp', stream: d.stream || '',
    });
  });

  function playbackActionOk(r) {
    const nestedStatus = r.data && r.data.data && Number(r.data.data.status);
    return !!(r.ok && r.data && r.data.code === 0 && !(nestedStatus >= 400));
  }

  async function stopPlayback(req, res) {
    const body = req.body || {};
    const did = encodeURIComponent(req.params.deviceId || body.deviceId || req.query.deviceId || '');
    const cid = encodeURIComponent(req.params.channelId || body.channelId || req.query.channelId || '');
    const sid = encodeURIComponent(req.params.streamId || '');
    if (!did || !cid || !sid) {
      return res.status(400).json({ ok: false, message: 'deviceId/channelId/streamId 必填' });
    }
    const r = await callWithAuth('GET', '/api/playback/stop/' + did + '/' + cid + '/' + sid, null);
    res.json({ ok: playbackActionOk(r), message: (r.data && r.data.msg) || r.message || '' });
  }
  app.post('/api/dcim-video/playback/stop/:deviceId/:channelId/:streamId', stopPlayback);
  // 兼容早期调用方：从 body 或 query 补齐 deviceId/channelId。
  app.post('/api/dcim-video/playback/stop/:streamId', stopPlayback);

  app.post('/api/dcim-video/playback/control/:streamId/:cmd', async function (req, res) {
    const sid = encodeURIComponent(req.params.streamId || '');
    const cmd = String(req.params.cmd || '').trim().toLowerCase();
    const value = String((req.body && req.body.value) || req.query.value || '').trim();
    let u = '';
    if (cmd === 'pause') u = '/api/playback/pause/' + sid;
    else if (cmd === 'resume' || cmd === 'play') u = '/api/playback/resume/' + sid;
    else if (cmd === 'seek' && value) u = '/api/playback/seek/' + sid + '/' + encodeURIComponent(value);
    else if ((cmd === 'speed' || cmd === 'fastforward') && value) u = '/api/playback/speed/' + sid + '/' + encodeURIComponent(value);
    else return res.status(400).json({ ok: false, message: '不支持的回放控制命令或缺少 value' });
    const r = await callWithAuth('GET', u, null);
    res.json({ ok: playbackActionOk(r), message: (r.data && r.data.msg) || r.message || '', data: r.data && r.data.data });
  });

  // /media-dcim/* 反代到 dcim 容器内 ZLM HTTP 80（host:80 → docker-proxy → 容器:80 → ZLM）
  const mediaProxyDcim = httpProxy.createProxyServer({
    target: 'http://127.0.0.1:80',
    changeOrigin: false, ws: false,
    proxyTimeout: 60000, timeout: 60000,
  });
  mediaProxyDcim.on('error', function (err, _req, res2) {
    if (res2 && !res2.headersSent) {
      try {
        res2.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res2.end(JSON.stringify({ ok: false, msg: 'dcim ZLM 不可达：' + err.message }));
      } catch (_e) {}
    }
  });
  app.all(/^\/media-dcim(\/.*)?$/, function (req, res) {
    req.url = req.url.replace(/^\/media-dcim/, '') || '/';
    mediaProxyDcim.web(req, res);
  });

  appendLog('dcim-video reverse proxy ready, apiBase=' + cfg.apiBase);
})();

// ===================== webssh 自己 wvp 反代（5070 那套）=====================
// 跟 setupDcimVideo 对称：webssh-wvp 监听 18082 HTTP（application-webssh.yml 里
// server.ssl.enabled: false）。让前端 video/ 子站可以切换查看两套数据：
// - /api/dcim-video/*    → dcim 容器内 wvp:18080 (HTTPS)，5060 SIP 注册的设备
// - /api/webssh-video/*  → webssh-wvp:18082 (HTTP)，5070 SIP 注册的设备
(function setupWebsshVideo() {
  const path = require('path');
  const httpMod = require('http');

  const CONFIG_PATH = process.env.WEBSSH_VIDEO_CONFIG || path.join(__dirname, 'config', 'webssh-video.json');
  const LOG_PATH = process.env.WEBSSH_VIDEO_LOG || path.join(__dirname, 'logs', 'webssh-video.log');

  const defaults = {
    apiBase: 'http://127.0.0.1:18082',
    username: 'admin',
    // wvp_webssh.wvp_user.password 字段（schema 从 dcim 同步过来，admin 用同样 hash）
    passwordHash: '551c76780e34e1c1fab9ff85dfc79947',
    timeoutMs: 6000,
  };

  let cfg = JSON.parse(JSON.stringify(defaults));
  function readCfg() {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = Object.assign({}, defaults, raw);
    } catch (_e) { cfg = JSON.parse(JSON.stringify(defaults)); }
  }
  readCfg();

  function localStamp() {
    const d = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, '[' + localStamp() + '] ' + line + '\n', 'utf8');
    } catch (_e) {}
  }

  const wsAgent = new httpMod.Agent({ keepAlive: true });
  let cachedToken = '';
  let lastLoginAt = 0;
  let lastError = '';

  function wsRequest(method, urlPath, headers, body) {
    return new Promise(function (resolve) {
      let urlObj;
      try { urlObj = new URL(urlPath, cfg.apiBase); }
      catch (e) { return resolve({ ok: false, status: 0, message: 'URL 构造失败：' + e.message }); }
      const buf = body ? Buffer.from(body, 'utf8') : Buffer.alloc(0);
      const reqOptions = {
        method: method,
        hostname: urlObj.hostname,
        port: urlObj.port || 80,
        path: urlObj.pathname + (urlObj.search || ''),
        agent: wsAgent,
        timeout: cfg.timeoutMs || 6000,
        headers: Object.assign({}, headers || {}),
      };
      if (buf.length) {
        reqOptions.headers['content-type'] = reqOptions.headers['content-type'] || 'application/json;charset=utf-8';
        reqOptions.headers['content-length'] = buf.length;
      }
      const req = httpMod.request(reqOptions, function (res) {
        const chunks = [];
        res.on('data', function (d) { chunks.push(d); });
        res.on('end', function () {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(text); } catch (_e) { data = text; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, data: data });
        });
      });
      req.on('timeout', function () {
        try { req.destroy(new Error('timeout ' + (cfg.timeoutMs || 6000) + 'ms')); } catch (_e) {}
      });
      req.on('error', function (err) {
        lastError = method + ' ' + urlPath + ': ' + err.message;
        resolve({ ok: false, status: 0, message: err.message });
      });
      if (buf.length) req.write(buf);
      req.end();
    });
  }

  async function loginWvp() {
    const u = '/api/user/login?username=' + encodeURIComponent(cfg.username)
      + '&password=' + encodeURIComponent(cfg.passwordHash);
    const r = await wsRequest('GET', u, {}, null);
    if (r.ok && r.data && r.data.code === 0 && r.data.data && r.data.data.accessToken) {
      cachedToken = r.data.data.accessToken;
      lastLoginAt = Date.now();
      appendLog('login ok, token len=' + cachedToken.length);
      return true;
    }
    lastError = 'login failed: status=' + r.status + ' code=' + (r.data && r.data.code);
    appendLog(lastError);
    cachedToken = '';
    return false;
  }

  async function callWithAuth(method, urlPath, body) {
    if (!cachedToken) { await loginWvp(); }
    let r = await wsRequest(method, urlPath, { 'access-token': cachedToken }, body);
    if (r.status === 401 || (r.data && r.data.code === -1) || (r.data && r.data.code === -2)) {
      const ok = await loginWvp();
      if (ok) r = await wsRequest(method, urlPath, { 'access-token': cachedToken }, body);
    }
    appendLog(method + ' ' + urlPath + ' -> status=' + r.status);
    return r;
  }

  app.get('/api/webssh-video/status', async function (_req, res) {
    const r = await callWithAuth('GET', '/api/server/version', null);
    res.json({
      ok: true,
      reachable: r.ok,
      status: r.status,
      version: (r.ok && r.data && r.data.data && r.data.data.version) || '',
      hasToken: !!cachedToken,
      lastLoginAt: lastLoginAt,
      lastError: lastError,
      config: { apiBase: cfg.apiBase, username: cfg.username, hasPasswordHash: !!cfg.passwordHash, timeoutMs: cfg.timeoutMs },
    });
  });

  registerVideoSystemConfigRoute(app, {
    path: '/api/webssh-video/config',
    callWithAuth: callWithAuth,
    sanitizeSystemConfig: sanitizeDcimVideoSystemConfig,
  });

  app.get('/api/webssh-video/devices', async function (req, res) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const count = Math.min(200, Math.max(1, parseInt(req.query.count, 10) || 50));
    const u = '/api/device/query/devices?page=' + page + '&count=' + count;
    const r = await callWithAuth('GET', u, null);
    if (!r.ok) return res.json({ ok: false, message: r.message || ('上游返回 ' + r.status), data: r.data });
    const d = (r.data && r.data.data) || {};
    res.json({ ok: true, total: d.total || 0, list: d.list || [] });
  });

  app.get('/api/webssh-video/channels', async function (req, res) {
    const deviceId = String(req.query.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ ok: false, message: 'deviceId 必填' });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const count = Math.min(500, Math.max(1, parseInt(req.query.count, 10) || 100));
    const u = '/api/device/query/devices/' + encodeURIComponent(deviceId) + '/channels?page=' + page + '&count=' + count;
    const r = await callWithAuth('GET', u, null);
    if (!r.ok) return res.json({ ok: false, message: r.message || ('上游返回 ' + r.status), data: r.data });
    const d = (r.data && r.data.data) || {};
    res.json({ ok: true, total: d.total || 0, list: d.list || [] });
  });

  // ---------- 实时点播 / 停止 / 回放（走 wvp /api/play /api/playback）----------
  // 把 wvp 返回的 flv URL（http://stream-ip:zlm-port/...）改写成 /media-webssh/*
  // 让浏览器同源走 webssh 反代，复用 webssh 登录态，避开自签证书 / 跨端口问题
  function rewriteToProxy(url) {
    if (!url) return '';
    return String(url).replace(/^(https?:)?\/\/[^/]+/, '/media-webssh');
  }

  registerLivePlaybackRoutes(app, {
    source: 'webssh',
    pathPrefix: '/api/webssh-video',
    liveGenerations: liveStreamGenerations,
    callWithAuth: callWithAuth,
    rewriteToProxy: rewriteToProxy,
    includeMediaServerId: true,
  });

  app.post('/api/webssh-video/playback/start/:deviceId/:channelId', async function (req, res) {
    const did = encodeURIComponent(req.params.deviceId || '');
    const cid = encodeURIComponent(req.params.channelId || '');
    const startTime = String((req.body && req.body.startTime) || req.query.startTime || '');
    const endTime = String((req.body && req.body.endTime) || req.query.endTime || '');
    if (!startTime || !endTime) return res.status(400).json({ ok: false, message: 'startTime/endTime 必填（YYYY-MM-DDTHH:mm:ss）' });
    const u = '/api/playback/start/' + did + '/' + cid + '?startTime=' + encodeURIComponent(startTime) + '&endTime=' + encodeURIComponent(endTime);
    const r = await callWithAuth('GET', u, null);
    if (!r.ok || !r.data || r.data.code !== 0) {
      return res.json({ ok: false, status: r.status, message: (r.data && r.data.msg) || r.message || ('上游返回 ' + r.status), raw: r.data });
    }
    const d = r.data.data || {};
    res.json({
      ok: true,
      streamKey: (d.app || 'rtp') + '/' + (d.stream || ''),
      flvUrl: rewriteToProxy(d.flv),
      hlsUrl: rewriteToProxy(d.hls),
      ssrc: d.ssrc || '',
      app: d.app || 'rtp',
      stream: d.stream || '',
    });
  });

  function playbackActionOk(r) {
    const nestedStatus = r.data && r.data.data && Number(r.data.data.status);
    return !!(r.ok && r.data && r.data.code === 0 && !(nestedStatus >= 400));
  }

  async function stopPlayback(req, res) {
    const body = req.body || {};
    const did = encodeURIComponent(req.params.deviceId || body.deviceId || req.query.deviceId || '');
    const cid = encodeURIComponent(req.params.channelId || body.channelId || req.query.channelId || '');
    const sid = encodeURIComponent(req.params.streamId || '');
    if (!did || !cid || !sid) {
      return res.status(400).json({ ok: false, message: 'deviceId/channelId/streamId 必填' });
    }
    const r = await callWithAuth('GET', '/api/playback/stop/' + did + '/' + cid + '/' + sid, null);
    res.json({ ok: playbackActionOk(r), message: (r.data && r.data.msg) || r.message || '' });
  }
  app.post('/api/webssh-video/playback/stop/:deviceId/:channelId/:streamId', stopPlayback);
  // 兼容早期调用方：从 body 或 query 补齐 deviceId/channelId。
  app.post('/api/webssh-video/playback/stop/:streamId', stopPlayback);

  // WVP 2.6.9 为暂停、恢复、拖动和倍速分别提供独立路由。
  app.post('/api/webssh-video/playback/control/:streamId/:cmd', async function (req, res) {
    const sid = encodeURIComponent(req.params.streamId || '');
    const cmd = String(req.params.cmd || '').trim().toLowerCase();
    const value = String((req.body && req.body.value) || req.query.value || '').trim();
    let u = '';
    if (cmd === 'pause') u = '/api/playback/pause/' + sid;
    else if (cmd === 'resume' || cmd === 'play') u = '/api/playback/resume/' + sid;
    else if (cmd === 'seek' && value) u = '/api/playback/seek/' + sid + '/' + encodeURIComponent(value);
    else if ((cmd === 'speed' || cmd === 'fastforward') && value) u = '/api/playback/speed/' + sid + '/' + encodeURIComponent(value);
    else return res.status(400).json({ ok: false, message: '不支持的回放控制命令或缺少 value' });
    const r = await callWithAuth('GET', u, null);
    res.json({ ok: playbackActionOk(r), message: (r.data && r.data.msg) || r.message || '', data: r.data && r.data.data });
  });

  // ---------- /media-webssh/* 反代到 webssh-mediaserver ZLM 18180 ----------
  const mediaProxyWebssh = httpProxy.createProxyServer({
    target: 'http://127.0.0.1:18180',
    changeOrigin: false, ws: false,
    proxyTimeout: 60000, timeout: 60000,
  });
  mediaProxyWebssh.on('error', function (err, _req, res2) {
    if (res2 && !res2.headersSent) {
      try {
        res2.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res2.end(JSON.stringify({ ok: false, msg: 'webssh 媒体服务未启动或无响应：' + err.message }));
      } catch (_e) {}
    }
  });
  app.all(/^\/media-webssh(\/.*)?$/, function (req, res) {
    req.url = req.url.replace(/^\/media-webssh/, '') || '/';
    mediaProxyWebssh.web(req, res);
  });

  appendLog('webssh-video reverse proxy ready, apiBase=' + cfg.apiBase);
})();

// ===== 协议转换 → IEC 60870-5-104 转发 =====
// 数据来源复用 setupModbusBridge.cfg.selectedDevices（不重复维护设备列表）
// 本期只做服务端 + 仅监视方向：
//   - U-frame: STARTDT_ACT/STOPDT_ACT/TESTFR_ACT 握手与心跳
//   - I-frame: M_SP_NA_1（开关量 → 遥信）+ M_ME_NC_1（模拟量 → 遥测短浮点）
//   - C_IC_NA_1: 总召唤 → 全量推送一遍 + ACTTERM
//   - 遥控类 C_SC/DC/RC/SE_*_1 一律回 negative ACT_CON（本期不做遥控）
// 编址：遥信、遥测两段 IOA 各自独立起始点号（cfg.ioaBase.singlePoint / measuredFloat），
//      DeviceStatus 视为开关量并入遥信段。
(function setupIec104Bridge() {
  const path = require('path');

  const CONFIG_PATH = process.env.IEC104_CONFIG || path.join(__dirname, 'config', 'proto-conv-iec104.json');
  const LOG_PATH = process.env.IEC104_LOG || path.join(__dirname, 'logs', 'proto-conv-iec104.log');

  const defaults = {
    enabled: false,
    port: 2405,             // 默认 2405（避开 dcim/其他系统可能占用的标准 2404）
    commonAddr: 1,          // ASDU 公共地址（站号），16 位
    cotSize: 2,             // 传送原因字节数：固定 2（含源发地址）
    caSize: 2,              // 公共地址字节数：固定 2
    ioaSize: 3,             // 信息对象地址字节数：固定 3
    k: 12,                  // 最大未确认 I-frame 数（IEC 104 规约推荐 12）
    w: 8,                   // 接收方累计未确认 I-frame 后必发 S-frame
    t1Sec: 30,              // 发送或测试 APDU 的超时（默认 30s，规约推荐 15s 但要 >= 客户端 t2 避免抢断）
    t2Sec: 10,              // 无数据时的确认超时（必须 t2 < t1）
    t3Sec: 20,              // 长闲置情况下的测试帧超时
    cyclicIntervalSec: 30,  // 周期上送间隔（秒）
    enableSpont: true,      // 变化数据主动上送（COT=3 SPONT），由 modbus 轮询触发
    deadbandFloat: 0.01,    // 模拟量死区：变化幅度 ≥ 此值才视为"有变化"，避免浮点抖动刷屏
    ipWhitelist: [],
    ioaBase: {
      singlePoint: 1,       // 遥信段起始点号（M_SP_NA_1）
      measuredFloat: 16385, // 遥测段起始点号（M_ME_NC_1，0x4001 行业惯例）
    },
  };

  let cfg = JSON.parse(JSON.stringify(defaults));
  function readCfg() {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = Object.assign({}, defaults, raw);
      cfg.ioaBase = Object.assign({}, defaults.ioaBase, raw.ioaBase || {});
      if (!Array.isArray(cfg.ipWhitelist)) cfg.ipWhitelist = [];
    } catch (_e) {
      cfg = JSON.parse(JSON.stringify(defaults));
    }
  }
  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_e) {}
    } catch (err) { console.error('[iec104] 写配置失败:', err.message); }
  }
  readCfg();

  function localStamp() {
    const d = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, '[' + localStamp() + '] ' + line + '\n', 'utf8');
    } catch (_e) {}
  }

  // ----- 协议常量（参考 mujave/iec104 constant/Ti.java、Cot.java、UFrameControlType.java）-----
  const TI = { M_SP_NA_1: 1, M_ME_NC_1: 13, C_SC_NA_1: 45, C_DC_NA_1: 46, C_RC_NA_1: 47,
    C_SE_NA_1: 48, C_SE_NB_1: 49, C_SE_NC_1: 50, C_IC_NA_1: 100, C_CI_NA_1: 101, C_CS_NA_1: 103 };
  const COT = { PER_CYC: 1, BACK: 2, SPONT: 3, INIT: 4, REQ: 5,
    ACT: 6, ACTCON: 7, DEACT: 8, DEACTCON: 9, ACTTERM: 10,
    INTROGEN: 20,
    UNKNOWN_TYPE: 44, UNKNOWN_COT: 45, UNKNOWN_CA: 46, UNKNOWN_IOA: 47 };
  const U_FRAME = {
    STARTDT_ACT: 0x07, STARTDT_CON: 0x0B,
    STOPDT_ACT:  0x13, STOPDT_CON:  0x23,
    TESTFR_ACT:  0x43, TESTFR_CON:  0x83,
  };

  // ----- 点表 -----
  // pointList：紧凑映射表，按设备顺序展开
  //   [{ ioa, ti: M_SP_NA_1|M_ME_NC_1, kind: 'DeviceStatus'|'CurValue', deviceId, deviceName, paraName, unit, dataType, modbusAddr }]
  let pointList = [];
  let ioaIndex = {}; // ioa -> point（便于快速查找）
  let lastSentValues = {}; // ioa -> { value, invalid }，SPONT 比对基线

  function buildPointList() {
    pointList = [];
    ioaIndex = {};
    lastSentValues = {}; // 点表重建后基线作废，下一轮 syncFromHolding 会重新初始化
    const mbCfg = (global.__modbus && global.__modbus.getCfg && global.__modbus.getCfg()) || {};
    const mapping = (global.__modbus && global.__modbus.getMapping && global.__modbus.getMapping()) || [];
    const devices = mbCfg.selectedDevices || [];

    // 把 modbus mapping 数据段按 deviceId 分组（拿到每个点在 holding buffer 里的地址）
    const dataByDevice = {};
    mapping.forEach(function (m) {
      if (m.segment !== 'data') return;
      (dataByDevice[m.deviceId] = dataByDevice[m.deviceId] || []).push(m);
    });

    let spIoa = (cfg.ioaBase && cfg.ioaBase.singlePoint) || 1;
    let mfIoa = (cfg.ioaBase && cfg.ioaBase.measuredFloat) || 16385;

    devices.forEach(function (dev) {
      const items = dataByDevice[dev.deviceId] || [];
      // 1. 设备状态视为遥信
      const dsItem = items.find(function (m) { return m.kind === 'DeviceStatus'; });
      if (dsItem) {
        const p = {
          ioa: spIoa++, ti: TI.M_SP_NA_1, kind: 'DeviceStatus',
          deviceId: dev.deviceId, deviceName: dev.deviceName,
          paraName: '在线状态', unit: '', dataType: '开关量',
          modbusAddr: dsItem.addr, modbusLen: dsItem.len,
        };
        pointList.push(p);
        ioaIndex[p.ioa] = p;
      }
      // 2. 参数按 dataType 分流：开关量 → 遥信，模拟量（含其他）→ 遥测短浮点
      (dev.params || []).forEach(function (param) {
        const dt = String(param.dataType == null ? '' : param.dataType);
        const pmap = items.find(function (m) {
          return m.kind === 'CurValue' && m.paraName === param.paraName;
        });
        if (!pmap) return;
        const isSP = (dt === '开关量');
        const p = {
          ioa: isSP ? spIoa++ : mfIoa++,
          ti: isSP ? TI.M_SP_NA_1 : TI.M_ME_NC_1,
          kind: 'CurValue',
          deviceId: dev.deviceId, deviceName: dev.deviceName,
          paraName: param.paraName, unit: param.unit || '',
          dataType: dt || '模拟量',
          modbusAddr: pmap.addr, modbusLen: pmap.len,
        };
        pointList.push(p);
        ioaIndex[p.ioa] = p;
      });
    });

    status.pointCount = pointList.length;
    status.singlePointCount = pointList.filter(function (p) { return p.ti === TI.M_SP_NA_1; }).length;
    status.measuredFloatCount = pointList.filter(function (p) { return p.ti === TI.M_ME_NC_1; }).length;
    status.deviceCount = devices.length;
    return pointList.length;
  }

  function readPointValue(p) {
    const holding = global.__modbus && global.__modbus.getHolding && global.__modbus.getHolding();
    if (!holding || p.modbusAddr == null) {
      return p.ti === TI.M_SP_NA_1 ? { value: 0, invalid: true } : { value: NaN, invalid: true };
    }
    if (p.ti === TI.M_SP_NA_1) {
      // 开关量在 holding 里有两种存储：
      //   DeviceStatus：1 个寄存器，INT16（1=在线 / 0=离线 / -1=未知）
      //   开关量参数（CurValue, dataType="开关量"）：2 个寄存器，FLOAT32 BE（同模拟量格式，但值通常是 0.0/1.0）
      // 用 modbusLen 区分；不命中长度时按 INT16 兜底。
      if (p.modbusLen === 2) {
        if ((p.modbusAddr + 2) * 2 > holding.length) return { value: 0, invalid: true };
        const f = holding.readFloatBE(p.modbusAddr * 2);
        if (!Number.isFinite(f)) return { value: 0, invalid: true };
        // 阈值 0.5：dcim 端开关量上送 0.0/1.0 居多，留点余量给 0.99 这类舍入
        return { value: f >= 0.5 ? 1 : 0, invalid: false };
      }
      if ((p.modbusAddr + 1) * 2 > holding.length) return { value: 0, invalid: true };
      const v = holding.readInt16BE(p.modbusAddr * 2);
      if (v === 1) return { value: 1, invalid: false };
      if (v === 0) return { value: 0, invalid: false };
      return { value: 0, invalid: true };
    }
    // M_ME_NC_1：FLOAT32 BE
    if ((p.modbusAddr + 2) * 2 > holding.length) return { value: NaN, invalid: true };
    const f = holding.readFloatBE(p.modbusAddr * 2);
    if (!Number.isFinite(f)) return { value: 0, invalid: true };
    return { value: f, invalid: false };
  }

  // ----- APCI 编解码 -----
  // I-frame: c1 bit0=0；S-frame: c1=0x01；U-frame: c1 低 2 位 = 11
  function encodeIFrame(sendSeq, recvSeq, asdu) {
    const len = asdu.length + 4;
    if (len > 253) throw new Error('APDU 超长 ' + len);
    const buf = Buffer.alloc(6 + asdu.length);
    buf[0] = 0x68; buf[1] = len;
    // 发送序号 N(S) 左移 1 位，bit0=0 标记 I-frame
    buf[2] = (sendSeq << 1) & 0xFE;
    buf[3] = (sendSeq >> 7) & 0xFF;
    buf[4] = (recvSeq << 1) & 0xFE;
    buf[5] = (recvSeq >> 7) & 0xFF;
    asdu.copy(buf, 6);
    return buf;
  }
  function encodeSFrame(recvSeq) {
    const buf = Buffer.alloc(6);
    buf[0] = 0x68; buf[1] = 4;
    buf[2] = 0x01; buf[3] = 0x00;
    buf[4] = (recvSeq << 1) & 0xFE;
    buf[5] = (recvSeq >> 7) & 0xFF;
    return buf;
  }
  function encodeUFrame(uType) {
    return Buffer.from([0x68, 4, uType, 0, 0, 0]);
  }
  function parseAPCI(buf) {
    if (buf.length < 6 || buf[0] !== 0x68) throw new Error('bad APCI start');
    const len = buf[1];
    const c1 = buf[2], c2 = buf[3], c3 = buf[4], c4 = buf[5];
    if ((c1 & 0x01) === 0) {
      return { type: 'I', len: len, sendSeq: ((c2 << 7) | (c1 >> 1)) & 0x7FFF,
        recvSeq: ((c4 << 7) | (c3 >> 1)) & 0x7FFF, asduLen: len - 4 };
    }
    if ((c1 & 0x03) === 0x01) {
      return { type: 'S', len: len, recvSeq: ((c4 << 7) | (c3 >> 1)) & 0x7FFF };
    }
    return { type: 'U', len: len, uType: c1 };
  }

  // ----- ASDU 编码 -----
  // ASDU 格式：[TI][VSQ][COT-2字节][CA-2字节][IO信息对象组...]
  // VSQ = SQ(bit7) | N(bit6..0)；本实现 SQ=0（每个 IO 各自带 IOA）便于稀疏点表
  function writeIoa(buf, off, ioa) {
    buf[off]   = ioa & 0xFF;
    buf[off+1] = (ioa >> 8) & 0xFF;
    buf[off+2] = (ioa >> 16) & 0xFF;
  }
  function buildAsduHeader(ti, n, cot, ca) {
    const h = Buffer.alloc(6);
    h[0] = ti; h[1] = n & 0x7F;       // SQ=0
    h[2] = cot & 0xFF; h[3] = 0x00;   // 源发地址留 0
    h[4] = ca & 0xFF; h[5] = (ca >> 8) & 0xFF;
    return h;
  }
  // M_SP_NA_1：每个 IO = 3字节 IOA + 1字节 SIQ（bit0=SPI；IV/NT/SB/BL 标志位 4..7）
  function buildAsduSP(points, cot, ca) {
    const n = points.length;
    const h = buildAsduHeader(TI.M_SP_NA_1, n, cot, ca);
    const body = Buffer.alloc(n * 4);
    let off = 0;
    points.forEach(function (it) {
      writeIoa(body, off, it.point.ioa);
      let siq = (it.value === 1) ? 0x01 : 0x00;
      if (it.invalid) siq |= 0x80;    // IV
      body[off + 3] = siq;
      off += 4;
    });
    return Buffer.concat([h, body]);
  }
  // M_ME_NC_1：每个 IO = 3字节 IOA + 4字节 IEEE-754 短浮点（小端）+ 1字节 QDS
  function buildAsduMF(points, cot, ca) {
    const n = points.length;
    const h = buildAsduHeader(TI.M_ME_NC_1, n, cot, ca);
    const body = Buffer.alloc(n * 8);
    let off = 0;
    points.forEach(function (it) {
      writeIoa(body, off, it.point.ioa);
      const f = Number.isFinite(it.value) ? it.value : 0;
      body.writeFloatLE(f, off + 3);
      body[off + 7] = it.invalid ? 0x80 : 0x00;
      off += 8;
    });
    return Buffer.concat([h, body]);
  }
  // C_IC_NA_1 ACTCON / ACTTERM：固定 1 个 IO，IOA=0，QOI=20（站总召唤）
  function buildAsduInterrogationAck(cot, ca, qoi) {
    const h = buildAsduHeader(TI.C_IC_NA_1, 1, cot, ca);
    const body = Buffer.alloc(4);
    writeIoa(body, 0, 0);
    body[3] = qoi & 0xFF;
    return Buffer.concat([h, body]);
  }
  // C_CI_NA_1 ACTCON / ACTTERM：固定 1 个 IO，IOA=0，QCC=5（计数器召唤，1 字节）
  function buildAsduCounterInterrogationAck(cot, ca, qcc) {
    const h = buildAsduHeader(TI.C_CI_NA_1, 1, cot, ca);
    const body = Buffer.alloc(4);
    writeIoa(body, 0, 0);
    body[3] = qcc & 0xFF;
    return Buffer.concat([h, body]);
  }
  // 通用 negative ACT_CON：用于本期不支持的遥控
  function buildAsduNegativeActCon(ti, ioa, ca) {
    const h = buildAsduHeader(ti, 1, COT.ACTCON | 0x40 /* P/N=1 negative */, ca);
    const body = Buffer.alloc(3);
    writeIoa(body, 0, ioa || 0);
    return Buffer.concat([h, body]);
  }

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // ----- 连接会话 -----
  // 每条 master 连接独立维护：sendSeq / recvSeq / inflight / startDt / t1/t2/t3 计时器 / 缓冲区
  function createSession(socket, sessionId) {
    const sess = {
      id: sessionId,
      socket: socket,
      remoteAddr: socket.remoteAddress + ':' + socket.remotePort,
      buf: Buffer.alloc(0),
      sendSeq: 0,            // N(S)：本端待发的下一个 I-frame 序号
      recvSeq: 0,            // N(R)：本端期望对方下一帧的序号 = 已收到的 I-frame 数
      ackSeq: 0,             // 对方已确认到的本端 N(S)
      pendingRecvUnack: 0,   // 收到 I-frame 数累计（≥w 时主动发 S-frame）
      startDt: false,        // 是否处于 STARTDT 数据传输态
      t1Timer: null,         // 等待对方确认 / 测试帧响应
      t2Timer: null,         // S-frame 延迟确认
      t3Timer: null,         // 长闲置测试
      testFrPending: false,
      sentIFrames: 0, recvIFrames: 0,
      txQueue: [],           // 出站 ASDU 队列：inflight ≥ k 时入队，收到 ACK 时 drain
      giInProgress: false,   // 总召唤进行中（防止周期帧抢窗口）
      ciInProgress: false,   // 计数器召唤进行中
      connectAt: localStamp(),
      lastActivityAt: localStamp(),
    };

    function clearT1() { if (sess.t1Timer) { clearTimeout(sess.t1Timer); sess.t1Timer = null; } }
    function clearT2() { if (sess.t2Timer) { clearTimeout(sess.t2Timer); sess.t2Timer = null; } }
    function clearT3() { if (sess.t3Timer) { clearTimeout(sess.t3Timer); sess.t3Timer = null; } }
    function armT3() {
      clearT3();
      sess.t3Timer = setTimeout(function () {
        if (socket.destroyed) return;
        try { socket.write(encodeUFrame(U_FRAME.TESTFR_ACT)); sess.testFrPending = true; armT1(); } catch (_e) {}
      }, (cfg.t3Sec || 20) * 1000);
    }
    function armT1() {
      clearT1();
      sess.t1Timer = setTimeout(function () {
        appendLog('[' + sess.remoteAddr + '] T1 超时（' + (cfg.t1Sec || 30) + 's 未收 ACK），断开');
        try { socket.destroy(); } catch (_e) {}
      }, (cfg.t1Sec || 30) * 1000);
    }
    function armT2() {
      clearT2();
      sess.t2Timer = setTimeout(function () {
        if (socket.destroyed || !sess.startDt) return;
        if (sess.pendingRecvUnack > 0) {
          try { socket.write(encodeSFrame(sess.recvSeq)); sess.pendingRecvUnack = 0; } catch (_e) {}
        }
      }, (cfg.t2Sec || 10) * 1000);
    }
    sess.armT3 = armT3;

    function inflight() {
      let n = sess.sendSeq - sess.ackSeq;
      if (n < 0) n += 0x8000;
      return n;
    }
    sess.canSend = function () { return sess.startDt && inflight() < (cfg.k || 12); };

    // 发送一帧 I-frame；如果 inflight 已满则入队，等收到 ACK 后再 drain
    sess.sendIFrame = function (asdu) {
      if (!sess.startDt) return false;
      sess.txQueue.push(asdu);
      drainQueue();
      return true;
    };

    // 把队列里能发的 I-frame 一次性发出去
    function drainQueue() {
      const k = cfg.k || 12;
      let sent = 0;
      while (sess.txQueue.length > 0 && sess.startDt && inflight() < k) {
        const asdu = sess.txQueue.shift();
        try {
          socket.write(encodeIFrame(sess.sendSeq, sess.recvSeq, asdu));
        } catch (e) {
          appendLog('[' + sess.remoteAddr + '] 发送异常 ' + e.message);
          sess.txQueue.length = 0;
          return;
        }
        sess.sendSeq = (sess.sendSeq + 1) & 0x7FFF;
        sess.sentIFrames += 1;
        status.totalSent += 1;
        sent += 1;
        armT3();
      }
      // 每轮 drain 后：只要还有未确认帧就刷 T1（让 T1 跟最近一次发送对齐，避免被早期 arm 卡住）
      if (sent > 0 && inflight() > 0) armT1();
      if (sess.txQueue.length > 0) {
        // 仅在堆积较多时打日志，避免刷屏
        if (sess.txQueue.length % 5 === 0) {
          appendLog('[' + sess.remoteAddr + '] 队列暂存 ' + sess.txQueue.length + ' 帧（inflight=' + inflight() + '/k=' + k + '）');
        }
      }
    }
    sess.drainQueue = drainQueue;

    function handleAPDU(apdu) {
      sess.lastActivityAt = localStamp();
      let info;
      try { info = parseAPCI(apdu); }
      catch (e) { appendLog('[' + sess.remoteAddr + '] APCI 解析失败: ' + e.message); return; }
      armT3();

      if (info.type === 'U') {
        handleU(info);
      } else if (info.type === 'S') {
        sess.ackSeq = info.recvSeq;
        if (inflight() === 0) clearT1();
        // 收到 ACK，可能腾出 inflight 配额，drain 一次
        drainQueue();
      } else {
        // I-frame
        sess.ackSeq = info.recvSeq;
        if (inflight() === 0) clearT1();
        sess.recvSeq = (info.sendSeq + 1) & 0x7FFF;
        sess.recvIFrames += 1;
        sess.pendingRecvUnack += 1;
        if (sess.pendingRecvUnack >= (cfg.w || 8)) {
          try { socket.write(encodeSFrame(sess.recvSeq)); } catch (_e) {}
          sess.pendingRecvUnack = 0;
          clearT2();
        } else {
          armT2();
        }
        const asdu = apdu.slice(6);
        handleASDU(asdu);
        // ASDU 处理可能产生回包；同时对方 N(R) 也可能腾出配额
        drainQueue();
      }
    }

    function handleU(info) {
      switch (info.uType) {
        case U_FRAME.STARTDT_ACT:
          sess.startDt = true;
          try { socket.write(encodeUFrame(U_FRAME.STARTDT_CON)); } catch (_e) {}
          appendLog('[' + sess.remoteAddr + '] STARTDT_ACT → CON');
          break;
        case U_FRAME.STOPDT_ACT:
          sess.startDt = false;
          try { socket.write(encodeUFrame(U_FRAME.STOPDT_CON)); } catch (_e) {}
          appendLog('[' + sess.remoteAddr + '] STOPDT_ACT → CON');
          break;
        case U_FRAME.TESTFR_ACT:
          try { socket.write(encodeUFrame(U_FRAME.TESTFR_CON)); } catch (_e) {}
          break;
        case U_FRAME.TESTFR_CON:
          sess.testFrPending = false;
          if (inflight() === 0) clearT1();
          break;
        default:
          appendLog('[' + sess.remoteAddr + '] 未知 U-frame 0x' + info.uType.toString(16));
      }
    }

    function handleASDU(asdu) {
      if (asdu.length < 6) return;
      const ti = asdu[0];
      const cot = asdu[2] & 0x3F;
      const ca = asdu[4] | (asdu[5] << 8);
      // 公共地址不匹配 → 回 UNKNOWN_CA（仅对 ACT 类）
      if (ca !== cfg.commonAddr && ca !== 0xFFFF) {
        appendLog('[' + sess.remoteAddr + '] CA 不匹配 got=' + ca + ' expect=' + cfg.commonAddr);
        return;
      }
      if (ti === TI.C_IC_NA_1 && cot === COT.ACT) {
        // 总召唤
        const qoi = asdu.length >= 10 ? asdu[9] : 20;
        appendLog('[' + sess.remoteAddr + '] C_IC_NA_1 ACT QOI=' + qoi + ' → 全量推送');
        // 1) ACT_CON
        sess.sendIFrame(buildAsduInterrogationAck(COT.ACTCON, cfg.commonAddr, qoi));
        // 2) 全量数据（COT=20 INTROGEN）
        sendAllPoints(sess, COT.INTROGEN);
        // 3) ACTTERM（即使 inflight 已满也会进入 txQueue，等 ACK 后由 drainQueue 自动发出）
        sess.sendIFrame(buildAsduInterrogationAck(COT.ACTTERM, cfg.commonAddr, qoi));
        return;
      }
      if (ti === TI.C_CI_NA_1 && cot === COT.ACT) {
        // 计数器召唤：本期不维护计数器，按规约要求回 ACT_CON 然后 ACTTERM（无数据帧）
        const qcc = asdu.length >= 10 ? asdu[9] : 5;
        appendLog('[' + sess.remoteAddr + '] C_CI_NA_1 ACT QCC=' + qcc + ' → 空响应（本期无计数器）');
        sess.sendIFrame(buildAsduCounterInterrogationAck(COT.ACTCON, cfg.commonAddr, qcc));
        sess.sendIFrame(buildAsduCounterInterrogationAck(COT.ACTTERM, cfg.commonAddr, qcc));
        return;
      }
      if (ti === TI.C_CS_NA_1 && cot === COT.ACT) {
        // 时钟同步：本期不实际同步，回 ACT_CON（带原 IO 但忽略时间值）
        const ack = buildAsduHeader(TI.C_CS_NA_1, 1, COT.ACTCON, cfg.commonAddr);
        const body = Buffer.alloc(10);
        if (asdu.length >= 16) asdu.copy(body, 0, 6, 16);
        sess.sendIFrame(Buffer.concat([ack, body]));
        return;
      }
      // 遥控类：本期一律拒绝
      if (ti === TI.C_SC_NA_1 || ti === TI.C_DC_NA_1 || ti === TI.C_RC_NA_1 ||
          ti === TI.C_SE_NA_1 || ti === TI.C_SE_NB_1 || ti === TI.C_SE_NC_1) {
        const ioa = asdu[6] | (asdu[7] << 8) | (asdu[8] << 16);
        appendLog('[' + sess.remoteAddr + '] 收到遥控 TI=' + ti + ' IOA=' + ioa + '，回 negative ACT_CON');
        sess.sendIFrame(buildAsduNegativeActCon(ti, ioa, cfg.commonAddr));
        return;
      }
      appendLog('[' + sess.remoteAddr + '] 未处理 ASDU TI=' + ti + ' COT=' + cot);
    }

    sess.handle = function (chunkBuf) {
      sess.buf = Buffer.concat([sess.buf, chunkBuf]);
      while (sess.buf.length >= 2) {
        if (sess.buf[0] !== 0x68) {
          appendLog('[' + sess.remoteAddr + '] 同步丢失，丢弃 1 字节');
          sess.buf = sess.buf.slice(1);
          continue;
        }
        const apduLen = sess.buf[1] + 2;
        if (sess.buf.length < apduLen) break;
        const apdu = sess.buf.slice(0, apduLen);
        sess.buf = sess.buf.slice(apduLen);
        handleAPDU(apdu);
      }
    };

    sess.cleanup = function () {
      clearT1(); clearT2(); clearT3();
    };

    armT3();
    return sess;
  }

  function sendAllPoints(sess, cot) {
    if (!sess || !sess.startDt) return;
    if (pointList.length === 0) buildPointList();
    const sps = [], mfs = [];
    pointList.forEach(function (p) {
      const v = readPointValue(p);
      if (p.ti === TI.M_SP_NA_1) sps.push({ point: p, value: v.value, invalid: v.invalid });
      else if (p.ti === TI.M_ME_NC_1) mfs.push({ point: p, value: v.value, invalid: v.invalid });
    });
    // APDU 长度上限 253 → ASDU 上限 249，N=127 时 SP 仅需 6+127*4=514（超）
    // 安全分块：SP 50 个/帧（206B），MF 25 个/帧（206B）
    chunk(sps, 50).forEach(function (g) { sess.sendIFrame(buildAsduSP(g, cot, cfg.commonAddr)); });
    chunk(mfs, 25).forEach(function (g) { sess.sendIFrame(buildAsduMF(g, cot, cfg.commonAddr)); });
  }

  // ----- TCP server -----
  let netServer = null;
  let sessions = {};
  let nextSessionId = 1;
  let cyclicTimer = null;
  const status = {
    running: false, port: 0,
    deviceCount: 0, pointCount: 0, singlePointCount: 0, measuredFloatCount: 0,
    clientCount: 0, totalSent: 0, totalSpont: 0,
    lastSyncAt: '', lastSpontAt: '', lastError: '',
  };

  function stopServer() {
    if (cyclicTimer) { clearInterval(cyclicTimer); cyclicTimer = null; }
    Object.keys(sessions).forEach(function (id) {
      try { sessions[id].cleanup(); sessions[id].socket.destroy(); } catch (_e) {}
    });
    sessions = {};
    if (netServer) {
      try { netServer.close(); } catch (_e) {}
      netServer = null;
    }
    status.running = false;
    status.port = 0;
    status.clientCount = 0;
    appendLog('IEC104 server stopped');
  }

  function startServer() {
    if (netServer) stopServer();
    if (!cfg.enabled) return;
    buildPointList();
    if (pointList.length === 0) {
      status.lastError = '无可暴露的点（请先在「Modbus 转发」选设备）';
      appendLog('启动失败：' + status.lastError);
      return;
    }
    netServer = net.createServer(function (socket) {
      const srcIp = socket.remoteAddress;
      if (cfg.ipWhitelist && cfg.ipWhitelist.length) {
        const ok = cfg.ipWhitelist.some(function (w) { return srcIp === w || srcIp === '::ffff:' + w; });
        if (!ok) {
          appendLog('IP 拦截 src=' + srcIp);
          try { socket.destroy(); } catch (_e) {}
          return;
        }
      }
      const id = nextSessionId++;
      const sess = createSession(socket, id);
      sessions[id] = sess;
      status.clientCount = Object.keys(sessions).length;
      appendLog('[' + sess.remoteAddr + '] 连接接入 session=' + id);

      socket.on('data', function (b) { try { sess.handle(b); } catch (e) { appendLog('handle err: ' + e.message); } });
      socket.on('close', function () {
        sess.cleanup();
        delete sessions[id];
        status.clientCount = Object.keys(sessions).length;
        appendLog('[' + sess.remoteAddr + '] 断开 session=' + id +
          ' sentI=' + sess.sentIFrames + ' recvI=' + sess.recvIFrames);
      });
      socket.on('error', function (err) {
        appendLog('[' + sess.remoteAddr + '] socket error: ' + err.message);
      });
    });
    netServer.on('error', function (err) {
      status.lastError = err.message;
      status.running = false;
      appendLog('netServer error: ' + err.message);
    });
    netServer.listen(cfg.port, '0.0.0.0', function () {
      status.running = true;
      status.port = cfg.port;
      status.lastError = '';
      appendLog('IEC104 server listening on 0.0.0.0:' + cfg.port +
        ' points=' + pointList.length +
        ' (SP=' + status.singlePointCount + ' MF=' + status.measuredFloatCount + ')');
    });
    // 周期上送：只检查 txQueue 是否为空（避免新批次叠在没消化的旧批次上），
    // 不检查 inflight——客户端按 w=8 边界 ACK 时 inflight 几乎永远 > 0，
    // 卡 inflight 会让周期帧永远轮不上。流控由 drainQueue 的 k 上限保证。
    cyclicTimer = setInterval(function () {
      try {
        Object.keys(sessions).forEach(function (id) {
          const s = sessions[id];
          if (!s || !s.startDt) return;
          if (s.txQueue && s.txQueue.length > 0) return;
          sendAllPoints(s, COT.PER_CYC);
        });
        status.lastSyncAt = localStamp();
      } catch (e) { appendLog('cyclic err: ' + e.message); }
    }, Math.max(1, cfg.cyclicIntervalSec || 30) * 1000);
  }

  // 由 setupModbusBridge.pollOnce 末尾调用（周期 = cfg.pollIntervalSec，默认 5s）：
  // 比对 holding buffer 当前值与上一次基线，找出变化点，以 COT=3 SPONT 主动推给所有 STARTDT 在线会话。
  // - 开关量：值翻转或 IV 标志变化即推
  // - 模拟量：|cur - prev| ≥ deadbandFloat 才推；IV 标志变化也推
  // - 第一次调用：仅初始化基线，不发 SPONT（避免启动时刷一波）
  // - 没有 STARTDT 在线会话时跳过比对（节省 CPU；下次有人接入时初始化基线）
  function syncFromHolding() {
    status.lastSyncAt = localStamp();
    if (!cfg.enableSpont) return;
    if (!pointList || pointList.length === 0) return;

    const activeSessions = Object.keys(sessions).filter(function (id) {
      return sessions[id] && sessions[id].startDt;
    });
    if (activeSessions.length === 0) {
      // 无在线 master：基线作废，下次再初始化（避免后续连接进来后误把"启动以来累积的变化"全推一遍）
      lastSentValues = {};
      return;
    }

    // 第一次：初始化基线，不发 SPONT
    if (Object.keys(lastSentValues).length === 0) {
      pointList.forEach(function (p) {
        const v = readPointValue(p);
        lastSentValues[p.ioa] = { value: v.value, invalid: v.invalid };
      });
      return;
    }

    const deadband = (cfg.deadbandFloat != null) ? Number(cfg.deadbandFloat) : 0.01;
    const changedSps = [];
    const changedMfs = [];

    pointList.forEach(function (p) {
      const cur = readPointValue(p);
      const prev = lastSentValues[p.ioa];
      let changed = false;
      if (!prev) {
        changed = true;
      } else if (cur.invalid !== prev.invalid) {
        changed = true;
      } else if (p.ti === TI.M_SP_NA_1) {
        if (cur.value !== prev.value) changed = true;
      } else {
        // 模拟量：当前有效时按死区比较；都无效时不算变化
        if (!cur.invalid && Math.abs(cur.value - prev.value) >= deadband) changed = true;
      }
      if (changed) {
        lastSentValues[p.ioa] = { value: cur.value, invalid: cur.invalid };
        const item = { point: p, value: cur.value, invalid: cur.invalid };
        if (p.ti === TI.M_SP_NA_1) changedSps.push(item);
        else if (p.ti === TI.M_ME_NC_1) changedMfs.push(item);
      }
    });

    const totalChanged = changedSps.length + changedMfs.length;
    if (totalChanged === 0) return;

    appendLog('SPONT 检测到变化：SP=' + changedSps.length + ' MF=' + changedMfs.length +
      ' → 推 ' + activeSessions.length + ' 个会话');
    status.totalSpont += totalChanged;
    status.lastSpontAt = localStamp();

    activeSessions.forEach(function (id) {
      const s = sessions[id];
      chunk(changedSps, 50).forEach(function (g) {
        s.sendIFrame(buildAsduSP(g, COT.SPONT, cfg.commonAddr));
      });
      chunk(changedMfs, 25).forEach(function (g) {
        s.sendIFrame(buildAsduMF(g, COT.SPONT, cfg.commonAddr));
      });
    });
  }

  // ----- 路由 -----
  function aggregateStatus() {
    const clients = Object.keys(sessions).map(function (id) {
      const s = sessions[id];
      return {
        sessionId: id, remoteAddr: s.remoteAddr,
        startDt: s.startDt,
        sendSeq: s.sendSeq, recvSeq: s.recvSeq, ackSeq: s.ackSeq,
        sentIFrames: s.sentIFrames, recvIFrames: s.recvIFrames,
        connectAt: s.connectAt, lastActivityAt: s.lastActivityAt,
      };
    });
    return Object.assign({}, status, { enabled: !!cfg.enabled, clients: clients });
  }

  app.get('/api/proto-conv/iec104/config', function (_req, res) {
    res.json({ ok: true, config: cfg, status: aggregateStatus() });
  });

  app.put('/api/proto-conv/iec104/config', function (req, res) {
    const b = req.body || {};
    const next = JSON.parse(JSON.stringify(cfg));
    if (typeof b.enabled === 'boolean') next.enabled = b.enabled;
    if (b.port != null) {
      const p = Number(b.port) | 0;
      if (p < 1 || p > 65535) return res.status(400).json({ ok: false, message: 'port 范围 1-65535' });
      next.port = p;
    }
    if (b.commonAddr != null) {
      const c = Number(b.commonAddr) | 0;
      if (c < 1 || c > 65534) return res.status(400).json({ ok: false, message: 'commonAddr 范围 1-65534' });
      next.commonAddr = c;
    }
    if (b.cyclicIntervalSec != null) {
      const s = Number(b.cyclicIntervalSec) | 0;
      if (s < 1 || s > 3600) return res.status(400).json({ ok: false, message: 'cyclicIntervalSec 范围 1-3600' });
      next.cyclicIntervalSec = s;
    }
    if (typeof b.enableSpont === 'boolean') next.enableSpont = b.enableSpont;
    if (b.deadbandFloat != null) {
      const d = Number(b.deadbandFloat);
      if (!Number.isFinite(d) || d < 0 || d > 1e9) {
        return res.status(400).json({ ok: false, message: 'deadbandFloat 必须是 ≥0 的有限数' });
      }
      next.deadbandFloat = d;
    }
    if (b.ioaBase && typeof b.ioaBase === 'object') {
      const sp = Number(b.ioaBase.singlePoint);
      const mf = Number(b.ioaBase.measuredFloat);
      if (Number.isFinite(sp)) {
        if (sp < 1 || sp > 0xFFFFFF) return res.status(400).json({ ok: false, message: '遥信起始点号范围 1-16777215' });
        next.ioaBase.singlePoint = sp | 0;
      }
      if (Number.isFinite(mf)) {
        if (mf < 1 || mf > 0xFFFFFF) return res.status(400).json({ ok: false, message: '遥测起始点号范围 1-16777215' });
        next.ioaBase.measuredFloat = mf | 0;
      }
    }
    if (Array.isArray(b.ipWhitelist)) {
      next.ipWhitelist = b.ipWhitelist
        .map(function (s) { return String(s == null ? '' : s).trim(); })
        .filter(Boolean);
    }
    cfg = next;
    writeCfg();
    appendLog('配置已更新 enabled=' + cfg.enabled + ' port=' + cfg.port +
      ' CA=' + cfg.commonAddr + ' SP起始=' + cfg.ioaBase.singlePoint +
      ' MF起始=' + cfg.ioaBase.measuredFloat + ' cyclic=' + cfg.cyclicIntervalSec + 's');
    stopServer();
    if (cfg.enabled) startServer();
    res.json({ ok: true, config: cfg, status: aggregateStatus() });
  });

  app.post('/api/proto-conv/iec104/start', function (_req, res) {
    cfg.enabled = true; writeCfg();
    stopServer(); startServer();
    res.json({ ok: status.running, status: aggregateStatus(), message: status.lastError || '' });
  });

  app.post('/api/proto-conv/iec104/stop', function (_req, res) {
    cfg.enabled = false; writeCfg();
    stopServer();
    res.json({ ok: true, status: aggregateStatus() });
  });

  app.get('/api/proto-conv/iec104/status', function (_req, res) {
    res.json({ ok: true, status: aggregateStatus() });
  });

  app.get('/api/proto-conv/iec104/clients', function (_req, res) {
    res.json({ ok: true, clients: aggregateStatus().clients });
  });

  // CSV 导出辅助：filter 可选，传入则按 ti 过滤
  function buildPointCsv(filter) {
    buildPointList();
    const lines = ['IOA,类型标识,字段,设备ID,设备名称,参数名,单位,数据类型'];
    const tiName = function (ti) { return ti === TI.M_SP_NA_1 ? 'M_SP_NA_1(遥信)' : (ti === TI.M_ME_NC_1 ? 'M_ME_NC_1(遥测短浮点)' : String(ti)); };
    const csvEsc = function (s) {
      s = String(s == null ? '' : s);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    pointList.forEach(function (p) {
      if (filter && !filter(p)) return;
      lines.push([
        csvEsc(p.ioa), csvEsc(tiName(p.ti)), csvEsc(p.kind),
        csvEsc(p.deviceId), csvEsc(p.deviceName), csvEsc(p.paraName),
        csvEsc(p.unit || ''), csvEsc(p.dataType || ''),
      ].join(','));
    });
    // ﻿ BOM 让 Excel 识别 UTF-8
    return Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
  }
  function sendCsv(res, buf, filename) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.end(buf);
  }

  // 全量点表（保留兼容；UI 用下面两个按类型分的接口）
  app.get('/api/proto-conv/iec104/map.csv', function (_req, res) {
    sendCsv(res, buildPointCsv(null), 'iec104-point-map.csv');
  });

  // 遥信（M_SP_NA_1，含 DeviceStatus 在线状态 + dataType=开关量 的参数）
  app.get('/api/proto-conv/iec104/map-yx.csv', function (_req, res) {
    sendCsv(res, buildPointCsv(function (p) { return p.ti === TI.M_SP_NA_1; }), 'iec104-yx-map.csv');
  });

  // 遥测（M_ME_NC_1，dataType=模拟量 的参数）
  app.get('/api/proto-conv/iec104/map-yc.csv', function (_req, res) {
    sendCsv(res, buildPointCsv(function (p) { return p.ti === TI.M_ME_NC_1; }), 'iec104-yc-map.csv');
  });

  // 自启（等 modbus 先就绪以便 buildPointList 拿到 selectedDevices）
  setTimeout(function () {
    if (cfg.enabled) {
      try { startServer(); } catch (e) { appendLog('自启失败: ' + e.message); }
    }
    appendLog('IEC104 模块就绪 enabled=' + cfg.enabled + ' port=' + cfg.port +
      ' SP起始=' + cfg.ioaBase.singlePoint + ' MF起始=' + cfg.ioaBase.measuredFloat);
  }, 1500);

  global.__iec104 = {
    syncFromHolding: syncFromHolding,
    isEnabled: function () { return !!cfg.enabled; },
    rebuild: function () {
      try { stopServer(); if (cfg.enabled) startServer(); } catch (_e) {}
    },
  };
})();

// ===== 数据库管理板块（Phase A：三库统一管理台）=====
// 通过 SSH 连到 dcim 容器所在的目标机，管理容器内 MySQL / openGauss / 达梦 DM 三套数据库。
// 能力：状态监控、服务启停（含达梦一键启动）、SQL 控制台、备份/还原（导入导出）、库表浏览。
// 后续 Phase B 将追加 dcim 数据源切换（本 IIFE 预留 global.__dbMgr 接口）。
(function setupDbManager() {
  const path = require('path');
  const { spawn } = require('child_process');
  const accessRules = require('./lib/opengauss-access-rules');
  const wvpUtils = require('./lib/dcim-wvp');
  const { createWvpRuntimeOperations } = require('./lib/dcim-wvp-runtime');
  let mysql2, pgLib, dmdbLib;
  try { mysql2 = require('mysql2/promise'); } catch (_e) { mysql2 = null; }
  try { pgLib = require('pg'); } catch (_e) { pgLib = null; }
  try { dmdbLib = require('dmdb'); } catch (_e) { dmdbLib = null; }

  const CONFIG_PATH = process.env.DBMGR_CONFIG || path.join(__dirname, 'config', 'db-manager.json');
  const LOG_PATH    = process.env.DBMGR_LOG    || path.join(__dirname, 'logs', 'db-manager.log');
  const BACKUP_DIR  = process.env.DBMGR_BACKUP_DIR || path.join(__dirname, 'backups', 'db-manager');

  const defaults = {
    ssh: { host: '192.168.0.60', port: 22, username: 'root', password: '' },
    container: 'dcim',
    databases: {
      mysql: {
        enabled: true, host: '192.168.0.60', port: 3333,
        username: 'root', password: '',
        systemdUnit: 'mysqld.service',
        dockerCli: '/www/server/mysql/bin/mysql',
        dockerDump: '/www/server/mysql/bin/mysqldump',
      },
      opengauss: {
        enabled: true, host: '192.168.0.60', port: 5432,
        username: 'omm', password: '', database: 'dcim',
        systemdUnit: 'opengauss.service',
        dockerCli: 'sudo -u omm /opt/software/openGauss/app/bin/gsql',
        dockerDump: 'sudo -u omm /opt/software/openGauss/app/bin/gs_dump',
      },
      dm: {
        enabled: true, host: '192.168.0.60', port: 5236,
        username: 'SYSDBA', password: 'SYSDBA',
        sysdbaPassword: '', // 专用于查询 V$LICENSE 等 SYS 视图；空则等价于用 password 字段
        systemdUnit: 'DmServiceDMSERVER.service',
        dockerCli: '/home/dmdba/dmdbms/bin/disql',
        dockerDump: '/home/dmdba/dmdbms/bin/dexp',
      },
    },
  };

  function deepMerge(target, src) {
    const out = Object.assign({}, target);
    for (const k of Object.keys(src || {})) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
        out[k] = deepMerge(target[k] || {}, src[k]);
      } else { out[k] = src[k]; }
    }
    return out;
  }
  let cfg = JSON.parse(JSON.stringify(defaults));
  function readCfg() {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = deepMerge(defaults, raw);
    } catch (_e) { cfg = JSON.parse(JSON.stringify(defaults)); }
  }
  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_e) {}
    } catch (err) { console.error('[db-manager] 写配置失败:', err.message); }
  }
  function redactDb(db) {
    const out = Object.assign({}, db, {
      password: '***',
      hasPassword: !!(db && db.password && db.password !== ''),
    });
    // DM 专属：sysdba 密码单独脱敏
    if (Object.prototype.hasOwnProperty.call(db || {}, 'sysdbaPassword')) {
      out.sysdbaPassword = '***';
      out.hasSysdbaPassword = !!(db.sysdbaPassword && db.sysdbaPassword !== '');
    }
    return out;
  }
  function redactCfg() {
    return {
      ssh: {
        host: cfg.ssh.host, port: cfg.ssh.port, username: cfg.ssh.username,
        password: '***', hasPassword: !!(cfg.ssh.password && cfg.ssh.password !== ''),
      },
      container: cfg.container,
      databases: {
        mysql: redactDb(cfg.databases.mysql),
        opengauss: redactDb(cfg.databases.opengauss),
        dm: redactDb(cfg.databases.dm),
      },
    };
  }
  readCfg();
  function localStamp() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, '[' + localStamp() + '] ' + line + '\n', 'utf8');
    } catch (_e) {}
  }
  function stampForFile() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // 复用主壳的 shellEscape / sshExecCommand（作用域内可见）。
  // 在容器内执行命令：docker exec <container> sh -c '<cmd>'
  function runInContainerCmd(container, innerCmd) {
    return 'docker exec ' + shellEscape(container) + ' sh -c ' + shellEscape(innerCmd);
  }
  // 以 root 身份在容器内执行；su - <user> -c '<cmd>' 场景
  function runInContainerAs(container, user, innerCmd) {
    if (!user || user === 'root') return runInContainerCmd(container, innerCmd);
    // openGauss 的 GAUSSHOME / LD_LIBRARY_PATH 在 omm 的 .bashrc 中，
    // 仅 su - 不会读取它，gsql 和 gs_dump 会因此找不到动态库。
    const command = user === 'omm'
      ? 'source /home/omm/.bashrc && ' + innerCmd
      : innerCmd;
    return 'docker exec ' + shellEscape(container) + ' su - ' + shellEscape(user) +
      ' -c ' + shellEscape(command);
  }
  // SSH -> 目标机 -> 命令
  function sshRun(cmd, options) {
    return new Promise((resolve) => {
      const sshCfg = cfg.ssh || {};
      const timeoutMs = Number(options && options.timeoutMs);
      if (!sshCfg.host || !sshCfg.username || !sshCfg.password) {
        return resolve({ code: -1, stdout: '', stderr: 'SSH 未配置（host/username/password 缺失）' });
      }
      sshExecCommand({
        host: sshCfg.host, port: Number(sshCfg.port) || 22,
        username: sshCfg.username, password: sshCfg.password,
        commandTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
      }, cmd, (err, r) => {
        if (err && err.code === 'SSH_COMMAND_TIMEOUT') {
          return resolve({ code: -1, stdout: '', stderr: 'SSH command timed out', timedOut: true });
        }
        if (err) return resolve({ code: -1, stdout: '', stderr: err.message || String(err) });
        resolve(r || { code: -1, stdout: '', stderr: '空结果' });
      });
    });
  }
  // 校验 dbId 合法性（mysql / opengauss / dm）
  function validDbId(id) { return id === 'mysql' || id === 'opengauss' || id === 'dm'; }
  function getDbCfg(id) { return validDbId(id) ? cfg.databases[id] : null; }
  function buildDmConnectUrl(db) {
    db = db || {};
    return 'dm://' + encodeURIComponent(db.username || 'SYSDBA') + ':' +
      encodeURIComponent(db.password || '') + '@' + (db.host || '127.0.0.1') + ':' +
      (Number(db.port) || 5236);
  }
  // 连接池：MySQL / openGauss / DM 各一个 pool，配置变更时销毁重建
  const pools = { mysql: null, opengauss: null, dm: null };
  async function getMysqlPool() {
    if (!mysql2) throw new Error('mysql2 未安装');
    if (pools.mysql) return pools.mysql;
    const db = cfg.databases.mysql;
    pools.mysql = mysql2.createPool({
      host: db.host, port: Number(db.port) || 3333,
      user: db.username, password: db.password || '',
      connectionLimit: 3, connectTimeout: 5000, waitForConnections: true,
      dateStrings: true,
    });
    return pools.mysql;
  }
  async function getPgPool() {
    if (!pgLib) throw new Error('pg 未安装');
    if (pools.opengauss) return pools.opengauss;
    const db = cfg.databases.opengauss;
    pools.opengauss = new pgLib.Pool({
      host: db.host, port: Number(db.port) || 5432,
      user: db.username, password: db.password || '',
      database: db.database || 'dcim',
      max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 15000,
    });
    return pools.opengauss;
  }
  async function getDmPool() {
    if (!dmdbLib) throw new Error('dmdb 未安装');
    if (pools.dm) return pools.dm;
    const db = cfg.databases.dm;
    pools.dm = await dmdbLib.createPool({
      connectString: buildDmConnectUrl(db),
      poolMax: 3, poolMin: 0, poolTimeout: 30,
    });
    return pools.dm;
  }
  async function destroyPools() {
    try { if (pools.mysql) await pools.mysql.end(); } catch (_e) {}
    try { if (pools.opengauss) await pools.opengauss.end(); } catch (_e) {}
    try { if (pools.dm && pools.dm.close) await pools.dm.close(0); } catch (_e) {}
    pools.mysql = null; pools.opengauss = null; pools.dm = null;
  }
  // 三库统一执行 SQL：返回 { columns, rows, rowCount, elapsedMs, notice? }
  async function runQuery(dbId, sql, limit) {
    const start = Date.now();
    const cap = Math.max(1, Math.min(5000, Number(limit) || 500));
    if (dbId === 'mysql') {
      const pool = await getMysqlPool();
      const conn = await pool.getConnection();
      try {
        const [rows, fields] = await conn.query({ sql: sql, rowsAsArray: false });
        // 非 SELECT 返回 { affectedRows: ... }，包成统一格式
        if (Array.isArray(rows)) {
          const cols = fields && fields.length ? fields.map(f => f.name) : (rows[0] ? Object.keys(rows[0]) : []);
          const trimmed = rows.length > cap ? rows.slice(0, cap) : rows;
          return { columns: cols, rows: trimmed, rowCount: rows.length,
            elapsedMs: Date.now() - start, notice: rows.length > cap ? '结果超过 ' + cap + ' 行，已截断' : null };
        }
        return { columns: ['result'], rows: [{ result: JSON.stringify(rows) }], rowCount: 1, elapsedMs: Date.now() - start };
      } finally { conn.release(); }
    }
    if (dbId === 'opengauss') {
      const pool = await getPgPool();
      const client = await pool.connect();
      try {
        const r = await client.query(sql);
        const rows = Array.isArray(r.rows) ? r.rows : [];
        const cols = (r.fields || []).map(f => f.name);
        const trimmed = rows.length > cap ? rows.slice(0, cap) : rows;
        return { columns: cols.length ? cols : (rows[0] ? Object.keys(rows[0]) : []),
          rows: trimmed, rowCount: rows.length, elapsedMs: Date.now() - start,
          notice: rows.length > cap ? '结果超过 ' + cap + ' 行，已截断' : null };
      } finally { client.release(); }
    }
    if (dbId === 'dm') {
      const pool = await getDmPool();
      const conn = await pool.getConnection();
      try {
        const r = await conn.execute(sql, [], { outFormat: dmdbLib.OUT_FORMAT_OBJECT });
        const rows = Array.isArray(r.rows) ? r.rows : [];
        const cols = (r.metaData || []).map(m => m.name);
        const trimmed = rows.length > cap ? rows.slice(0, cap) : rows;
        return { columns: cols.length ? cols : (rows[0] ? Object.keys(rows[0]) : []),
          rows: trimmed, rowCount: rows.length, elapsedMs: Date.now() - start,
          notice: rows.length > cap ? '结果超过 ' + cap + ' 行，已截断' : null };
      } finally { try { await conn.close(); } catch (_e) {} }
    }
    throw new Error('未知的 dbId: ' + dbId);
  }
  // 三库状态探测：数据库实际连接决定在线状态；systemd 仅作为服务管理诊断。
  const DB_HEALTH_TIMEOUT_MS = 6000;
  async function probeSsh() {
    const r = await sshRun('echo ok');
    return { ok: r.code === 0 && r.stdout.indexOf('ok') !== -1, message: r.stderr || (r.stdout || '') };
  }
  async function probeServiceRunning(dbId) {
    const db = getDbCfg(dbId); if (!db) return { running: false };
    const cmd = runInContainerCmd(cfg.container, 'systemctl is-active ' + db.systemdUnit + ' 2>/dev/null');
    const r = await sshRun(cmd);
    return { running: r.stdout.trim() === 'active', raw: r.stdout.trim() || r.stderr };
  }
  function withProbeTimeout(promise, dbId) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(dbId + ' 连接超时（' + DB_HEALTH_TIMEOUT_MS + 'ms）'));
      }, DB_HEALTH_TIMEOUT_MS);
      Promise.resolve(promise).then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }
  // openGauss 的 pg 协议兼容性受服务端版本/认证配置影响。状态探测在 pg 驱动被
  // 服务端主动断开时，回退到容器内同环境的官方 gsql。这里不带 -h/-W，使用 omm
  // 运行环境中的 Unix socket 与 local trust 规则，避免过期的页面连接地址或密码误报离线。
  async function runOpenGaussGsql(sql) {
    const db = getDbCfg('opengauss');
    if (!db) throw new Error('openGauss 未配置');
    const command = [
      '/opt/software/openGauss/app/bin/gsql',
      '-d ' + shellEscape(db.database || 'dcim'),
      '-A -t -F ' + shellEscape('|'),
      '-c ' + shellEscape(sql),
      '2>&1',
    ].join(' ');
    const result = await sshRun(runInContainerAs(cfg.container, 'omm', command));
    if (result.code !== 0) {
      throw new Error(String(result.stderr || result.stdout || 'gsql 执行失败').trim().slice(0, 300));
    }
    return String(result.stdout || '').trim();
  }
  async function probeDbConnection(dbId) {
    const startedAt = Date.now();
    const sql = dbId === 'dm' ? 'SELECT 1 FROM DUAL' : 'SELECT 1';
    try {
      await withProbeTimeout(runQuery(dbId, sql, 1), dbId);
      return { ok: true, elapsedMs: Date.now() - startedAt, error: '', transport: 'driver' };
    } catch (err) {
      if (dbId === 'opengauss') {
        try {
          await withProbeTimeout(runOpenGaussGsql('SELECT 1;'), dbId);
          return { ok: true, elapsedMs: Date.now() - startedAt, error: '', transport: 'gsql' };
        } catch (fallbackErr) {
          err = fallbackErr;
        }
      }
      return {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: String((err && err.message) || err || '数据库连接失败').slice(0, 300),
        transport: '',
      };
    }
  }
  async function probeOptional(task, dbId, fallback) {
    try {
      return await withProbeTimeout(Promise.resolve().then(task), dbId);
    } catch (_e) {
      return fallback;
    }
  }
  async function probeVersion(dbId) {
    try {
      if (dbId === 'mysql') {
        const r = await runQuery('mysql', 'SELECT VERSION() AS v', 1);
        return r.rows[0] ? r.rows[0].v : '';
      }
      if (dbId === 'opengauss') {
        const value = await runOpenGaussGsql('SELECT version();');
        return String(value).split(' ')[0] || '';
      }
      if (dbId === 'dm') {
        const r = await runQuery('dm', 'SELECT * FROM V$VERSION', 10);
        const first = r.rows[0] || {};
        return Object.values(first).join(' ') || '';
      }
    } catch (_e) { return ''; }
    return '';
  }
  async function probeDbCounts(dbId) {
    try {
      if (dbId === 'mysql') {
        const r = await runQuery('mysql',
          "SELECT COUNT(DISTINCT table_schema) AS dbs, COUNT(*) AS tbls FROM information_schema.tables " +
          "WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')", 1);
        return { databases: Number(r.rows[0].dbs), tables: Number(r.rows[0].tbls) };
      }
      if (dbId === 'opengauss') {
        const value = await runOpenGaussGsql(
          "SELECT (SELECT COUNT(*) FROM pg_database WHERE datistemplate=false), " +
          "(SELECT COUNT(*) FROM pg_class WHERE relkind='r');");
        const values = String(value).split('|');
        return { databases: Number(values[0]) || 0, tables: Number(values[1]) || 0 };
      }
      if (dbId === 'dm') {
        const r = await runQuery('dm',
          "SELECT COUNT(*) AS tbls FROM ALL_TABLES", 1);
        return { databases: 1, tables: Number(r.rows[0].TBLS || r.rows[0].tbls || 0) };
      }
    } catch (_e) {}
    return { databases: 0, tables: 0 };
  }
  async function probeAll() {
    const [ssh, mysqlSvc, gaussSvc, dmSvc, mysqlConn, gaussConn, dmConn] = await Promise.all([
      probeSsh(), probeServiceRunning('mysql'),
      probeServiceRunning('opengauss'), probeServiceRunning('dm'),
      probeDbConnection('mysql'), probeDbConnection('opengauss'), probeDbConnection('dm'),
    ]);
    // 版本与统计由真实连接成功触发，不能被 systemd 的错误状态阻断。
    const [mv, gv, dv, mc, gc, dc] = await Promise.all([
      mysqlConn.ok ? probeOptional(() => probeVersion('mysql'), 'mysql', '') : Promise.resolve(''),
      gaussConn.ok ? probeOptional(() => probeVersion('opengauss'), 'opengauss', '') : Promise.resolve(''),
      dmConn.ok ? probeOptional(() => probeVersion('dm'), 'dm', '') : Promise.resolve(''),
      mysqlConn.ok ? probeOptional(() => probeDbCounts('mysql'), 'mysql', { databases: 0, tables: 0 }) : Promise.resolve({ databases: 0, tables: 0 }),
      gaussConn.ok ? probeOptional(() => probeDbCounts('opengauss'), 'opengauss', { databases: 0, tables: 0 }) : Promise.resolve({ databases: 0, tables: 0 }),
      dmConn.ok ? probeOptional(() => probeDbCounts('dm'), 'dm', { databases: 0, tables: 0 }) : Promise.resolve({ databases: 0, tables: 0 }),
    ]);
    function buildDbStatus(id, label, service, connection, version, counts) {
      const health = connection.ok ? 'online' : 'offline';
      return {
        id: id, label: label, running: connection.ok, health: health,
        serviceRunning: service.running, systemdState: service.raw || 'unknown',
        probeError: connection.error || '', probeElapsedMs: connection.elapsedMs,
        probeTransport: connection.transport || '',
        version: version, databases: counts.databases, tables: counts.tables,
        unit: cfg.databases[id].systemdUnit,
      };
    }
    return {
      ssh: ssh,
      container: cfg.container,
      databases: {
        mysql: buildDbStatus('mysql', 'MySQL', mysqlSvc, mysqlConn, mv, mc),
        opengauss: buildDbStatus('opengauss', 'openGauss', gaussSvc, gaussConn, gv, gc),
        dm: buildDbStatus('dm', '达梦 DM', dmSvc, dmConn, dv, dc),
      },
    };
  }

  // 服务生命周期：docker exec <container> systemctl <action> <unit>
  async function serviceAction(dbId, action) {
    if (!['start', 'stop', 'restart', 'status'].includes(action)) throw new Error('非法 action');
    const db = getDbCfg(dbId); if (!db) throw new Error('未知的 dbId');
    const cmd = runInContainerCmd(cfg.container, 'systemctl ' + action + ' ' + db.systemdUnit);
    appendLog('service ' + dbId + ' ' + action + ' → ' + db.systemdUnit);
    const r = await sshRun(cmd);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr, unit: db.systemdUnit };
  }

  // 备份：先在容器内 dump 到 /tmp/dbmgr-<ts>.<ext>，再 SFTP 拉回本机 backups/db-manager/
  async function backupDatabase(dbId, dbName) {
    const db = getDbCfg(dbId); if (!db) throw new Error('未知的 dbId');
    if (!dbName) throw new Error('database 必填');
    const ts = stampForFile();
    let remotePath, localName, dumpCmd;
    if (dbId === 'mysql') {
      remotePath = '/tmp/dbmgr-mysql-' + dbName + '-' + ts + '.sql';
      localName = 'mysql-' + dbName + '-' + ts + '.sql';
      const inner = db.dockerDump + ' -u' + shellEscape(db.username).slice(1, -1) +
        (db.password ? ' -p' + shellEscape(db.password).slice(1, -1) : '') +
        ' --single-transaction --routines --triggers --set-gtid-purged=OFF ' +
        shellEscape(dbName).slice(1, -1) + ' > ' + remotePath;
      dumpCmd = runInContainerCmd(cfg.container, inner);
    } else if (dbId === 'opengauss') {
      remotePath = '/tmp/dbmgr-gauss-' + dbName + '-' + ts + '.dump';
      localName = 'gauss-' + dbName + '-' + ts + '.dump';
      // openGauss 不认 PGPASSWORD 环境变量，必须用 -W <password> 命令行传密码
      const inner = '/opt/software/openGauss/app/bin/gs_dump ' +
        '-h 127.0.0.1 -p ' + (Number(db.port) || 5432) +
        ' -U ' + shellEscape(db.username).slice(1, -1) +
        ' -W ' + shellEscape(db.password || '').slice(1, -1) +
        ' -f ' + remotePath + ' -F c ' + shellEscape(dbName).slice(1, -1);
      dumpCmd = runInContainerAs(cfg.container, 'omm', inner);
    } else {
      remotePath = '/tmp/dbmgr-dm-' + dbName + '-' + ts + '.dmp';
      localName = 'dm-' + dbName + '-' + ts + '.dmp';
      const inner = db.dockerDump + ' USERID=' + shellEscape(db.username).slice(1, -1) + '/' +
        shellEscape(db.password || '').slice(1, -1) + '@127.0.0.1:' + (Number(db.port) || 5236) +
        ' FILE=' + remotePath + ' DIRECTORY=/tmp SCHEMAS=' + shellEscape(dbName).slice(1, -1) +
        ' LOG=/tmp/dbmgr-dm-' + dbName + '-' + ts + '.log';
      dumpCmd = runInContainerCmd(cfg.container, inner);
    }
    appendLog('backup start ' + dbId + '/' + dbName + ' → ' + remotePath);
    const r = await sshRun(dumpCmd);
    if (r.code !== 0) {
      appendLog('backup dump 失败: ' + (r.stderr || r.stdout).slice(0, 500));
      throw new Error('dump 失败: ' + (r.stderr || r.stdout || 'exit ' + r.code).slice(0, 500));
    }
    // dump 命令跑在容器内，产物在容器 /tmp，而 sftpDownload 从宿主机 /tmp 拉。
    // docker cp 把文件从容器复制到宿主，然后清容器内临时文件
    const dockerCp = 'docker cp ' + shellEscape(cfg.container) + ':' + remotePath + ' ' + remotePath;
    const cpR = await sshRun(dockerCp);
    if (cpR.code !== 0) {
      appendLog('backup docker cp 失败: ' + (cpR.stderr || cpR.stdout).slice(0, 400));
      throw new Error('docker cp 失败（容器内 dump 可能没生成文件）: ' +
        (cpR.stderr || cpR.stdout || 'exit ' + cpR.code).slice(0, 400));
    }
    await sshRun(runInContainerCmd(cfg.container, 'rm -f ' + remotePath));
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const localPath = path.join(BACKUP_DIR, localName);
    await sftpDownload(remotePath, localPath);
    await sshRun('rm -f ' + shellEscape(remotePath));
    const stat = fs.statSync(localPath);
    appendLog('backup ok ' + dbId + '/' + dbName + ' size=' + stat.size + ' → ' + localName);
    return { file: localName, size: stat.size, path: localPath };
  }

  // SFTP 从目标机下载到本机
  function sftpDownload(remotePath, localPath) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const sshCfg = cfg.ssh || {};
      client.on('ready', () => {
        client.sftp((err, sftp) => {
          if (err) { try { client.end(); } catch(_e){} return reject(err); }
          const rs = sftp.createReadStream(remotePath);
          const ws = fs.createWriteStream(localPath);
          let done = false;
          const finish = (e) => { if (done) return; done = true; try { client.end(); } catch(_e){} e ? reject(e) : resolve(); };
          rs.on('error', finish);
          ws.on('error', finish);
          ws.on('close', () => finish(null));
          rs.pipe(ws);
        });
      });
      client.on('error', reject);
      client.connect({
        host: sshCfg.host, port: Number(sshCfg.port) || 22,
        username: sshCfg.username, password: sshCfg.password,
        readyTimeout: 15000,
      });
    });
  }
  // SFTP 从本机上传到目标机
  function sftpUpload(localPath, remotePath) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const sshCfg = cfg.ssh || {};
      client.on('ready', () => {
        client.sftp((err, sftp) => {
          if (err) { try { client.end(); } catch(_e){} return reject(err); }
          const rs = fs.createReadStream(localPath);
          const ws = sftp.createWriteStream(remotePath);
          let done = false;
          const finish = (e) => { if (done) return; done = true; try { client.end(); } catch(_e){} e ? reject(e) : resolve(); };
          rs.on('error', finish);
          ws.on('error', finish);
          ws.on('close', () => finish(null));
          rs.pipe(ws);
        });
      });
      client.on('error', reject);
      client.connect({
        host: sshCfg.host, port: Number(sshCfg.port) || 22,
        username: sshCfg.username, password: sshCfg.password,
        readyTimeout: 15000,
      });
    });
  }

  // 还原：本机备份文件 → SFTP 上传 → 容器内 restore 命令
  async function restoreDatabase(dbId, dbName, localFileName) {
    const db = getDbCfg(dbId); if (!db) throw new Error('未知的 dbId');
    if (!dbName) throw new Error('database 必填');
    // 校验文件名，避免路径穿越
    if (!/^[A-Za-z0-9._-]+$/.test(localFileName)) throw new Error('文件名非法');
    const localPath = path.join(BACKUP_DIR, localFileName);
    if (!fs.existsSync(localPath)) throw new Error('本地备份文件不存在: ' + localFileName);
    const ts = stampForFile();
    const remotePath = '/tmp/dbmgr-restore-' + ts + '-' + localFileName;
    appendLog('restore start ' + dbId + '/' + dbName + ' ← ' + localFileName);
    await sftpUpload(localPath, remotePath);
    // 容器 restore 命令读的是容器内路径；sftpUpload 只放到了宿主 /tmp，需要 docker cp 进容器
    const cpIn = await sshRun('docker cp ' + remotePath + ' ' + shellEscape(cfg.container) + ':' + remotePath);
    if (cpIn.code !== 0) {
      throw new Error('docker cp 上传到容器失败: ' + (cpIn.stderr || cpIn.stdout).slice(0, 400));
    }
    let restoreCmd;
    if (dbId === 'mysql') {
      const inner = db.dockerCli + ' -u' + shellEscape(db.username).slice(1, -1) +
        (db.password ? ' -p' + shellEscape(db.password).slice(1, -1) : '') +
        ' ' + shellEscape(dbName).slice(1, -1) + ' < ' + remotePath;
      restoreCmd = runInContainerCmd(cfg.container, inner);
    } else if (dbId === 'opengauss') {
      // openGauss 用 -W 传密码
      const inner = '/opt/software/openGauss/app/bin/gs_restore ' +
        '-h 127.0.0.1 -p ' + (Number(db.port) || 5432) +
        ' -U ' + shellEscape(db.username).slice(1, -1) +
        ' -W ' + shellEscape(db.password || '').slice(1, -1) +
        ' -d ' + shellEscape(dbName).slice(1, -1) + ' ' + remotePath;
      restoreCmd = runInContainerAs(cfg.container, 'omm', inner);
    } else {
      const inner = '/home/dmdba/dmdbms/bin/dimp USERID=' + shellEscape(db.username).slice(1, -1) + '/' +
        shellEscape(db.password || '').slice(1, -1) + '@127.0.0.1:' + (Number(db.port) || 5236) +
        ' FILE=' + remotePath + ' DIRECTORY=/tmp SCHEMAS=' + shellEscape(dbName).slice(1, -1) +
        ' LOG=/tmp/dbmgr-restore-' + ts + '.log';
      restoreCmd = runInContainerCmd(cfg.container, inner);
    }
    const r = await sshRun(restoreCmd);
    // 清理：容器内 + 宿主 tmp
    await sshRun(runInContainerCmd(cfg.container, 'rm -f ' + remotePath));
    await sshRun('rm -f ' + shellEscape(remotePath));
    if (r.code !== 0) {
      appendLog('restore 失败 ' + dbId + '/' + dbName + ': ' + (r.stderr || r.stdout).slice(0, 500));
      throw new Error('restore 失败 (exit ' + r.code + '): ' + (r.stderr || r.stdout || '').slice(0, 500));
    }
    appendLog('restore ok ' + dbId + '/' + dbName);
    return { stdout: r.stdout, stderr: r.stderr };
  }

  // ===== 路由 =====
  app.get('/api/db-manager/config', (_req, res) => {
    res.json({ ok: true, config: redactCfg(),
      drivers: { mysql2: !!mysql2, pg: !!pgLib, dmdb: !!dmdbLib } });
  });

  app.put('/api/db-manager/config', async (req, res) => {
    const b = req.body || {};
    const next = JSON.parse(JSON.stringify(cfg));
    if (b.ssh && typeof b.ssh === 'object') {
      if (typeof b.ssh.host === 'string')     next.ssh.host = b.ssh.host.trim();
      if (b.ssh.port != null)                 next.ssh.port = Math.max(1, Math.min(65535, Number(b.ssh.port) || 22));
      if (typeof b.ssh.username === 'string') next.ssh.username = b.ssh.username.trim();
      if (typeof b.ssh.password === 'string' && b.ssh.password !== '' && b.ssh.password !== '***') {
        next.ssh.password = b.ssh.password;
      }
    }
    if (typeof b.container === 'string' && b.container.trim()) next.container = b.container.trim();
    ['mysql', 'opengauss', 'dm'].forEach((id) => {
      if (b.databases && b.databases[id] && typeof b.databases[id] === 'object') {
        const src = b.databases[id]; const tgt = next.databases[id];
        if (typeof src.enabled === 'boolean')  tgt.enabled = src.enabled;
        if (typeof src.host === 'string')      tgt.host = src.host.trim();
        if (src.port != null)                  tgt.port = Math.max(1, Math.min(65535, Number(src.port) || tgt.port));
        if (typeof src.username === 'string')  tgt.username = src.username.trim();
        if (typeof src.database === 'string')  tgt.database = src.database.trim();
        if (typeof src.systemdUnit === 'string') tgt.systemdUnit = src.systemdUnit.trim();
        if (typeof src.password === 'string' && src.password !== '' && src.password !== '***') {
          tgt.password = src.password;
        }
        // DM 专属：SYSDBA 密码（授权 / license 管理用）
        if (id === 'dm' && typeof src.sysdbaPassword === 'string' &&
            src.sysdbaPassword !== '' && src.sysdbaPassword !== '***') {
          tgt.sysdbaPassword = src.sysdbaPassword;
        }
      }
    });
    cfg = next; writeCfg();
    await destroyPools(); // 配置变更，销毁连接池
    appendLog('配置已更新 ssh=' + cfg.ssh.host);
    res.json({ ok: true, config: redactCfg() });
  });

  app.post('/api/db-manager/test-connection', async (req, res) => {
    const body = req.body || {};
    const target = String(body.target || 'ssh');
    // 支持前端把弹窗当前 form 值传进来，测完不写盘（避免用户「测试」前必须先「保存」）
    const inline = body.credentials || null;
    try {
      if (target === 'ssh') {
        // SSH 测试：走 sshExecCommand 用 inline 或已存 cfg.ssh
        const sshCfg = inline
          ? { host: inline.host, port: Number(inline.port) || 22, username: inline.username, password: inline.password }
          : (cfg.ssh || {});
        if (!sshCfg.host || !sshCfg.username || !sshCfg.password) {
          return res.json({ ok: false, message: 'SSH 未配置（host/username/password 缺失）' });
        }
        const r = await new Promise((resolve) => {
          sshExecCommand(sshCfg, 'echo ok', (err, r) => {
            if (err) return resolve({ ok: false, message: err.message || String(err) });
            const ok = r && r.code === 0 && (r.stdout || '').indexOf('ok') !== -1;
            resolve({ ok, message: ok ? 'SSH 连通' : (r.stderr || r.stdout || 'SSH 不通').slice(0, 300) });
          });
        });
        return res.json(r);
      }
      if (!validDbId(target)) return res.status(400).json({ ok: false, message: '非法 target' });
      // DB 直连测试：如果传了 inline 用 inline，否则用已保存的 pool
      if (inline) {
        // 用 inline 凭据临时开一个连接测（不用 pool，避免污染）
        if (target === 'mysql') {
          if (!mysql2) throw new Error('mysql2 未安装');
          const conn = await mysql2.createConnection({
            host: inline.host, port: Number(inline.port) || 3333,
            user: inline.username, password: inline.password || '',
            connectTimeout: 5000, ssl: false,
          });
          try { await conn.query('SELECT 1'); } finally { try { await conn.end(); } catch(_e){} }
        } else if (target === 'opengauss') {
          if (!pgLib) throw new Error('pg 未安装');
          const c2 = new pgLib.Client({
            host: inline.host, port: Number(inline.port) || 5432,
            user: inline.username, password: inline.password || '',
            database: inline.database || 'dcim',
            connectionTimeoutMillis: 5000,
          });
          try { await c2.connect(); await c2.query('SELECT 1'); } finally { try { await c2.end(); } catch(_e){} }
        } else if (target === 'dm') {
          if (!dmdbLib) throw new Error('dmdb 未安装');
          const conn = await dmdbLib.getConnection(buildDmConnectUrl({
            username: inline.username, password: inline.password,
            host: inline.host, port: inline.port,
          }));
          try { await conn.execute('SELECT 1 FROM DUAL'); } finally { try { await conn.close(); } catch(_e){} }
        }
      } else {
        if (target === 'opengauss') {
          const probe = await probeDbConnection(target);
          if (!probe.ok) throw new Error(probe.error || 'openGauss 不可用');
        } else {
          await runQuery(target, target === 'dm' ? 'SELECT 1 FROM DUAL' : 'SELECT 1', 1);
        }
      }
      res.json({ ok: true, message: target + ' 连通' });
    } catch (e) {
      res.json({ ok: false, message: (e.message || String(e)).slice(0, 300) });
    }
  });

  app.get('/api/db-manager/status', async (_req, res) => {
    try { res.json({ ok: true, status: await probeAll() }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  app.post('/api/db-manager/service/:db/:action', async (req, res) => {
    try {
      const r = await serviceAction(req.params.db, req.params.action);
      res.json({ ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr, unit: r.unit });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.post('/api/db-manager/query', async (req, res) => {
    const b = req.body || {};
    const dbId = String(b.db || '');
    const sql = String(b.sql || '').trim();
    if (!validDbId(dbId)) return res.status(400).json({ ok: false, message: '非法 db' });
    if (!sql) return res.status(400).json({ ok: false, message: 'sql 必填' });
    try {
      const r = await runQuery(dbId, sql, b.limit);
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.get('/api/db-manager/databases/:db', async (req, res) => {
    const dbId = req.params.db;
    if (!validDbId(dbId)) return res.status(400).json({ ok: false, message: '非法 db' });
    try {
      let sql;
      if (dbId === 'mysql') sql = "SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY schema_name";
      else if (dbId === 'opengauss') sql = "SELECT datname AS name FROM pg_database WHERE datistemplate=false ORDER BY datname";
      else sql = "SELECT USERNAME AS name FROM DBA_USERS WHERE ACCOUNT_STATUS='OPEN' AND USERNAME NOT IN ('SYS','SYSAUDITOR','SYSSSO') ORDER BY USERNAME";
      const r = await runQuery(dbId, sql, 500);
      res.json({ ok: true, databases: r.rows.map(x => x.name || x.NAME) });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.get('/api/db-manager/tables/:db/:database', async (req, res) => {
    const dbId = req.params.db; const dbName = req.params.database;
    if (!validDbId(dbId)) return res.status(400).json({ ok: false, message: '非法 db' });
    try {
      let sql;
      if (dbId === 'mysql') {
        // 用参数拼装：mysql2 pool.query 不支持 pool 级 database 切换；把 database 名内联进 SQL
        // 只允许 [\w-] 避免注入
        if (!/^[\w-]+$/.test(dbName)) return res.status(400).json({ ok: false, message: 'database 名非法' });
        sql = "SELECT table_name AS name, table_rows AS rows, data_length + index_length AS bytes FROM information_schema.tables WHERE table_schema='" + dbName + "' AND table_type='BASE TABLE' ORDER BY table_name";
      } else if (dbId === 'opengauss') {
        sql = "SELECT tablename AS name FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY tablename";
      } else {
        if (!/^[\w-]+$/.test(dbName)) return res.status(400).json({ ok: false, message: 'schema 名非法' });
        sql = "SELECT TABLE_NAME AS name, NUM_ROWS AS rows FROM ALL_TABLES WHERE OWNER='" + dbName.toUpperCase() + "' ORDER BY TABLE_NAME";
      }
      const r = await runQuery(dbId, sql, 5000);
      res.json({ ok: true, tables: r.rows.map(row => ({
        name: row.name || row.NAME,
        rows: row.rows != null ? Number(row.rows) : (row.ROWS != null ? Number(row.ROWS) : null),
        bytes: row.bytes != null ? Number(row.bytes) : null,
      })) });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.get('/api/db-manager/table/:db/:database/:table', async (req, res) => {
    const dbId = req.params.db; const dbName = req.params.database; const tbl = req.params.table;
    if (!validDbId(dbId)) return res.status(400).json({ ok: false, message: '非法 db' });
    if (!/^[\w-]+$/.test(dbName) || !/^[\w-]+$/.test(tbl)) return res.status(400).json({ ok: false, message: '名称非法' });
    try {
      let structSql, previewSql;
      if (dbId === 'mysql') {
        structSql = "SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_default AS `default`, column_comment AS comment FROM information_schema.columns WHERE table_schema='" + dbName + "' AND table_name='" + tbl + "' ORDER BY ordinal_position";
        previewSql = "SELECT * FROM `" + dbName + "`.`" + tbl + "` LIMIT 100";
      } else if (dbId === 'opengauss') {
        structSql = "SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS \"default\" FROM information_schema.columns WHERE table_name='" + tbl + "' ORDER BY ordinal_position";
        previewSql = 'SELECT * FROM "' + tbl + '" LIMIT 100';
      } else {
        structSql = "SELECT COLUMN_NAME AS name, DATA_TYPE AS type, NULLABLE AS nullable, DATA_DEFAULT AS \"default\" FROM ALL_TAB_COLUMNS WHERE OWNER='" + dbName.toUpperCase() + "' AND TABLE_NAME='" + tbl.toUpperCase() + "' ORDER BY COLUMN_ID";
        previewSql = 'SELECT * FROM "' + dbName.toUpperCase() + '"."' + tbl.toUpperCase() + '" WHERE ROWNUM <= 100';
      }
      const struct = await runQuery(dbId, structSql, 500);
      let preview = { columns: [], rows: [] };
      try { preview = await runQuery(dbId, previewSql, 100); } catch (e) { preview.notice = e.message; }
      res.json({ ok: true,
        columns: struct.rows.map(r => ({
          name: r.name || r.NAME, type: r.type || r.TYPE,
          nullable: r.nullable || r.NULLABLE,
          default: r.default || r.DEFAULT,
          comment: r.comment || r.COMMENT || null,
        })),
        preview: { columns: preview.columns, rows: preview.rows, notice: preview.notice || null },
      });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.post('/api/db-manager/backup', async (req, res) => {
    const b = req.body || {};
    if (!validDbId(b.db)) return res.status(400).json({ ok: false, message: '非法 db' });
    if (!b.database) return res.status(400).json({ ok: false, message: 'database 必填' });
    try {
      const r = await backupDatabase(b.db, String(b.database));
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.get('/api/db-manager/backups', (_req, res) => {
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => !f.startsWith('.'))
        .map(f => { const s = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: s.size, mtime: s.mtimeMs }; })
        .sort((a, b) => b.mtime - a.mtime);
      res.json({ ok: true, files: files });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  app.get('/api/db-manager/backups/:file', (req, res) => {
    const f = req.params.file;
    if (!/^[A-Za-z0-9._-]+$/.test(f)) return res.status(400).json({ ok: false, message: '文件名非法' });
    const full = path.join(BACKUP_DIR, f);
    if (!fs.existsSync(full)) return res.status(404).json({ ok: false, message: '文件不存在' });
    res.download(full, f);
  });

  app.delete('/api/db-manager/backups/:file', (req, res) => {
    const f = req.params.file;
    if (!/^[A-Za-z0-9._-]+$/.test(f)) return res.status(400).json({ ok: false, message: '文件名非法' });
    const full = path.join(BACKUP_DIR, f);
    if (!fs.existsSync(full)) return res.status(404).json({ ok: false, message: '文件不存在' });
    try { fs.unlinkSync(full); appendLog('删备份 ' + f); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  app.post('/api/db-manager/restore', async (req, res) => {
    const b = req.body || {};
    if (!validDbId(b.db)) return res.status(400).json({ ok: false, message: '非法 db' });
    if (!b.database) return res.status(400).json({ ok: false, message: 'database 必填' });
    if (!b.file) return res.status(400).json({ ok: false, message: 'file 必填' });
    try {
      const r = await restoreDatabase(b.db, String(b.database), String(b.file));
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  // 上传备份文件（base64 dataUrl，body: { name, content }）
  app.post('/api/db-manager/upload-backup', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return res.status(400).json({ ok: false, message: '文件名非法（只允许字母数字._-）' });
    if (!b.content || typeof b.content !== 'string') return res.status(400).json({ ok: false, message: 'content 必填（dataURL 或 base64）' });
    try {
      let buf;
      if (b.content.indexOf('data:') === 0) buf = dataUrlToBuffer(b.content);
      else buf = Buffer.from(b.content, 'base64');
      if (buf.length > 2 * 1024 * 1024 * 1024) return res.status(413).json({ ok: false, message: '单文件超过 2GB' });
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const full = path.join(BACKUP_DIR, name);
      fs.writeFileSync(full, buf);
      appendLog('上传备份 ' + name + ' size=' + buf.length);
      res.json({ ok: true, file: name, size: buf.length });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  async function locateOpenGaussAccessFiles() {
    let result = await sshRun(runInContainerCmd(cfg.container,
      "find /opt/software/openGauss/data -maxdepth 3 -name pg_hba.conf -type f 2>/dev/null | head -1"));
    const hbaPath = String(result.stdout || '').trim();
    if (result.code !== 0 || !hbaPath) {
      throw new Error('未找到 openGauss pg_hba.conf（预期 /opt/software/openGauss/data 下）');
    }

    result = await sshRun(runInContainerCmd(cfg.container,
      "find /opt/software/openGauss -maxdepth 4 -name gs_ctl -type f 2>/dev/null | head -1"));
    const gsCtlPath = String(result.stdout || '').trim();
    if (result.code !== 0 || !gsCtlPath) {
      throw new Error('未找到 openGauss gs_ctl 工具（预期 /opt/software/openGauss 下）');
    }

    return {
      hbaPath: hbaPath,
      dataDir: hbaPath.replace(/\/pg_hba\.conf$/, ''),
      gsCtlPath: gsCtlPath,
    };
  }

  async function readContainerText(filePath) {
    const result = await sshRun(runInContainerCmd(cfg.container,
      'cat ' + shellEscape(filePath) + ' 2>&1'));
    if (result.code !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim().slice(0, 300);
      throw new Error('读取容器文件失败 ' + filePath + '：' + detail);
    }
    return String(result.stdout || '');
  }

  async function replaceContainerText(filePath, text, backupPath) {
    const contentBase64 = Buffer.from(String(text), 'utf8').toString('base64');
    const tempPath = filePath + '.tmp.webssh-cidr.' + Date.now() + '.' + Math.random().toString(16).slice(2);
    const command = [
      'cp -a ' + shellEscape(filePath) + ' ' + shellEscape(backupPath),
      'cp -a ' + shellEscape(filePath) + ' ' + shellEscape(tempPath),
      'printf %s ' + shellEscape(contentBase64) + ' | base64 -d > ' + shellEscape(tempPath),
      'mv -f ' + shellEscape(tempPath) + ' ' + shellEscape(filePath),
    ].join(' && ');
    const result = await sshRun(runInContainerCmd(cfg.container, command));
    if (result.code !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim().slice(0, 300);
      throw new Error('备份或原子替换容器文件失败 ' + filePath + '：' + detail);
    }
    return { backupPath: backupPath };
  }

  async function reloadOpenGaussAccessRules(files) {
    const reloadCommand = shellEscape(files.gsCtlPath) + ' reload -D ' +
      shellEscape(files.dataDir) + ' 2>&1';
    const result = await sshRun(runInContainerAs(cfg.container, 'omm', reloadCommand));
    if (result.code !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim().slice(0, 300);
      throw new Error('openGauss 重载 pg_hba.conf 失败：' + detail);
    }

    const sqlCheck = await runOpenGaussGsql('SELECT 1;');
    if (sqlCheck !== '1') {
      throw new Error('openGauss SQL 验证失败，预期返回 1，实际：' + String(sqlCheck).slice(0, 300));
    }
    return {
      sqlCheck: sqlCheck,
      reloadOutput: String(result.stdout || result.stderr || '').trim().slice(0, 300),
    };
  }

  let openGaussAccessUpdateTail = Promise.resolve();
  function queueOpenGaussAccessUpdate(task) {
    const next = openGaussAccessUpdateTail.then(task, task);
    // 保持队列可用，不能让一次失败永久阻塞之后的 CIDR 操作。
    openGaussAccessUpdateTail = next.catch(() => {});
    return next;
  }

  async function updateOpenGaussAccessRules(mode, cidr) {
    return queueOpenGaussAccessUpdate(() => updateOpenGaussAccessRulesLocked(mode, cidr));
  }

  async function probeOpenGaussAccessAvailability() {
    const [serviceResult, sqlResult] = await Promise.allSettled([
      probeServiceRunning('opengauss'),
      runOpenGaussGsql('SELECT 1;'),
    ]);
    const service = serviceResult.status === 'fulfilled' ? serviceResult.value : null;
    const systemdState = service && service.raw ? service.raw : 'unknown';
    if (sqlResult.status === 'fulfilled') {
      const sqlCheck = String(sqlResult.value || '').trim();
      return {
        available: sqlCheck === '1',
        sqlCheck: sqlCheck,
        systemdState: systemdState,
        error: sqlCheck === '1' ? '' : 'SELECT 1 返回异常：' + sqlCheck.slice(0, 300),
      };
    }
    return {
      available: false,
      sqlCheck: '',
      systemdState: systemdState,
      error: String((sqlResult.reason && sqlResult.reason.message) || sqlResult.reason || 'openGauss SQL 探测失败').slice(0, 300),
    };
  }

  async function updateOpenGaussAccessRulesLocked(mode, cidr) {
    const availability = await probeOpenGaussAccessAvailability();
    if (!availability.available) {
      throw new Error('openGauss SQL 不可用，拒绝修改访问 CIDR（systemd: ' +
        availability.systemdState + '）：' + availability.error);
    }

    const files = await locateOpenGaussAccessFiles();
    const originalText = await readContainerText(files.hbaPath);
    const parsed = accessRules.readManagedRules(originalText);
    const normalizedCidr = accessRules.normalizeIpv4Cidr(cidr);
    let nextRules;
    if (mode === 'append' && parsed.rules.indexOf(normalizedCidr) >= 0) {
      return {
        ok: true,
        unchanged: true,
        rules: parsed.rules,
        globalAllowWarning: parsed.globalAllowWarning,
        backupPath: null,
        verification: null,
      };
    } else if (mode === 'replace') {
      nextRules = [normalizedCidr];
    } else if (mode === 'append') {
      nextRules = parsed.rules.concat([normalizedCidr]);
    } else if (mode === 'remove') {
      if (parsed.rules.indexOf(normalizedCidr) < 0) {
        const missing = new Error('CIDR 不在 WebSSH 管理的规则中：' + normalizedCidr);
        missing.statusCode = 404;
        throw missing;
      }
      nextRules = parsed.rules.filter((rule) => rule !== normalizedCidr);
    } else {
      throw new Error('不支持的访问 CIDR 更新方式：' + mode);
    }

    const nextText = accessRules.writeManagedRules(originalText, nextRules);
    const backupPath = files.hbaPath + '.bak.webssh-cidr.' + stampForFile() + '.' +
      Date.now() + '.' + Math.random().toString(16).slice(2);
    await replaceContainerText(files.hbaPath, nextText, backupPath);

    try {
      const verification = await reloadOpenGaussAccessRules(files);
      const nextParsed = accessRules.readManagedRules(nextText);
      return {
        ok: true,
        rules: nextParsed.rules,
        globalAllowWarning: nextParsed.globalAllowWarning,
        backupPath: backupPath,
        verification: verification,
      };
    } catch (err) {
      let restoreError = '';
      try {
        const restore = await sshRun(runInContainerCmd(cfg.container,
          'cp -a ' + shellEscape(backupPath) + ' ' + shellEscape(files.hbaPath)));
        if (restore.code !== 0) {
          throw new Error(String(restore.stderr || restore.stdout || '').trim().slice(0, 300));
        }
        await reloadOpenGaussAccessRules(files);
      } catch (rollbackErr) {
        restoreError = String((rollbackErr && rollbackErr.message) || rollbackErr || '未知错误').slice(0, 300);
      }
      const failure = String((err && err.message) || err || '未知错误').slice(0, 300);
      if (restoreError) {
        throw new Error('更新访问 CIDR 后验证失败：' + failure + '；恢复原配置也失败：' + restoreError);
      }
      throw new Error('更新访问 CIDR 后验证失败：' + failure + '；已恢复原配置并重新加载');
    }
  }

  // ===== openGauss 一键启用 + 建 dcim 应用账号 + 局域网白名单 =====
  // 场景：初始版本的 dcim 容器里 openGauss 是 disabled+inactive，也没有可远程连的应用账号。
  // 本接口完成：启动 opengauss.service → 建/改 dcim 账号 → 改 pg_hba+listen_addresses → 重启，
  // 让 dcim / 局域网客户端可通过 dcim/Gauss@2026 从 <CIDR> 连过来。
  // 路径自适应：50.10 与 0.60 的 gauss home / data dir 目录名不同（app/bin 与 bin，dn 与 single_node）
  async function initOpenGauss(opts) {
    return queueOpenGaussAccessUpdate(() => initOpenGaussLocked(opts));
  }

  async function initOpenGaussLocked(opts) {
    opts = opts || {};
    const password = String(opts.password || 'Gauss@2026');
    const cidr = accessRules.normalizeIpv4Cidr(opts.cidr || '192.168.0.0/24');
    const dbUser = 'dcim';
    if (password.length < 8) throw new Error('密码至少 8 位');
    // openGauss 强度要求：大小写/数字/特殊字符至少 3 类
    let kinds = 0;
    if (/[a-z]/.test(password)) kinds++;
    if (/[A-Z]/.test(password)) kinds++;
    if (/[0-9]/.test(password)) kinds++;
    if (/[^A-Za-z0-9]/.test(password)) kinds++;
    if (kinds < 3) throw new Error('密码需要包含大小写字母/数字/特殊字符中至少 3 类');

    const logs = [];
    const step = (name, out) => {
      const s = '[' + name + '] ' + (out || '').split('\n').slice(0, 5).join(' | ').slice(0, 400);
      logs.push(s); appendLog('gauss-init ' + s);
    };

    // 1. 探测路径（gaussdb 二进制 + pg_hba.conf 所在 data 目录）
    let r = await sshRun(runInContainerCmd(cfg.container,
      "find /opt/software/openGauss -maxdepth 4 -name gaussdb -type f 2>/dev/null | head -1"));
    const gaussBin = r.stdout.trim();
    if (!gaussBin) throw new Error('未找到 openGauss 的 gaussdb 二进制（预期 /opt/software/openGauss 下）');
    const gaussHome = gaussBin.replace(/\/bin\/gaussdb$/, '');
    step('detect-home', gaussHome);

    r = await sshRun(runInContainerCmd(cfg.container,
      "find /opt/software/openGauss/data -maxdepth 3 -name pg_hba.conf 2>/dev/null | head -1"));
    const pgHbaPath = r.stdout.trim();
    if (!pgHbaPath) throw new Error('未找到 pg_hba.conf（预期 /opt/software/openGauss/data 下）');
    const dataDir = pgHbaPath.replace(/\/pg_hba\.conf$/, '');
    const pgConfPath = dataDir + '/postgresql.conf';
    step('detect-data', dataDir);

    // 2. enable + start（幂等）
    r = await sshRun(runInContainerCmd(cfg.container, 'systemctl enable opengauss 2>&1'));
    step('enable', r.stdout || r.stderr);
    r = await sshRun(runInContainerCmd(cfg.container, 'systemctl start opengauss 2>&1'));
    step('start', r.stdout || r.stderr);

    // 3. 轮询等 5432 起来（最多 30 秒）
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const p = await sshRun(runInContainerCmd(cfg.container,
        "ss -lntp 2>/dev/null | awk '{print $4}' | grep -E ':5432$' | head -1"));
      if (p.stdout.trim()) { ready = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    step('ready', ready ? 'openGauss 已监听 5432' : '等待 5432 超时');
    if (!ready) throw new Error('openGauss 启动后 30 秒内未监听 5432');

    // 4. 写 SQL 脚本到容器内 /tmp，omm 身份执行（避免命令行 escape 问题）
    const sqlPw = password.replace(/'/g, "''");
    const sqlBody = [
      "DO $$",
      "BEGIN",
      "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '" + dbUser + "') THEN",
      "    CREATE USER " + dbUser + " WITH PASSWORD '" + sqlPw + "';",
      "  ELSE",
      "    ALTER USER " + dbUser + " WITH PASSWORD '" + sqlPw + "';",
      "  END IF;",
      "END",
      "$$;",
      "ALTER USER " + dbUser + " SET search_path TO public;",
      "GRANT CONNECT ON DATABASE postgres TO " + dbUser + ";",
    ].join('\n');
    // heredoc 拷进容器：base64 一次性传，避免 shell 里的 $ 展开与转义
    const b64 = Buffer.from(sqlBody, 'utf8').toString('base64');
    const writeSqlCmd = runInContainerCmd(cfg.container,
      "sh -c 'echo " + shellEscape(b64).slice(1, -1) + " | base64 -d > /tmp/gauss-init.sql && chown omm:dbgrp /tmp/gauss-init.sql'");
    r = await sshRun(writeSqlCmd);
    step('write-sql', r.stdout || r.stderr);

    // 5. 用 omm 用户跑 gsql（导 GAUSSHOME/PATH/LD_LIBRARY_PATH）
    const gsqlEnv = 'export GAUSSHOME=' + gaussHome + '; ' +
      'export PATH=$GAUSSHOME/bin:$PATH; ' +
      'export LD_LIBRARY_PATH=$GAUSSHOME/lib:$LD_LIBRARY_PATH; ';
    const gsqlRun = gsqlEnv + 'gsql -d postgres -p 5432 -f /tmp/gauss-init.sql 2>&1';
    r = await sshRun(runInContainerAs(cfg.container, 'omm', gsqlRun));
    step('grant', r.stdout || r.stderr);
    if (r.code !== 0 && !/CREATE ROLE|ALTER ROLE|DO|GRANT/.test(r.stdout)) {
      throw new Error('创建 dcim 用户失败: ' + (r.stdout || r.stderr).slice(0, 400));
    }

    // 6. 改 postgresql.conf 的 listen_addresses = '*'
    const laFix = "sed -i \"s/^#*listen_addresses.*/listen_addresses = '*'/\" " + pgConfPath +
      " && grep '^listen_addresses' " + pgConfPath;
    r = await sshRun(runInContainerCmd(cfg.container, laFix));
    step('listen-addresses', r.stdout || r.stderr);

    // 7. pg_hba.conf 写入 WebSSH 受管块。保留非受管规则，初始 CIDR 可随后的独立接口无重启维护。
    const currentHbaText = await readContainerText(pgHbaPath);
    const currentRules = accessRules.readManagedRules(currentHbaText).rules;
    const nextHbaText = accessRules.writeManagedRules(currentHbaText, currentRules.concat([cidr]));
    const initBackupPath = pgHbaPath + '.bak.webssh-init.' + stampForFile();
    await replaceContainerText(pgHbaPath, nextHbaText, initBackupPath);
    step('pg_hba', '已写入 WebSSH 受管 CIDR 块，备份：' + initBackupPath);

    // 8. 重启 opengauss 让 listen_addresses + pg_hba 生效
    r = await sshRun(runInContainerCmd(cfg.container, 'systemctl restart opengauss 2>&1'));
    step('restart', r.stdout || r.stderr);
    // 再等一次 5432
    ready = false;
    for (let i = 0; i < 30; i++) {
      const p = await sshRun(runInContainerCmd(cfg.container,
        "ss -lntp 2>/dev/null | awk '{print $4}' | grep -E ':5432$' | head -1"));
      if (p.stdout.trim()) { ready = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    step('ready-after-restart', ready ? '重启后已监听 5432' : '重启后等待超时');

    // 9. 验证：用 dcim/pw 连一次（在容器内跑，绕过宿主端口映射差异）
    const verifyCmd = gsqlEnv + 'gsql -h 127.0.0.1 -p 5432 -U ' + dbUser +
      " -W " + shellEscape(password).slice(1, -1) +
      " -d postgres -c \"select current_user;\" 2>&1";
    r = await sshRun(runInContainerAs(cfg.container, 'omm', verifyCmd));
    step('verify', r.stdout || r.stderr);
    const verified = /current_user/i.test(r.stdout) && /dcim/.test(r.stdout);

    // 10. 顺便把 db-manager 配置里的 opengauss 密码同步进去，用户后续 SQL 控制台可直连
    try {
      cfg.databases.opengauss.username = dbUser;
      cfg.databases.opengauss.password = password;
      // 存 'dcim' 而非 'postgres'：dcim 业务库和 WVP 表都在 dcim 库，
      // 且 pg_hba 白名单我们只针对 'dcim' 数据库+dcim 用户开放
      cfg.databases.opengauss.database = 'dcim';
      writeCfg();
      await destroyPools();
      step('save-cfg', 'db-manager 配置已同步 opengauss 用户与密码');
    } catch (e) { step('save-cfg', 'ERROR: ' + e.message); }

    return {
      ok: true,
      gaussHome, dataDir, pgHbaPath, pgConfPath,
      dbUser, cidr,
      hostMap5432: '容器内 5432 已监听，若需从外部主机 <IP>:5432 访问，需保证 docker 有 5432→5432 端口映射',
      verified,
      logs,
    };
  }

  // 6GB 宿主机的保守配置：避免默认 6GB process memory + 大缓存导致 gaussdb
  // 无法创建共享内存。通过 gs_guc 写入，失败时恢复同一份配置备份。
  async function optimizeOpenGaussMemory() {
    const db = getDbCfg('opengauss');
    if (!db) throw new Error('openGauss 未配置');
    const unit = String(db.systemdUnit || 'opengauss.service');
    if (!/^[A-Za-z0-9_.@-]+$/.test(unit)) throw new Error('openGauss systemd Unit 非法');

    const profile = {
      max_process_memory: '2097152',
      shared_buffers: '128MB',
      cstore_buffers: '128MB',
      max_connections: '100',
    };
    const logs = [];
    const step = (name, output) => {
      const text = '[' + name + '] ' + String(output || '').trim().split('\n').slice(0, 4).join(' | ').slice(0, 400);
      logs.push(text);
      appendLog('gauss-memory-optimize ' + text);
    };

    let r = await sshRun(runInContainerCmd(cfg.container,
      "find /opt/software/openGauss/data -maxdepth 3 -name postgresql.conf -type f 2>/dev/null | head -1"));
    const pgConfPath = r.stdout.trim();
    if (!pgConfPath) throw new Error('未找到 openGauss postgresql.conf');
    const dataDir = pgConfPath.replace(/\/postgresql\.conf$/, '');

    r = await sshRun(runInContainerCmd(cfg.container,
      "find /opt/software/openGauss -maxdepth 4 -name gs_guc -type f 2>/dev/null | head -1"));
    const gsGucPath = r.stdout.trim();
    if (!gsGucPath) throw new Error('未找到 openGauss gs_guc 工具');

    const backupPath = pgConfPath + '.bak.' + stampForFile();
    r = await sshRun(runInContainerCmd(cfg.container,
      'cp -a ' + shellEscape(pgConfPath) + ' ' + shellEscape(backupPath)));
    if (r.code !== 0) throw new Error('备份 postgresql.conf 失败: ' + (r.stderr || r.stdout).slice(0, 300));
    step('backup', backupPath);

    async function restoreBackup(reason) {
      const restoreCmd = 'cp -a ' + shellEscape(backupPath) + ' ' + shellEscape(pgConfPath) +
        ' && systemctl restart ' + shellEscape(unit) + ' 2>&1';
      const restoreResult = await sshRun(runInContainerCmd(cfg.container, restoreCmd));
      step('rollback', restoreResult.stdout || restoreResult.stderr);
      const suffix = restoreResult.code === 0 ? '已恢复原配置' : '恢复原配置也失败';
      throw new Error(reason + '；' + suffix + ': ' + (restoreResult.stderr || restoreResult.stdout || '').slice(0, 300));
    }

    for (const key of Object.keys(profile)) {
      const value = profile[key];
      const setCmd = shellEscape(gsGucPath) + ' set -D ' + shellEscape(dataDir) +
        ' -c ' + shellEscape(key + '=' + value) + ' 2>&1';
      r = await sshRun(runInContainerAs(cfg.container, 'omm', setCmd));
      step('set-' + key, r.stdout || r.stderr);
      if (r.code !== 0) await restoreBackup('写入 ' + key + ' 失败');
    }

    r = await sshRun(runInContainerCmd(cfg.container,
      'systemctl restart ' + shellEscape(unit) + ' 2>&1'));
    step('restart-openGauss', r.stdout || r.stderr);
    if (r.code !== 0) await restoreBackup('重启 openGauss 失败');

    let ready = false;
    for (let i = 0; i < 20; i++) {
      const probe = await sshRun(runInContainerCmd(cfg.container,
        "ss -lnt 2>/dev/null | awk '{print $4}' | grep -E ':5432$' | head -1"));
      if (probe.stdout.trim()) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) await restoreBackup('openGauss 重启后 20 秒内未监听 5432');

    let sqlCheck;
    try {
      sqlCheck = await runOpenGaussGsql('SELECT 1;');
    } catch (err) {
      await restoreBackup('openGauss SQL 验证失败: ' + (err.message || err));
    }
    step('verify', '5432 已监听，SELECT 1 = ' + sqlCheck);

    return { ok: true, backupPath, dataDir, profile, sqlCheck, logs };
  }

  // 数据源快照覆盖 conf 后，Docker bind mount 的宿主目录可能保留了错误的权限。
  // 此操作只修复 Apache 虚拟主机目录并重启 dcim 重新挂载，不修改数据库数据或 dbconfig。
  async function repairOpenGaussApacheMount() {
    const APACHE_MOUNT_SOURCE = '/dcim/conf/apache';
    const APACHE_MOUNT_TARGET = '/www/server/panel/vhost/apache';
    const HTTPS_CHECK_URL = 'https://127.0.0.1:8086/index.html';
    const logs = [];
    const step = (name, output) => {
      const text = '[' + name + '] ' + String(output || '').trim().split('\n').slice(0, 8).join(' | ').slice(0, 700);
      logs.push(text);
      appendLog('gauss-apache-mount-repair ' + text);
    };

    let r = await sshRun('test -d /dcim/conf/apache');
    if (r.code !== 0) {
      throw new Error('/dcim/conf/apache 不是目录，无法安全修复；请先从高斯数据源快照恢复 conf/apache 目录');
    }

    const mountCmd = 'docker inspect ' + shellEscape(cfg.container) +
      " --format '{{range .Mounts}}{{if eq .Source \"" + APACHE_MOUNT_SOURCE + "\"}}{{.Destination}}{{end}}{{end}}'";
    r = await sshRun(mountCmd);
    const mountTarget = r.stdout.trim();
    if (r.code !== 0 || mountTarget !== APACHE_MOUNT_TARGET) {
      throw new Error('dcim Apache 挂载校验失败，期望 ' + APACHE_MOUNT_SOURCE + ' -> ' +
        APACHE_MOUNT_TARGET + '，实际为 ' + (mountTarget || '未找到'));
    }
    step('mount', APACHE_MOUNT_SOURCE + ' -> ' + mountTarget);

    const permissionCmd = [
      'find /dcim/conf/apache -type d -exec chmod 755 {} +',
      'find /dcim/conf/apache -type f -exec chmod 644 {} +',
      'printf "dirs=%s files=%s root_mode=%s\\n" "$(find /dcim/conf/apache -type d | wc -l)" "$(find /dcim/conf/apache -type f | wc -l)" "$(stat -c %a /dcim/conf/apache)"',
    ].join(' && ');
    r = await sshRun(permissionCmd);
    if (r.code !== 0) throw new Error('修复 /dcim/conf/apache 权限失败: ' + (r.stderr || r.stdout).slice(0, 400));
    step('permissions', r.stdout || r.stderr);

    r = await sshRun('docker restart ' + shellEscape(cfg.container) + ' 2>&1');
    step('restart-dcim', r.stdout || r.stderr);
    if (r.code !== 0) throw new Error('重启 dcim 容器失败: ' + (r.stderr || r.stdout).slice(0, 400));

    let mounted = false;
    for (let i = 0; i < 30; i++) {
      const state = await sshRun('docker inspect ' + shellEscape(cfg.container) + " -f '{{.State.Running}}'");
      if (state.stdout.trim() === 'true') {
        const check = await sshRun(runInContainerCmd(cfg.container,
          'test -d ' + shellEscape(APACHE_MOUNT_TARGET)));
        if (check.code === 0) { mounted = true; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!mounted) throw new Error('dcim 重启后 30 秒内未恢复 Apache 配置目录挂载');
    step('container-mount', APACHE_MOUNT_TARGET + ' 已挂载');

    const syntax = await sshRun(runInContainerCmd(cfg.container,
      '/www/server/apache/bin/httpd -t 2>&1'));
    step('httpd-test', syntax.stdout || syntax.stderr);
    if (syntax.code !== 0 || !/Syntax OK/i.test(syntax.stdout || syntax.stderr || '')) {
      throw new Error('Apache 配置语法检查失败: ' + (syntax.stderr || syntax.stdout).slice(0, 400));
    }

    let httpCheck = { code: -1, stdout: '', stderr: '' };
    let headers = '';
    for (let i = 0; i < 15; i++) {
      httpCheck = await sshRun('curl -k -s -S -I --max-time 5 ' + shellEscape(HTTPS_CHECK_URL) + " | sed -n '1,12p'");
      headers = String((httpCheck.stdout || '') + '\n' + (httpCheck.stderr || '')).trim();
      if (httpCheck.code === 0 && /HTTP\/[0-9.]+ 200/i.test(headers) && /^server:\s*Apache/im.test(headers)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    step('https', headers);
    if (httpCheck.code !== 0 || !/HTTP\/[0-9.]+ 200/i.test(headers) || !/^server:\s*Apache/im.test(headers)) {
      throw new Error('HTTPS 验证失败: ' + headers.slice(0, 500));
    }

    return {
      ok: true,
      mountSource: APACHE_MOUNT_SOURCE,
      mountTarget: APACHE_MOUNT_TARGET,
      permissions: { directories: '755', files: '644' },
      httpHeaders: headers,
      logs,
    };
  }

  async function repairDeviceProtocolSequence() {
    const phpScript = String.raw`<?php
require '/www/wwwroot/localhost_8086/wwwroot/src/config.php';

$db = Flight::db();
$db->exec('SELECT setval(\'"dcim-deviceprotocol_id_seq"\', (SELECT GREATEST(MAX("id"), 1) FROM "dcim-deviceprotocol"), true)');

$maxRow = $db->query('SELECT MAX("id") AS max_id FROM "dcim-deviceprotocol"')->fetch(PDO::FETCH_ASSOC);
$sequenceRow = $db->query('SELECT last_value FROM public."dcim-deviceprotocol_id_seq"')->fetch(PDO::FETCH_ASSOC);

echo json_encode(array(
  'max_id' => (int)($maxRow['max_id'] ?: 0),
  'last_value' => (int)($sequenceRow['last_value'] ?: 0),
), JSON_UNESCAPED_UNICODE);
`;
    const tmpPath = '/tmp/dbmgr-fix-deviceprotocol-sequence.php';
    const encoded = Buffer.from(phpScript, 'utf8').toString('base64');
    const inner = [
      'tmp=' + shellEscape(tmpPath),
      'echo ' + shellEscape(encoded) + ' | base64 -d > "$tmp"',
      'cd ' + shellEscape('/www/wwwroot/localhost_8086/wwwroot/src'),
      'php "$tmp"',
      'status=$?',
      'rm -f "$tmp"',
      'exit $status',
    ].join('; ');
    const r = await sshRun(runInContainerCmd(cfg.container, inner));
    const output = String((r.stdout || '') + '\n' + (r.stderr || '')).trim();
    if (r.code !== 0) {
      throw new Error('修复设备协议序列失败: ' + output.slice(0, 500));
    }
    const match = output.match(/\{[^{}\r\n]*\}\s*$/);
    if (!match) throw new Error('修复命令未返回结果: ' + output.slice(0, 500));
    let result;
    try { result = JSON.parse(match[0]); }
    catch (_e) { throw new Error('修复结果格式错误: ' + match[0]); }
    const response = {
      ok: true,
      maxId: Number(result.max_id),
      lastValue: Number(result.last_value),
    };
    appendLog('opengauss deviceprotocol sequence repaired maxId=' + response.maxId +
      ' lastValue=' + response.lastValue);
    return response;
  }

  app.post('/api/db-manager/opengauss/fix-deviceprotocol-sequence', async (_req, res) => {
    try { res.json(await repairDeviceProtocolSequence()); }
    catch (e) {
      appendLog('opengauss/fix-deviceprotocol-sequence 失败: ' + e.message);
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.get('/api/db-manager/opengauss/access-rules', async (_req, res) => {
    try {
      const availability = await probeOpenGaussAccessAvailability();
      const files = await locateOpenGaussAccessFiles();
      const text = await readContainerText(files.hbaPath);
      const parsed = accessRules.readManagedRules(text);
      res.json({
        ok: true,
        rules: parsed.rules,
        hasManagedBlock: parsed.hasManagedBlock,
        globalAllowWarning: parsed.globalAllowWarning,
        serviceRunning: availability.available,
        systemdState: availability.systemdState,
        availabilityError: availability.error,
        hbaPath: files.hbaPath,
      });
    } catch (e) {
      appendLog('opengauss/access-rules 读取失败: ' + e.message);
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.put('/api/db-manager/opengauss/access-rules', async (req, res) => {
    const body = req.body || {};
    const mode = String(body.mode || '');
    if (mode !== 'replace' && mode !== 'append') {
      return res.status(400).json({ ok: false, message: 'mode 只能是 replace 或 append' });
    }
    try {
      const result = await updateOpenGaussAccessRules(mode, body.cidr);
      res.json(result);
    } catch (e) {
      appendLog('opengauss/access-rules 更新失败: ' + e.message);
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.delete('/api/db-manager/opengauss/access-rules/:cidr', async (req, res) => {
    try {
      const cidr = decodeURIComponent(req.params.cidr || '');
      const result = await updateOpenGaussAccessRules('remove', cidr);
      res.json(result);
    } catch (e) {
      appendLog('opengauss/access-rules 删除失败: ' + e.message);
      res.status(e.statusCode === 404 ? 404 : 400).json({ ok: false, message: e.message });
    }
  });

  app.post('/api/db-manager/opengauss/init', async (req, res) => {
    const b = req.body || {};
    try {
      const r = await initOpenGauss({ password: b.password, cidr: b.cidr });
      res.json(r);
    } catch (e) {
      appendLog('opengauss/init 失败: ' + e.message);
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.post('/api/db-manager/opengauss/optimize-memory', async (_req, res) => {
    try {
      res.json(await optimizeOpenGaussMemory());
    } catch (e) {
      appendLog('opengauss/optimize-memory 失败: ' + e.message);
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.post('/api/db-manager/opengauss/repair-apache-mount', async (_req, res) => {
    try {
      res.json(await repairOpenGaussApacheMount());
    } catch (e) {
      appendLog('opengauss/repair-apache-mount 失败: ' + e.message);
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  // ===== openGauss 一键新建 WVP 数据库表 =====
  // 场景：openGauss dcim 库刚建，但 WVP 15 张业务表还没有；这个按钮一键建表 + 塞初始 admin 账号。
  // SQL 从 db/vendor/wvp-init-opengauss.sql 读，本身已经是 PG/openGauss 兼容语法（SERIAL / character varying 等）。
  const WVP_TABLES = [
    'wvp_device','wvp_device_alarm','wvp_device_channel','wvp_device_mobile_position',
    'wvp_gb_stream','wvp_log','wvp_media_server','wvp_platform','wvp_platform_catalog',
    'wvp_platform_gb_channel','wvp_platform_gb_stream','wvp_stream_proxy','wvp_stream_push',
    'wvp_user','wvp_user_role',
  ];
  async function countWvpTables() {
    // 走 SSH + 容器内 gsql（loopback 127.0.0.1）避开 pg_hba 白名单问题
    // pg pool 从 webssh 主机连 5432 需 pg_hba 白名单 192.168.50.0/24；SSH → docker exec 则走本机 loopback
    const gsqlPw = String(cfg.databases.opengauss.password || '');
    const gsqlCmd = '/opt/software/openGauss/app/bin/gsql -h 127.0.0.1 -p 5432 -U dcim -W ' +
      shellEscape(gsqlPw).slice(1, -1) +
      ' -d dcim -At -c "SELECT tablename FROM pg_tables WHERE schemaname=' + "'public'" +
      ' AND tablename LIKE ' + "'wvp' || '_%' ESCAPE '\\\\' ORDER BY tablename;\"";
    const r = await sshRun(runInContainerAs(cfg.container, 'omm', gsqlCmd));
    if (r.code !== 0) throw new Error('countWvpTables 失败: ' + (r.stderr || r.stdout).slice(0, 300));
    return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(s => /^wvp_[a-z_]+$/.test(s));
  }
  async function initWvpSchema(opts) {
    opts = opts || {};
    const dropExisting = !!opts.dropExisting;
    const targetDb = String(opts.database || 'dcim');
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(targetDb)) throw new Error('数据库名非法');
    // 1. 读本地 bundle 的 SQL
    const sqlPath = path.join(__dirname, 'db', 'vendor', 'wvp-init-opengauss.sql');
    if (!fs.existsSync(sqlPath)) throw new Error('SQL 模板不存在: ' + sqlPath);
    let sql = fs.readFileSync(sqlPath, 'utf8');
    // 2. dropExisting → 先拼 DROP，再拼 CREATE
    if (dropExisting) {
      const dropSql = WVP_TABLES.map(t => 'DROP TABLE IF EXISTS "' + t + '" CASCADE;').join('\n');
      sql = dropSql + '\n\n' + sql;
    }
    // 注：不改 INSERT 幂等性 —— openGauss 6.0 ON CONFLICT 语法不完全兼容 PG，
    // 且首次建表 wvp_user/wvp_user_role 是空表，原始 INSERT 一定成功；
    // 重复执行时 CREATE TABLE 会因表存在报错，用户勾选「先 DROP 再建」重跑即可。
    // 4. 上传到目标机 /tmp
    const ts = stampForFile();
    const localTmp = path.join(__dirname, 'tmp', 'wvp-init-' + ts + '.sql');
    fs.mkdirSync(path.dirname(localTmp), { recursive: true });
    fs.writeFileSync(localTmp, sql, 'utf8');
    const remoteTmp = '/tmp/wvp-init-' + ts + '.sql';
    await sftpUpload(localTmp, remoteTmp);
    // 5. docker cp 进容器
    const cpIn = await sshRun('docker cp ' + remoteTmp + ' ' + shellEscape(cfg.container) + ':' + remoteTmp);
    if (cpIn.code !== 0) throw new Error('docker cp 失败: ' + (cpIn.stderr || cpIn.stdout).slice(0, 400));
    // 6. 用 omm 身份 gsql -f 执行（避免 dcim 用户没有 CREATE 权限）
    //    但表属主应该属于 dcim。所以在 SQL 头加个 SET SESSION AUTHORIZATION dcim;
    //    简化方案：直接用 dcim 用户跑（dcim 默认对 public schema 有 CREATE 权限）
    const dbUser = 'dcim';
    const dbPw = cfg.databases.opengauss.password || '';
    const gsqlCmd = '/opt/software/openGauss/app/bin/gsql -h 127.0.0.1 -p 5432 -U ' + dbUser +
      ' -W ' + shellEscape(dbPw).slice(1, -1) + ' -d ' + targetDb +
      ' -v ON_ERROR_STOP=1 -f ' + remoteTmp;
    const execR = await sshRun(runInContainerAs(cfg.container, 'omm', gsqlCmd));
    // 7. 清理临时文件
    try { fs.unlinkSync(localTmp); } catch (_e) {}
    await sshRun(runInContainerCmd(cfg.container, 'rm -f ' + remoteTmp));
    await sshRun('rm -f ' + shellEscape(remoteTmp));

    // 8. 结果分析：以最终表数量为真相。gsql 有时会因 NOTICE 输出让 exit code 变化，不能只看 code
    const output = (execR.stdout || '') + '\n' + (execR.stderr || '');
    const hasError = /^ERROR:|^FATAL:|gsql:.*ERROR:|gsql:.*FATAL:/m.test(output);
    // 9. 校验：跑完后再查一次表数量
    const after = await countWvpTables().catch(() => []);
    const success = after.length >= WVP_TABLES.length && !hasError;
    if (!success) {
      appendLog('init-wvp 失败 tables=' + after.length + '/' + WVP_TABLES.length +
        ' hasError=' + hasError + ' out=' + output.slice(0, 300));
      throw new Error('建表未达预期 (got=' + after.length + '/expected=' + WVP_TABLES.length +
        (hasError ? '，有 ERROR/FATAL' : '') + '): ' + output.slice(0, 400));
    }
    appendLog('init-wvp ok tables=' + after.length + ' dropExisting=' + dropExisting);
    return {
      ok: true, database: targetDb, dropExisting,
      created: after, createdCount: after.length,
      expectedCount: WVP_TABLES.length,
      output: output.slice(0, 2000),
    };
  }

  // GET  /api/db-manager/opengauss/wvp/status - 查 openGauss dcim 库里现有多少 wvp_ 表
  app.get('/api/db-manager/opengauss/wvp/status', async (_req, res) => {
    try {
      const tables = await countWvpTables();
      res.json({ ok: true, tables, count: tables.length, expected: WVP_TABLES.length,
        expectedList: WVP_TABLES });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  function wvpRuntimeSummary(runtime) {
    const status = runtime.status || {};
    return 'ssh=' + runtime.sshCode + ' ready=' + Boolean(status.ready) +
      ' restartAllowed=' + Boolean(status.restartAllowed);
  }
  async function collectWvpRuntimeStatus(options) {
    try {
      const probe = 'timeout 10s sh -c ' + shellEscape(wvpUtils.wvpRuntimeProbeCommand());
      const result = await sshRun(runInContainerCmd(cfg.container, probe), options);
      const runtime = wvpUtils.wvpRuntimeStatusFromSshResult(result);
      if (result.code === 124 || result.timedOut) runtime.timedOut = true;
      return runtime;
    } catch (_e) {
      return wvpUtils.wvpRuntimeStatusFromSshResult({ code: -1, stdout: '' });
    }
  }
  const wvpRuntimeOperations = createWvpRuntimeOperations({
    collect: collectWvpRuntimeStatus,
    restartService: (command, options) => sshRun(runInContainerCmd(cfg.container,
      'timeout 10s sh -c ' + shellEscape(command)), options),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  registerWvpRuntimeRoutes(app, {
    runtimeOperations: wvpRuntimeOperations,
    isAuthed: isAuthed,
    appendLog: appendLog,
    runtimeSummary: wvpRuntimeSummary,
  });

  // POST /api/db-manager/opengauss/wvp/init - 一键建 WVP 表
  //   body: { database?: 'dcim', dropExisting?: false }
  app.post('/api/db-manager/opengauss/wvp/init', async (req, res) => {
    const b = req.body || {};
    try {
      const r = await initWvpSchema({ database: b.database, dropExisting: b.dropExisting });
      res.json(r);
    } catch (e) {
      appendLog('opengauss/wvp/init 失败: ' + e.message);
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  // ===== WVP 数据同步：MySQL wvp 库 → openGauss dcim.public 15 张 wvp_ 表 =====
  // 场景：dcim 主业务已切 openGauss，只有 WVP 还挂在 MySQL；此接口把 MySQL 里的 WVP 历史数据搬到
  // openGauss（wvp_* 表结构必须已存在，未建先跑「建 WVP 表」）。WVP 服务不动，继续用 MySQL。
  // 关键处理：
  //   1. MySQL tinyint(1) 0/1 → openGauss boolean true/false（探测 information_schema data_type='boolean' 列）
  //   2. 幂等追加（ON CONFLICT DO NOTHING）或先 TRUNCATE 全量重灌
  //   3. 保留主键值以维持外键关系，同步完 setval(pg_get_serial_sequence, MAX(id))
  //   4. 只同步双方共有的列，MySQL 独有列忽略，openGauss 独有列走默认值
  async function syncWvpFromMysql(opts) {
    opts = opts || {};
    const dropExisting = !!opts.dropExisting;
    if (!mysql2) throw new Error('mysql2 未安装');
    if (!pgLib)   throw new Error('pg 未安装');

    // 前置校验：目标 15 张 wvp_ 表必须已存在
    const existTables = await countWvpTables();
    const missing = WVP_TABLES.filter(t => !existTables.includes(t));
    if (missing.length) {
      throw new Error('openGauss 缺少 wvp 表 ' + missing.join(', ') + '，请先跑「建 WVP 表」');
    }

    // MySQL 连接（wvp 库，不是 dcim）
    const my = cfg.databases.mysql;
    const myConn = await mysql2.createConnection({
      host: my.host, port: Number(my.port) || 3333,
      user: my.username, password: my.password || '',
      database: 'wvp', charset: 'utf8mb4',
      connectTimeout: 8000, dateStrings: true,
    });
    // openGauss 连接（dcim 库）
    const gauss = cfg.databases.opengauss;
    const pgClient = new pgLib.Client({
      host: gauss.host, port: Number(gauss.port) || 5432,
      user: gauss.username, password: gauss.password || '',
      database: gauss.database || 'dcim',
      connectionTimeoutMillis: 8000,
    });
    await pgClient.connect();

    const report = [];
    try {
      for (const table of WVP_TABLES) {
        const item = { table, mysqlRows: 0, gaussBefore: 0, gaussAfter: 0,
          inserted: 0, error: null, elapsedMs: 0 };
        const t0 = Date.now();
        try {
          // 双方列
          const [myColsRaw] = await myConn.query(
            "SELECT column_name AS c FROM information_schema.columns WHERE table_schema='wvp' AND table_name=? ORDER BY ordinal_position",
            [table]);
          const mySet = new Set(myColsRaw.map(r => (r.c || r.column_name || r.COLUMN_NAME || '').toLowerCase()));
          const gaussColsRes = await pgClient.query(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
            [table]);
          const gaussCols = gaussColsRes.rows.map(r => r.column_name);
          const boolCols = new Set(gaussColsRes.rows.filter(r => r.data_type === 'boolean').map(r => r.column_name));
          const commonCols = gaussCols.filter(c => mySet.has(c.toLowerCase()));
          if (!commonCols.length) throw new Error('无共有列');

          // 主键列（openGauss 不认 ON CONFLICT，用客户端预取 + 过滤代替）
          const pkRes = await pgClient.query(
            "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)" +
            " WHERE i.indrelid = ($1::regclass) AND i.indisprimary ORDER BY a.attnum",
            ['public."' + table + '"']);
          const pkCols = pkRes.rows.map(r => r.attname).filter(c => commonCols.includes(c));

          // 行数（前）
          const [c1] = await myConn.query('SELECT COUNT(*) AS c FROM `' + table + '`');
          item.mysqlRows = Number(c1[0].c || 0);
          const b = await pgClient.query('SELECT COUNT(*)::bigint AS c FROM "' + table + '"');
          item.gaussBefore = Number(b.rows[0].c);

          // TRUNCATE 或客户端幂等：预取已存 PK 集合
          // 注意：openGauss（PGXC 分布式）不支持 RESTART IDENTITY，只能纯 TRUNCATE CASCADE；
          // sequence 由后续 setval 逻辑重置到 MAX(id)+1
          let existingPkSet = null;
          if (dropExisting && item.gaussBefore > 0) {
            await pgClient.query('TRUNCATE TABLE "' + table + '" CASCADE');
          } else if (!dropExisting && item.gaussBefore > 0 && pkCols.length) {
            // 拉出所有已存 PK 值组成 Set（key 用 '' 拼），下面 INSERT 前过滤
            const pkSelect = pkCols.map(c => '"' + c + '"').join(',');
            const ex = await pgClient.query('SELECT ' + pkSelect + ' FROM "' + table + '"');
            existingPkSet = new Set();
            for (const r of ex.rows) {
              const key = pkCols.map(c => String(r[c])).join('');
              existingPkSet.add(key);
            }
          }

          // 批量搬
          if (item.mysqlRows > 0) {
            const BATCH = 500;
            const colList = commonCols.map(c => '`' + c + '`').join(',');
            for (let off = 0; off < item.mysqlRows; off += BATCH) {
              const [rows] = await myConn.query(
                'SELECT ' + colList + ' FROM `' + table + '` LIMIT ? OFFSET ?', [BATCH, off]);
              if (!rows.length) break;

              // 客户端过滤：跳过 PK 已存在的
              const rowsToInsert = existingPkSet
                ? rows.filter(row => {
                    const key = pkCols.map(c => String(row[c])).join('');
                    return !existingPkSet.has(key);
                  })
                : rows;
              if (!rowsToInsert.length) continue;

              // 构造多行 INSERT
              const params = []; const placeholders = [];
              for (const row of rowsToInsert) {
                const rowP = [];
                for (const col of commonCols) {
                  let v = row[col];
                  if (boolCols.has(col)) {
                    if (v === null || v === undefined || v === '') v = null;
                    else if (v === 0 || v === '0' || v === false) v = false;
                    else if (v === 1 || v === '1' || v === true) v = true;
                  }
                  params.push(v);
                  rowP.push('$' + params.length);
                }
                placeholders.push('(' + rowP.join(',') + ')');
              }
              const sql = 'INSERT INTO "' + table + '" (' +
                commonCols.map(c => '"' + c + '"').join(',') + ') VALUES ' + placeholders.join(',');
              const r = await pgClient.query(sql, params);
              item.inserted += r.rowCount || 0;
              // 更新已存 PK 集合，避免下一批冲突
              if (existingPkSet) {
                for (const row of rowsToInsert) {
                  const key = pkCols.map(c => String(row[c])).join('');
                  existingPkSet.add(key);
                }
              }
            }
          }

          // 修 sequence：把 wvp 表的自增主键 sequence 推到 MAX(pk)+1
          // 用两步查询 + 参数化，避免手拼字符串导致 MAX(列名) 变成 MAX('列名字符串')
          const serialColsRes = await pgClient.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='public' " +
            "AND table_name=$1 AND column_default LIKE 'nextval%'", [table]);
          for (const sc of serialColsRes.rows) {
            const col = sc.column_name;
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) continue;
            try {
              await pgClient.query(
                'SELECT setval(pg_get_serial_sequence($1, $2), ' +
                'COALESCE((SELECT MAX("' + col + '") FROM public."' + table + '"), 1), ' +
                'EXISTS (SELECT 1 FROM public."' + table + '"))',
                ['public."' + table + '"', col]);
            } catch (_e) { /* setval 失败不算致命 */ }
          }

          const a = await pgClient.query('SELECT COUNT(*)::bigint AS c FROM "' + table + '"');
          item.gaussAfter = Number(a.rows[0].c);
        } catch (e) {
          item.error = (e.message || String(e)).slice(0, 400);
          // 出错也刷新 gaussAfter，避免 UI 看到 gauss=X→0 的假象（其实数据可能还在）
          try {
            const a2 = await pgClient.query('SELECT COUNT(*)::bigint AS c FROM "' + table + '"');
            item.gaussAfter = Number(a2.rows[0].c);
          } catch (_ee) { item.gaussAfter = item.gaussBefore; }
        }
        item.elapsedMs = Date.now() - t0;
        report.push(item);
      }
    } finally {
      try { await myConn.end(); } catch (_e) {}
      try { await pgClient.end(); } catch (_e) {}
    }

    const totalMy = report.reduce((s, r) => s + r.mysqlRows, 0);
    const totalIns = report.reduce((s, r) => s + r.inserted, 0);
    const errCnt = report.filter(r => r.error).length;
    appendLog('wvp-sync tables=' + report.length + ' mysqlRows=' + totalMy +
      ' inserted=' + totalIns + ' errors=' + errCnt + ' dropExisting=' + dropExisting);
    return { ok: errCnt === 0, dropExisting, tables: report,
      summary: { totalMysqlRows: totalMy, totalInserted: totalIns, errorCount: errCnt } };
  }

  // 双库行数对比（页面加载弹窗时先查一次）
  async function wvpSyncStatus() {
    if (!mysql2) throw new Error('mysql2 未安装');
    if (!pgLib)   throw new Error('pg 未安装');
    const my = cfg.databases.mysql;
    const gauss = cfg.databases.opengauss;
    let myConn, pgClient;
    try {
      myConn = await mysql2.createConnection({
        host: my.host, port: Number(my.port) || 3333,
        user: my.username, password: my.password || '',
        database: 'wvp', connectTimeout: 5000,
      });
      pgClient = new pgLib.Client({
        host: gauss.host, port: Number(gauss.port) || 5432,
        user: gauss.username, password: gauss.password || '',
        database: gauss.database || 'dcim',
        connectionTimeoutMillis: 5000,
      });
      await pgClient.connect();
      const rows = [];
      for (const table of WVP_TABLES) {
        let mysqlRows = -1, gaussRows = -1, err = null;
        try {
          const [c1] = await myConn.query('SELECT COUNT(*) AS c FROM `' + table + '`');
          mysqlRows = Number(c1[0].c || 0);
        } catch (e) { err = 'mysql: ' + e.message.slice(0, 100); }
        try {
          const g = await pgClient.query('SELECT COUNT(*)::bigint AS c FROM "' + table + '"');
          gaussRows = Number(g.rows[0].c);
        } catch (e) { err = (err ? err + ' | ' : '') + 'gauss: ' + e.message.slice(0, 100); }
        rows.push({ table, mysqlRows, gaussRows, error: err });
      }
      return rows;
    } finally {
      try { if (myConn) await myConn.end(); } catch (_e) {}
      try { if (pgClient) await pgClient.end(); } catch (_e) {}
    }
  }

  app.get('/api/db-manager/opengauss/wvp/sync-status', async (_req, res) => {
    try { res.json({ ok: true, rows: await wvpSyncStatus() }); }
    catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.post('/api/db-manager/opengauss/wvp/sync-from-mysql', async (req, res) => {
    const b = req.body || {};
    try {
      const r = await syncWvpFromMysql({ dropExisting: b.dropExisting });
      res.json(r);
    } catch (e) {
      appendLog('opengauss/wvp/sync-from-mysql 失败: ' + e.message);
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  // 单独修 15 张 wvp_ 表的自增序列（推到 MAX(pk)+1）—— 无需重跑同步
  async function fixWvpSequences() {
    if (!pgLib) throw new Error('pg 未安装');
    const gauss = cfg.databases.opengauss;
    const pgClient = new pgLib.Client({
      host: gauss.host, port: Number(gauss.port) || 5432,
      user: gauss.username, password: gauss.password || '',
      database: gauss.database || 'dcim',
      connectionTimeoutMillis: 8000,
    });
    await pgClient.connect();
    const results = [];
    try {
      for (const table of WVP_TABLES) {
        const item = { table, sequences: [], error: null };
        try {
          const serialColsRes = await pgClient.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='public' " +
            "AND table_name=$1 AND column_default LIKE 'nextval%'", [table]);
          for (const sc of serialColsRes.rows) {
            const col = sc.column_name;
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) continue;
            // 拿 sequence 名 + max 值 + isCalled 前后值
            const seqRes = await pgClient.query(
              "SELECT pg_get_serial_sequence($1, $2) AS seq", ['public."' + table + '"', col]);
            const seqName = seqRes.rows[0] && seqRes.rows[0].seq;
            if (!seqName) continue;
            const beforeRes = await pgClient.query('SELECT last_value, is_called FROM ' + seqName);
            const maxRes = await pgClient.query(
              'SELECT COALESCE(MAX("' + col + '"), 0)::bigint AS m, COUNT(*)::bigint AS n FROM public."' + table + '"');
            const maxVal = Number(maxRes.rows[0].m);
            const cnt = Number(maxRes.rows[0].n);
            // 有数据：setval(seq, MAX, true) → 下次 nextval=MAX+1
            // 无数据：setval(seq, 1, false) → 下次 nextval=1
            await pgClient.query('SELECT setval($1, $2, $3)',
              [seqName, cnt > 0 ? maxVal : 1, cnt > 0]);
            const afterRes = await pgClient.query('SELECT last_value, is_called FROM ' + seqName);
            item.sequences.push({
              column: col, sequence: seqName, tableRows: cnt, maxPk: maxVal,
              before: { last_value: String(beforeRes.rows[0].last_value), is_called: beforeRes.rows[0].is_called },
              after:  { last_value: String(afterRes.rows[0].last_value),  is_called: afterRes.rows[0].is_called },
            });
          }
        } catch (e) { item.error = (e.message || String(e)).slice(0, 300); }
        results.push(item);
      }
    } finally {
      try { await pgClient.end(); } catch (_e) {}
    }
    const fixed = results.reduce((s, r) => s + r.sequences.length, 0);
    const errs = results.filter(r => r.error).length;
    appendLog('wvp/fix-sequences fixed=' + fixed + ' errors=' + errs);
    return { ok: errs === 0, fixed, errors: errs, tables: results };
  }

  app.post('/api/db-manager/opengauss/wvp/fix-sequences', async (_req, res) => {
    try { res.json(await fixWvpSequences()); }
    catch (e) {
      appendLog('opengauss/wvp/fix-sequences 失败: ' + e.message);
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  // ===== 达梦授权 / dm.key 管理 =====
  // - GET  /api/db-manager/dm/license      查授权信息（SYSDBA 查 V$LICENSE + 探 dm.key 文件）
  // - POST /api/db-manager/dm/upload-key   上传 dm.key（base64 content）→ 备份旧 key → 覆盖 → 重启 DM → 重查
  const DM_KEY_PATH = '/home/dmdba/dmdbms/bin/dm.key'; // 达梦 V8 默认查找位置
  const APACHE_VHOSTS_PATH = '/www/server/apache/conf/extra/httpd-vhosts.conf';
  const APACHE_HTTPD_BIN = '/www/server/apache/bin/httpd';
  async function queryDmLicense() {
    if (!dmdbLib) throw new Error('dmdb 驱动未安装');
    const db = cfg.databases.dm || {};
    const sysPw = (db.sysdbaPassword && db.sysdbaPassword !== '') ? db.sysdbaPassword : db.password;
    if (!sysPw) throw new Error('SYSDBA 密码未配置（在「连接信息」弹窗里填 达梦 SYSDBA 密码）');
    const connStr = buildDmConnectUrl({
      username: 'SYSDBA', password: sysPw, host: db.host, port: db.port,
    });
    let conn;
    try {
      conn = await dmdbLib.getConnection(connStr);
      // 查所有 license 字段
      const sql = 'SELECT * FROM V' + String.fromCharCode(36) + 'LICENSE';
      const r = await conn.execute(sql, [], { outFormat: dmdbLib.OUT_FORMAT_OBJECT });
      const row = (r.rows || [])[0] || {};
      // 版本
      let dbVersion = '';
      try {
        const rv = await conn.execute('SELECT * FROM V' + String.fromCharCode(36) + 'VERSION', [], { outFormat: dmdbLib.OUT_FORMAT_OBJECT });
        const v0 = (rv.rows || [])[0] || {};
        dbVersion = Object.values(v0).filter(x => typeof x === 'string' && /DM/i.test(x)).join(' ') || Object.values(v0).join(' ');
      } catch (_e) {}
      // 计算剩余天数
      let daysLeft = null;
      const exp = row.EXPIRED_DATE || row.expired_date || row['EXPIRED_DATE'];
      let expStr = '';
      if (exp) {
        const expDate = new Date(exp);
        if (!isNaN(expDate.getTime())) {
          expStr = expDate.toISOString().slice(0, 10);
          daysLeft = Math.floor((expDate.getTime() - Date.now()) / 86400000);
        } else expStr = String(exp);
      }
      return { fields: row, dbVersion: dbVersion, expiredDate: expStr, daysLeft: daysLeft };
    } finally {
      try { if (conn) await conn.close(); } catch (_e) {}
    }
  }
  async function probeDmKey() {
    // 探 dm.key 是否存在 + stat 信息（走 SSH docker exec）
    const r = await sshRun(runInContainerCmd(cfg.container,
      'if [ -f ' + DM_KEY_PATH + ' ]; then stat -c "%s %Y %U:%G %a" ' + DM_KEY_PATH + '; else echo MISSING; fi'));
    const line = (r.stdout || '').trim();
    if (line === 'MISSING' || !line) return { exists: false, path: DM_KEY_PATH };
    const parts = line.split(/\s+/);
    return { exists: true, path: DM_KEY_PATH, size: Number(parts[0]), mtime: Number(parts[1]) * 1000,
      owner: parts[2], mode: parts[3] };
  }
  async function uploadDmKey(contentBase64) {
    const buf = Buffer.from(contentBase64, 'base64');
    if (buf.length === 0) throw new Error('文件内容为空');
    if (buf.length > 1024 * 1024) throw new Error('dm.key 通常 < 10KB，收到 ' + buf.length + ' 字节可能不对');
    // 简单校验：文件里应包含 "License" 或 "AUTHORIZED" 关键字（达梦 key 是明文 KV 格式）
    const preview = buf.slice(0, Math.min(buf.length, 500)).toString('utf8');
    if (!/License|AUTHORIZED|SERIES|EXPIRED/i.test(preview)) {
      appendLog('dm.key 内容首部不含预期关键字，前 200 字节：' + preview.slice(0, 200).replace(/\s+/g, ' '));
      throw new Error('文件内容不像 dm.key（缺少 License / AUTHORIZED / SERIES 等关键字）');
    }
    const ts = stampForFile();
    // 1. 写宿主 tmp
    const hostTmp = '/tmp/dm.key.upload-' + ts;
    fs.mkdirSync(path.dirname(path.join(__dirname, 'tmp', 'dm-key')), { recursive: true });
    const localTmp = path.join(__dirname, 'tmp', 'dm-key', 'dm.key.upload-' + ts);
    fs.writeFileSync(localTmp, buf);
    await sftpUpload(localTmp, hostTmp);
    try { fs.unlinkSync(localTmp); } catch (_e) {}

    // 2. 容器内先备份现有 dm.key（若有）
    const bakPath = DM_KEY_PATH + '.bak.' + ts;
    const bakCmd = runInContainerCmd(cfg.container,
      'if [ -f ' + DM_KEY_PATH + ' ]; then cp -a ' + DM_KEY_PATH + ' ' + bakPath + '; fi');
    const bakR = await sshRun(bakCmd);
    appendLog('dm.key 旧文件备份 ' + (bakR.code === 0 ? bakPath : '失败/无原文件'));

    // 3. docker cp 上传到容器
    const cpR = await sshRun('docker cp ' + hostTmp + ' ' + shellEscape(cfg.container) + ':' + DM_KEY_PATH);
    if (cpR.code !== 0) {
      await sshRun('rm -f ' + shellEscape(hostTmp));
      throw new Error('docker cp 上传失败: ' + (cpR.stderr || cpR.stdout).slice(0, 400));
    }
    await sshRun('rm -f ' + shellEscape(hostTmp));

    // 4. 容器内改属主/权限（达梦 V8 官方推荐 dmdba:dinstall 0600）
    await sshRun(runInContainerCmd(cfg.container,
      'chown dmdba:dinstall ' + DM_KEY_PATH + ' && chmod 0600 ' + DM_KEY_PATH));

    // 5. 重启 DmServiceDMSERVER
    const restartR = await sshRun(runInContainerCmd(cfg.container,
      'systemctl restart DmServiceDMSERVER.service 2>&1'));
    // 6. 等 5236 就绪
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const p = await sshRun(runInContainerCmd(cfg.container,
        "ss -lntp 2>/dev/null | grep -E ':5236' | head -1"));
      if (p.stdout.trim()) { ready = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    appendLog('dm.key 上传 size=' + buf.length + ' 备份=' + bakPath + ' 重启=' + (ready ? 'OK' : 'timeout'));

    // 7. 重新查授权（成功后返回给前端）
    let license = null;
    try { license = await queryDmLicense(); } catch (e) { license = { error: e.message }; }
    return { ok: true, uploaded: buf.length, backup: bakPath, restarted: ready, license: license };
  }

  async function uploadDmApacheVhosts(fileName, contentBase64) {
    if (fileName !== 'httpd-vhosts.conf') throw new Error('只允许上传 httpd-vhosts.conf');
    const compactBase64 = String(contentBase64 || '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compactBase64)) throw new Error('文件内容不是有效的 Base64 数据');
    const buf = Buffer.from(compactBase64, 'base64');
    if (buf.length === 0) throw new Error('文件内容为空');
    if (buf.length > 512 * 1024) throw new Error('httpd-vhosts.conf 不能超过 512KB');
    if (buf.indexOf(0) >= 0 || buf.toString('utf8').indexOf('\uFFFD') >= 0) {
      throw new Error('httpd-vhosts.conf 必须是 UTF-8 文本配置文件');
    }

    const ts = stampForFile();
    const hostTmp = '/tmp/httpd-vhosts.conf.codex';
    const hostBackup = '/tmp/httpd-vhosts.conf.bak.' + ts;
    const containerTmp = '/tmp/httpd-vhosts.conf.codex';
    const containerBackup = APACHE_VHOSTS_PATH + '.bak.' + ts;
    const localTmpDir = path.join(__dirname, 'tmp', 'dm-apache-vhosts');
    const localTmp = path.join(localTmpDir, 'httpd-vhosts.conf.upload-' + ts);
    fs.mkdirSync(localTmpDir, { recursive: true });
    fs.writeFileSync(localTmp, buf);

    try {
      await sftpUpload(localTmp, hostTmp);
      const hostBackupResult = await sshRun('docker cp ' +
        shellEscape(cfg.container + ':' + APACHE_VHOSTS_PATH) + ' ' + shellEscape(hostBackup));
      if (hostBackupResult.code !== 0) {
        throw new Error('备份宿主机配置失败: ' + (hostBackupResult.stderr || hostBackupResult.stdout).slice(0, 400));
      }

      const copyResult = await sshRun('docker cp ' + shellEscape(hostTmp) + ' ' +
        shellEscape(cfg.container + ':' + containerTmp));
      if (copyResult.code !== 0) {
        throw new Error('复制配置到 dcim 容器失败: ' + (copyResult.stderr || copyResult.stdout).slice(0, 400));
      }

      const applyCommand = [
        'set -e',
        'cp -a ' + APACHE_VHOSTS_PATH + ' ' + containerBackup,
        'if install -m 0644 ' + containerTmp + ' ' + APACHE_VHOSTS_PATH + '; then true; else cp -a ' + containerBackup + ' ' + APACHE_VHOSTS_PATH + '; echo INSTALL_FAILED_RESTORED; exit 1; fi',
        'if ' + APACHE_HTTPD_BIN + ' -t; then true; else status=$?; cp -a ' + containerBackup + ' ' + APACHE_VHOSTS_PATH + '; echo HTTPD_TEST_FAILED_RESTORED; exit "$status"; fi',
        'rm -f ' + containerTmp,
      ].join('; ');
      const applyResult = await sshRun(runInContainerCmd(cfg.container, applyCommand));
      if (applyResult.code !== 0) {
        throw new Error('Apache 配置语法检查失败，已恢复容器备份 ' + containerBackup + ': ' +
          String(applyResult.stdout || applyResult.stderr || '').slice(0, 800));
      }

      const reloadCommand = [
        'if ' + APACHE_HTTPD_BIN + ' -k graceful; then echo HTTPD_GRACEFUL_OK; else',
        'status=$?',
        'cp -a ' + containerBackup + ' ' + APACHE_VHOSTS_PATH,
        APACHE_HTTPD_BIN + ' -t || true',
        APACHE_HTTPD_BIN + ' -k graceful || true',
        'echo HTTPD_GRACEFUL_FAILED_RESTORED',
        'exit "$status"',
        'fi',
      ].join('; ');
      const reloadResult = await sshRun(runInContainerCmd(cfg.container, reloadCommand));
      if (reloadResult.code !== 0) {
        throw new Error('Apache graceful 重载失败，已恢复容器备份 ' + containerBackup + ': ' +
          String(reloadResult.stdout || reloadResult.stderr || '').slice(0, 800));
      }

      const lanHost = String((cfg.ssh && cfg.ssh.host) || '192.168.0.60').trim();
      const urls = ['https://127.0.0.1:8086/index.html', 'https://' + lanHost + ':8086/index.html'];
      const checks = [];
      for (const url of urls) {
        const probe = await sshRun('curl -k -s -S -I --max-time 12 ' + shellEscape(url) + " | sed -n '1,12p'");
        const headers = String((probe.stdout || '') + (probe.stderr ? '\n' + probe.stderr : '')).trim();
        checks.push({
          url: url,
          ok: probe.code === 0 && /^HTTP\/\S+\s+200\b/m.test(headers) && /^Server:\s*Apache\b/im.test(headers),
          headers: headers.slice(0, 1200),
        });
      }
      appendLog('dm Apache vhosts uploaded size=' + buf.length + ' backup=' + containerBackup +
        ' verified=' + checks.every(c => c.ok));
      return {
        ok: true,
        uploaded: buf.length,
        containerBackup: containerBackup,
        hostBackup: hostBackup,
        checks: checks,
        verified: checks.every(c => c.ok),
      };
    } finally {
      try { fs.unlinkSync(localTmp); } catch (_e) {}
      try { await sshRun('rm -f ' + shellEscape(hostTmp)); } catch (_e) {}
      try { await sshRun(runInContainerCmd(cfg.container, 'rm -f ' + containerTmp)); } catch (_e) {}
    }
  }

  app.get('/api/db-manager/dm/license', async (_req, res) => {
    try {
      const license = await queryDmLicense();
      const keyFile = await probeDmKey();
      res.json({ ok: true, license: license, keyFile: keyFile });
    } catch (e) {
      appendLog('dm/license 查询失败: ' + e.message);
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.post('/api/db-manager/dm/upload-key', async (req, res) => {
    const b = req.body || {};
    if (!b.contentBase64) return res.status(400).json({ ok: false, message: 'contentBase64 必填' });
    try {
      const r = await uploadDmKey(String(b.contentBase64));
      res.json(r);
    } catch (e) {
      appendLog('dm/upload-key 失败: ' + e.message);
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.post('/api/db-manager/dm/upload-httpd-vhosts', async (req, res) => {
    const b = req.body || {};
    try {
      const r = await uploadDmApacheVhosts(String(b.fileName || ''), String(b.contentBase64 || ''));
      res.json(r);
    } catch (e) {
      appendLog('dm/upload-httpd-vhosts 失败: ' + e.message);
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  // ===== 数据源切换（Phase B）=====
  // 版本快照存放路径（目标机）：/opt/dcim-datasource-versions/{mysql|opengauss|dm}/
  //   snapshot.zip          代码快照（localhost_8080 + localhost_8086 + python + conf 四个子目录打包）
  //   dbconfig.json         对应版本的数据库连接配置（type/host/port/user/password）
  // 切换目标（宿主机上的 bind mount 源，同步生效到容器）：
  //   /dcim/admin/localhost_8080/  ↔ 容器 /www/wwwroot/localhost_8080/
  //   /dcim/admin/localhost_8086/  ↔ 容器 /www/wwwroot/localhost_8086/
  //   /dcim/python/                ↔ 容器 /www/python/
  //   /dcim/conf/dbconfig.json     ↔ 容器 /www/dbconfig.json
  const DS_VERSIONS_DIR = '/opt/dcim-datasource-versions';
  const DS_KEYS = ['mysql', 'opengauss', 'dm'];
  const DS_LABELS = { mysql: 'MySQL', opengauss: 'openGauss', dm: '达梦 DM' };
  // 这些路径由 dcim 容器以“宿主文件 → 容器文件”的 bind mount 方式挂载。
  // 快照出现 conf/conf/... 双层目录时，Docker 会把空目录挂到文件目标而导致容器无法启动。
  const DCIM_CONF_REQUIRED_FILES = ['rc.local', 'server.crt', 'server.key', 'wvp_cert.p12'];
  const DS_DEFAULT_DBCONFIG = {
    mysql: {
      type: 'mysql', host: '127.0.0.1', port: 3306, name: 'dcim',
      user: 'dcim', password: '3seckmG7eKstTCRz', charset: 'UTF8',
      schema: 'public', pdo_options: {},
      pool_min: 1, pool_max: 128, pool_max_connections: 0, pool_max_usage: 0,
      pool_blocking: true, pool_setsession: '', timeout: 5,
    },
    opengauss: {
      type: 'opengauss', host: '127.0.0.1', port: 5432, name: 'dcim',
      user: 'dcim', password: 'Gauss@2026', charset: 'UTF8',
      schema: 'public',
      pdo_options: { '1002': "SET client_encoding TO 'UTF8'" },
      pool_min: 1, pool_max: 128, pool_max_connections: 0, pool_max_usage: 0,
      pool_blocking: true, pool_setsession: '', timeout: 5,
    },
    dm: {
      type: 'dm', host: '127.0.0.1', port: 5236, name: 'DCIM',
      user: 'dcim', password: '3seckmG7eKstTCRz', charset: 'UTF8',
      schema: 'DCIM', pdo_options: {},
      pool_min: 1, pool_max: 128, pool_max_connections: 0, pool_max_usage: 0,
      pool_blocking: true, pool_setsession: '', timeout: 5,
    },
  };
  // dcim 代码从多个位置读 dbconfig.json，切换时必须全部覆盖（否则残留旧凭据导致 500）
  // 优先级从 dcim/src/config.php:5-8 出来的搜索顺序：
  //   1. /www/wwwroot/localhost_8086/wwwroot/dbconfig.json  = /dcim/admin/localhost_8086/wwwroot/dbconfig.json  ← 优先级最高
  //   2. /www/wwwroot/localhost_8080/wwwroot/dbconfig.json  = /dcim/admin/localhost_8080/wwwroot/dbconfig.json
  //   3. /www/dbconfig.json                                 = /dcim/conf/dbconfig.json
  //   4. Python 采集独立配置（不走 bind mount，docker cp 单独更新）
  const DS_DBCONFIG_HOST_PATHS = [
    '/dcim/admin/localhost_8086/wwwroot/dbconfig.json',
    '/dcim/admin/localhost_8080/wwwroot/dbconfig.json',
    '/dcim/conf/dbconfig.json',
  ];
  const DS_DBCONFIG_CONTAINER_PATHS = [
    '/www/python/src/collection/config/dbconfig.json',
  ];

  function validateDcimConfSnapshotEntries(entries) {
    const nested = entries.filter(entry => entry.indexOf('conf/conf/') === 0);
    if (nested.length) {
      throw new Error('快照 conf 目录结构错误（检测到 conf/conf/... 双层目录），请重新从 数据库管理/{MySQL,高斯,达梦}数据库 根目录上传');
    }
    const missing = DCIM_CONF_REQUIRED_FILES.filter(name => entries.indexOf('conf/' + name) < 0);
    if (missing.length) {
      throw new Error('快照 conf 缺少 Docker 挂载必需文件: ' + missing.join(', '));
    }
    if (!entries.some(entry => entry.indexOf('conf/apache/') === 0)) {
      throw new Error('快照 conf 缺少 apache/ 虚拟主机配置目录');
    }
  }

  async function assertDcimConfMountSources() {
    const checks = [
      'test -f /dcim/conf/rc.local',
      'test -f /dcim/conf/server.crt',
      'test -f /dcim/conf/server.key',
      'test -f /dcim/conf/wvp_cert.p12',
      'test -d /dcim/conf/apache',
    ];
    const result = await sshRun(checks.join(' && '));
    if (result.code !== 0) {
      throw new Error('dcim 配置挂载源类型异常：rc.local/server.crt/server.key/wvp_cert.p12 必须是文件，apache 必须是目录');
    }
  }

  // 读目标机当前 dbconfig.json，判断当前是哪种数据库
  async function detectCurrentDatasource() {
    const r = await sshRun('cat /dcim/conf/dbconfig.json 2>/dev/null');
    if (r.code !== 0 || !r.stdout) return { type: 'unknown', raw: r.stderr || r.stdout || '' };
    try {
      const conf = JSON.parse(r.stdout);
      const t = String(conf.type || '').toLowerCase();
      return { type: t || 'unknown', config: conf };
    } catch (_e) {
      return { type: 'unknown', raw: r.stdout };
    }
  }

  // 列出目标机上已上传的版本快照
  async function listDatasourceVersions() {
    await sshRun('mkdir -p ' + DS_VERSIONS_DIR);
    const result = {};
    for (const key of DS_KEYS) {
      const path = DS_VERSIONS_DIR + '/' + key;
      const r = await sshRun(
        'if [ -f ' + path + '/snapshot.zip ]; then ' +
        '  echo READY:$(stat -c %s ' + path + '/snapshot.zip):$(stat -c %Y ' + path + '/snapshot.zip); ' +
        'else echo MISSING; fi'
      );
      const line = r.stdout.trim();
      if (line.startsWith('READY:')) {
        const parts = line.slice(6).split(':');
        result[key] = { ready: true, size: Number(parts[0]), mtime: Number(parts[1]) * 1000 };
      } else {
        result[key] = { ready: false };
      }
    }
    return result;
  }

  // 从目标机当前生产 /dcim/admin + /dcim/python + /dcim/conf 抓一份基线快照（默认标签 mysql）
  async function initCurrentBaseline(versionKey) {
    if (!DS_KEYS.includes(versionKey)) throw new Error('非法 version: ' + versionKey);
    const dst = DS_VERSIONS_DIR + '/' + versionKey;
    const zip = dst + '/snapshot.zip';
    // 需要 zip 工具；kylin 默认有
    const cmd = [
      'mkdir -p ' + dst,
      'mkdir -p /dcim/conf',
      'cd /dcim && rm -f ' + shellEscape(zip),
      'zip -qr ' + shellEscape(zip) + ' admin/localhost_8080 admin/localhost_8086 python conf' +
        " -x '*.bak.*' '*.localbak.*' '*.servercopy.*' '*.php1' '*.localbeforepull.*'" +
        " '*/__pycache__/*' '*.pyc' 'php-beast.log' '**/.git/*' '**/.git' '**/.gitignore' '**/.gitattributes'",
      'ls -la ' + shellEscape(zip),
    ].join(' && ');
    const r = await sshRun(cmd);
    if (r.code !== 0) throw new Error('抓基线失败: ' + (r.stderr || r.stdout).slice(0, 400));
    // 写默认 dbconfig.json（从目标机当前实际的复制过去）
    const cur = await sshRun('cat /dcim/conf/dbconfig.json 2>/dev/null');
    const dbconfigPath = dst + '/dbconfig.json';
    if (cur.code === 0 && cur.stdout.trim()) {
      await sshRun('echo ' + shellEscape(cur.stdout) + ' > ' + shellEscape(dbconfigPath));
    } else {
      // 兜底：用默认模板
      await sshRun('echo ' + shellEscape(JSON.stringify(DS_DEFAULT_DBCONFIG[versionKey], null, 2)) +
        ' > ' + shellEscape(dbconfigPath));
    }
    appendLog('baseline ' + versionKey + ' snapshot 生成');
    return { ok: true, version: versionKey, zip: zip };
  }

  // 上传 zip 快照（浏览器分块传，后端累积写到目标机）
  // body: { version, chunkIndex, totalChunks, dataBase64, sha256 (optional, 最后一块传) }
  const dsUploadState = new Map(); // key: version → { totalChunks, receivedChunks, localTmpPath }
  async function uploadChunk(body) {
    const { version, chunkIndex, totalChunks } = body;
    if (!DS_KEYS.includes(version)) throw new Error('非法 version');
    const idx = Number(chunkIndex);
    const total = Number(totalChunks);
    if (!Number.isFinite(idx) || idx < 0 || idx >= total) throw new Error('非法 chunkIndex');
    if (!body.dataBase64) throw new Error('dataBase64 必填');

    // 本地临时目录
    const tmpDir = path.join(__dirname, 'tmp', 'ds-upload', version);
    fs.mkdirSync(tmpDir, { recursive: true });
    const chunkFile = path.join(tmpDir, 'chunk-' + String(idx).padStart(6, '0'));
    fs.writeFileSync(chunkFile, Buffer.from(body.dataBase64, 'base64'));

    let state = dsUploadState.get(version);
    if (!state || state.totalChunks !== total) {
      state = { totalChunks: total, receivedChunks: 0, tmpDir };
      dsUploadState.set(version, state);
    }
    state.receivedChunks++;

    if (state.receivedChunks < total) {
      return { ok: true, received: state.receivedChunks, total: total, done: false };
    }

    // 全部收齐 → 拼接 → SFTP 上传到目标机
    const finalZip = path.join(tmpDir, 'snapshot.zip');
    const ws = fs.createWriteStream(finalZip);
    for (let i = 0; i < total; i++) {
      const cf = path.join(tmpDir, 'chunk-' + String(i).padStart(6, '0'));
      ws.write(fs.readFileSync(cf));
    }
    await new Promise((resolve, reject) => { ws.end((e) => e ? reject(e) : resolve()); });

    // 本地文件 ready，SFTP 上传
    await sshRun('mkdir -p ' + DS_VERSIONS_DIR + '/' + version);
    const remoteZip = DS_VERSIONS_DIR + '/' + version + '/snapshot.zip';
    await sftpUpload(finalZip, remoteZip);
    // 写对应版本的 dbconfig.json（用默认模板，避免复制生产的 mysql 密码到 opengauss/dm）
    const dbconfigStr = JSON.stringify(DS_DEFAULT_DBCONFIG[version], null, 2) + '\n';
    await sshRun('cat > ' + DS_VERSIONS_DIR + '/' + version + '/dbconfig.json << \'EOF\'\n' + dbconfigStr + '\nEOF');

    // 清理 chunks 和 tmp
    try {
      for (let i = 0; i < total; i++) fs.unlinkSync(path.join(tmpDir, 'chunk-' + String(i).padStart(6, '0')));
      fs.unlinkSync(finalZip);
    } catch (_e) {}
    dsUploadState.delete(version);
    const stat = fs.existsSync(finalZip) ? fs.statSync(finalZip) : null;
    const remoteSize = await sshRun('stat -c %s ' + remoteZip);
    appendLog('datasource upload ok ' + version + ' size=' + remoteSize.stdout.trim());
    return { ok: true, done: true, remoteZip: remoteZip, remoteSize: Number(remoteSize.stdout.trim() || 0) };
  }

  // 主切换流程：停服务 → 备份 → 解压快照 → 覆盖 dbconfig → 启服务 → 探活；失败自动回滚
  async function switchDatasource(targetVersion) {
    if (!DS_KEYS.includes(targetVersion)) throw new Error('非法 version: ' + targetVersion);
    const remoteZip = DS_VERSIONS_DIR + '/' + targetVersion + '/snapshot.zip';
    const remoteDbConf = DS_VERSIONS_DIR + '/' + targetVersion + '/dbconfig.json';

    // 快照就绪校验
    const chk = await sshRun('test -f ' + remoteZip + ' && test -f ' + remoteDbConf + ' && echo READY || echo MISSING');
    if (chk.stdout.trim() !== 'READY') throw new Error('目标版本快照未就绪，请先上传（或跑「抓当前基线」）');
    // 旧版快照没有 conf/。这类快照切换时保留目标机现有 conf，避免误删 HTTPS、Apache 等配置。
    const zipEntriesResult = await sshRun('unzip -Z1 ' + shellEscape(remoteZip) + ' 2>&1');
    if (zipEntriesResult.code !== 0) {
      throw new Error('无法读取快照目录结构: ' + String(zipEntriesResult.stderr || zipEntriesResult.stdout || '').slice(0, 400));
    }
    const zipEntries = String(zipEntriesResult.stdout || '').split(/\r?\n/).filter(Boolean);
    const snapshotHasConf = zipEntries.some(entry => entry.indexOf('conf/') === 0);
    if (snapshotHasConf) validateDcimConfSnapshotEntries(zipEntries);

    const ts = stampForFile();
    const backupTag = 'ds-switch-' + ts;
    const backupDir = '/dcim/admin/.datasource-backups/' + backupTag;
    const steps = [];
    const record = (name, out) => { steps.push('[' + name + '] ' + (out || '').slice(0, 400)); appendLog('ds-switch ' + name + ' ' + (out || '').split('\n')[0].slice(0, 200)); };

    // 1. 停服务（容器内）
    let r = await sshRun(runInContainerCmd(cfg.container,
      'systemctl stop dcim httpd php-fpm-70 php-fpm-74 2>&1 || true'));
    record('stop-services', r.stdout || r.stderr);

    try {
      // 2. 备份 /dcim/admin/localhost_808{0,6} + /dcim/python + 整个 /dcim/conf
      const bakCmd = [
        'mkdir -p ' + backupDir,
        'cp -a /dcim/admin/localhost_8080 ' + backupDir + '/localhost_8080',
        'cp -a /dcim/admin/localhost_8086 ' + backupDir + '/localhost_8086',
        'cp -a /dcim/python ' + backupDir + '/python',
        'cp -a /dcim/conf ' + backupDir + '/conf',
      ].join(' && ');
      r = await sshRun(bakCmd);
      if (r.code !== 0) throw new Error('备份失败: ' + (r.stderr || r.stdout).slice(0, 400));
      record('backup', backupDir);

      // 3. 清空目标目录（保留目录本身，只清内容）
      const cleanCmd = [
        'rm -rf /dcim/admin/localhost_8080/* /dcim/admin/localhost_8080/.[!.]* 2>/dev/null',
        'rm -rf /dcim/admin/localhost_8086/* /dcim/admin/localhost_8086/.[!.]* 2>/dev/null',
        'rm -rf /dcim/python/src /dcim/python/deps 2>/dev/null',
        snapshotHasConf ? 'rm -rf /dcim/conf/* /dcim/conf/.[!.]* 2>/dev/null' : 'true',
        'true',
      ].join('; ');
      await sshRun(cleanCmd);
      record('clean', snapshotHasConf ? '已清空目标目录（含 conf）' : '已清空应用目录（旧快照保留 conf）');

      // 4. 解压快照到 /dcim/（zip 包内根应有 admin/localhost_8080 / admin/localhost_8086 / python / conf）
      // 用 unzip -o 覆盖；unzip 一般宿主机有；容器内不用
      const unzipR = await sshRun('cd /dcim && unzip -o -q ' + remoteZip + ' && echo UNZIP_OK');
      if (!/UNZIP_OK/.test(unzipR.stdout)) {
        // fallback：装 unzip 或 python 解压
        const pyR = await sshRun('cd /dcim && python3 -c "import zipfile; zipfile.ZipFile(\'' +
          remoteZip + '\').extractall(\'/dcim\')" && echo PY_OK');
        if (!/PY_OK/.test(pyR.stdout)) throw new Error('解压失败（unzip 和 python3 都失败）: ' + unzipR.stderr + ' | ' + pyR.stderr);
      }
      record('extract', '快照已解压到 /dcim/');

      if (snapshotHasConf) {
        // 浏览器打包无法保留 Unix 权限，恢复后收紧私钥/证书包权限并保留 rc.local 可执行。
        const confPermCmd = [
          'chown -R root:root /dcim/conf',
          'find /dcim/conf -type d -exec chmod 755 {} \\;',
          'find /dcim/conf -type f -exec chmod 644 {} \\;',
          "find /dcim/conf -type f \\( -name '*.key' -o -name '*.p12' \\) -exec chmod 600 {} \\;",
          'test ! -f /dcim/conf/rc.local || chmod 755 /dcim/conf/rc.local',
        ].join(' && ');
        await sshRun(confPermCmd);
        record('conf', '已恢复 /dcim/conf（私钥与证书包权限已收紧）');
      }

      // 5. 覆盖 dbconfig.json：所有 dcim 会读的位置都必须写（否则旧 dbconfig 残留会导致 500）
      //   - 宿主 3 处（bind mount 到容器）
      //   - 容器内 python collection 1 处（不是 bind mount）
      const cpConfLines = DS_DBCONFIG_HOST_PATHS.map(p =>
        'mkdir -p "$(dirname ' + p + ')" && cp -f ' + remoteDbConf + ' ' + p);
      cpConfLines.push('chown www:www ' + DS_DBCONFIG_HOST_PATHS.join(' ') + ' 2>/dev/null; true');
      await sshRun(cpConfLines.join(' && '));
      for (const cp of DS_DBCONFIG_CONTAINER_PATHS) {
        await sshRun('docker cp ' + remoteDbConf + ' ' + cfg.container + ':' + cp);
      }
      record('dbconfig', '已覆盖到 ' + (DS_DBCONFIG_HOST_PATHS.length + DS_DBCONFIG_CONTAINER_PATHS.length) + ' 个位置');

      // Apache 证书、rc.local 等均以宿主文件挂到容器文件；类型异常必须在启动容器服务前失败并回滚。
      await assertDcimConfMountSources();
      record('conf-mounts', 'dcim 配置挂载源类型校验通过');

      // 6. 权限修复：/dcim/admin 属主是 www:www；/dcim/python 属主是 1000:www
      await sshRun('chown -R www:www /dcim/admin/localhost_8080 /dcim/admin/localhost_8086 2>/dev/null; ' +
        'chown -R 1000:www /dcim/python 2>/dev/null; true');
      record('chown', '权限已修复');

      // 7. 启动服务
      r = await sshRun(runInContainerCmd(cfg.container,
        'systemctl start php-fpm-70 php-fpm-74 httpd dcim 2>&1 || true'));
      record('start-services', r.stdout || r.stderr);

      // 8. 探活：等 httpd 8086/8080 都起来 + dcim 进程活着
      let alive = false;
      for (let i = 0; i < 20; i++) {
        const p = await sshRun(runInContainerCmd(cfg.container,
          "systemctl is-active httpd 2>/dev/null; systemctl is-active dcim 2>/dev/null; ss -lntp 2>/dev/null | grep -E ':(8080|8086) ' | wc -l"));
        if (/active[\s\S]*active[\s\S]*[2-9]/.test(p.stdout)) { alive = true; break; }
        await new Promise(r => setTimeout(r, 1000));
      }
      record('probe', alive ? '服务就绪' : '探活超时（服务可能异常）');
      if (!alive) throw new Error('切换后服务探活失败');

      // 9. 记录当前活动版本（写个 marker 文件）
      await sshRun('echo ' + shellEscape(JSON.stringify({
        active: targetVersion, switchedAt: new Date().toISOString(), backup: backupDir,
      }, null, 2)) + ' > ' + DS_VERSIONS_DIR + '/.active.json');

      // 10. 清理老备份（保留最近 5 个）
      await sshRun('ls -1td /dcim/admin/.datasource-backups/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf');

      appendLog('ds-switch success → ' + targetVersion + ' (backup=' + backupTag + ')');
      return { ok: true, version: targetVersion, backup: backupDir, steps };
    } catch (err) {
      // 回滚
      record('ROLLBACK', err.message);
      const rbCmd = [
        'rm -rf /dcim/admin/localhost_8080/* /dcim/admin/localhost_8080/.[!.]* 2>/dev/null',
        'rm -rf /dcim/admin/localhost_8086/* /dcim/admin/localhost_8086/.[!.]* 2>/dev/null',
        'cp -a ' + backupDir + '/localhost_8080/. /dcim/admin/localhost_8080/',
        'cp -a ' + backupDir + '/localhost_8086/. /dcim/admin/localhost_8086/',
        'rm -rf /dcim/python/src /dcim/python/deps 2>/dev/null; true',
        'cp -a ' + backupDir + '/python/. /dcim/python/',
        'rm -rf /dcim/conf/* /dcim/conf/.[!.]* 2>/dev/null',
        'mkdir -p /dcim/conf',
        'cp -a ' + backupDir + '/conf/. /dcim/conf/',
      ].join(' && ');
      await sshRun(rbCmd);
      await sshRun('docker cp ' + backupDir + '/conf/dbconfig.json ' + cfg.container +
        ':/www/python/src/collection/config/dbconfig.json');
      await sshRun(runInContainerCmd(cfg.container,
        'systemctl start php-fpm-70 php-fpm-74 httpd dcim 2>&1 || true'));
      appendLog('ds-switch ROLLBACK from ' + targetVersion + ' → ' + err.message);
      throw new Error('切换失败已自动回滚：' + err.message + '\n步骤：\n' + steps.join('\n'));
    }
  }

  // ===== 数据源切换 路由 =====
  app.get('/api/db-manager/datasource/current', async (_req, res) => {
    try {
      const cur = await detectCurrentDatasource();
      const versions = await listDatasourceVersions();
      // 读 marker
      const mk = await sshRun('cat ' + DS_VERSIONS_DIR + '/.active.json 2>/dev/null');
      let marker = null;
      try { marker = JSON.parse(mk.stdout); } catch (_e) {}
      res.json({ ok: true, current: cur, versions: versions, marker: marker, labels: DS_LABELS });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  app.post('/api/db-manager/datasource/init-current', async (req, res) => {
    const b = req.body || {};
    const v = b.version || 'mysql';
    try {
      const r = await initCurrentBaseline(v);
      res.json(r);
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.post('/api/db-manager/datasource/upload-chunk', async (req, res) => {
    try {
      const r = await uploadChunk(req.body || {});
      res.json(r);
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.post('/api/db-manager/datasource/switch', async (req, res) => {
    const b = req.body || {};
    if (!DS_KEYS.includes(b.version)) return res.status(400).json({ ok: false, message: '非法 version' });
    try {
      const r = await switchDatasource(b.version);
      res.json(r);
    } catch (e) {
      appendLog('ds-switch 失败: ' + e.message);
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.delete('/api/db-manager/datasource/:version', async (req, res) => {
    const v = req.params.version;
    if (!DS_KEYS.includes(v)) return res.status(400).json({ ok: false, message: '非法 version' });
    try {
      await sshRun('rm -rf ' + DS_VERSIONS_DIR + '/' + v);
      appendLog('ds delete version=' + v);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });


  appendLog('数据库管理模块就绪 ssh=' + (cfg.ssh.host || '(未配置)') + ' container=' + cfg.container +
    ' drivers=' + JSON.stringify({ mysql2: !!mysql2, pg: !!pgLib, dmdb: !!dmdbLib }));

  // 预留给 Phase B（dcim 数据源切换）复用
  global.__dbMgr = {
    getCfg: () => cfg,
    runQuery: runQuery,
    probeAll: probeAll,
    sshRun: sshRun,
    appendLog: appendLog,
    backupDatabase: backupDatabase,
    restoreDatabase: restoreDatabase,
  };
})();

const port = Number(process.env.PORT || 3000);
server.listen(port, function () {
  console.log('Web SSH running at http://0.0.0.0:' + port);
});
