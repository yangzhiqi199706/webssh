const assert = require('assert');
const EventEmitter = require('events');
const serialBridge = require('../serial/bridge-manager');

class FakeSocket extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.writes = []; }
  write(value) { this.writes.push(Buffer.from(value)); return true; }
  setTimeout(value) { this.timeoutMs = value; }
  destroy() { this.destroyed = true; this.emit('close'); }
}

const outbound = new FakeSocket();
const fakeNet = {
  createServer: function () { throw new Error('网口转串口不应创建 TCP 监听'); },
  createConnection: function () { process.nextTick(function () { outbound.emit('connect'); }); return outbound; },
};

const readable = new EventEmitter();
readable.destroy = function () { readable.emit('close'); };
const writable = new EventEmitter();
writable.writes = [];
writable.write = function (value) { writable.writes.push(Buffer.from(value)); return true; };
writable.destroy = function () {};

(async function () {
  const config = serialBridge.createDefaultSerialBridgeConfig();
  config.ports = config.ports.map(function (port) { return Object.assign({}, port, { devicePath: '/dev/ttyUSB' + port.id, packetIntervalMs: 0 }); });
  config.ports[0].type = serialBridge.SERIAL_TYPES.TCP_TO_SERIAL;
  config.ports[0].targetHost = '192.168.50.10';
  config.ports[0].targetPort = 502;
  const manager = new serialBridge.SerialBridgeManager({
    config: config,
    net: fakeNet,
    fs: { existsSync: function () { return true; } },
    configureSerial: function () { return Promise.resolve(); },
    openSerial: function () { return { readable: readable, writable: writable }; },
  });
  const status = await manager.start(1);
  assert.strictEqual(status.state, 'running', '网口转串口连接成功后应为 running');
  assert.strictEqual(outbound.timeoutMs, 60 * 60 * 1000, '网口转串口必须应用客户端超时设置');
  assert.ok(outbound.listenerCount('error') > 0, '出站 TCP 连接成功后仍必须保留错误处理器');
  readable.emit('data', Buffer.from('serial-to-network'));
  assert.deepStrictEqual(outbound.writes.map(function (item) { return item.toString(); }), ['serial-to-network']);
  outbound.emit('data', Buffer.from('network-to-serial'));
  assert.deepStrictEqual(writable.writes.map(function (item) { return item.toString(); }), ['network-to-serial']);
  await manager.stop(1);
  console.log('serial bridge TCP-to-serial: passed');
})().catch(function (error) { console.error(error); process.exitCode = 1; });
