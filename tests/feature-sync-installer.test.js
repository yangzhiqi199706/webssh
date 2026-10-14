'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), crypto = require('crypto');
const source = path.resolve(__dirname, '../scripts/hotfix-feature-sync/install.sh');
assert.ok(fs.existsSync(source), '累计热更新安装器必须备份并恢复新增和替换的全部文件');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const shellPath = p => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => '/' + d.toLowerCase());
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); fs.chmodSync(file, 0o755); }
function scenario(mode, arch = 'arm64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-sync-installer-'));
  const bundle = path.join(root, 'bundle'), app = path.join(root, 'app'), mocks = path.join(root, 'mocks');
  const original = '// OLD_SERVER\n', patched = '// FEATURE_SYNC_NEW\n';
  try {
    write(path.join(app, 'server.js'), original); write(path.join(app, 'package.json'), '{}');
    write(path.join(app, 'config/proto-conv-b-interface.json'), 'SAVED_MAPPING');
    write(path.join(bundle, 'payload/server.js'), patched);
    write(path.join(bundle, 'payload/proto-conv/b-interface-mock-ack.js'), '// FEATURE_SYNC_ACK\n');
    write(path.join(bundle, 'install.sh'), fs.readFileSync(source));
    write(path.join(bundle, 'update-files.js'), fs.readFileSync(path.resolve(__dirname, '../scripts/hotfix-feature-sync/update-files.js')));
    write(path.join(bundle, 'ARCH'), arch + '\n');
    const manifest = { files: [
      { path: 'server.js', sha256: hash(path.join(bundle, 'payload/server.js')), allowedBeforeHashes: [hash(path.join(app, 'server.js'))], allowMissing: false },
      { path: 'proto-conv/b-interface-mock-ack.js', sha256: hash(path.join(bundle, 'payload/proto-conv/b-interface-mock-ack.js')), allowedBeforeHashes: [], allowMissing: true }
    ] };
    write(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
    const files = ['install.sh', 'update-files.js', 'ARCH', 'manifest.json', 'payload/server.js', 'payload/proto-conv/b-interface-mock-ack.js'];
    write(path.join(bundle, 'SHA256SUMS'), files.map(f => hash(path.join(bundle, f)) + '  ' + f).join('\n') + '\n');
    write(path.join(mocks, 'id'), '#!/bin/sh\necho 0\n');
    write(path.join(mocks, 'uname'), '#!/bin/sh\necho "$FIXTURE_ARCH"\n');
    write(path.join(mocks, 'systemctl'), '#!/bin/sh\necho "$*" >> "$FIXTURE_LOG"\nif [ "$1" = restart ] && [ "$FIXTURE_MODE" = restart-failure ] && grep -q FEATURE_SYNC_NEW "$WEBSSH_APP_DIR/server.js"; then exit 1; fi\n');
    write(path.join(mocks, 'curl'), '#!/bin/sh\nif [ "$FIXTURE_MODE" = health-failure ] && grep -q FEATURE_SYNC_NEW "$WEBSSH_APP_DIR/server.js"; then exit 22; fi\necho \'{"ok":true}\'\n');
    write(path.join(mocks, 'sleep'), '#!/bin/sh\nexit 0\n');
    write(path.join(mocks, 'node'), "#!/bin/sh\nif [ \"$1\" = -e ]; then exit 0; fi\nexec '" + shellPath(process.execPath).replace(/'/g, "'\\''") + "' \"$@\"\n");
    if (mode === 'checksum-failure') fs.appendFileSync(path.join(bundle, 'payload/server.js'), '// corrupt');
    if (mode === 'unknown-version') write(path.join(app, 'server.js'), '// CUSTOM_SERVER\n');
    const env = Object.assign({}, process.env, { WEBSSH_APP_DIR: shellPath(app), WEBSSH_NODE_BIN: shellPath(path.join(mocks, 'node')),
      HOTFIX_MOCKS: shellPath(mocks), FIXTURE_ARCH: mode === 'wrong-arch' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : 'x86_64',
      FIXTURE_MODE: mode === 'manual-unhealthy' ? 'success' : mode, FIXTURE_LOG: shellPath(path.join(root, 'services.log')) });
    const run = args => cp.spawnSync(bash, ['-c', 'export PATH="$HOTFIX_MOCKS:$PATH"; exec bash "$@"', 'fixture', shellPath(path.join(bundle, 'install.sh'))].concat(args || []), { env, encoding: 'utf8', timeout: 45000 });
    const result = run(), success = ['success', 'manual-rollback', 'manual-unhealthy', 'later-change'].includes(mode);
    assert.strictEqual(result.status === 0, success, result.stdout + result.stderr);
    if (success) {
      assert.strictEqual(fs.readFileSync(path.join(app, 'server.js'), 'utf8'), patched);
      assert.ok(fs.existsSync(path.join(app, 'proto-conv/b-interface-mock-ack.js')));
      const backup = fs.readdirSync(path.join(app, '.hotfix-backups'))[0];
      if (mode === 'manual-rollback' || mode === 'manual-unhealthy') {
        if (mode === 'manual-unhealthy') env.FIXTURE_MODE = 'health-failure';
        const rollback = run(['--rollback', backup]); assert.strictEqual(rollback.status, 0, rollback.stdout + rollback.stderr);
        assert.strictEqual(fs.readFileSync(path.join(app, 'server.js'), 'utf8'), original);
        assert.ok(!fs.existsSync(path.join(app, 'proto-conv/b-interface-mock-ack.js')));
      } else if (mode === 'later-change') {
        write(path.join(app, 'server.js'), '// LATER_SERVER\n');
        const rollback = run(['--rollback', backup]); assert.notStrictEqual(rollback.status, 0);
        assert.strictEqual(fs.readFileSync(path.join(app, 'server.js'), 'utf8'), '// LATER_SERVER\n');
      }
    } else {
      assert.strictEqual(fs.readFileSync(path.join(app, 'server.js'), 'utf8'), mode === 'unknown-version' ? '// CUSTOM_SERVER\n' : original);
      assert.ok(!fs.existsSync(path.join(app, 'proto-conv/b-interface-mock-ack.js')), '失败后不能留下新增 ACK 模块');
    }
    assert.strictEqual(fs.readFileSync(path.join(app, 'config/proto-conv-b-interface.json'), 'utf8'), 'SAVED_MAPPING');
    console.log('PASS feature sync installer: ' + arch + ' ' + mode);
  } finally {
    const resolved = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('feature-sync-installer-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
for (const mode of ['manual-unhealthy', 'success', 'manual-rollback', 'later-change', 'restart-failure', 'health-failure', 'wrong-arch', 'checksum-failure', 'unknown-version']) scenario(mode);
scenario('success', 'x64');
