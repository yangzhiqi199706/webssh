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
  /cp -a \/opt\/webssh\/app\/lib \$\{STAGE_DIR\}\/app\//,
  '全栈包必须包含主壳 lib 目录，避免 server.js 的本地模块缺失'
);

assert.match(
  source,
  /test -d \$\{STAGE_DIR\}\/app\/lib/,
  '打包结构校验必须确认 app/lib 已进入归档 stage'
);

console.log('fullstack package app lib: OK');
