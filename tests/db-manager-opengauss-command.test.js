'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('function runInContainerAs(container, user, innerCmd)');
assert(start >= 0, '应保留 runInContainerAs 容器命令包装函数');
const body = source.slice(start, source.indexOf('// SSH -> 目标机 -> 命令', start));

assert.match(body, /user === 'omm'/, 'openGauss 管理命令应识别 omm 用户');
assert.match(body, /source \/home\/omm\/.bashrc/, 'openGauss 管理命令必须加载 omm 的运行环境');

console.log('db-manager openGauss command environment: OK');
