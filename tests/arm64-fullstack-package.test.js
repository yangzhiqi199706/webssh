const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const builderPath = path.join(root, 'scripts', 'build-fullstack-arm64.js');
const installerPath = path.join(root, 'scripts', 'install-all-arm64.sh');

assert.ok(fs.existsSync(builderPath), '缺少 ARM64 全栈打包器');
assert.ok(fs.existsSync(installerPath), '缺少 ARM64 全栈安装器');
const builder = fs.readFileSync(builderPath, 'utf8');
const installer = fs.readFileSync(installerPath, 'utf8');

assert.match(builder, /linux-arm64/);
assert.match(builder, /aarch64/);
assert.match(builder, /sha256/);
assert.match(builder, /protocol_app/);
assert.match(builder, /offline-downloads-arm64/);
assert.match(builder, /need\(path\.join\(ROOT, "node_modules"\), "app\/node_modules"\)/);
assert.match(builder, /copyProtocolApp/);
assert.match(builder, /RUNTIME_PROTOCOL_DIRS/);
assert.match(installer, /uname -m/);
assert.match(installer, /aarch64/);
assert.match(installer, /process\.arch/);
assert.match(installer, /protocol: true/);
assert.match(installer, /video: true/);
assert.match(installer, /db: true/);
assert.match(installer, /ha: true/);
assert.match(installer, /protoConv: true/);
assert.match(installer, /webssh-protocol/);
assert.match(installer, /dcim/);
assert.doesNotMatch(installer, /docker\s+(stop|rm)\s+dcim/);
assert.doesNotMatch(installer, /x86_64-unknown-linux-gnu/);
assert.match(installer, /PROTOCOL_RUNTIME_DIRS=/);
assert.match(installer, /protocol-runtime-data/);

const copyProtocolApp = require(builderPath).copyProtocolApp;
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-arm64-package-'));
try {
  const source = path.join(fixtureRoot, 'protocol-app');
  const destination = path.join(fixtureRoot, 'staged-app');
  fs.mkdirSync(path.join(source, 'modules', '__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(source, 'app.py'), '# application\n', 'utf8');
  fs.writeFileSync(path.join(source, 'modules', '__pycache__', 'cached.pyc'), 'cache', 'utf8');
  ['uploads', 'outputs', 'downloads', 'module4_uploads', 'module4_downloads'].forEach(function (name) {
    fs.mkdirSync(path.join(source, name), { recursive: true });
    fs.writeFileSync(path.join(source, name, 'user-data.txt'), 'private', 'utf8');
  });
  copyProtocolApp(source, destination);
  assert.ok(fs.existsSync(path.join(destination, 'app.py')), '业务代码必须进入离线包');
  assert.strictEqual(fs.existsSync(path.join(destination, 'modules', '__pycache__')), false, 'Python 缓存不得进入离线包');
  ['uploads', 'outputs', 'downloads', 'module4_uploads', 'module4_downloads'].forEach(function (name) {
    assert.strictEqual(fs.existsSync(path.join(destination, name)), false, name + ' 运行时数据不得进入离线包');
  });
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
console.log('ARM64 全栈包契约测试：通过');
