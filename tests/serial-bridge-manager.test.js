const assert = require('assert');

let serialBridge = {};
try {
  serialBridge = require('../serial/bridge-manager');
} catch (_err) {
  // 先让断言报告缺少的契约，而不是因模块尚未实现而中断测试。
}

assert.strictEqual(
  typeof serialBridge.createDefaultSerialBridgeConfig,
  'function',
  '串口转网口必须提供默认配置工厂'
);

const config = serialBridge.createDefaultSerialBridgeConfig();
assert.strictEqual(config.comNum, 16, '参考 DTU 默认应创建 16 路串口');
assert.strictEqual(config.communication.maxConnections, 1, '默认每路仅允许一个 TCP 客户端');
assert.strictEqual(config.ports.length, 16, '默认配置必须包含 16 条端口记录');
assert.deepStrictEqual(
  config.ports.slice(0, 4).map(function (port) { return port.packetIntervalMs; }),
  [100, 100, 100, 100],
  '前四路应使用 100ms 串口分包间隔'
);
assert.deepStrictEqual(
  config.ports.slice(4).map(function (port) { return port.packetIntervalMs; }),
  new Array(12).fill(300),
  '其余串口应使用 300ms 串口分包间隔'
);
assert.deepStrictEqual(
  config.ports.map(function (port) { return port.listenPort; }),
  Array.from({ length: 16 }, function (_value, index) { return 8001 + index; }),
  '默认监听端口应连续映射为 8001 至 8016'
);
assert.deepStrictEqual(
  config.ports.map(function (port) { return port.devicePath; }),
  new Array(16).fill(''),
  '默认配置不得假设未安装的 ttyO 驱动，串口设备必须经扫描后选择'
);

console.log('serial bridge defaults: passed');
