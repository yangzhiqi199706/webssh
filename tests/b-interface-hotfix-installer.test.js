'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const crypto = require('crypto'), cp = require('child_process');
const source = path.resolve(__dirname, '../scripts/hotfix-b-alarm-db/install.sh');
assert.ok(fs.existsSync(source), '热更新安装器必须存在，并提供备份、健康检查和回滚');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const shellPath = p => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_match, drive) => '/' + drive.toLowerCase());
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function write(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); fs.chmodSync(p, 0o755); }

function scenario(mode, arch = 'arm64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-hotfix-test-'));
  const bundle = path.join(root, 'bundle'), app = path.join(root, 'app'), mocks = path.join(root, 'mocks');
  const target = path.join(app, 'proto-conv/b-interface-alarm-db.js');
  const old = "'use strict';\nmodule.exports = { read: function () {} };\n// OLD_FIXTURE\n";
  try {
    write(path.join(bundle, 'install.sh'), fs.readFileSync(source));
    write(path.join(bundle, 'ARCH'), arch + '\n');
    write(path.join(bundle, 'payload/b-interface-alarm-db.js'), fs.readFileSync(path.resolve(__dirname, '../proto-conv/b-interface-alarm-db.js')));
    const files = ['install.sh', 'ARCH', 'payload/b-interface-alarm-db.js'];
    write(path.join(bundle, 'SHA256SUMS'), files.map(f => hash(path.join(bundle, f)) + '  ' + f).join('\n') + '\n');
    write(target, old); write(path.join(app, 'server.js'), '// SERVER_UNCHANGED\n');
    write(path.join(app, 'config/proto-conv-b-interface.json'), 'SAVED_SETTINGS');
    write(path.join(mocks, 'id'), '#!/bin/sh\necho 0\n');
    write(path.join(mocks, 'uname'), '#!/bin/sh\necho "$FIXTURE_ARCH"\n');
    write(path.join(mocks, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_LOG"\nif [ "$1" = restart ] && [ "$FIXTURE_MODE" = restart-failure ] && grep -q configPaths "$WEBSSH_APP_DIR/proto-conv/b-interface-alarm-db.js"; then exit 1; fi\nexit 0\n');
    write(path.join(mocks, 'curl'), '#!/bin/sh\nif [ "$FIXTURE_MODE" = health-failure ] && grep -q configPaths "$WEBSSH_APP_DIR/proto-conv/b-interface-alarm-db.js"; then exit 22; fi\nprintf \'{"ok":true}\\n\'\n');
    write(path.join(mocks, 'sleep'), '#!/bin/sh\nexit 0\n');
    const quotedNode = shellPath(process.execPath).replace(/'/g, "'\\''");
    write(path.join(mocks, 'node'), "#!/bin/sh\nexec '" + quotedNode + "' \"$@\"\n");
    if (mode === 'checksum-failure') fs.appendFileSync(path.join(bundle, 'payload/b-interface-alarm-db.js'), '// tampered');
    if (mode === 'syntax-failure') {
      write(path.join(bundle, 'payload/b-interface-alarm-db.js'), 'function {');
      write(path.join(bundle, 'SHA256SUMS'), files.map(f => hash(path.join(bundle, f)) + '  ' + f).join('\n') + '\n');
    }
    const env = Object.assign({}, process.env, {
      WEBSSH_APP_DIR: shellPath(app), WEBSSH_NODE_BIN: shellPath(path.join(mocks, 'node')),
      FIXTURE_ARCH: mode === 'wrong-arch' ? 'x86_64' : (arch === 'arm64' ? 'aarch64' : 'x86_64'),
      FIXTURE_MODE: mode, FIXTURE_LOG: shellPath(path.join(root, 'services.log')),
      // Git Bash inherits the Windows PATH and converts it before evaluating the command.
      HOTFIX_MOCKS: shellPath(mocks)
    });
    const run = args => cp.spawnSync(bash, ['-c', 'export PATH="$HOTFIX_MOCKS:$PATH"; exec bash "$@"', 'fixture',
      shellPath(path.join(bundle, 'install.sh'))].concat(args || []), { env, encoding: 'utf8', timeout: 30000 });
    const result = run();
    const successful = ['success', 'manual-rollback', 'later-change'].includes(mode);
    assert.strictEqual(result.status === 0, successful, result.stdout + result.stderr);
    if (successful) {
      assert.strictEqual(hash(target), hash(path.join(bundle, 'payload/b-interface-alarm-db.js')));
      const backups = fs.readdirSync(path.join(app, '.hotfix-backups'));
      assert.strictEqual(backups.length, 1);
      assert.strictEqual(fs.readFileSync(path.join(app, '.hotfix-backups', backups[0], 'original.js'), 'utf8'), old);
      if (mode === 'manual-rollback') {
        const rollback = run(['--rollback', backups[0]]);
        assert.strictEqual(rollback.status, 0, rollback.stdout + rollback.stderr);
        assert.strictEqual(fs.readFileSync(target, 'utf8'), old);
      }
      if (mode === 'later-change') {
        fs.appendFileSync(target, '// LATER_UPDATE');
        const before = hash(target), rollback = run(['--rollback', backups[0]]);
        assert.notStrictEqual(rollback.status, 0);
        assert.strictEqual(hash(target), before, '回滚不能覆盖之后的更新');
      }
    } else assert.strictEqual(fs.readFileSync(target, 'utf8'), old, '失败后应保留或恢复原文件');
    assert.strictEqual(fs.readFileSync(path.join(app, 'server.js'), 'utf8'), '// SERVER_UNCHANGED\n');
    assert.strictEqual(fs.readFileSync(path.join(app, 'config/proto-conv-b-interface.json'), 'utf8'), 'SAVED_SETTINGS');
    console.log('PASS hotfix installer: ' + arch + ' ' + mode);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
for (const mode of ['success', 'manual-rollback', 'later-change', 'restart-failure', 'health-failure',
  'wrong-arch', 'checksum-failure', 'syntax-failure']) scenario(mode);
scenario('success', 'x64');
