const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFeatureChapter } = require('../scripts/create-feature-chapter');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-chapter-test-'));

function removeDirectory(target) {
  if (!fs.existsSync(target)) return;
  fs.readdirSync(target).forEach(function (name) {
    const child = path.join(target, name);
    if (fs.statSync(child).isDirectory()) removeDirectory(child);
    else fs.unlinkSync(child);
  });
  fs.rmdirSync(target);
}

try {
  const first = createFeatureChapter({
    rootDir: sandbox,
    title: '串口稳定性优化',
    summary: '清理残留桥接进程。',
    scope: ['串口转网口'],
    files: ['serial/bridge-manager.js'],
    verification: ['npm test'],
  });

  assert.strictEqual(first.number, 1);
  assert.match(first.fileName, /^第01章-\d{4}-\d{2}-\d{2}-串口稳定性优化\.md$/);
  assert.ok(fs.existsSync(path.join(sandbox, 'docs', 'development-chapters', first.fileName)));

  const second = createFeatureChapter({
    rootDir: sandbox,
    title: '服务总览增强',
    summary: '增加运行状态汇总。',
    scope: ['运维指挥台'],
    files: ['overview/index.html'],
    verification: ['npm test'],
  });

  assert.strictEqual(second.number, 2);
  assert.match(second.fileName, /^第02章-\d{4}-\d{2}-\d{2}-服务总览增强\.md$/);
  const index = fs.readFileSync(path.join(sandbox, 'docs', 'development-chapters', 'README.md'), 'utf8');
  assert.match(index, /第01章.*串口稳定性优化/);
  assert.match(index, /第02章.*服务总览增强/);
  console.log('feature chapter tools: passed');
} finally {
  removeDirectory(sandbox);
}
