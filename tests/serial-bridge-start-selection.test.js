const assert = require('assert');
const fs = require('fs');
const path = require('path');
const serialBridge = require('../serial/bridge-manager');
const autoStart = require('../serial/auto-start');

const defaults = serialBridge.createDefaultSerialBridgeConfig();
assert.strictEqual(defaults.ports[0].autoStart, false, '默认配置必须将开机自启关闭');

const legacy = serialBridge.validateSerialBridgeConfig({
  comNum: 1,
  ports: [{ id: 1, enabled: true }],
});
assert.strictEqual(legacy.ok, true, '旧版启用配置必须可迁移');
assert.strictEqual(legacy.config.ports[0].enabled, false, '旧版一次性启动勾选不能在刷新后保留');
assert.strictEqual(legacy.config.ports[0].autoStart, true, '旧版启用配置必须迁移为开机自启');

(async function testAutoStartUsesPersistentAutoStartFlag() {
  const attempts = [];
  const result = await autoStart.startEnabledSerialBridges({
    getConfig: function () {
      return {
        communication: { portInitAttempts: 2 },
        ports: [{ id: 1, enabled: false, autoStart: true }],
      };
    },
    startPort: async function (id) { attempts.push(id); return { id: id, state: 'running' }; },
  });
  assert.deepStrictEqual(attempts, [1], '服务器重启时必须根据开机自启标记恢复端口');
  assert.deepStrictEqual(result, [{ id: 1, state: 'running', action: 'started', attempts: 1 }]);

  const root = path.join(__dirname, '..');
  const ui = fs.readFileSync(path.join(root, 'serial', 'assets', 'js', 'serial-bridge.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(ui.includes('startSelected'), '本次启动的勾选必须仅保留在页面内存');
  assert.ok(ui.includes('本次启动') && ui.includes('开机自启'), '页面必须明确区分本次启动和开机自启');
  assert.ok(ui.includes('state.startSelected.clear()'), '批量启动完成后必须清除本次启动勾选');
  assert.ok(ui.includes('JSON.stringify({ portIds: selectedIds })'), '批量启动必须仅提交本次勾选的端口');
  assert.ok(server.includes('portIds'), '服务端必须接收本次勾选的端口列表');
  console.log('serial bridge start selection: passed');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
