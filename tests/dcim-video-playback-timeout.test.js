'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('(function setupDcimVideo()');
const end = source.indexOf('(function setupWebsshVideo()', start);
assert(start >= 0 && end > start, '应保留 dcim 视频代理模块边界');
const block = source.slice(start, end);

assert.match(block, /const DEFAULT_TIMEOUT_MS = 30000;/,
  'dcim 回放代理默认超时应覆盖录像机的 10 秒以上建流时间');
assert.match(block, /timeoutMs: DEFAULT_TIMEOUT_MS/,
  'dcim 视频默认配置应使用回放超时常量');
assert.match(block, /timeout: cfg\.timeoutMs \|\| DEFAULT_TIMEOUT_MS/,
  '请求超时时应回退到 dcim 回放超时常量');

console.log('dcim video playback timeout: OK');
