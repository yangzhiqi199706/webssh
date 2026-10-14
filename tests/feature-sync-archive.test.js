'use strict';
// Exercise the delivered archive against actual historical application snapshots.
const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os'), crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const latest = arch => fs.readdirSync(path.join(root, 'dist')).filter(n => n.startsWith('webssh-feature-sync-hotfix-linux-' + arch + '-') && n.endsWith('.tar.gz')).sort().pop();
const extracted = {};
for (const arch of ['arm64', 'x64']) {
  const archive = latest(arch); assert.ok(archive, '必须先生成两架构累计热更新包');
  const dir = path.join(root, 'output/feature-sync-hotfix/archive-test', arch);
  fs.mkdirSync(dir, { recursive: true }); cp.execFileSync('tar', ['-xzf', path.join(root, 'dist', archive), '-C', dir]);
  const bundle = path.join(dir, archive.replace(/\.tar\.gz$/, ''));
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json')));
  for (const entry of manifest.files) assert.strictEqual(hash(path.join(bundle, 'payload', entry.path)), entry.sha256);
  const checks = fs.readFileSync(path.join(bundle, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/);
  for (const line of checks) assert.strictEqual(hash(path.join(bundle, line.slice(66))), line.slice(0, 64));
  assert.ok(manifest.files.some(e => e.path === 'proto-conv/b-interface-mock-ack.js'));
  assert.ok(manifest.files.some(e => e.path === 'proto-conv/b-interface-alarm-db.js'));
  assert.ok(!manifest.files.some(e => /^(config|runtime|protocol)\//.test(e.path)));
  const ui = fs.readFileSync(path.join(bundle, 'payload/proto-conv/assets/js/pc-b-interface.js'), 'utf8');
  for (const marker of ['biRegenerateAckScript', 'biCopyAckScript', 'biCopyAckBody']) assert.ok(ui.includes(marker), 'ACK 界面缺少按钮：' + marker);
  assert.ok(fs.readFileSync(path.join(bundle, 'payload/proto-conv/b-interface-routes.js'), 'utf8').includes("'mock-ack-script'"));
  extracted[arch] = { bundle, manifest };
}
assert.deepStrictEqual(extracted.arm64.manifest.files, extracted.x64.manifest.files, '两架构业务补丁应一致');
function oldApp(arch, day) {
  const filename = fs.readdirSync(path.join(root, 'dist')).filter(n => n.includes('fullstack-offline-linux-' + arch) && n.includes('202610' + day) && n.endsWith('.tar.gz')).sort().pop();
  const dir = path.join(root, 'output/feature-sync-hotfix/baseline-test', arch + '-' + day);
  fs.mkdirSync(dir, { recursive: true });
  cp.execFileSync('tar', ['-xzf', path.join(root, 'dist', filename), '-C', dir,
    '--exclude=*/node_modules/*', '--exclude=*/runtime/*', '--exclude=*/wheels/*']);
  return path.join(dir, filename.replace(/\.tar\.gz$/, ''), 'app');
}
function verifyBaseline(arch, day, previousHotfix) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-sync-archive-'));
  const app = path.join(fixture, 'app'), bundle = extracted[arch].bundle;
  try {
    const source = oldApp(arch, day);
    if (process.platform === 'win32') {
      try { cp.execFileSync('robocopy', [source, app, '/E', '/COPY:DAT', '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'pipe' }); }
      catch (e) { if (!Number.isInteger(e.status) || e.status < 0 || e.status > 7) throw e; }
    } else fs.cpSync(source, app, { recursive: true });
    fs.mkdirSync(path.join(app, 'config'), { recursive: true });
    fs.writeFileSync(path.join(app, 'config/proto-conv-b-interface.json'), 'PRESERVE_BUSINESS_CONFIG');
    if (previousHotfix) fs.copyFileSync(path.join(bundle, 'payload/proto-conv/b-interface-alarm-db.js'), path.join(app, 'proto-conv/b-interface-alarm-db.js'));
    const worker = require(path.join(bundle, 'update-files.js'));
    const backup = path.join(app, '.hotfix-backups/feature-sync-archive-test');
    worker.preflight(app, bundle); worker.prepare(app, bundle, backup); worker.apply(app, bundle, backup); worker.checkCurrent(app, backup);
    const smoke = 'const p=require("path"),r=require("module").createRequire(p.join(process.argv[1],"server.js"));' +
      'const d=r("./proto-conv/b-interface-forwarder").defaults,a=r("./proto-conv/b-interface-mock-ack").generate(d);' +
      'if(a.responseBody!=="${bAckEnvelope}"||!a.script.includes("SEND_HISALARM"))throw Error("ACK generation");' +
      'r("./proto-conv/b-interface-routes");r("./proto-conv/b-interface-alarm-db");' +
      'if(!r.resolve("sax").startsWith(process.argv[1]))throw Error("SAX must load delivered pure JS");console.log("ACK_AND_MODULES_OK");';
    const output = cp.execFileSync(process.execPath, ['-e', smoke, app], { encoding: 'utf8',
      env: Object.assign({}, process.env, { NODE_PATH: path.join(root, 'node_modules') }) });
    assert.ok(output.includes('ACK_AND_MODULES_OK'));
    assert.strictEqual(fs.readFileSync(path.join(app, 'config/proto-conv-b-interface.json'), 'utf8'), 'PRESERVE_BUSINESS_CONFIG');
    worker.restore(app, backup);
    const state = JSON.parse(fs.readFileSync(path.join(backup, 'state.json')));
    for (const entry of state.files) {
      const file = path.join(app, entry.path);
      if (entry.existed) assert.strictEqual(hash(file), entry.originalSha256);
      else assert.ok(!fs.existsSync(file), '回滚残留新增文件：' + entry.path);
    }
    console.log('PASS archive update/ACK/rollback: ' + arch + ' 2026-10-' + day + (previousHotfix ? ' + prior DB hotfix' : ''));
  } finally {
    const resolved = fs.realpathSync(fixture), parent = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('feature-sync-archive-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
for (const arch of ['arm64', 'x64']) for (const day of ['12', '14']) verifyBaseline(arch, day, false);
verifyBaseline('arm64', '14', true);
