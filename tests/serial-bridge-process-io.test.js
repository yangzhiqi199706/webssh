const assert = require('assert');
const EventEmitter = require('events');
const serialBridge = require('../serial/bridge-manager');

class FakeServer extends EventEmitter {
  listen(_port, _host, callback) { callback(); }
  close(callback) { callback(); }
}

class FakeProcess extends EventEmitter {
  constructor(kind) {
    super();
    this.kind = kind;
    this.pid = kind === 'reader' ? 101 : 102;
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stdout.destroy = function () { this.destroyed = true; };
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.stdin.writes = [];
    this.stdin.write = function (value) { this.writes.push(Buffer.from(value)); return true; };
    this.stdin.end = function () { this.ended = true; };
    this.stdin.destroy = function () { this.destroyed = true; };
  }
  kill(signal) { this.killed = signal || true; return true; }
}

(async function testSerialBridgeUsesChildProcessesInsteadOfFsStreams() {
  const config = serialBridge.createDefaultSerialBridgeConfig();
  config.ports[0].devicePath = '/dev/ttyS0';
  const children = [];
  const groupKills = [];
  const manager = new serialBridge.SerialBridgeManager({
    config: config,
    platform: 'linux',
    fs: {
      existsSync: function () { return true; },
      createReadStream: function () { throw new Error('串口读取不得占用 Node 文件 I/O 线程池'); },
      createWriteStream: function () { throw new Error('串口写入不得占用 Node 文件 I/O 线程池'); },
    },
    net: { createServer: function () { return new FakeServer(); } },
    configureSerial: function () { return Promise.resolve(); },
    killProcess: function (pid, signal) { groupKills.push({ pid: pid, signal: signal }); },
    spawn: function (command, args, options) {
      const child = new FakeProcess(command === 'cat' ? 'reader' : 'writer');
      child.command = command;
      child.args = args;
      child.options = options;
      children.push(child);
      return child;
    },
  });

  const status = await manager.start(1);
  assert.strictEqual(status.state, 'running', '串口桥接应在不使用 fs 流的情况下启动');
  assert.deepStrictEqual(children.map(function (child) { return child.command; }), ['cat', 'tee']);
  assert.deepStrictEqual(children[0].args, ['/dev/ttyS0'], '读取子进程必须只接收已验证的设备路径');
  assert.deepStrictEqual(children[1].args, ['/dev/ttyS0'], '写入子进程必须直接接收已验证的设备路径');
  assert.ok(children.every(function (child) { return child.options.detached === true; }), '串口子进程必须位于独立进程组，便于完整回收');

  children[0].stdout.emit('data', Buffer.from('serial-data'));
  await manager.stop(1);
  assert.ok(children.every(function (child) { return child.killed; }), '停止桥接必须终止所有串口子进程');
  assert.deepStrictEqual(groupKills, [{ pid: -101, signal: 'SIGTERM' }, { pid: -102, signal: 'SIGTERM' }], '停止桥接必须终止整个子进程组');
  console.log('serial bridge process I/O: passed');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
