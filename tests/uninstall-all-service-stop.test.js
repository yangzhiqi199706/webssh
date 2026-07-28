'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.resolve(__dirname, '..', 'scripts', 'uninstall-all.sh'),
  'utf8'
);

const loopStart = source.indexOf('for svc in "$SERVICE_PROTO" "$SERVICE_MEDIA" "$SERVICE_MAIN"; do');
const guardStart = source.indexOf('if systemctl list-unit-files', loopStart);
const stopMatch = /systemctl stop\s+"\$svc"\s+2>\/dev\/null \|\| true/.exec(source);
const resetMatch = /systemctl reset-failed\s+"\$svc"\s+2>\/dev\/null \|\| true/.exec(source);
const stopStart = stopMatch ? stopMatch.index : -1;
const resetStart = resetMatch ? resetMatch.index : -1;

assert.ok(loopStart >= 0, '卸载脚本必须遍历协议、媒体和主服务');
assert.ok(stopStart >= loopStart, '卸载脚本必须尝试停止每个服务');
assert.ok(guardStart < 0 || stopStart < guardStart,
  '停止服务不能依赖 list-unit-files 是否枚举到 unit');
assert.ok(resetStart >= loopStart, '卸载后必须清理可能遗留的 failed unit 状态');

console.log('uninstall service stop behavior: OK');
