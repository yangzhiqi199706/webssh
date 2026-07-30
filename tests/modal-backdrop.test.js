'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourceFiles = [
  'index.html',
  'ha/assets/js/ha-config.js',
  'ha/assets/js/ha-failover.js',
  'ha/assets/js/ha-sync.js',
  'sms/assets/js/sms-db.js',
  'sms/assets/js/sms-monitor.js',
  'sms/assets/js/sms-push.js',
  'sms/assets/js/sms-scheduled.js',
  'proto-conv/assets/js/pc-config.js',
  'proto-conv/assets/js/pc-iec104.js',
  'proto-conv/assets/js/pc-modbus-control.js',
  'proto-conv/assets/js/pc-modbus.js',
  'proto-conv/assets/js/pc-runner.js',
  'proto-conv/assets/js/pc-snmp.js',
  'protocol_app/templates/module4.html',
  'video/index.html',
  'video/assets/js/video-config.js',
];

const backdropClosePattern = /\b(?:e|event)\.target\s*===/;

sourceFiles.forEach(function (relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  assert.strictEqual(
    backdropClosePattern.test(source),
    false,
    '遮罩点击不应关闭弹窗：' + relativePath,
  );
});

console.log('modal backdrop: OK');
