const assert = require('assert');
const fs = require('fs');
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
console.log('ARM64 全栈包契约测试：通过');
