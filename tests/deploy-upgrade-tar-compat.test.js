'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'deploy-upgrade.js'), 'utf8');

assert.match(source, /function createTarArchive\(/,
  '部署脚本应将打包动作封装为可兼容 Windows tar 的函数');
assert.match(source, /tar 不支持 --force-local，省略该参数后重试/,
  'Windows tar 不支持 GNU 参数时应给出清晰提示并回退');
assert.match(source, /buildTarArguments\(tarPath, workingDirectory, entries, false\)/,
  'buildTar 必须使用可回退的打包逻辑');

console.log('deploy upgrade tar compatibility: OK');
