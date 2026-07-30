'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const helperPath = path.resolve(__dirname, '..', 'proto-conv', 'dcim-area-db.js');
const serverPath = path.resolve(__dirname, '..', 'server.js');
const configJsPath = path.resolve(__dirname, '..', 'proto-conv', 'assets', 'js', 'pc-config.js');
const indexPath = path.resolve(__dirname, '..', 'proto-conv', 'index.html');
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

assert.ok(fs.existsSync(helperPath), 'dcim 数据库类型工具必须存在');
assert.ok(
  packageJson.scripts.test.includes('node tests/proto-conv-db-type.test.js'),
  'npm test 必须执行 dcim 数据库类型回归测试',
);

const db = require(helperPath);

assert.deepStrictEqual(db.SUPPORTED_TYPES, ['mysql', 'opengauss', 'dm']);
assert.strictEqual(db.defaultPort('mysql'), 3333);
assert.strictEqual(db.defaultPort('opengauss'), 5432);
assert.strictEqual(db.defaultPort('dm'), 5236);
assert.strictEqual(db.isSupportedType('opengauss'), true);
assert.strictEqual(db.isSupportedType('oracle'), false);

assert.deepStrictEqual(
  db.mergeConnectionConfig(
    { type: 'opengauss', host: '192.168.50.197', port: 5432, user: 'dcim', database: 'dcim' },
    { type: 'mysql', host: 'old-host', port: 3333, user: 'old-user', password: 'saved-password', database: 'old-db' },
  ),
  {
    type: 'opengauss', host: '192.168.50.197', port: 5432, user: 'dcim',
    password: 'saved-password', database: 'dcim',
  },
  '测试未保存的数据库配置时，空密码应沿用已保存密码，且不得修改保存配置',
);

assert.ok(
  db.areaQuery('mysql').includes('`dcim-area`'),
  'MySQL 应使用反引号表名',
);
assert.ok(
  db.areaQuery('opengauss').includes('public."dcim-area"'),
  'openGauss 应使用 public schema 和双引号表名',
);
assert.ok(
  db.areaQuery('dm').includes('"dcim-area"'),
  '达梦应使用双引号表名',
);

assert.deepStrictEqual(
  db.normalizeAreaRows([
    { ID: 1, AREANAME: '达梦区域', STATUS: 1 },
    { id: 2, AreaName: '停用区域', status: 0 },
    { id: 3, AreaName: '高斯区域', status: '1' },
  ]),
  [
    { id: '1', areaName: '达梦区域' },
    { id: '3', areaName: '高斯区域' },
  ],
  '不同数据库返回的字段大小写均应统一并过滤停用区域',
);

const serverSource = fs.readFileSync(serverPath, 'utf8');
const configSource = fs.readFileSync(configJsPath, 'utf8');
const indexSource = fs.readFileSync(indexPath, 'utf8');
assert.ok(serverSource.includes("require('./proto-conv/dcim-area-db')"), '协议转换后端必须使用数据库类型工具');
assert.ok(serverSource.includes("require('pg')"), '协议转换后端必须加载 openGauss 驱动');
assert.ok(serverSource.includes("require('dmdb')"), '协议转换后端必须加载达梦驱动');
assert.ok(configSource.includes('dbType'), '连接信息前端必须读写数据库类型');
assert.ok(indexSource.includes('id="cfgDbType"'), '连接信息界面必须展示数据库类型选择');
assert.ok(indexSource.includes('id="btnCfgDbTest"'), '连接信息界面必须提供数据库测试连接按钮');
assert.ok(configSource.includes("/api/proto-conv/test-dcim-db"), '数据库测试按钮必须调用专用测试接口');
assert.ok(serverSource.includes("app.post('/api/proto-conv/test-dcim-db'"), '协议转换后端必须提供数据库测试接口');

console.log('proto-conv db type: OK');
