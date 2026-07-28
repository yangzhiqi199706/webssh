'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'video', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.resolve(__dirname, '..', 'video', 'assets', 'css', 'style.css'), 'utf8');

assert.match(source, /function hideLoader\(\) \{ self\.elLoader\.hidden = true; \}/,
  '首帧到达后必须统一隐藏加载遮罩');
assert.match(source, /this\.video\.addEventListener\('loadeddata', hideLoader\);/,
  '浏览器解码到首帧时必须关闭加载遮罩');
assert.match(source, /this\.video\.addEventListener\('playing', hideLoader\);/,
  '开始播放时必须关闭加载遮罩');
assert.match(styles, /\.tile-loader\[hidden\]\s*\{\s*display:\s*none;/,
  'hidden 属性必须覆盖 tile-loader 的 display:flex 样式');

console.log('video loader: OK');
