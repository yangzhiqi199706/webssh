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

console.log('serial bridge stale lock: passed');
