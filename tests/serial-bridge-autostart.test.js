const assert = require('assert');
const fs = require('fs');
const path = require('path');

let autoStart = {};
try { autoStart = require('../serial/auto-start'); } catch (_err) {}

assert.strictEqual(
  typeof autoStart.startEnabledSerialBridges,
  'function',
  '服务重启后必须提供已启用串口的自动启动器'
);

(async function testEnabledPortsRetryUntilTheyStart() {
  const attempts = [];
  const delays = [];
  const config = {
    communication: { portInitAttempts: 3 },
    ports: [
      { id: 1, autoStart: false },
      { id: 2, autoStart: true },
    ],
  };
  const result = await autoStart.startEnabledSerialBridges({
    getConfig: function () { return config; },
    startPort: async function (id) {
      attempts.push(id);
      if (attempts.length < 3) throw new Error('串口设备尚未就绪');
      return { id: id, state: 'running', action: 'started' };
    },
    wait: async function (delayMs) { delays.push(delayMs); },
    retryDelayMs: 25,
  });

  assert.deepStrictEqual(attempts, [2, 2, 2], '启用端口必须按初始化次数重试');
  assert.deepStrictEqual(delays, [25, 25], '失败重试必须使用固定退避间隔');
  assert.deepStrictEqual(result, [{ id: 2, state: 'running', action: 'started', attempts: 3 }]);
})();

(async function testAutoStartDisabledDuringRetryWillNotBeRestarted() {
  let autoStartEnabled = true;
  let attempts = 0;
  const result = await autoStart.startEnabledSerialBridges({
    getConfig: function () {
      return { communication: { portInitAttempts: 3 }, ports: [{ id: 2, autoStart: autoStartEnabled }] };
    },
    startPort: async function () { attempts += 1; throw new Error('等待设备'); },
    wait: async function () { autoStartEnabled = false; },
    retryDelayMs: 1,
  });

  assert.strictEqual(attempts, 1, '用户关闭启用后不得继续后台拉起端口');
  assert.deepStrictEqual(result, [{ id: 2, state: 'stopped', action: 'disabled', attempts: 1 }]);
})();

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.ok(server.includes("require('./serial/auto-start')"), '服务端必须加载自动启动器');
assert.ok(server.includes('startPersistedSerialBridges();'), '服务监听后必须启动已保存的启用端口');

console.log('serial bridge autostart: passed');
