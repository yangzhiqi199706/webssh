'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const scriptsDirectory = path.resolve(__dirname, '..', 'scripts');
fs.readdirSync(scriptsDirectory)
  .filter(function (name) { return name.endsWith('.sh'); })
  .forEach(function (name) {
    const source = fs.readFileSync(path.join(scriptsDirectory, name), 'utf8');
    assert.strictEqual(source.includes('\r\n'), false, 'Shell 脚本必须使用 LF：' + name);
  });

console.log('shell script line endings: OK');
