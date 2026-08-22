const assert = require('assert');
const EventEmitter = require('events');
const serialBridge = require('../serial/bridge-manager');

class DeferredServer extends EventEmitter {
  listen(_port, _host, callback) { this.listenCallback = callback; }
  finishListen() { this.listenCallback(); }
  close(callback) { this.closed = true; callback(); }
}

class FakeProcess extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stdout.destroy = function () {};
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.stdin.end = function () {};
    this.stdin.destroy = function () {};
  }
  kill() {}
}

(async function testStopDuringStartClosesLaterRegisteredListener() {
  const config = serialBridge.createDefaultSerialBridgeConfig();
  config.ports[0].devicePath = '/dev/ttyS0';
  const server = new DeferredServer();
  let nextPid = 200;
  const manager = new serialBridge.SerialBridgeManager({
    config: config,
    platform: 'linux',
    fs: { existsSync: function () { return true; } },
    net: { createServer: function () { return server; } },
    configureSerial: function () { return Promise.resolve(); },
    spawn: function () { return new FakeProcess(nextPid++); },
    killProcess: function () {},
  });

  const starting = manager.start(1);
  await Promise.resolve();
  await Promise.resolve();
  await manager.stop(1);
  server.finishListen();

  await assert.rejects(starting, /已停止/, '启动过程中被停止必须取消启动请求');
  assert.strictEqual(server.closed, true, '启动中被停止时，延后创建的监听器也必须关闭');
  assert.strictEqual(manager.getStatus().find(function (item) { return item.id === 1; }).state, 'stopped');
  console.log('serial bridge stop race: passed');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
