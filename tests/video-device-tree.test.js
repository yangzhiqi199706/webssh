'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'video', 'index.html'), 'utf8');

assert.match(source, /<div class="dev-node collapsed"/, '设备节点初始应可展开');
assert.match(source, /<div class="dev-children"><\/div>/, '设备节点必须包含通道容器');
assert.match(source, /function loadDeviceChannels\(node\)/, '单击设备应按需加载通道');
assert.match(source, /['"]\/api\/['"] \+ currentSource \+ ['"]-video\/channels\?deviceId=/,
  '通道树必须调用当前数据源的通道接口');
assert.match(source, /class="ch-leaf" data-dev=/, '加载结果必须渲染为可识别的通道节点');

console.log('video device tree: OK');
