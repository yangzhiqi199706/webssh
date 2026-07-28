'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'video', 'assets', 'css', 'style.css'), 'utf8');
const match = source.match(/\.video-grid\s*\{([\s\S]*?)\n\}/);

assert(match, '应保留视频分屏网格样式');
assert.match(match[1], /height:\s*clamp\(260px, 45vh, 420px\);/,
  '配置面板展开后，视频网格仍应保有可见的响应式高度');
assert.match(match[1], /flex:\s*0 0 auto;/,
  '视频网格不能被后续配置面板压缩为不可见区域');

console.log('video layout: OK');
