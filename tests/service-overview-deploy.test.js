'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const upgrade = fs.readFileSync(path.join(root, 'scripts', 'deploy-upgrade.js'), 'utf8');
const protocol = fs.readFileSync(path.join(root, 'scripts', 'deploy-protocol.js'), 'utf8');
const fullstack = fs.readFileSync(path.join(root, 'scripts', 'build-fullstack-on-server.js'), 'utf8');

assert.ok(/'overview'/.test(upgrade), '增量部署必须包含 overview');
assert.ok(/'overview'/.test(protocol), '协议部署主壳同步必须包含 overview');
assert.ok(/path\.join\(releaseDir, 'main-sync', entry\)/.test(protocol), '协议部署必须将主壳目录复制到 main-sync');
assert.ok(protocol.includes("['index.html', 'assets/js/overview.js', 'assets/css/style.css']"), '协议部署必须验证 overview 的必需文件');
assert.ok(protocol.includes("['lib', 'video', 'overview']"), '协议部署必须以目录交换方式安装 overview');
assert.ok(protocol.includes("entry !== 'overview'"), 'overview 不得走普通文件 cp -f 分支');
assert.ok(fullstack.includes('cp -a /opt/webssh/app/overview ${STAGE_DIR}/app/`);'), '全栈包必须强制复制 overview 子站');
assert.ok(fullstack.includes('test -f ${STAGE_DIR}/app/overview/index.html'), '全栈包结构检查必须验证 overview 入口');
assert.ok(fullstack.includes('test -f ${STAGE_DIR}/app/overview/assets/js/overview.js'), '全栈包结构检查必须验证 overview 脚本');
assert.ok(fullstack.includes('test -f ${STAGE_DIR}/app/overview/assets/css/style.css'), '全栈包结构检查必须验证 overview 样式');

console.log('service overview deploy: OK');
