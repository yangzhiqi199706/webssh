'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'video', 'index.html'), 'utf8');

[
  'btnTogglePlayback', 'playbackBar', 'pbStart', 'pbEnd', 'btnPlaybackStart',
  'btnPlaybackPause', 'btnPlaybackResume', 'pbSpeed', 'pbSeek', 'pbHint',
].forEach((id) => assert.match(source, new RegExp('id="' + id + '"')));

assert.match(source, /function toWvpTime\(/, 'datetime-local 必须转为 WVP 可接受的时间格式');
assert.match(source, /\/playback\/start\//, '回放模式必须调用回放启动接口');
assert.match(source, /\/playback\/control\//, '回放工具条必须调用控制接口');
assert.match(source, /\/playback\/stop\//, '停止分屏必须释放回放流');
assert.match(source, /mode === 'playback'/, '分屏必须区分实时流和回放流');
assert.match(source, /stream: pr\.stream/, '回放停止必须保留 WVP 返回的 stream ID');
assert.match(source, /function isChannelOnline\(channel\)/,
  'WVP 通道在线状态需要集中兼容处理');
assert.match(source, /channel\.status === true/,
  'dcim WVP 返回布尔 true 时必须识别为在线通道');
assert.match(source, /resp\.list\.find\(isChannelOnline\)/,
  '起播前必须优先选择已在线的通道');
assert.match(source, /\['SIP 鉴权密码', sip\.password \? '\(已配置，已隐藏\)' : '\(留空 = 不校验\)'\]/,
  '配置面板只能显示 SIP 密码是否已配置，不能输出明文');
assert.doesNotMatch(source, /sip\.password \? sip\.password :/,
  'SIP 密码不得直接渲染到视频页面');

console.log('video playback UI: OK');
