'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.resolve(__dirname, '..', 'scripts', 'build-fullstack-on-server.js'),
  'utf8',
);

assert.match(
  source,
  /cp -a \/opt\/webssh\/app\/lib \$\{STAGE_DIR\}\/app\//,
  '全栈包必须复制主壳 lib 目录',
);
assert.match(
  source,
  /test -d \$\{STAGE_DIR\}\/app\/lib/,
  '全栈包结构校验必须确认主壳 lib 目录',
);

console.log('build fullstack app lib: OK');
