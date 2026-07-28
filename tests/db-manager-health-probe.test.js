'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'db', 'index.html'), 'utf8');

assert.match(server, /async function probeDbConnection\(dbId\)/,
  '状态探测应通过实际数据库连接确认在线状态');
assert.match(server, /SELECT 1 FROM DUAL/,
  '达梦健康检查应使用 DUAL 语法');
assert.match(server, /async function runOpenGaussGsql\(sql\)/,
  'openGauss 状态探测应支持容器内原生 gsql');
const gaussProbeStart = server.indexOf('async function runOpenGaussGsql(sql)');
const gaussProbeEnd = server.indexOf('async function probeDbConnection(dbId)', gaussProbeStart);
const gaussProbe = server.slice(gaussProbeStart, gaussProbeEnd);
assert.doesNotMatch(gaussProbe, /'-h ' \+ shellEscape\(/,
  '容器内 gsql 备援必须走本地 Unix socket，不能使用过期的远端主机地址');
assert.doesNotMatch(gaussProbe, /'-W ' \+ shellEscape\(/,
  '容器内 trust 认证的 gsql 备援不能依赖页面保存的数据库密码');
assert.match(gaussProbe, /'-d ' \+ shellEscape\(db\.database \|\| 'dcim'\)/,
  '容器内 gsql 备援仍应使用已配置的数据库名称');
assert.match(server, /runOpenGaussGsql\('SELECT 1;'\)/,
  'pg 驱动异常时，openGauss 健康检查应回退到 gsql');
assert.match(server, /transport: 'gsql'/,
  '状态响应应标识 openGauss 的 gsql 回退通道');
assert.match(server, /target === 'opengauss'[\s\S]{0,300}probeDbConnection\(target\)/,
  '已保存配置的 openGauss 连接测试应复用健康检查通道');
assert.match(server, /function buildDmConnectUrl\(db\)/,
  '达梦连接串应由单一助手构造，避免各调用方格式不一致');
assert.match(server, /dmdbLib\.getConnection\(buildDmConnectUrl\(/,
  '达梦单次测试连接必须把完整 dm URL 字符串直接传给 dmdb');
assert.match(server, /mysqlConn\.ok \? probeOptional\(/,
  '版本与统计查询应由实际连接结果触发，不能再由 systemd 状态阻断');
assert.match(server, /const health = connection\.ok \? 'online' : 'offline';/,
  '数据库实际连通时必须始终判定为 online，不受 systemd 状态影响');
assert.match(server, /systemdState: service\.raw/, '状态响应应保留 systemd 原始状态供诊断');

assert.match(ui, /const health = info\.health/,
  '界面应使用后端返回的健康状态字段');
assert.doesNotMatch(ui, /health === 'degraded'/,
  '概览页不应再生成数据库可用但服务异常的降级状态');
assert.doesNotMatch(ui, /服务状态异常/,
  '概览页不应再显示会造成误判的服务异常提示');
assert.doesNotMatch(ui, /systemdState/,
  '概览页不应展示 systemd 历史状态作为数据库健康度');

console.log('db-manager health probe contract: OK');
