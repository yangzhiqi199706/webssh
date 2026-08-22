const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = /async function startSerialBridge\(id\) \{([\s\S]*?)\n\}/.exec(server);

assert.ok(start, '必须提供串口桥接启动函数');
assert.ok(server.includes('function reconcileSerialBridgeLocks()'), '服务端必须回收停止桥接遗留的串口锁');
assert.ok(
  start[1].indexOf('reconcileSerialBridgeLocks();') < start[1].indexOf('serialLocks.has'),
  '启动前必须先回收已停止桥接的遗留锁'
);
assert.ok(
  /app\.get\('\/api\/serial\/bridge\/status'[\s\S]*?reconcileSerialBridgeLocks\(\)/.test(server),
  '状态查询必须同步回收异常停止桥接的遗留锁'
);
const openBlock = /if \(msg\.type === 'open'\) \{([\s\S]*?)\n    if \(msg\.type === 'input'\)/.exec(server);
assert.ok(openBlock, '必须存在串口 WebSocket open 处理逻辑');
assert.ok(
  openBlock[1].indexOf('serialLocks.set(devPath') < openBlock[1].indexOf('runStty(devPath, payload)'),
  'WebSocket 串口必须在异步 stty 配置前原子占用设备锁'
);
assert.ok(
  /lock && lock\.owner === serialLockOwner/.test(server),
  'WebSocket 释放锁时必须校验锁所有权，不能误删其他任务的锁'
);
assert.ok(
  /if \(currentPath\) \{[\s\S]*?串口已经打开或正在打开/.test(server),
  '同一 WebSocket 会话重复打开时必须拒绝，避免先前保留锁遗留'
);

console.log('serial bridge stale lock: passed');
