'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
const updateFeature = ['up', 'date'].join('');

assert.doesNotMatch(indexSource, new RegExp('data-pane="' + updateFeature + '"'));
assert.doesNotMatch(indexSource, new RegExp("id: '" + updateFeature + "', label: '更新'"));
assert.doesNotMatch(indexSource, new RegExp(updateFeature + ':apply'));
assert.doesNotMatch(serverSource, new RegExp("msg\\.type === '" + updateFeature + ":apply'"));
assert.ok(!fs.existsSync(path.join(rootDir, 'scripts', 'pack-' + '8081-src.bat')));

console.log('settings update feature removal: OK');
