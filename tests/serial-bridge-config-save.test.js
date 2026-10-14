const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const route = /app\.put\('\/api\/serial\/bridge\/config',[\s\S]*?\n\}\);/.exec(server);

assert.ok(route, '必须提供串口转网口配置保存接口');
assert.ok(
  !route[0].includes('await stopAllSerialBridges()'),
  '保存配置不能停止全部运行中的桥接任务，否则一个串口卡住会阻塞主服务'
);

console.log('serial bridge config save: passed');
