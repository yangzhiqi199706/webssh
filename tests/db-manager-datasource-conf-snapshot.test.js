'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'db', 'index.html'), 'utf8');

assert.match(ui, /\^\(localhost_8080\|localhost_8086\|python\|conf\)\\\//,
  '本地版本目录打包时应接收 conf 顶层目录');
assert.match(ui, /rest\.startsWith\('conf\/'\) \? rest/,
  'conf 文件应在 ZIP 根目录保存为 conf/...，不能错误放进 admin');

assert.match(server, /admin\/localhost_8080 admin\/localhost_8086 python conf/,
  '抓取当前基线时应把 /dcim/conf 一并写入快照');
assert.match(server, /const snapshotHasConf = /,
  '切换前应识别快照是否包含 conf，兼容旧快照');
assert.match(server, /cp -a \/dcim\/conf .*\/conf/,
  '切换前必须备份整个 /dcim/conf 目录');
assert.match(server, /snapshotHasConf \? 'rm -rf \/dcim\/conf\/\* \/dcim\/conf\/\.\[!\.\]\* 2>\/dev\/null'/,
  '只有快照含 conf 时才清空目标 conf，旧快照必须保留现有配置');
assert.match(server, /cp -a .*\/conf\/\. \/dcim\/conf\//,
  '切换失败时必须回滚整个 /dcim/conf 目录');
assert.match(server, /const DCIM_CONF_REQUIRED_FILES = \['rc\.local', 'server\.crt', 'server\.key', 'wvp_cert\.p12'\]/,
  '含 conf 的快照必须声明 Docker 文件挂载所需的固定文件');
assert.match(server, /zipEntriesResult\.code !== 0/,
  '切换前必须确认能够读取 ZIP 条目，不能在未知结构下解压');
assert.match(server, /conf\/conf\//,
  '切换前必须拒绝 conf/conf/... 双层目录，避免文件挂载源变成目录');
assert.match(server, /async function assertDcimConfMountSources\(\)/,
  '解压后必须验证 Docker bind mount 的源路径类型');
assert.match(server, /test -f \/dcim\/conf\/rc\.local/,
  'rc.local 必须作为普通文件存在');
assert.match(server, /test -d \/dcim\/conf\/apache/,
  'apache 虚拟主机目录必须作为目录存在');
assert.match(server, /await assertDcimConfMountSources\(\)/,
  '启动 dcim 服务前必须执行 bind mount 源路径校验');

console.log('db-manager datasource conf snapshot: OK');
