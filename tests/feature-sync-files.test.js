'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const worker = path.resolve(__dirname, '../scripts/hotfix-feature-sync/update-files.js');
assert.ok(fs.existsSync(worker), '累计热更新必须提供多文件备份、原子替换及回滚工作器');
const update = require(worker);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function fixture(action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-sync-files-'));
  const app = path.join(root, 'app'), bundle = path.join(root, 'bundle'), backup = path.join(app, '.hotfix-backups/feature-sync-fixture');
  const entries = [
    { path: 'server.js', sha256: hash('NEW_SERVER'), allowedBeforeHashes: [hash('OLD_SERVER')], allowMissing: false },
    { path: 'proto-conv/b-interface-mock-ack.js', sha256: hash('NEW_ACK'), allowedBeforeHashes: [], allowMissing: true },
    { path: 'node_modules/sax/lib/sax.js', sha256: hash('NEW_SAX'), allowedBeforeHashes: [], allowMissing: true }
  ];
  const manifest = { files: entries };
  write(path.join(app, 'server.js'), 'OLD_SERVER');
  write(path.join(app, 'config/proto-conv-b-interface.json'), 'PRIVATE_SETTINGS');
  entries.forEach(e => write(path.join(bundle, 'payload', e.path), e.path === 'server.js' ? 'NEW_SERVER' : e.path.includes('sax') ? 'NEW_SAX' : 'NEW_ACK'));
  write(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
  try { action({ root, app, bundle, backup, manifest }); }
  finally {
    const resolved = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('feature-sync-files-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
fixture(({ app, bundle, backup }) => {
  update.preflight(app, bundle);
  update.prepare(app, bundle, backup); update.apply(app, bundle, backup);
  assert.strictEqual(fs.readFileSync(path.join(app, 'server.js'), 'utf8'), 'NEW_SERVER');
  assert.strictEqual(fs.readFileSync(path.join(app, 'proto-conv/b-interface-mock-ack.js'), 'utf8'), 'NEW_ACK');
  update.checkCurrent(app, backup);
  update.restore(app, backup);
  assert.strictEqual(fs.readFileSync(path.join(app, 'server.js'), 'utf8'), 'OLD_SERVER');
  assert.ok(!fs.existsSync(path.join(app, 'proto-conv/b-interface-mock-ack.js')));
  assert.ok(!fs.existsSync(path.join(app, 'node_modules/sax/lib/sax.js')));
  assert.strictEqual(fs.readFileSync(path.join(app, 'config/proto-conv-b-interface.json'), 'utf8'), 'PRIVATE_SETTINGS');
});
fixture(({ app, bundle, backup }) => {
  update.prepare(app, bundle, backup);
  // A failure after only the first file was committed must restore the complete old state.
  write(path.join(app, 'server.js'), 'NEW_SERVER');
  update.restore(app, backup);
  assert.strictEqual(fs.readFileSync(path.join(app, 'server.js'), 'utf8'), 'OLD_SERVER');
  assert.ok(!fs.existsSync(path.join(app, 'proto-conv/b-interface-mock-ack.js')));
});
fixture(({ app, bundle, backup }) => {
  update.prepare(app, bundle, backup); update.apply(app, bundle, backup);
  write(path.join(app, 'server.js'), 'LATER_UPDATE');
  assert.throws(() => update.checkCurrent(app, backup), /后续更新/);
  assert.throws(() => update.restore(app, backup), /后续更新/);
  assert.strictEqual(fs.readFileSync(path.join(app, 'server.js'), 'utf8'), 'LATER_UPDATE');
});
fixture(({ app, bundle }) => {
  write(path.join(app, 'server.js'), 'CUSTOM_SERVER');
  assert.throws(() => update.preflight(app, bundle), /未知版本|定制/);
  assert.strictEqual(fs.readFileSync(path.join(app, 'server.js'), 'utf8'), 'CUSTOM_SERVER');
});
fixture(({ app, bundle, backup }) => {
  update.prepare(app, bundle, backup);
  write(path.join(app, 'server.js'), 'RACE_UPDATE');
  assert.throws(() => update.apply(app, bundle, backup), /变化/);
  assert.strictEqual(fs.readFileSync(path.join(app, 'server.js'), 'utf8'), 'RACE_UPDATE');
});
fixture(({ app, bundle, backup }) => {
  update.prepare(app, bundle, backup); update.apply(app, bundle, backup);
  write(path.join(backup, 'original/server.js'), 'CORRUPT_BACKUP');
  assert.throws(() => update.restore(app, backup), /备份.*校验/);
  assert.strictEqual(fs.readFileSync(path.join(app, 'server.js'), 'utf8'), 'NEW_SERVER');
});
fixture(({ app, bundle }) => {
  write(path.join(bundle, 'payload/server.js'), 'TAMPERED');
  assert.throws(() => update.preflight(app, bundle), /补丁.*校验/);
});
for (const unsafe of ['../outside.js', 'config/proto-conv.json', 'node_modules/mysql2/index.js', 'runtime/node', 'proto-conv/../../outside.js']) {
  fixture(({ app, bundle, manifest }) => {
    manifest.files[0].path = unsafe;
    write(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
    assert.throws(() => update.preflight(app, bundle), /范围|路径/);
  });
}
fixture(({ app, bundle, manifest }) => {
  manifest.files.push(manifest.files[0]); write(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => update.preflight(app, bundle), /重复/);
});
console.log('PASS feature-sync files: replacement/new-file rollback, partial recovery, config preservation, hashes, version guard and path bounds');
