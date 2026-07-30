const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const {
  createProbeCommand,
  parseProbeOutput,
  cpuPercent,
  pruneHistory,
  toPublicSnapshot,
  createCollector,
  createServiceOverview,
} = require('../lib/service-overview');

const probeOutput = [
  'cpu.user=100',
  'cpu.nice=0',
  'cpu.system=50',
  'cpu.idle=850',
  'mem.totalKb=1000',
  'mem.availableKb=250',
  'disk.usedKb=400',
  'disk.totalKb=1000',
  'load.1m=1.25',
  'uptime.seconds=7200',
  'service.webssh=active',
  'service.protocol=active',
  'service.docker=active',
  'dcim.container=true',
  'dcim.service=active',
].join('\n');

function createSuccessfulSpawn() {
  return function () {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(function () {
      child.stdout.emit('data', probeOutput);
      child.emit('close', 0);
    });
    return child;
  };
}

function createTimeoutClient(mode, instances) {
  return class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.endCalled = false;
      instances.push(this);
    }

    connect() {
      process.nextTick(() => this.emit('ready'));
    }

    exec(_command, callback) {
      if (mode === 'no-callback') return;
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      callback(null, stream);
    }

    end() {
      this.endCalled = true;
    }
  };
}

async function run() {
  assert.ok(
    serverSource.includes("require('./lib/service-overview')"),
    'server.js 必须加载服务总览模块'
  );
  assert.ok(
    serverSource.includes("app.get('/api/service-overview'"),
    'server.js 必须注册服务总览读取接口'
  );
  assert.ok(
    serverSource.includes("app.post('/api/service-overview/refresh'"),
    'server.js 必须注册服务总览刷新接口'
  );
  assert.ok(
    serverSource.includes("path.join(__dirname, 'config', 'ha.json')"),
    '服务总览必须读取双机热备实际使用的 HA 配置路径'
  );
  assert.ok(
    /const SERVICE_OVERVIEW_HA_CONFIG_PATH = process\.env\.HA_CONFIG\s*\|\| path\.join\(__dirname, 'config', 'ha\.json'\);/.test(serverSource),
    '服务总览与双机热备必须读取同一份 HA 配置'
  );
  assert.ok(
    /app\.get\('\/api\/service-overview', function \(req, res\) \{\s*if \(!requireSettingsAuth\(req, res\)\) return;[\s\S]*?serviceOverview\.getSnapshot\(\)/.test(serverSource),
    '服务总览读取接口必须在读取快照前立即鉴权'
  );
  assert.ok(
    /app\.post\('\/api\/service-overview\/refresh', async function \(req, res\) \{\s*if \(!requireSettingsAuth\(req, res\)\) return;\s*try \{\s*await serviceOverview\.refresh\(\)/.test(serverSource),
    '服务总览刷新接口必须在刷新前立即鉴权'
  );
  assert.ok(serverSource.includes('serviceOverview.start();'), 'server.js 必须在启动时开启采集');
  assert.ok(serverSource.includes('serviceOverview.stop();'), 'server.js 必须在退出时停止采集');
  assert.ok(serverSource.includes('server.close('), '信号退出路径必须关闭 HTTP 服务');
  assert.ok(serverSource.includes('process.exit('), '信号退出路径必须受控退出进程');
  assert.ok(
    /function shutdownServiceOverview\(\) \{[\s\S]*?serviceOverview\.stop\(\);[\s\S]*?server\.close\(function \(\) \{[\s\S]*?process\.exit\(0\);/.test(serverSource),
    '优雅退出必须先停采集、关闭 HTTP 服务，再成功退出'
  );
  assert.ok(serverSource.includes('let serviceOverviewShuttingDown = false;'), '优雅退出必须防止重复关闭');
  assert.ok(serverSource.includes('}, 5000);'), '优雅退出必须设置短超时兜底');
  assert.ok(serverSource.includes('shutdownTimeout.unref();'), '优雅退出超时不应阻止正常退出');

  assert.ok(
    createProbeCommand().includes('cpu.user=%s\\ncpu.nice=%s'),
    '探针命令必须以真实 AWK 换行符分隔 CPU 键值'
  );

  const parsed = parseProbeOutput(probeOutput);
  assert.deepStrictEqual(parsed.cpu, { user: 100, nice: 0, system: 50, idle: 850 });
  assert.strictEqual(parsed.memory.percent, 75);
  assert.strictEqual(parsed.disk.percent, 40);
  assert.strictEqual(parsed.dcim.healthy, true);

  assert.strictEqual(cpuPercent(null, { user: 130, nice: 0, system: 70, idle: 900 }), null);
  assert.strictEqual(
    cpuPercent(parsed.cpu, { user: 130, nice: 0, system: 70, idle: 900 }),
    50
  );

  const now = Date.UTC(2026, 6, 30);
  const retained = pruneHistory([
    { at: now - 8 * 24 * 60 * 60 * 1000 },
    { at: now - 6 * 24 * 60 * 60 * 1000 },
  ], now, 7 * 24 * 60 * 60 * 1000);
  assert.deepStrictEqual(retained, [{ at: now - 6 * 24 * 60 * 60 * 1000 }]);
  assert.strictEqual(pruneHistory([{ sampledAt: 0 }], 0, 7 * 24 * 60 * 60 * 1000).length, 1);

  const publicSnapshot = toPublicSnapshot({
    peer: { password: 'secret' },
    error: 'password=secret',
  });
  assert.strictEqual(JSON.stringify(publicSnapshot).includes('secret'), false);
  [
    ['password: peer-secret', 'peer-secret'],
    ['password=equal-secret', 'equal-secret'],
    ['token: token-secret', 'token-secret'],
    ['secret=secret-value', 'secret-value'],
    ['key: key-value', 'key-value'],
    ['Authorization: Bearer authorization-secret', 'authorization-secret'],
    ['Bearer bearer-secret', 'bearer-secret'],
    ['Cookie: session=cookie-secret', 'cookie-secret'],
    ['Cookie=session=cookie-equals-secret', 'cookie-equals-secret'],
    ['Set-Cookie: session=set-cookie-secret', 'set-cookie-secret'],
    ['cookie=cookie-equals-secret', 'cookie-equals-secret'],
    ['ssh://root:ssh-password@host', 'ssh-password'],
    ['https://root:url-secret@example.test/path', 'url-secret'],
    ['Bearer: bearer-colon-secret', 'bearer-colon-secret'],
    ['bearer=bearer-equals-secret', 'bearer-equals-secret'],
    ['password is phrase-secret', 'phrase-secret'],
    ['password bare-secret', 'bare-secret'],
    ['passphrase: passphrase-secret', 'passphrase-secret'],
    ['credential=credential-secret', 'credential-secret'],
  ].forEach(function (entry) {
    assert.strictEqual(JSON.stringify(toPublicSnapshot({ error: entry[0] })).includes(entry[1]), false);
  });
  assert.deepStrictEqual(toPublicSnapshot({ message: 'service running normally' }), { message: 'service running normally' });

  let calls = 0;
  const collector = createCollector({
    collectOnce: async function () {
      calls += 1;
      return { collected: true };
    },
  });
  const results = await Promise.all([collector.refresh(), collector.refresh()]);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(results, [{ collected: true }, { collected: true }]);

  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-overview-'));
  try {
    const historyPath = path.join(temporaryDir, 'history.json');
    const haConfigPath = path.join(temporaryDir, 'ha.json');
    const fixedNow = Date.UTC(2026, 6, 30);
    fs.writeFileSync(historyPath, JSON.stringify([
      { sampledAt: new Date(fixedNow - 8 * 24 * 60 * 60 * 1000).toISOString() },
      { sampledAt: new Date(fixedNow - 6 * 24 * 60 * 60 * 1000).toISOString() },
    ]), 'utf8');
    fs.writeFileSync(haConfigPath, JSON.stringify({
      selfRole: 'primary',
      primary: { ssh: { host: 'local-host', user: 'root', password: 'local-secret' } },
      standby: { ssh: { host: 'standby-host', user: 'root', password: 'peer-secret' } },
    }), 'utf8');

    const historyWriteEvents = [];
    const tracedFs = {
      readFileSync: fs.readFileSync.bind(fs),
      mkdirSync: fs.mkdirSync.bind(fs),
      writeFileSync: function () {
        historyWriteEvents.push({ type: 'write', path: arguments[0] });
        return fs.writeFileSync.apply(fs, arguments);
      },
      renameSync: function () {
        historyWriteEvents.push({ type: 'rename', from: arguments[0], to: arguments[1] });
        return fs.renameSync.apply(fs, arguments);
      },
    };
    const initialized = createServiceOverview({
      fs: tracedFs,
      path: path,
      historyPath: historyPath,
      haConfigPath: haConfigPath,
      now: function () { return fixedNow; },
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    });
    assert.strictEqual(initialized.getHistory().length, 1);
    const writeEvent = historyWriteEvents.find(function (event) { return event.type === 'write'; });
    const renameEvent = historyWriteEvents.find(function (event) { return event.type === 'rename'; });
    assert.ok(writeEvent.path.startsWith(historyPath + '.tmp-'));
    assert.notStrictEqual(writeEvent.path, historyPath);
    assert.ok(renameEvent);
    assert.strictEqual(renameEvent.from, writeEvent.path);
    assert.strictEqual(renameEvent.to, historyPath);
    assert.ok(historyWriteEvents.indexOf(writeEvent) < historyWriteEvents.indexOf(renameEvent));
    assert.strictEqual(JSON.parse(fs.readFileSync(historyPath, 'utf8')).length, 1);

    const runnerCalls = [];
    const overview = createServiceOverview({
      fs: fs,
      path: path,
      historyPath: path.join(temporaryDir, 'runtime-history.json'),
      haConfigPath: haConfigPath,
      now: function () { return fixedNow; },
      runner: function (_command, context) {
        runnerCalls.push(context);
        if (context.target === 'peer') {
          return Promise.reject(new Error('password: peer-secret; token=peer-token'));
        }
        return Promise.resolve(probeOutput);
      },
    });
    const snapshots = await Promise.all([overview.refresh(), overview.refresh()]);
    const snapshot = snapshots[0];
    assert.strictEqual(runnerCalls.length, 2);
    assert.strictEqual(runnerCalls[1].target, 'peer');
    assert.strictEqual(runnerCalls[1].ssh.host, 'standby-host');
    assert.strictEqual(snapshot.local.services.dcim.healthy, true);
    assert.strictEqual(snapshot.peer.status, 'unknown');
    assert.strictEqual(JSON.stringify(snapshot).includes('peer-secret'), false);
    assert.strictEqual(JSON.stringify(snapshots).includes('peer-token'), false);
    assert.strictEqual(/"password"\s*:/.test(JSON.stringify(overview.getSnapshot())), false);
    assert.strictEqual(/"password"\s*:/.test(JSON.stringify(overview.getHistory())), false);

    for (const mode of ['no-callback', 'no-close']) {
      const clients = [];
      const timeoutOverview = createServiceOverview({
        fs: fs,
        path: path,
        haConfigPath: haConfigPath,
        Client: createTimeoutClient(mode, clients),
        spawn: createSuccessfulSpawn(),
        now: function () { return fixedNow; },
        sshTimeoutMs: 75,
      });
      const startedAt = Date.now();
      const timeoutSnapshot = await timeoutOverview.refresh();
      assert.ok(Date.now() - startedAt <= 150, mode + ' SSH 探针超时必须及时释放');
      assert.strictEqual(timeoutSnapshot.peer.status, 'unknown');
      assert.strictEqual(clients.length, 1);
      assert.strictEqual(clients[0].endCalled, true);
      await timeoutOverview.refresh();
      assert.strictEqual(clients.length, 2, mode + ' 超时后 refresh 必须可重新发起采集');
      assert.strictEqual(clients[1].endCalled, true);
    }
  } finally {
    if (typeof fs.rmSync === 'function') fs.rmSync(temporaryDir, { recursive: true, force: true });
    else fs.rmdirSync(temporaryDir, { recursive: true });
  }

  console.log('service overview core: OK');
}

run().catch(function (err) {
  console.error(err.stack || err);
  process.exitCode = 1;
});
