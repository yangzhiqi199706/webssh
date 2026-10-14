const assert = require('assert');
const EventEmitter = require('events');
const serialBridge = require('../serial/bridge-manager');

const invalidConfig = serialBridge.createDefaultSerialBridgeConfig();
invalidConfig.ports[0].listenPort = invalidConfig.ports[1].listenPort;
const invalidResult = serialBridge.validateSerialBridgeConfig(invalidConfig);
assert.strictEqual(invalidResult.ok, false, '重复监听端口必须拒绝保存');
assert.ok(invalidResult.errors.some(function (message) { return message.indexOf('端口') >= 0 && message.indexOf('重复') >= 0; }));

const badPortConfig = serialBridge.createDefaultSerialBridgeConfig();
badPortConfig.ports[0].devicePath = '/etc/passwd';
badPortConfig.ports[0].listenPort = 80;
const badPortResult = serialBridge.validateSerialBridgeConfig(badPortConfig);
assert.strictEqual(badPortResult.ok, false, '危险设备路径和特权监听端口必须拒绝');
assert.ok(badPortResult.errors.some(function (message) { return message.indexOf('设备路径') >= 0; }));
assert.ok(badPortResult.errors.some(function (message) { return message.indexOf('监听端口') >= 0; }));

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writes = [];
    this.ended = false;
  }
  write(value) { this.writes.push(Buffer.from(value)); return true; }
  end() { this.ended = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  setTimeout(value) { this.timeoutMs = value; }
}

class FakeServer extends EventEmitter {
  listen(port, host, callback) { this.port = port; this.host = host; callback(); }
  close(callback) { this.closed = true; callback(); }
}

const fakeNet = {
  createServer: function (handler) {
    const server = new FakeServer();
    server.accept = handler;
    return server;
  },
  createConnection: function () {
    const socket = new FakeSocket();
    process.nextTick(function () { socket.emit('connect'); });
    return socket;
  },
};

function fakeReadable() {
  const stream = new EventEmitter();
  stream.destroy = function () { stream.destroyed = true; stream.emit('close'); };
  return stream;
}

function fakeWritable() {
  const stream = new EventEmitter();
  stream.writes = [];
  stream.write = function (value) { stream.writes.push(Buffer.from(value)); return true; };
  stream.destroy = function () { stream.destroyed = true; };
  return stream;
}

(async function testBidirectionalForwarding() {
  const bridgeConfig = serialBridge.createDefaultSerialBridgeConfig();
  bridgeConfig.ports = bridgeConfig.ports.map(function (port) {
    return Object.assign({}, port, { devicePath: '/dev/ttyUSB' + port.id, packetIntervalMs: 0 });
  });
  const readable = fakeReadable();
  const writable = fakeWritable();
  const manager = new serialBridge.SerialBridgeManager({
    config: bridgeConfig,
    net: fakeNet,
    fs: { existsSync: function () { return true; } },
    configureSerial: function () { return Promise.resolve(); },
    openSerial: function () { return { readable: readable, writable: writable }; },
  });
  const status = await manager.start(1);
  assert.strictEqual(status.state, 'running', '串口转网口启动后应为 running');
  const server = manager.bridges.get(1).server;
  const firstClient = new FakeSocket();
  server.accept(firstClient);
  readable.emit('data', Buffer.from('from-serial'));
  await new Promise(function (resolve) { setTimeout(resolve, 10); });
  assert.deepStrictEqual(firstClient.writes.map(function (item) { return item.toString(); }), ['from-serial']);
  firstClient.emit('data', Buffer.from('to-serial'));
  assert.deepStrictEqual(writable.writes.map(function (item) { return item.toString(); }), ['to-serial']);
  const secondClient = new FakeSocket();
  server.accept(secondClient);
  assert.strictEqual(secondClient.ended, true, '超过最大连接数的客户端必须被拒绝');
  await manager.stop(1);
  assert.strictEqual(manager.getStatus()[0].state, 'stopped', '停止后状态应回到 stopped');
  console.log('serial bridge validation and forwarding: passed');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});

(async function testMissingDeviceFailsBeforeSerialConfiguration() {
  const bridgeConfig = serialBridge.createDefaultSerialBridgeConfig();
  bridgeConfig.ports[0].devicePath = '/dev/ttyS0';
  let configureCalls = 0;
  const manager = new serialBridge.SerialBridgeManager({
    config: bridgeConfig,
    fs: { existsSync: function () { return false; } },
    configureSerial: function () { configureCalls += 1; return Promise.resolve(); },
    openSerial: function () { throw new Error('不存在的设备不应被打开'); },
  });
  await assert.rejects(
    function () { return manager.start(1); },
    /串口设备不存在：\/dev\/ttyS0/,
    '启动前必须明确检查设备是否存在'
  );
  assert.strictEqual(configureCalls, 0, '不存在的串口不得继续执行 stty 配置');
  console.log('serial bridge missing-device guard: passed');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
