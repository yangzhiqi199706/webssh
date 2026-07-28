'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'db', 'index.html'), 'utf8');

assert.match(server, /async function repairOpenGaussApacheMount\(\)/,
  '后端应提供切换高斯后 Apache 挂载修复操作');
assert.match(server, /const APACHE_MOUNT_SOURCE = '\/dcim\/conf\/apache';/,
  '修复必须限定宿主 Apache 配置目录');
assert.match(server, /const APACHE_MOUNT_TARGET = '\/www\/server\/panel\/vhost\/apache';/,
  '修复必须校验 dcim 容器的实际 Apache bind mount 目标');
assert.match(server, /test -d \/dcim\/conf\/apache/,
  '修复前必须确认宿主 Apache 挂载源是目录');
assert.match(server, /find \/dcim\/conf\/apache -type d -exec chmod 755/,
  '修复必须将 Apache 配置目录恢复为 755');
assert.match(server, /find \/dcim\/conf\/apache -type f -exec chmod 644/,
  '修复必须将 Apache 配置文件恢复为 644');
assert.match(server, /docker restart/,
  '修复权限后必须重启 dcim 容器以重新挂载配置');
assert.match(server, /https:\/\/127\.0\.0\.1:8086\/index\.html/,
  '修复后必须验证本机 HTTPS 页面');
assert.match(server, /\/api\/db-manager\/opengauss\/repair-apache-mount/,
  '后端应暴露高斯切换后的 Apache 挂载修复接口');

assert.match(ui, /btnGaussRepairApacheMount/,
  'openGauss 卡片应包含 Apache 挂载修复按钮');
assert.match(ui, /repairOpenGaussApacheMount/,
  '页面应绑定 Apache 挂载修复操作');
assert.match(ui, /opengauss\/repair-apache-mount/,
  '页面应调用固定的 Apache 挂载修复接口');
assert.match(ui, /确定修复切换高斯数据库后的 Apache 挂载/,
  '重启容器前必须要求二次确认');

console.log('db-manager openGauss Apache mount repair: OK');
