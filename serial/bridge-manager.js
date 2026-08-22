'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const MAX_PORTS = 16;
const SERIAL_TYPES = Object.freeze({
  SERIAL_TO_TCP: 1,
  TCP_TO_SERIAL: 11,
  REAL_SERIAL: 0,
});

const DEFAULT_COMMUNICATION = Object.freeze({
  maxConnections: 1,
  portInitAttempts: 1000,
  pollIntervalMs: 100,
  heartbeatTimeoutAttempts: 3,
  workerHeartbeatSec: 35,
  daemonReportSec: 10,
  listenerTimeoutMin: 1,
  clientTimeoutMin: 60,
  serialTimeoutMin: 100,
  dataTimeoutSec: 10,
});

const DEFAULT_BAUD_RATES = [2400, 4800, 9600, 19200, 38400, 57600, 115200];
const DEFAULT_DEVICE = function () { return ''; };

function createDefaultSerialBridgeConfig() {
  return {
    version: '1.0.0',
    comNum: MAX_PORTS,
    logLevel: 2,
    communication: Object.assign({}, DEFAULT_COMMUNICATION),
    ports: Array.from({ length: MAX_PORTS }, function (_value, index) {
      const id = index + 1;
      return {
        id: id,
        devicePath: DEFAULT_DEVICE(id),
        baudRate: 9600,
        dataBits: 8,
        parity: 'N',
        stopBits: 1,
        packetIntervalMs: id <= 4 ? 100 : 300,
        type: SERIAL_TYPES.SERIAL_TO_TCP,
        listenPort: 8000 + id,
        targetHost: '',
        targetPort: 0,
        enabled: false,
        autoStart: false,
      };
    }),
  };
}

function integerInRange(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max;
}

function isValidDevicePath(value) {
  return typeof value === 'string' && /^\/dev\/tty(?:S|USB|ACM|XRUSB|O)\d+$/.test(value.trim());
}

function isValidHost(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:\-[\]]+$/.test(value.trim()) && value.trim().length <= 253;
}

function normalizeParity(value) {
  const p = String(value == null ? 'N' : value).toUpperCase();
  return p === 'E' || p === 'O' ? p : 'N';
}

function normalizePort(port, index) {
  const source = port && typeof port === 'object' ? port : {};
  const hasAutoStart = Object.prototype.hasOwnProperty.call(source, 'autoStart');
  const id = Number.isInteger(Number(source.id)) ? Number(source.id) : index + 1;
  const defaults = createDefaultSerialBridgeConfig().ports[Math.max(0, Math.min(MAX_PORTS - 1, id - 1))];
  return {
    id: id,
    devicePath: String(source.devicePath == null ? defaults.devicePath : source.devicePath).trim(),
    baudRate: Number(source.baudRate == null ? defaults.baudRate : source.baudRate),
    dataBits: Number(source.dataBits == null ? defaults.dataBits : source.dataBits),
    parity: normalizeParity(source.parity == null ? defaults.parity : source.parity),
    stopBits: Number(source.stopBits == null ? defaults.stopBits : source.stopBits),
    packetIntervalMs: Number(source.packetIntervalMs == null ? defaults.packetIntervalMs : source.packetIntervalMs),
    type: Number(source.type == null ? defaults.type : source.type),
    listenPort: Number(source.listenPort == null ? defaults.listenPort : source.listenPort),
    targetHost: String(source.targetHost == null ? '' : source.targetHost).trim(),
    targetPort: Number(source.targetPort == null ? 0 : source.targetPort),
    // enabled used to be the persisted boot flag. It is now a page-only batch
    // selection, so retain legacy values as autoStart during configuration migration.
    enabled: false,
    autoStart: hasAutoStart ? source.autoStart === true : source.enabled === true,
  };
}

function validatePortConfig(port, allPorts) {
  const errors = [];
  if (!integerInRange(port.id, 1, MAX_PORTS)) errors.push('端口编号必须在 1-16 之间');
  if (port.devicePath && !isValidDevicePath(port.devicePath)) errors.push('串口设备路径无效');
  if (port.devicePath) {
    const duplicateDevice = (allPorts || []).some(function (other) {
      return other !== port && other.devicePath === port.devicePath;
    });
    if (duplicateDevice) errors.push('串口设备路径不能重复');
  }
  if (DEFAULT_BAUD_RATES.indexOf(port.baudRate) < 0) errors.push('波特率不受支持');
  if ([5, 6, 7, 8].indexOf(port.dataBits) < 0) errors.push('数据位必须为 5-8');
  if (['N', 'E', 'O'].indexOf(port.parity) < 0) errors.push('校验必须为 N/E/O');
  if ([1, 2].indexOf(port.stopBits) < 0) errors.push('停止位必须为 1 或 2');
  if (!integerInRange(port.packetIntervalMs, 0, 10000)) errors.push('分包时间间隔必须为 0-10000ms');
  if ([0, 1, 11].indexOf(port.type) < 0) errors.push('串口类型无效');
  if (port.type === SERIAL_TYPES.SERIAL_TO_TCP) {
    if (!integerInRange(port.listenPort, 1024, 65535)) errors.push('监听端口必须在 1024-65535 之间');
    const duplicate = (allPorts || []).some(function (other) {
      return other !== port && other.type === SERIAL_TYPES.SERIAL_TO_TCP && other.listenPort === port.listenPort;
    });
    if (duplicate) errors.push('监听端口不能重复');
  }
  if (port.type === SERIAL_TYPES.TCP_TO_SERIAL) {
    if (!isValidHost(port.targetHost)) errors.push('目标主机无效');
    if (!integerInRange(port.targetPort, 1, 65535)) errors.push('目标端口必须在 1-65535 之间');
  }
  return errors;
}

function normalizeCommunication(value) {
  const source = value && typeof value === 'object' ? value : {};
  const ranges = {
    maxConnections: [1, 100],
    portInitAttempts: [2, 1000],
    pollIntervalMs: [0, 9999],
    heartbeatTimeoutAttempts: [1, 9999],
    workerHeartbeatSec: [1, 9999],
    daemonReportSec: [1, 9999],
    listenerTimeoutMin: [1, 9999],
    clientTimeoutMin: [1, 9999],
    serialTimeoutMin: [1, 9999],
    dataTimeoutSec: [1, 9999],
  };
  const result = {};
  Object.keys(ranges).forEach(function (key) {
    const fallback = DEFAULT_COMMUNICATION[key];
    const valueNumber = Number(source[key] == null ? fallback : source[key]);
    result[key] = Number.isFinite(valueNumber) ? valueNumber : fallback;
  });
  return result;
}

function validateSerialBridgeConfig(value) {
  const input = value && typeof value === 'object' ? value : {};
  const defaults = createDefaultSerialBridgeConfig();
  const comNum = Number(input.comNum == null ? defaults.comNum : input.comNum);
  const errors = [];
  if (!integerInRange(comNum, 1, MAX_PORTS)) errors.push('串口数量必须在 1-16 之间');
  const ports = Array.from({ length: MAX_PORTS }, function (_value, index) {
    return normalizePort(input.ports && input.ports[index], index);
  });
  const portErrors = [];
  const activePortCount = integerInRange(comNum, 1, MAX_PORTS) ? comNum : MAX_PORTS;
  const activePorts = ports.slice(0, activePortCount);
  activePorts.forEach(function (port) {
    const currentErrors = validatePortConfig(port, activePorts);
    if (currentErrors.length) portErrors.push({ id: port.id, errors: currentErrors });
  });
  portErrors.forEach(function (item) {
    item.errors.forEach(function (message) { errors.push('端口' + item.id + '：' + message); });
  });
  const communication = normalizeCommunication(input.communication);
  Object.keys(DEFAULT_COMMUNICATION).forEach(function (key) {
    const range = {
      maxConnections: [1, 100],
      portInitAttempts: [2, 1000],
      pollIntervalMs: [0, 9999],
      heartbeatTimeoutAttempts: [1, 9999],
      workerHeartbeatSec: [1, 9999],
      daemonReportSec: [1, 9999],
      listenerTimeoutMin: [1, 9999],
      clientTimeoutMin: [1, 9999],
      serialTimeoutMin: [1, 9999],
      dataTimeoutSec: [1, 9999],
    }[key];
    if (!integerInRange(communication[key], range[0], range[1])) errors.push('通信参数 ' + key + ' 超出范围');
  });
  return {
    ok: errors.length === 0,
    errors: errors,
    config: {
      version: String(input.version || defaults.version),
      comNum: integerInRange(comNum, 1, MAX_PORTS) ? comNum : defaults.comNum,
      logLevel: integerInRange(Number(input.logLevel == null ? defaults.logLevel : input.logLevel), 0, 4)
        ? Number(input.logLevel == null ? defaults.logLevel : input.logLevel) : defaults.logLevel,
      communication: communication,
      ports: ports,
    },
  };
}

function buildSttyArgs(device, port) {
  const args = ['-F', device, 'raw', '-echo', '-echoe', '-echok', '-echoctl', '-echoke', String(port.baudRate), 'cs' + port.dataBits];
  if (port.parity === 'E') args.push('parenb', '-parodd');
  else if (port.parity === 'O') args.push('parenb', 'parodd');
  else args.push('-parenb');
  args.push(port.stopBits === 2 ? 'cstopb' : '-cstopb', '-crtscts', '-ixon', '-ixoff', 'clocal', '-hupcl');
  return args;
}

function runStty(device, port, spawnImpl) {
  return new Promise(function (resolve, reject) {
    const child = (spawnImpl || spawn)('stty', buildSttyArgs(device, port));
    let stderr = '';
    if (child.stderr && child.stderr.on) child.stderr.on('data', function (chunk) { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', function (code) {
      if (code === 0) resolve();
      else reject(new Error('stty 配置失败：' + (stderr.trim() || ('exit ' + code))));
    });
  });
}

function resolveStreamResult(result) {
  return result && typeof result.then === 'function' ? result : Promise.resolve(result);
}

class SerialBridgeManager {
  constructor(options) {
    const opts = options || {};
    const checked = validateSerialBridgeConfig(opts.config || createDefaultSerialBridgeConfig());
    if (!checked.ok) throw new Error(checked.errors.join('；'));
    this.config = checked.config;
    this.net = opts.net || net;
    this.fs = opts.fs || fs;
    this.spawn = opts.spawn || spawn;
    this.platform = opts.platform || process.platform;
    this.killProcess = opts.killProcess || process.kill.bind(process);
    this.openSerial = opts.openSerial || this._openSerial.bind(this);
    this.configureSerial = opts.configureSerial || this._configureSerial.bind(this);
    this.bridges = new Map();
  }

  _configureSerial(port) {
    if (this.platform !== 'linux') return Promise.resolve();
    return runStty(port.devicePath, port, this.spawn);
  }

  _openSerial(port) {
    if (this.platform === 'linux') {
      // tty read operations block until data arrives. Keep them in child processes so
      // they cannot occupy libuv's shared filesystem worker pool and stall HTTP.
      const reader = this.spawn('cat', [port.devicePath], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      const writer = this.spawn('tee', [port.devicePath], { stdio: ['pipe', 'ignore', 'pipe'], detached: true });
      let closing = false;
      const killProcess = this.killProcess;

      function terminateChild(child) {
        if (!child) return;
        const pid = Number(child.pid);
        try {
          if (pid > 0) killProcess(-pid, 'SIGTERM');
        } catch (_err) {}
        try { if (child.kill) child.kill('SIGTERM'); } catch (_err) {}

        const forceTimer = setTimeout(function () {
          try {
            if (pid > 0) killProcess(-pid, 'SIGKILL');
          } catch (_err) {}
          try { if (child.kill) child.kill('SIGKILL'); } catch (_err) {}
        }, 2000);
        if (forceTimer && typeof forceTimer.unref === 'function') forceTimer.unref();
        if (typeof child.once === 'function') child.once('exit', function () { clearTimeout(forceTimer); });
      }

      function wireChildError(child, stream, label) {
        if (child.stderr && typeof child.stderr.resume === 'function') child.stderr.resume();
        child.on('error', function (error) {
          if (!closing && stream && typeof stream.destroy === 'function') stream.destroy(new Error(label + '启动失败：' + error.message));
        });
        child.on('exit', function (code, signal) {
          if (!closing && code && stream && typeof stream.destroy === 'function') {
            stream.destroy(new Error(label + '意外退出：' + (signal || ('exit ' + code))));
          }
        });
      }

      wireChildError(reader, reader.stdout, '串口读取进程');
      wireChildError(writer, writer.stdin, '串口写入进程');
      return {
        readable: reader.stdout,
        writable: writer.stdin,
        close: function () {
          closing = true;
          try { if (writer.stdin && typeof writer.stdin.end === 'function') writer.stdin.end(); } catch (_err) {}
          terminateChild(reader);
          terminateChild(writer);
        },
      };
    }
    return {
      readable: this.fs.createReadStream(port.devicePath, { highWaterMark: 4096 }),
      writable: this.fs.createWriteStream(port.devicePath, { flags: 'r+' }),
    };
  }

  getConfig() {
    return JSON.parse(JSON.stringify(this.config));
  }

  setConfig(nextConfig) {
    const checked = validateSerialBridgeConfig(nextConfig);
    if (!checked.ok) return checked;
    this.config = checked.config;
    return { ok: true, errors: [], config: this.getConfig() };
  }

  getStatus() {
    const manager = this;
    return this.config.ports.map(function (port) {
      const bridge = manager.bridges.get(port.id);
      return {
        id: port.id,
        state: bridge ? bridge.state : 'stopped',
        clientCount: bridge ? bridge.clients.size : 0,
        listenPort: port.listenPort,
        devicePath: port.devicePath,
        type: port.type,
        error: bridge && bridge.error ? bridge.error : '',
      };
    });
  }

  _assertDeviceAvailable(port) {
    if (!port.devicePath) throw new Error('请先扫描并选择实际串口设备');
    if (this.fs && typeof this.fs.existsSync === 'function' && !this.fs.existsSync(port.devicePath)) {
      throw new Error('串口设备不存在：' + port.devicePath + '。请先扫描并选择可用设备');
    }
  }

  _isBridgeActive(port, bridge) {
    return !bridge.stopRequested && this.bridges.get(port.id) === bridge;
  }

  _throwIfBridgeStopped(port, bridge) {
    if (!this._isBridgeActive(port, bridge)) throw new Error('串口桥接已停止');
  }

  _closeSerial(serial) {
    if (!serial) return;
    try { if (typeof serial.close === 'function') serial.close(); } catch (_err) {}
    try { if (serial.readable && serial.readable.destroy) serial.readable.destroy(); } catch (_err) {}
    try { if (serial.writable && serial.writable.destroy) serial.writable.destroy(); } catch (_err) {}
  }

  _closeServer(server) {
    if (!server) return Promise.resolve();
    return new Promise(function (resolve) {
      try { server.close(function () { resolve(); }); } catch (_err) { resolve(); }
    });
  }

  async start(id) {
    const port = this.config.ports.find(function (item) { return item.id === Number(id); });
    if (!port) throw new Error('串口配置不存在');
    if (this.bridges.has(port.id)) return this.getStatus().find(function (item) { return item.id === port.id; });
    this._assertDeviceAvailable(port);
    const bridge = {
      state: 'starting',
      clients: new Set(),
      server: null,
      serial: null,
      outbound: null,
      error: '',
      packetBuffer: Buffer.alloc(0),
      packetTimer: null,
      stopRequested: false,
    };
    this.bridges.set(port.id, bridge);
    try {
      await this.configureSerial(port);
      this._throwIfBridgeStopped(port, bridge);
      const serial = await resolveStreamResult(this.openSerial(port));
      if (!this._isBridgeActive(port, bridge)) {
        this._closeSerial(serial);
        throw new Error('串口桥接已停止');
      }
      bridge.serial = serial;
      this._wireSerial(port, bridge);
      if (port.type === SERIAL_TYPES.SERIAL_TO_TCP) {
        const server = await this._listen(port, bridge);
        if (!this._isBridgeActive(port, bridge)) {
          await this._closeServer(server);
          throw new Error('串口桥接已停止');
        }
        bridge.server = server;
      } else if (port.type === SERIAL_TYPES.TCP_TO_SERIAL) {
        const outbound = await this._connect(port, bridge);
        if (!this._isBridgeActive(port, bridge)) {
          try { outbound.destroy(); } catch (_err) {}
          throw new Error('串口桥接已停止');
        }
        bridge.outbound = outbound;
      }
      this._throwIfBridgeStopped(port, bridge);
      bridge.state = 'running';
      return this.getStatus().find(function (item) { return item.id === port.id; });
    } catch (error) {
      bridge.error = error.message;
      await this._closeBridge(port.id);
      throw error;
    }
  }

  _wireSerial(port, bridge) {
    const readable = bridge.serial && bridge.serial.readable;
    const writable = bridge.serial && bridge.serial.writable;
    if (!readable || typeof readable.on !== 'function') throw new Error('串口读流不可用');
    readable.on('data', (chunk) => this._onSerialData(port, bridge, chunk));
    readable.on('error', (error) => { bridge.error = '串口读取错误：' + error.message; });
    if (writable && typeof writable.on === 'function') {
      writable.on('error', (error) => { bridge.error = '串口写入错误：' + error.message; });
    }
    readable.on('close', () => { if (this.bridges.get(port.id) === bridge) this.stop(port.id).catch(function () {}); });
  }

  _onSerialData(port, bridge, chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (port.type === SERIAL_TYPES.TCP_TO_SERIAL && bridge.outbound) {
      bridge.outbound.write(chunk);
      return;
    }
    if (port.type !== SERIAL_TYPES.SERIAL_TO_TCP) return;
    bridge.packetBuffer = Buffer.concat([bridge.packetBuffer, chunk]);
    if (bridge.packetTimer) return;
    const delay = Math.max(0, Number(port.packetIntervalMs) || 0);
    bridge.packetTimer = setTimeout(() => {
      bridge.packetTimer = null;
      const packet = bridge.packetBuffer;
      bridge.packetBuffer = Buffer.alloc(0);
      bridge.clients.forEach(function (client) {
        if (!client.destroyed) client.write(packet);
      });
    }, delay);
  }

  _listen(port, bridge) {
    return new Promise((resolve, reject) => {
      const server = this.net.createServer((socket) => {
        if (bridge.clients.size >= this.config.communication.maxConnections) {
          socket.end();
          return;
        }
        bridge.clients.add(socket);
        socket.setTimeout(this.config.communication.clientTimeoutMin * 60 * 1000);
        socket.on('data', (chunk) => {
          if (bridge.serial && bridge.serial.writable) bridge.serial.writable.write(chunk);
        });
        socket.on('timeout', () => socket.destroy());
        socket.on('close', () => bridge.clients.delete(socket));
        socket.on('error', () => bridge.clients.delete(socket));
      });
      server.once('error', reject);
      server.listen(port.listenPort, '0.0.0.0', () => {
        if (!this._isBridgeActive(port, bridge)) {
          this._closeServer(server).then(function () { reject(new Error('串口桥接已停止')); });
          return;
        }
        resolve(server);
      });
    });
  }

  _connect(port, bridge) {
    return new Promise((resolve, reject) => {
      const socket = this.net.createConnection({ host: port.targetHost, port: port.targetPort });
      socket.setTimeout(this.config.communication.clientTimeoutMin * 60 * 1000);
      socket.on('timeout', () => socket.destroy());
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.removeListener('error', reject);
        if (!this._isBridgeActive(port, bridge)) {
          socket.destroy();
          reject(new Error('串口桥接已停止'));
          return;
        }
        socket.on('error', (error) => { bridge.error = 'TCP 连接错误：' + error.message; });
        socket.on('data', (chunk) => {
          if (bridge.serial && bridge.serial.writable) bridge.serial.writable.write(chunk);
        });
        socket.on('close', () => { bridge.outbound = null; });
        resolve(socket);
      });
    });
  }

  async stop(id) {
    return this._closeBridge(Number(id));
  }

  async _closeBridge(id) {
    const bridge = this.bridges.get(id);
    if (!bridge) return;
    bridge.stopRequested = true;
    this.bridges.delete(id);
    if (bridge.packetTimer) clearTimeout(bridge.packetTimer);
    bridge.clients.forEach(function (client) { try { client.destroy(); } catch (_err) {} });
    bridge.clients.clear();
    if (bridge.outbound) try { bridge.outbound.destroy(); } catch (_err) {}
    await this._closeServer(bridge.server);
    this._closeSerial(bridge.serial);
  }

  async startEnabled() {
    const results = [];
    for (const port of this.config.ports.slice(0, this.config.comNum)) {
      if (!port.enabled) continue;
      try { results.push(await this.start(port.id)); }
      catch (error) { results.push({ id: port.id, state: 'error', error: error.message }); }
    }
    return results;
  }

  async stopAll() {
    const ids = Array.from(this.bridges.keys());
    await Promise.all(ids.map((id) => this.stop(id)));
  }
}

function loadSerialBridgeConfig(configPath, fileSystem) {
  const fileOps = fileSystem || fs;
  try {
    const parsed = JSON.parse(fileOps.readFileSync(configPath, 'utf8'));
    const checked = validateSerialBridgeConfig(parsed);
    return checked.ok ? checked.config : createDefaultSerialBridgeConfig();
  } catch (_err) {
    return createDefaultSerialBridgeConfig();
  }
}

function saveSerialBridgeConfig(configPath, config, fileSystem, pathModule) {
  const fileOps = fileSystem || fs;
  const pathOps = pathModule || path;
  const checked = validateSerialBridgeConfig(config);
  if (!checked.ok) throw new Error(checked.errors.join('；'));
  const dir = pathOps.dirname(configPath);
  fileOps.mkdirSync(dir, { recursive: true });
  const temp = configPath + '.tmp-' + process.pid + '-' + Date.now();
  fileOps.writeFileSync(temp, JSON.stringify(checked.config, null, 2) + '\n', { mode: 0o600 });
  try { fileOps.chmodSync(temp, 0o600); } catch (_err) {}
  fileOps.renameSync(temp, configPath);
  return checked.config;
}

module.exports = {
  MAX_PORTS,
  SERIAL_TYPES,
  DEFAULT_COMMUNICATION,
  createDefaultSerialBridgeConfig,
  validateSerialBridgeConfig,
  validatePortConfig,
  isValidDevicePath,
  buildSttyArgs,
  loadSerialBridgeConfig,
  saveSerialBridgeConfig,
  SerialBridgeManager,
};
