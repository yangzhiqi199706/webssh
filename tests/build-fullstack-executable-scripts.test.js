'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.resolve(__dirname, '..', 'scripts', 'build-fullstack-on-server.js'),
  'utf8'
);

assert.match(
  source,
  /chmod \+x \$\{STAGE_DIR\}\/install-all\.sh \$\{STAGE_DIR\}\/uninstall-all\.sh/,
  '全栈包根目录的安装和卸载脚本都必须在归档前设为可执行'
);

assert.match(
  source,
  /test -x \$\{STAGE_DIR\}\/uninstall-all\.sh/,
  '打包结构校验必须验证卸载脚本具备可执行权限'
);

console.log('fullstack package executable scripts: OK');
