'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'db', 'index.html'), 'utf8');

assert.match(server, /async function optimizeOpenGaussMemory\(\)/,
  '后端应提供固定的一键 openGauss 内存优化操作');
assert.match(server, /pgConfPath \+ '\.bak\.' \+ stampForFile\(\)/,
  '优化前必须备份 postgresql.conf');
assert.match(server, /gs_guc/,
  '优化必须使用 openGauss 官方 gs_guc 工具写入配置');
assert.match(server, /max_process_memory: '2097152'/,
  '优化必须把 max_process_memory 调整为 2GB');
assert.match(server, /shared_buffers: '128MB'/,
  '优化必须把 shared_buffers 调整为 128MB');
assert.match(server, /cstore_buffers: '128MB'/,
  '优化必须把 cstore_buffers 调整为 128MB');
assert.match(server, /max_connections: '100'/,
  '优化必须把 max_connections 调整为 100');
assert.match(server, /systemctl restart[\s\S]{0,120}opengauss/,
  '配置写入后必须重启 openGauss');
assert.match(server, /\/api\/db-manager\/opengauss\/optimize-memory/,
  '后端应暴露一键内存优化接口');

assert.match(ui, /btnGaussOptimizeMemory/,
  'openGauss 卡片应包含内存优化按钮');
assert.match(ui, /optimizeOpenGaussMemory/,
  '页面应绑定内存优化操作');
assert.match(ui, /opengauss\/optimize-memory/,
  '页面应调用固定的内存优化接口');
assert.match(ui, /确定按 6GB 服务器参数优化 openGauss 内存/, 
  '写入配置前必须要求二次确认');

console.log('db-manager openGauss memory optimization: OK');
