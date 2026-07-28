'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');

function blockBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, '应保留 ' + startMarker + ' 视频代理模块');
  return source.slice(start, end);
}

const dcim = blockBetween('(function setupDcimVideo()', '(function setupWebsshVideo()');
const webssh = blockBetween('(function setupWebsshVideo()', '// ===== 协议转换');

[dcim, webssh].forEach((block, index) => {
  const label = index === 0 ? 'dcim' : 'webssh';
  assert.match(block, /playback\/stop\/' \+ did \+ '\/' \+ cid \+ '\/' \+ sid/,
    label + ' 停止回放必须携带设备、通道与流 ID');
  assert.match(block, /\/api\/playback\/pause\//, label + ' 暂停必须映射到 WVP pause 路由');
  assert.match(block, /\/api\/playback\/resume\//, label + ' 恢复必须映射到 WVP resume 路由');
  assert.match(block, /\/api\/playback\/seek\//, label + ' 拖动必须映射到 WVP seek 路由');
  assert.match(block, /\/api\/playback\/speed\//, label + ' 倍速必须映射到 WVP speed 路由');
  assert.doesNotMatch(block, /\/api\/playback\/control\//,
    label + ' 不得调用 WVP 2.6.9 中不存在的 control 路由');
});

console.log('WVP playback control routing: OK');
