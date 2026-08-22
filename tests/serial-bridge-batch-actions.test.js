const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'serial', 'assets', 'js', 'serial-bridge.js'), 'utf8');
const startBridge = /async function startSerialBridge\(id\) \{([\s\S]*?)\n\}/.exec(server);

assert.ok(startBridge, '必须提供单路串口转网口启动函数');
assert.ok(
  /const existing = serialBridgeManager\.getStatus\(\)\.find/.test(startBridge[1]),
  '重复启动前必须识别已经运行的串口任务'
);
assert.ok(
  startBridge[1].indexOf('const existing') < startBridge[1].indexOf('serialLocks.has'),
  '已运行的串口必须先被识别，不能被自身的串口锁误判为占用'
);
assert.ok(
  startBridge[1].includes("action: 'already-running'") && startBridge[1].includes("action: 'started'"),
  '批量启动结果必须区分已在运行与本次启动的端口'
);
assert.ok(ui.includes('function summarizeStartEnabledResults'), '前端必须汇总批量启动结果');
assert.ok(ui.includes('已在运行') && ui.includes('启动失败'), '前端必须分别反馈已运行和启动失败的端口');

console.log('serial bridge batch actions: passed');
