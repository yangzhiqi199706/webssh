'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'db', 'index.html'), 'utf8');

assert.match(server, /async function repairDeviceProtocolSequence\(\)/,
  '后端应提供固定的设备协议序列修复操作');
assert.match(server, /dcim-deviceprotocol_id_seq/,
  '修复操作必须使用设备协议表的固定序列');
assert.match(server, /dcim-deviceprotocol/,
  '修复操作必须使用设备协议表的固定表名');
assert.match(server, /Flight::db\(\)/,
  '修复操作应复用 dcim PHP 配置中的 Flight 数据库连接');
assert.match(server, /\/api\/db-manager\/opengauss\/fix-deviceprotocol-sequence/,
  '后端应暴露固定的序列修复接口');
assert.match(server, /maxId: Number\(result\.max_id\)/,
  '接口应返回修复后的最大 ID');
assert.match(server, /lastValue: Number\(result\.last_value\)/,
  '接口应返回修复后的序列值');

assert.match(ui, /btnGaussFixDeviceProtocolSeq/,
  'openGauss 卡片应包含设备协议序列修复按钮');
assert.match(ui, /fixDeviceProtocolSequence/,
  '页面应绑定设备协议序列修复操作');
assert.match(ui, /fix-deviceprotocol-sequence/,
  '页面应调用固定的序列修复接口');
assert.match(ui, /确定修复设备协议序列/, '写操作必须要求二次确认');

console.log('db-manager openGauss deviceprotocol sequence repair: OK');
