'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const helperPath = path.resolve(__dirname, '..', 'proto-conv', 'assets', 'js', 'pc-area-utils.js');
const modbusPath = path.resolve(__dirname, '..', 'proto-conv', 'assets', 'js', 'pc-modbus.js');
const modbusControlPath = path.resolve(__dirname, '..', 'proto-conv', 'assets', 'js', 'pc-modbus-control.js');
const serverPath = path.resolve(__dirname, '..', 'server.js');
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

assert.ok(fs.existsSync(helperPath), '区域响应归一化工具必须存在');
assert.ok(
  packageJson.scripts.test.includes('node tests/proto-conv-area-utils.test.js'),
  'npm test 必须执行区域响应归一化回归测试',
);

const areaUtils = require(helperPath);

assert.deepStrictEqual(
  areaUtils.normalizeAreaRecords([{ Zonesubno: '1', Zonesubname: '旧区域' }]),
  [{ Zonesubno: '1', Zonesubname: '旧区域' }],
  '数组响应应保持不变',
);
assert.deepStrictEqual(
  areaUtils.normalizeAreaRecords({ info: [{ id: '2', AreaName: '新区域' }] }),
  [{ id: '2', AreaName: '新区域' }],
  'dcim 分页响应应提取 info 数组',
);
assert.deepStrictEqual(
  areaUtils.normalizeAreaRecords({ page: { total: 0 } }),
  [],
  '未知响应结构应降级为空数组',
);

assert.deepStrictEqual(
  areaUtils.normalizeRecords({ info: [{ DeviceId: '1001' }] }),
  [{ DeviceId: '1001' }],
  '设备和控制项的分页 info 响应应归一化为数组',
);

assert.deepStrictEqual(
  areaUtils.normalizeRecords([{ GroupId: '10' }]),
  [{ GroupId: '10' }],
  '分组的数组响应应可复用同一归一化工具',
);

assert.strictEqual(
  areaUtils.getDeviceId({ id: 1001, DeviceName: '8086 设备' }),
  '1001',
  '8086 设备应使用 id 作为 DeviceId 兼容值',
);

assert.strictEqual(
  areaUtils.getZoneNo({ AreaId: 1 }),
  '1',
  '8086 设备应使用 AreaId 作为区域号兼容值',
);

assert.strictEqual(
  areaUtils.getControlId({ id: 2001, DevID: 1001 }),
  '2001',
  '8086 控制项应使用 id 作为 ControlId 兼容值',
);

assert.strictEqual(
  areaUtils.getControlName({ CommandDesc: '启动设备' }),
  '启动设备',
  '8086 控制项应使用 CommandDesc 作为名称兜底',
);

assert.strictEqual(
  areaUtils.belongsToGroup({ id: 7, DeviceClass: 1 }, 1),
  true,
  '8086 设备没有 GroupId 时，DeviceClass 应作为分组归属',
);
assert.strictEqual(
  areaUtils.belongsToGroup({ id: 9, DeviceClass: 20 }, 1),
  false,
  '接口忽略 GroupId 且返回全量设备时，必须过滤掉不属于当前分组的设备',
);
assert.strictEqual(
  areaUtils.belongsToGroup({ DeviceId: 1001 }, 1),
  true,
  '旧接口没有分组归属字段时，应保留接口已过滤的设备列表',
);

const modbusSource = fs.readFileSync(modbusPath, 'utf8');
const modbusControlSource = fs.readFileSync(modbusControlPath, 'utf8');
const serverSource = fs.readFileSync(serverPath, 'utf8');
assert.ok(
  modbusSource.includes("GetDeviceParasKey") && modbusSource.includes('AreaUtils.getDeviceId(d)'),
  '设备扫描必须兼容 8086 设备 ID 并读取参数列表',
);
assert.ok(
  modbusControlSource.includes('AreaUtils.getControlId(c)'),
  '控制扫描必须兼容 8086 控制项 ID',
);
assert.ok(
  modbusSource.includes('AreaUtils.belongsToGroup(d, g.GroupId)'),
  '设备扫描必须按响应内的归属字段过滤被接口重复返回的设备',
);
assert.ok(
  modbusControlSource.includes('AreaUtils.belongsToGroup(dev, g.GroupId)'),
  '控制扫描必须按响应内的归属字段过滤被接口重复返回的设备',
);
assert.ok(
  serverSource.includes("require('./proto-conv/assets/js/pc-area-utils')") &&
    serverSource.includes('dcimRecords.getDeviceId(dev)'),
  '后端 Modbus 轮询必须复用 8086 设备 ID 兼容规则',
);

const areaMap = { '1': '数据库区域' };
areaUtils.mergeAreaRecords(areaMap, {
  info: [
    { id: '1', AreaName: '接口区域' },
    { id: '2', AreaName: '新区域' },
    { Zonesubno: '3', Zonesubname: '旧接口区域' },
  ],
});
assert.deepStrictEqual(areaMap, {
  '1': '数据库区域',
  '2': '新区域',
  '3': '旧接口区域',
}, '接口兜底应兼容新旧字段且不得覆盖数据库区域名');

console.log('proto-conv area utils: OK');
