'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'db', 'index.html'), 'utf8');

assert.match(server, /const APACHE_VHOSTS_PATH = '\/www\/server\/apache\/conf\/extra\/httpd-vhosts\.conf';/,
  '后端必须把 Apache 虚拟主机配置目标固定为容器内指定路径');
assert.match(server, /async function uploadDmApacheVhosts\(/,
  '后端应提供独立的达梦页面 Apache 虚拟主机上传操作');
assert.match(server, /fileName !== 'httpd-vhosts\.conf'/,
  '后端必须拒绝非 httpd-vhosts.conf 文件名');
assert.match(server, /httpd-vhosts\.conf\.bak\./,
  '覆盖前必须生成容器内带时间戳的备份');
assert.match(server, /APACHE_HTTPD_BIN \+ ' -t/,
  '覆盖后必须执行 Apache 配置语法检查');
assert.match(server, /APACHE_HTTPD_BIN \+ ' -k graceful/,
  '只有语法检查通过后才应 graceful 重载 Apache');
assert.match(server, /https:\/\/127\.0\.0\.1:8086\/index\.html/,
  '上传后必须验证本机 HTTPS 虚拟主机');
assert.match(server, /\/api\/db-manager\/dm\/upload-httpd-vhosts/,
  '后端必须暴露固定的虚拟主机上传接口');

assert.match(ui, /btnDmApacheVhosts/,
  '达梦 DM 概览卡片应包含 Apache 虚拟主机上传按钮');
assert.match(ui, /dmApacheVhostsFile/,
  '页面应提供固定配置文件选择控件');
assert.match(ui, /upload-httpd-vhosts/,
  '页面应调用 Apache 虚拟主机上传接口');
assert.match(ui, /httpd-vhosts\.conf/, '页面应明确要求固定文件名');
assert.match(ui, /确定上传并应用 Apache 虚拟主机配置/, '页面必须要求二次确认');

console.log('db-manager DM Apache vhosts upload: OK');
