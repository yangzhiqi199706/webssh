'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const express = require('express');
const {
  mergeDcimVideoConfig,
  publicDcimVideoConfig,
  parseWvpRuntimeProbe,
  wvpRuntimeStatusFromSshResult,
  wvpRuntimeProbeCommand,
} = require('../lib/dcim-wvp');
const { createSshCommandRunner, createWvpRuntimeOperations, registerWvpRuntimeRoutes } = require('../lib/dcim-wvp-runtime');
const runtime = require('../video/assets/js/video-runtime');

function extractServerFunction(name) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  if (start === -1) throw new Error('server.js 未导出可测函数: ' + name);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) {
        return vm.runInNewContext('(' + source.slice(start, index + 1) + ')', { Buffer: Buffer, Date: Date, Math: Math });
      }
    }
  }
  throw new Error('server.js 函数不完整: ' + name);
}

function extractVideoFunction(name) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'video', 'index.html'), 'utf8');
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  if (start === -1) throw new Error('video/index.html 未导出可测函数: ' + name);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error('video/index.html 函数不完整: ' + name);
}

function extractScriptFunction(relativePath, name) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(relativePath + ' 未导出可测函数: ' + name);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return vm.runInNewContext('(' + source.slice(start, index + 1) + ')');
    }
  }
  throw new Error(relativePath + ' 函数不完整: ' + name);
}

function assertDeploymentManifest(entries, label) {
  const requiredFiles = [
    'lib/dcim-wvp.js',
    'lib/dcim-wvp-runtime.js',
    'video/index.html',
    'video/assets/js/video-runtime.js',
    'video/assets/css/style.css',
  ];
  requiredFiles.forEach(function (requiredFile) {
    assert.strictEqual(fs.existsSync(path.join(__dirname, '..', requiredFile)), true, requiredFile + ' 必须存在');
    assert.strictEqual(entries.some(function (entry) {
      return requiredFile === entry || requiredFile.indexOf(entry + '/') === 0;
    }), true, label + ' 必须部署 ' + requiredFile);
  });
}

const createDcimVideoDefaults = extractServerFunction('createDcimVideoDefaults');
const writeDcimVideoConfig = extractServerFunction('writeDcimVideoConfig');
const createDcimVideoSession = extractServerFunction('createDcimVideoSession');
const dcimVideoRequestLabel = extractServerFunction('dcimVideoRequestLabel');
const setupDcimVideoConnectionSource = extractVideoFunction('setupDcimVideoConnection');
const upgradePayloadEntries = extractScriptFunction('scripts/deploy-upgrade.js', 'upgradePayloadEntries');
const protocolMainSyncEntries = extractScriptFunction('scripts/deploy-protocol.js', 'protocolMainSyncEntries');
const createMainSyncDirectorySwap = extractScriptFunction('scripts/deploy-protocol.js', 'createMainSyncDirectorySwap');
const createMainSyncReleasePlan = extractScriptFunction('scripts/deploy-protocol.js', 'createMainSyncReleasePlan');
assertDeploymentManifest(upgradePayloadEntries(), 'deploy-upgrade');
assertDeploymentManifest(protocolMainSyncEntries(), 'deploy-protocol main-sync');
['lib', 'video'].forEach(function (entry) {
  const swap = createMainSyncDirectorySwap('/root/release/main-sync', '/opt/webssh/app', entry, 'test-stamp');
  const source = '/root/release/main-sync/' + entry;
  const target = '/opt/webssh/app/' + entry;
  assert.ok(swap.stage.indexOf('cp -a ' + source + ' ' + swap.staged) !== -1, entry + ' 必须先复制到同级临时目录');
  assert.ok(swap.stage.indexOf('test -f ' + swap.staged + '/') !== -1, entry + ' 必须检查临时目录完整性');
  assert.strictEqual(swap.stage.indexOf('rm -rf ' + target), -1, entry + ' 暂存阶段不得删除旧目录');
  assert.ok(swap.switch.indexOf('mv ' + target + ' ' + swap.backup) !== -1, entry + ' 切换必须保留旧目录');
  assert.ok(swap.switch.indexOf('mv ' + swap.staged + ' ' + target) !== -1, entry + ' 切换必须使用 mv');
  assert.ok(swap.rollback.indexOf('mv ' + swap.backup + ' ' + target) !== -1, entry + ' 失败必须恢复旧目录');
  assert.ok(swap.cleanup.indexOf('rm -rf ' + swap.backup) !== -1, entry + ' 验证成功后才清理旧目录');
  assert.strictEqual(/rm -rf [^;]+ && cp -a [^;]+/.test(swap.stage + ';' + swap.switch), false, entry + ' 不得先删旧目录再复制');
});
const releasePlan = createMainSyncReleasePlan('/opt/webssh/app', 'test-stamp', 'webssh', 3010);
['server.js', 'index.html', 'node_modules', 'lib', 'video'].forEach(function (entry) {
  const target = '/opt/webssh/app/' + entry;
  const backup = releasePlan.backup + '/' + entry;
  assert.ok(releasePlan.backupCommand.indexOf('cp -a ' + target + ' ' + backup) !== -1, entry + ' 必须在主壳更新前备份');
  assert.ok(releasePlan.restoreCommand.indexOf('rm -rf ' + target) !== -1, entry + ' 失败必须移除新内容');
  assert.ok(releasePlan.restoreCommand.indexOf('cp -a ' + backup + ' ' + target) !== -1, entry + ' 失败必须恢复旧内容');
  assert.ok(releasePlan.restoreCommand.indexOf('else rm -rf ' + target) !== -1, entry + ' 原先不存在时恢复后必须保持不存在');
});
assert.deepStrictEqual(Array.prototype.slice.call(releasePlan.recoveryCommands), [
  releasePlan.restoreCommand,
  'systemctl restart webssh',
  'systemctl is-active webssh',
  "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3010/health",
]);
const protocolDeploySource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deploy-protocol.js'), 'utf8');
const releaseBackupIndex = protocolDeploySource.indexOf('await exec(conn, releasePlan.backupCommand);');
const releaseActivationIndex = protocolDeploySource.indexOf('mainSyncRelease = releasePlan;');
assert.ok(releaseBackupIndex !== -1, '完整备份必须先执行');
assert.ok(releaseActivationIndex > releaseBackupIndex, '仅成功完成完整备份后才允许进入回滚路径');
const dcimVideoDefaults = createDcimVideoDefaults();
assert.strictEqual(dcimVideoDefaults.passwordHash, '');
assert.strictEqual(publicDcimVideoConfig(dcimVideoDefaults).hasPasswordHash, false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(publicDcimVideoConfig(dcimVideoDefaults), 'passwordHash'), false);
assert.strictEqual(
  dcimVideoRequestLabel('GET', '/api/user/login?username=test-operator&password=test-only-hash'),
  'GET /api/user/login'
);

const validProbeText = [
  'service.active=active',
  'service.enabled=enabled',
  'legacyService.active=inactive',
  'legacyService.enabled=disabled',
  'listeners.java_wvp=1',
  'listeners.http_18080=1',
  'listeners.sip_5060=1',
  'datasource.postgresDriver=1',
  'datasource.postgresUrl=1',
  'datasource.postgresDialect=1',
  'datasource.mysqlUrl=0',
  'database.wvp_app_connections=1',
  'database.wvp_device_rows=2',
  'database.wvp_channel_rows=3',
  'database.wvp_log_rows=4',
  'logs.db_error_lines=0',
].join('\n');

assert.strictEqual(
  mergeDcimVideoConfig({ password: 'test-password' }, {}).passwordHash,
  'dfb450efddbb5387197c84460623675b'
);
assert.strictEqual(
  mergeDcimVideoConfig({ password: '***' }, { passwordHash: 'old-hash' }).passwordHash,
  'old-hash'
);
assert.deepStrictEqual(
  mergeDcimVideoConfig({}, {}),
  { apiBase: 'https://127.0.0.1:18080', username: '', timeoutMs: 6000 }
);
assert.deepStrictEqual(
  publicDcimVideoConfig(mergeDcimVideoConfig({
    username: 'admin',
    password: 'test-password',
    timeoutMs: 7000,
  }, {})),
  {
    apiBase: 'https://127.0.0.1:18080',
    username: 'admin',
    timeoutMs: 7000,
    hasPasswordHash: true,
  }
);
assert.strictEqual(
  mergeDcimVideoConfig({ password: '' }, { passwordHash: 'old-hash' }).passwordHash,
  'old-hash'
);
assert.throws(
  () => mergeDcimVideoConfig({ apiBase: 'http://127.0.0.1:8082' }, {}),
  /HTTPS/
);
['https://user:secret@host', 'https://host:18080?token=x', 'https://host:18080#x'].forEach((apiBase) => {
  assert.throws(() => mergeDcimVideoConfig({ apiBase }, {}));
});
assert.strictEqual(
  mergeDcimVideoConfig({ apiBase: 'https://host:18443/path' }, {}).apiBase,
  'https://host:18443'
);
assert.throws(() => mergeDcimVideoConfig({ timeoutMs: 999 }, {}), /1000/);
assert.throws(() => mergeDcimVideoConfig({ timeoutMs: 30001 }, {}), /30000/);
assert.strictEqual(mergeDcimVideoConfig({ timeoutMs: 1000 }, {}).timeoutMs, 1000);
assert.strictEqual(mergeDcimVideoConfig({ timeoutMs: 30000 }, {}).timeoutMs, 30000);

const parsed = parseWvpRuntimeProbe(validProbeText);
assert.strictEqual(parsed.status, 'ready');
assert.strictEqual(parsed.ready, true);
assert.strictEqual(parsed.restartAllowed, true);
['service', 'legacyService', 'listeners', 'datasource', 'database', 'logs'].forEach((name) => {
  assert.strictEqual(parsed.checks[name].healthy, true, name + ' should be healthy');
});
assert.strictEqual(JSON.stringify(parsed).includes('password'), false);
assert.strictEqual(
  parseWvpRuntimeProbe(validProbeText.replace('legacyService.active=inactive', 'legacyService.active=active')).restartAllowed,
  false
);
assert.strictEqual(
  parseWvpRuntimeProbe(validProbeText.replace('legacyService.active=inactive', 'legacyService.active=active')).ready,
  false
);
assert.strictEqual(
  parseWvpRuntimeProbe(validProbeText.replace('legacyService.enabled=disabled', 'legacyService.enabled=enabled')).restartAllowed,
  false
);
['activating', 'reloading', 'deactivating', 'failed', 'unknown'].forEach((legacyState) => {
  assert.strictEqual(
    parseWvpRuntimeProbe(validProbeText.replace('legacyService.active=inactive', 'legacyService.active=' + legacyState)).restartAllowed,
    false,
    legacyState + ' must block restart'
  );
});
['enabled', 'static', 'unknown'].forEach((legacyState) => {
  assert.strictEqual(
    parseWvpRuntimeProbe(validProbeText.replace('legacyService.enabled=disabled', 'legacyService.enabled=' + legacyState)).restartAllowed,
    false,
    legacyState + ' must block restart'
  );
});
assert.strictEqual(
  parseWvpRuntimeProbe(validProbeText.replace('listeners.java_wvp=1', 'listeners.java_wvp=0')).checks.listeners.healthy,
  false
);
['0', '2'].forEach((value) => {
  assert.strictEqual(
    parseWvpRuntimeProbe(validProbeText.replace('listeners.java_wvp=1', 'listeners.java_wvp=' + value)).checks.listeners.healthy,
    false
  );
});
assert.strictEqual(parseWvpRuntimeProbe(validProbeText.replace('database.wvp_app_connections=1', 'database.wvp_app_connections=0')).checks.database.healthy, false);
assert.strictEqual(parseWvpRuntimeProbe(validProbeText.replace('database.wvp_device_rows=2', 'database.wvp_device_rows=0')).checks.database.healthy, false);
assert.strictEqual(parseWvpRuntimeProbe(validProbeText.replace('database.wvp_channel_rows=3', 'database.wvp_channel_rows=ERR')).checks.database.healthy, false);
assert.strictEqual(parseWvpRuntimeProbe(validProbeText.replace('database.wvp_log_rows=4', 'database.wvp_log_rows=-1')).checks.database.healthy, false);

const runtimeSuccess = wvpRuntimeStatusFromSshResult({ code: 0, stdout: validProbeText, stderr: '' });
assert.strictEqual(runtimeSuccess.ok, true);
assert.strictEqual(runtimeSuccess.sshCode, 0);
assert.strictEqual(runtimeSuccess.status.ready, true);

const runtimeSshFailure = wvpRuntimeStatusFromSshResult({
  code: -1,
  stdout: validProbeText,
  stderr: 'connection refused password=must-not-leak',
});
assert.strictEqual(runtimeSshFailure.ok, false);
assert.strictEqual(runtimeSshFailure.sshCode, -1);
assert.strictEqual(runtimeSshFailure.status.ready, false);
assert.strictEqual(runtimeSshFailure.status.restartAllowed, false);
assert.strictEqual(runtimeSshFailure.status.status, 'unavailable');
assert.strictEqual(JSON.stringify(runtimeSshFailure).includes('must-not-leak'), false);
['service', 'legacyService', 'listeners', 'datasource', 'database', 'logs'].forEach((name) => {
  assert.strictEqual(runtimeSshFailure.status.checks[name].healthy, false, name + ' should be unavailable');
});

function runtimeOperationStatus(ready, restartAllowed) {
  const coreReady = Boolean(ready);
  return {
    ok: true,
    sshCode: 0,
    status: {
      status: ready ? 'ready' : 'unhealthy',
      ready: Boolean(ready),
      restartAllowed: Boolean(restartAllowed),
      checks: {
        service: { healthy: coreReady, summary: 'service state' },
        legacyService: { healthy: Boolean(restartAllowed), summary: 'legacy state' },
        listeners: { healthy: coreReady, summary: 'listener state' },
        datasource: { healthy: Boolean(ready), summary: 'datasource state' },
        database: { healthy: Boolean(ready), summary: 'database state' },
        logs: { healthy: Boolean(ready), summary: 'log state' },
      },
    },
  };
}

async function runSshCommandTimeoutTests() {
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      FakeClient.last = this;
      this.ended = false;
      this.stream = new EventEmitter();
      this.stream.stderr = new EventEmitter();
      this.stream.closed = false;
      this.stream.close = () => { this.stream.closed = true; };
      this.stream.destroy = () => { this.stream.destroyed = true; };
    }
    connect() { process.nextTick(() => this.emit('ready')); }
    exec(_command, callback) { callback(null, this.stream); }
    end() { this.ended = true; }
  }

  const run = createSshCommandRunner(FakeClient);
  const timeoutError = await new Promise((resolve) => {
    run({ host: 'test', port: 22, username: 'test', password: '', commandTimeoutMs: 5 }, 'probe', (error) => resolve(error));
  });
  assert.strictEqual(timeoutError.code, 'SSH_COMMAND_TIMEOUT');
  assert.strictEqual(timeoutError.message, 'SSH command timed out');
  assert.strictEqual(FakeClient.last.stream.closed, true);
  assert.strictEqual(FakeClient.last.ended, true);
}

async function runSshCommandLateEventTests() {
  class DelayedClient extends EventEmitter {
    constructor() {
      super();
      DelayedClient.instances.push(this);
      this.destroyCalls = 0;
      this.endCalls = 0;
      this.execCalls = 0;
      this.execCallback = null;
    }
    connect() {}
    exec(_command, callback) {
      this.execCalls++;
      this.execCallback = callback;
    }
    destroy() { this.destroyCalls++; }
    end() { this.endCalls++; }
  }
  DelayedClient.instances = [];

  const run = createSshCommandRunner(DelayedClient);
  let readyFirstCallbackCalls = 0;
  run({ host: 'test', port: 22, username: 'test', password: '', commandTimeoutMs: 5 }, 'probe', () => {
    readyFirstCallbackCalls++;
  });
  const readyFirstClient = DelayedClient.instances[0];
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.strictEqual(readyFirstCallbackCalls, 1);
  assert.strictEqual(readyFirstClient.destroyCalls, 1);
  assert.doesNotThrow(() => readyFirstClient.emit('ready'));
  assert.strictEqual(readyFirstClient.execCalls, 0);
  assert.strictEqual(readyFirstCallbackCalls, 1);

  let channelCallbackCalls = 0;
  run({ host: 'test', port: 22, username: 'test', password: '', commandTimeoutMs: 5 }, 'probe', () => {
    channelCallbackCalls++;
  });
  const channelClient = DelayedClient.instances[1];
  channelClient.emit('ready');
  assert.strictEqual(channelClient.execCalls, 1);
  await new Promise((resolve) => setTimeout(resolve, 15));
  const lateChannel = new EventEmitter();
  lateChannel.stderr = new EventEmitter();
  lateChannel.closeCalls = 0;
  lateChannel.destroyCalls = 0;
  lateChannel.close = () => { lateChannel.closeCalls++; };
  lateChannel.destroy = () => { lateChannel.destroyCalls++; };
  assert.doesNotThrow(() => channelClient.execCallback(null, lateChannel));
  assert.strictEqual(channelCallbackCalls, 1);
  assert.strictEqual(channelClient.destroyCalls, 1);
  assert.strictEqual(lateChannel.closeCalls, 1);
  assert.strictEqual(lateChannel.destroyCalls, 1);
}

function requestJson(app, pathname, method, payload) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    function closeAnd(callback) {
      server.close(function () { callback(); });
    }
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () {
      const address = server.address();
      const request = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        path: pathname,
        method: method || 'GET',
        headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      }, function (response) {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', function (chunk) { text += chunk; });
        response.on('end', function () {
          closeAnd(function () {
            let body;
            try { body = JSON.parse(text); } catch (error) { return reject(error); }
            resolve({ statusCode: response.statusCode, body: body });
          });
        });
      });
      request.on('error', function (error) { closeAnd(function () { reject(error); }); });
      request.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
  });
}

function postJson(app, pathname) {
  return requestJson(app, pathname, 'POST');
}

const registerDcimVideoConnectionRoutes = extractServerFunction('registerDcimVideoConnectionRoutes');

async function runDcimVideoConnectionRouteContractTests() {
  const storedConfig = Object.assign(createDcimVideoDefaults(), { passwordHash: 'stored-hash' });
  const routeApp = express();
  routeApp.use(express.json());
  routeApp.get('/api/dcim-video/config', function (_req, res) {
    res.json({ ok: true, data: { preservedProxy: true } });
  });
  registerDcimVideoConnectionRoutes(routeApp, {
    getConfig: function () { return storedConfig; },
    setConfig: function () {},
    writeConfig: function () {},
    resetSession: function () {},
    isAuthed: function () { return true; },
    loginDcim: async function () { return true; },
    wvpUtils: { mergeDcimVideoConfig: mergeDcimVideoConfig, publicDcimVideoConfig: publicDcimVideoConfig },
  });

  const connectionResponse = await requestJson(routeApp, '/api/dcim-video/connection-config', 'GET');
  assert.strictEqual(connectionResponse.statusCode, 200);
  assert.deepStrictEqual(connectionResponse.body, {
    ok: true,
    config: {
      apiBase: 'https://127.0.0.1:18080',
      username: 'admin',
      timeoutMs: 6000,
      hasPasswordHash: true,
    },
  });
  assert.strictEqual(JSON.stringify(connectionResponse.body).includes('stored-hash'), false);

  const legacyConfigResponse = await requestJson(routeApp, '/api/dcim-video/config', 'GET');
  assert.strictEqual(legacyConfigResponse.statusCode, 200);
  assert.deepStrictEqual(legacyConfigResponse.body, { ok: true, data: { preservedProxy: true } });

  let anonymousWrites = 0;
  let anonymousLoginCalls = 0;
  const anonymousApp = express();
  anonymousApp.use(express.json());
  registerDcimVideoConnectionRoutes(anonymousApp, {
    getConfig: function () { return storedConfig; },
    setConfig: function () {},
    writeConfig: function () { anonymousWrites++; },
    resetSession: function () {},
    isAuthed: function () { return false; },
    loginDcim: async function () { anonymousLoginCalls++; return true; },
    wvpUtils: { mergeDcimVideoConfig: mergeDcimVideoConfig, publicDcimVideoConfig: publicDcimVideoConfig },
  });
  const anonymousSave = await requestJson(anonymousApp, '/api/dcim-video/connection-config', 'PUT', {
    password: 'must-not-be-written',
  });
  assert.strictEqual(anonymousSave.statusCode, 401);
  assert.deepStrictEqual(anonymousSave.body, { ok: false, message: '请先登录' });
  const anonymousTest = await requestJson(anonymousApp, '/api/dcim-video/test-login', 'POST');
  assert.strictEqual(anonymousTest.statusCode, 401);
  assert.deepStrictEqual(anonymousTest.body, { ok: false, message: '请先登录' });
  assert.strictEqual(anonymousWrites, 0);
  assert.strictEqual(anonymousLoginCalls, 0);

  const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcim-video-config-'));
  const tempConfigPath = path.join(tempConfigDir, 'dcim-video.json');
  const chmodModes = [];
  const fsSpy = {
    mkdirSync: fs.mkdirSync.bind(fs),
    openSync: fs.openSync.bind(fs),
    writeSync: fs.writeSync.bind(fs),
    fsyncSync: fs.fsyncSync.bind(fs),
    closeSync: fs.closeSync.bind(fs),
    writeFileSync: fs.writeFileSync.bind(fs),
    chmodSync: function (target, mode) {
      chmodModes.push(mode);
      return fs.chmodSync(target, mode);
    },
    renameSync: fs.renameSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
  };
  let savedConfig = Object.assign(createDcimVideoDefaults(), { passwordHash: 'previous-hash' });
  const session = { cachedToken: 'cached-token', lastLoginAt: 123, lastError: 'previous-error' };
  const saveApp = express();
  saveApp.use(express.json());
  registerDcimVideoConnectionRoutes(saveApp, {
    getConfig: function () { return savedConfig; },
    setConfig: function (nextConfig) { savedConfig = nextConfig; },
    writeConfig: function () { writeDcimVideoConfig(tempConfigPath, savedConfig, fsSpy, path); },
    resetSession: function () {
      session.cachedToken = '';
      session.lastLoginAt = 0;
      session.lastError = '';
    },
    isAuthed: function () { return true; },
    loginDcim: async function () { return true; },
    wvpUtils: { mergeDcimVideoConfig: mergeDcimVideoConfig, publicDcimVideoConfig: publicDcimVideoConfig },
  });
  const saved = await requestJson(saveApp, '/api/dcim-video/connection-config', 'PUT', {
    apiBase: 'https://wvp.example.test:18443/path',
    username: 'test-operator',
    password: 'test-only-password',
    timeoutMs: 7000,
  });
  const expectedSavedConfig = mergeDcimVideoConfig({
    apiBase: 'https://wvp.example.test:18443/path',
    username: 'test-operator',
    password: 'test-only-password',
    timeoutMs: 7000,
  }, { passwordHash: 'previous-hash' });
  try {
    assert.strictEqual(saved.statusCode, 200);
    assert.deepStrictEqual(saved.body, { ok: true, config: publicDcimVideoConfig(expectedSavedConfig) });
    assert.strictEqual(JSON.stringify(saved.body).includes(expectedSavedConfig.passwordHash), false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(tempConfigPath, 'utf8')), expectedSavedConfig);
    assert.strictEqual(JSON.parse(fs.readFileSync(tempConfigPath, 'utf8')).password, undefined);
    assert.deepStrictEqual(chmodModes, [0o600]);
    assert.deepStrictEqual(session, { cachedToken: '', lastLoginAt: 0, lastError: '' });
  } finally {
    try { fs.unlinkSync(tempConfigPath); } catch (_e) {}
    try { fs.rmdirSync(tempConfigDir); } catch (_e) {}
  }

  const writeFailurePrevious = Object.assign(createDcimVideoDefaults(), { passwordHash: 'previous-hash' });
  let writeFailureConfig = writeFailurePrevious;
  let writeFailureResets = 0;
  const writeFailureApp = express();
  writeFailureApp.use(express.json());
  registerDcimVideoConnectionRoutes(writeFailureApp, {
    getConfig: function () { return writeFailureConfig; },
    setConfig: function (nextConfig) { writeFailureConfig = nextConfig; },
    writeConfig: function () { throw new Error('test-only-write-error'); },
    resetSession: function () { writeFailureResets++; },
    isAuthed: function () { return true; },
    loginDcim: async function () { return true; },
    wvpUtils: { mergeDcimVideoConfig: mergeDcimVideoConfig, publicDcimVideoConfig: publicDcimVideoConfig },
  });
  const writeFailure = await requestJson(writeFailureApp, '/api/dcim-video/connection-config', 'PUT', {
    password: 'test-only-password',
  });
  assert.strictEqual(writeFailure.statusCode, 500);
  assert.deepStrictEqual(writeFailure.body, { ok: false, message: '无法保存连接配置' });
  assert.deepStrictEqual(writeFailureConfig, writeFailurePrevious);
  assert.strictEqual(writeFailureResets, 0);
  assert.strictEqual(/test-only-write-error|test-only-password/.test(JSON.stringify(writeFailure.body)), false);

  const routeAtomicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcim-video-route-atomic-'));
  const routeAtomicPath = path.join(routeAtomicDir, 'dcim-video.json');
  const routeAtomicOriginal = JSON.stringify({ apiBase: 'https://before.example.test', passwordHash: 'old-hash' }) + '\n';
  fs.writeFileSync(routeAtomicPath, routeAtomicOriginal, 'utf8');
  const routeAtomicPrevious = Object.assign(createDcimVideoDefaults(), { passwordHash: 'old-hash' });
  let routeAtomicConfig = routeAtomicPrevious;
  const routeAtomicApp = express();
  routeAtomicApp.use(express.json());
  registerDcimVideoConnectionRoutes(routeAtomicApp, {
    getConfig: function () { return routeAtomicConfig; },
    setConfig: function (nextConfig) { routeAtomicConfig = nextConfig; },
    writeConfig: function () {
      writeDcimVideoConfig(routeAtomicPath, routeAtomicConfig, createAtomicWriteFs({
        renameSync: function () { throw new Error('test-only-route-rename-failure'); },
      }), path, 'route-rename-failure');
    },
    resetSession: function () { throw new Error('失败保存不得清理会话'); },
    isAuthed: function () { return true; },
    loginDcim: async function () { return true; },
    wvpUtils: { mergeDcimVideoConfig: mergeDcimVideoConfig, publicDcimVideoConfig: publicDcimVideoConfig },
  });
  try {
    const routeAtomicFailure = await requestJson(routeAtomicApp, '/api/dcim-video/connection-config', 'PUT', {
      username: 'new-test-operator',
    });
    assert.strictEqual(routeAtomicFailure.statusCode, 500);
    assert.deepStrictEqual(routeAtomicFailure.body, { ok: false, message: '无法保存连接配置' });
    assert.deepStrictEqual(routeAtomicConfig, routeAtomicPrevious);
    assert.strictEqual(fs.readFileSync(routeAtomicPath, 'utf8'), routeAtomicOriginal);
    assertNoAtomicTempFiles(routeAtomicDir, 'dcim-video.json');
  } finally {
    try { fs.unlinkSync(routeAtomicPath); } catch (_e) {}
    try { fs.rmdirSync(routeAtomicDir); } catch (_e) {}
  }

  let failedLoginCalls = 0;
  const failedLoginApp = express();
  failedLoginApp.use(express.json());
  registerDcimVideoConnectionRoutes(failedLoginApp, {
    getConfig: function () { return storedConfig; },
    setConfig: function () {},
    writeConfig: function () {},
    resetSession: function () {},
    isAuthed: function () { return true; },
    loginDcim: async function () {
      failedLoginCalls++;
      throw new Error('upstream-body accessToken=test-only-token');
    },
    wvpUtils: { mergeDcimVideoConfig: mergeDcimVideoConfig, publicDcimVideoConfig: publicDcimVideoConfig },
  });
  const failedLogin = await requestJson(failedLoginApp, '/api/dcim-video/test-login', 'POST');
  assert.strictEqual(failedLoginCalls, 1);
  assert.strictEqual(failedLogin.statusCode, 502);
  assert.deepStrictEqual(failedLogin.body, {
    ok: false,
    status: 502,
    message: 'WVP 登录失败，请检查账号或密码',
  });
  assert.strictEqual(/accessToken|test-only-token|upstream-body/.test(JSON.stringify(failedLogin.body)), false);
}

async function runDcimVideoConnectionRaceTests() {
  const session = createDcimVideoSession();
  let currentConfig = Object.assign(createDcimVideoDefaults(), { passwordHash: 'old-hash' });
  let startLogin;
  const loginStarted = new Promise(function (resolve) { startLogin = resolve; });
  let releaseLogin;
  const loginRelease = new Promise(function (resolve) { releaseLogin = resolve; });
  const raceApp = express();
  raceApp.use(express.json());
  registerDcimVideoConnectionRoutes(raceApp, {
    getConfig: function () { return currentConfig; },
    setConfig: function (nextConfig) { currentConfig = nextConfig; },
    writeConfig: function () {},
    resetSession: function () { session.reset(); },
    isAuthed: function () { return true; },
    loginDcim: async function () {
      const generation = session.generation();
      startLogin();
      await loginRelease;
      return session.acceptLogin(generation, 'test-only-stale-token', 123);
    },
    wvpUtils: { mergeDcimVideoConfig: mergeDcimVideoConfig, publicDcimVideoConfig: publicDcimVideoConfig },
  });

  const oldLoginRequest = requestJson(raceApp, '/api/dcim-video/test-login', 'POST');
  await loginStarted;
  const saveResponse = await requestJson(raceApp, '/api/dcim-video/connection-config', 'PUT', {
    username: 'new-test-operator',
  });
  assert.strictEqual(saveResponse.statusCode, 200);
  releaseLogin();
  const oldLoginResponse = await oldLoginRequest;
  assert.strictEqual(oldLoginResponse.statusCode, 502);
  assert.deepStrictEqual(oldLoginResponse.body, {
    ok: false,
    status: 502,
    message: 'WVP 登录失败，请检查账号或密码',
  });
  assert.strictEqual(session.token(), '');
  assert.strictEqual(session.lastLoginAt(), 0);
  assert.strictEqual(session.lastError(), '');
  assert.strictEqual(session.generation(), 1);
}

function createAtomicWriteFs(overrides) {
  return Object.assign({
    mkdirSync: fs.mkdirSync.bind(fs),
    openSync: fs.openSync.bind(fs),
    writeFileSync: fs.writeFileSync.bind(fs),
    writeSync: fs.writeSync.bind(fs),
    fsyncSync: fs.fsyncSync.bind(fs),
    closeSync: fs.closeSync.bind(fs),
    chmodSync: fs.chmodSync.bind(fs),
    renameSync: fs.renameSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
  }, overrides || {});
}

function assertNoAtomicTempFiles(dir, fileName) {
  assert.deepStrictEqual(fs.readdirSync(dir).filter(function (name) {
    return name.indexOf(fileName + '.tmp-') === 0;
  }), []);
}

function runDcimVideoAtomicWriteTests() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcim-video-atomic-'));
  const configPath = path.join(tempDir, 'dcim-video.json');
  const originalConfig = JSON.stringify({ apiBase: 'https://before.example.test', passwordHash: 'old-hash' }) + '\n';
  const nextConfig = { apiBase: 'https://after.example.test', passwordHash: 'new-hash' };
  fs.writeFileSync(configPath, originalConfig, 'utf8');
  try {
    const renameFailFs = createAtomicWriteFs({
      renameSync: function () { throw new Error('test-only-rename-failure'); },
    });
    assert.throws(function () {
      writeDcimVideoConfig(configPath, nextConfig, renameFailFs, path, 'rename-failure');
    }, /test-only-rename-failure/);
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), originalConfig);
    assertNoAtomicTempFiles(tempDir, 'dcim-video.json');

    const collisionPath = path.join(tempDir, 'dcim-video.json.tmp-collision');
    fs.writeFileSync(collisionPath, 'other-writer-temp', 'utf8');
    const collisionFs = createAtomicWriteFs({
      openSync: function () {
        const error = new Error('test-only-open-collision');
        error.code = 'EEXIST';
        throw error;
      },
    });
    assert.throws(function () {
      writeDcimVideoConfig(configPath, nextConfig, collisionFs, path, 'collision');
    }, /test-only-open-collision/);
    assert.strictEqual(fs.readFileSync(collisionPath, 'utf8'), 'other-writer-temp');
    fs.unlinkSync(collisionPath);

    const openModes = [];
    const chmodModes = [];
    let fsyncCalls = 0;
    const successFs = createAtomicWriteFs({
      openSync: function (target, flags, mode) {
        openModes.push({ target: target, flags: flags, mode: mode });
        return fs.openSync(target, flags, mode);
      },
      fsyncSync: function (fd) {
        fsyncCalls++;
        return fs.fsyncSync(fd);
      },
      chmodSync: function (target, mode) {
        chmodModes.push({ target: target, mode: mode });
        return fs.chmodSync(target, mode);
      },
    });
    writeDcimVideoConfig(configPath, nextConfig, successFs, path, 'success');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), nextConfig);
    assert.deepStrictEqual(openModes.map(function (entry) { return entry.flags; }), ['wx']);
    assert.deepStrictEqual(openModes.map(function (entry) { return entry.mode; }), [0o600]);
    assert.deepStrictEqual(chmodModes.map(function (entry) { return entry.mode; }), [0o600]);
    assert.strictEqual(fsyncCalls, 1);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(configPath).mode & 0o777, 0o600);
    assertNoAtomicTempFiles(tempDir, 'dcim-video.json');

    fs.writeFileSync(configPath, originalConfig, 'utf8');
    const writeFailFs = createAtomicWriteFs({
      writeSync: function () { throw new Error('test-only-write-failure'); },
    });
    assert.throws(function () {
      writeDcimVideoConfig(configPath, nextConfig, writeFailFs, path, 'write-failure');
    }, /test-only-write-failure/);
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), originalConfig);
    assertNoAtomicTempFiles(tempDir, 'dcim-video.json');

    const chmodFailFs = createAtomicWriteFs({
      chmodSync: function () { throw new Error('test-only-chmod-failure'); },
    });
    assert.throws(function () {
      writeDcimVideoConfig(configPath, nextConfig, chmodFailFs, path, 'chmod-failure');
    }, /test-only-chmod-failure/);
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), originalConfig);
    assertNoAtomicTempFiles(tempDir, 'dcim-video.json');
  } finally {
    try { fs.unlinkSync(configPath); } catch (_e) {}
    try { fs.rmdirSync(tempDir); } catch (_e) {}
  }
}

function createFakeElement() {
  const listeners = {};
  const classes = {};
  return {
    value: '',
    textContent: '',
    placeholder: '',
    disabled: false,
    hidden: false,
    attributes: {},
    classList: {
      add: function (name) { classes[name] = true; },
      remove: function (name) { delete classes[name]; },
      contains: function (name) { return Boolean(classes[name]); },
    },
    addEventListener: function (name, handler) { listeners[name] = handler; },
    setAttribute: function (name, value) { this.attributes[name] = String(value); },
    focus: function () {},
    trigger: function (name, event) {
      return listeners[name](Object.assign({ target: this, preventDefault: function () {} }, event || {}));
    },
  };
}

async function runDcimVideoConnectionUiTests() {
  const elementIds = [
    'btnDcimConnection', 'dcimConnectionModal', 'btnDcimConnectionClose',
    'dcimConnectionApiBase', 'dcimConnectionUsername', 'dcimConnectionPassword',
    'dcimConnectionTimeout', 'btnDcimConnectionTest', 'btnDcimConnectionSave',
    'dcimConnectionHint',
  ];
  const elements = {};
  elementIds.forEach(function (id) { elements[id] = createFakeElement(); });
  const calls = [];
  let configStatus = 200;
  const context = {
    $: function (id) { return elements[id]; },
    document: { addEventListener: function () {} },
    fetch: function (url, options) {
      const request = { url: url, options: options || {} };
      calls.push(request);
      const method = request.options.method;
      if (url === '/api/dcim-video/connection-config' && method === 'GET') {
        if (configStatus === 401) {
          return Promise.resolve({ status: 401, json: async function () { return { ok: false }; } });
        }
        return Promise.resolve({
          status: 200,
          json: async function () {
            return {
              ok: true,
              config: {
                apiBase: 'https://wvp.example.test:18443',
                username: 'test-operator',
                timeoutMs: 7000,
                hasPasswordHash: true,
                passwordHash: 'test-only-hash-must-not-render',
              },
            };
          },
        });
      }
      if (url === '/api/dcim-video/connection-config' && method === 'PUT') {
        return Promise.resolve({ status: 200, json: async function () { return { ok: true, config: {} }; } });
      }
      if (url === '/api/dcim-video/test-login' && method === 'POST') {
        return Promise.resolve({
          status: 502,
          json: async function () {
            return { ok: false, message: 'upstream-body accessToken=test-only-token', data: { accessToken: 'test-only-token' } };
          },
        });
      }
      throw new Error('意外请求: ' + method + ' ' + url);
    },
  };
  vm.runInNewContext('(' + setupDcimVideoConnectionSource + ')()', context);
  const flush = function () { return new Promise(function (resolve) { setImmediate(resolve); }); };

  elements.btnDcimConnection.trigger('click');
  await flush();
  await flush();
  assert.strictEqual(elements.dcimConnectionModal.classList.contains('open'), true);
  assert.strictEqual(elements.dcimConnectionModal.attributes['aria-hidden'], 'false');
  assert.strictEqual(calls[0].url, '/api/dcim-video/connection-config');
  assert.strictEqual(calls[0].options.method, 'GET');
  assert.strictEqual(elements.dcimConnectionApiBase.value, 'https://wvp.example.test:18443');
  assert.strictEqual(elements.dcimConnectionUsername.value, 'test-operator');
  assert.strictEqual(elements.dcimConnectionTimeout.value, '7000');
  assert.strictEqual(elements.dcimConnectionPassword.value, '');
  assert.ok(elements.dcimConnectionPassword.placeholder.indexOf('已配置') !== -1);
  assert.strictEqual(JSON.stringify(elements).includes('test-only-hash-must-not-render'), false);

  elements.dcimConnectionPassword.value = '';
  elements.btnDcimConnectionSave.trigger('click');
  await flush();
  await flush();
  const saveCall = calls.find(function (call) { return call.options.method === 'PUT'; });
  assert.ok(saveCall);
  assert.strictEqual(saveCall.url, '/api/dcim-video/connection-config');
  const savedBody = JSON.parse(saveCall.options.body);
  assert.deepStrictEqual(Object.keys(savedBody).sort(), ['apiBase', 'timeoutMs', 'username']);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(savedBody, 'password'), false);

  elements.btnDcimConnectionTest.trigger('click');
  await flush();
  await flush();
  const testLoginCall = calls.find(function (call) { return call.url === '/api/dcim-video/test-login'; });
  assert.ok(testLoginCall);
  assert.strictEqual(testLoginCall.options.method, 'POST');
  assert.strictEqual(elements.dcimConnectionHint.textContent, 'WVP 登录失败，请检查账号或密码');
  assert.strictEqual(/accessToken|test-only-token|upstream-body/.test(JSON.stringify(elements)), false);

  configStatus = 401;
  elements.btnDcimConnection.trigger('click');
  await flush();
  await flush();
  assert.strictEqual(elements.dcimConnectionHint.textContent, '登录已过期，请重新登录');
  assert.strictEqual(elements.btnDcimConnectionTest.disabled, false);
  assert.strictEqual(elements.btnDcimConnectionSave.disabled, false);

  elements.btnDcimConnectionClose.trigger('click');
  assert.strictEqual(elements.dcimConnectionModal.classList.contains('open'), false);
  assert.strictEqual(elements.dcimConnectionModal.attributes['aria-hidden'], 'true');
}

async function runWvpRuntimeRouteContractTests() {
  let anonymousControllerCalls = 0;
  const anonymousApp = express();
  registerWvpRuntimeRoutes(anonymousApp, {
    runtimeOperations: {
      readStatus: async () => { throw new Error('匿名请求不得读取状态'); },
      restart: async () => { anonymousControllerCalls++; throw new Error('匿名请求不得重启'); },
    },
    isAuthed: () => false,
    appendLog: () => {},
    runtimeSummary: () => '',
  });
  const anonymousResponse = await postJson(anonymousApp, '/api/db-manager/opengauss/wvp/restart');
  assert.strictEqual(anonymousResponse.statusCode, 401);
  assert.deepStrictEqual(anonymousResponse.body, { ok: false, message: '请先登录' });
  assert.strictEqual(anonymousControllerCalls, 0);

  let timeoutRestartCalls = 0;
  let timeoutSleepCalls = 0;
  const timeoutOperations = createWvpRuntimeOperations({
    collect: async () => ({ code: 124 }),
    restartService: async () => { timeoutRestartCalls++; return { code: 0 }; },
    sleep: async () => { timeoutSleepCalls++; },
  });
  const timeoutApp = express();
  registerWvpRuntimeRoutes(timeoutApp, {
    runtimeOperations: timeoutOperations,
    isAuthed: () => true,
    appendLog: () => {},
    runtimeSummary: () => '',
  });
  const timeoutResponse = await postJson(timeoutApp, '/api/db-manager/opengauss/wvp/restart');
  assert.strictEqual(timeoutResponse.statusCode, 504);
  assert.strictEqual(timeoutResponse.body.ok, false);
  assert.strictEqual(timeoutResponse.body.restartCode, -1);
  assert.strictEqual(timeoutResponse.body.statusCode, 504);
  assert.strictEqual(timeoutRestartCalls, 0);
  assert.strictEqual(timeoutSleepCalls, 0);
}

async function runWvpRuntimeOperationTests() {
  let legacyRestartCalls = 0;
  const legacyActiveRuntime = runtimeOperationStatus(false, false);
  legacyActiveRuntime.status.checks.legacyService.summary = 'legacy active';
  const legacyOps = createWvpRuntimeOperations({
    collect: async () => legacyActiveRuntime,
    restartService: async () => { legacyRestartCalls++; return { code: 0 }; },
    sleep: async () => { throw new Error('legacy conflict must not poll'); },
  });
  const legacyResult = await legacyOps.restart();
  assert.strictEqual(legacyResult.statusCode, 409);
  assert.strictEqual(legacyResult.ok, false);
  assert.strictEqual(legacyResult.status.restartAllowed, false);
  assert.strictEqual(legacyRestartCalls, 0);

  const restartCommands = [];
  const allowedOps = createWvpRuntimeOperations({
    collect: async () => runtimeOperationStatus(true, true),
    restartService: async (command) => { restartCommands.push(command); return { code: 0 }; },
    sleep: async () => {},
  });
  const allowedResult = await allowedOps.restart();
  assert.strictEqual(allowedResult.ok, true);
  assert.strictEqual(restartCommands.length, 1);
  assert.ok(/systemctl is-active wvp-pro\.service/.test(restartCommands[0]));
  assert.ok(/systemctl is-enabled wvp-pro\.service/.test(restartCommands[0]));
  assert.ok(/legacy_active.*inactive/.test(restartCommands[0]));
  assert.ok(/legacy_enabled.*disabled/.test(restartCommands[0]));
  assert.ok(/systemctl restart wvp-opengauss\.service 2>&1/.test(restartCommands[0]));
  assert.strictEqual(/systemctl restart wvp-pro\.service/.test(restartCommands[0]), false);

  const atomicConflictOps = createWvpRuntimeOperations({
    collect: async () => runtimeOperationStatus(true, true),
    restartService: async () => ({ code: 75, stdout: 'legacy active' }),
    sleep: async () => { throw new Error('atomic conflict must not poll'); },
  });
  const atomicConflictResult = await atomicConflictOps.restart();
  assert.strictEqual(atomicConflictResult.statusCode, 409);
  assert.strictEqual(atomicConflictResult.ok, false);
  assert.strictEqual(atomicConflictResult.restartCode, 75);
  assert.strictEqual(atomicConflictResult.status.restartAllowed, false);

  const pollSequence = [runtimeOperationStatus(false, true), runtimeOperationStatus(false, true), runtimeOperationStatus(true, true)];
  let pollCollectCalls = 0;
  let pollSleepCalls = 0;
  const pollingOps = createWvpRuntimeOperations({
    collect: async () => pollSequence[pollCollectCalls++] || runtimeOperationStatus(true, true),
    restartService: async () => ({ code: 0 }),
    sleep: async () => { pollSleepCalls++; },
  });
  const pollingResult = await pollingOps.restart();
  assert.strictEqual(pollingResult.ok, true);
  assert.strictEqual(pollCollectCalls, 3);
  assert.strictEqual(pollSleepCalls, 2);
  assert.ok(pollSleepCalls <= 15);

  let timeoutCollectCalls = 0;
  let timeoutSleepCalls = 0;
  const timeoutOps = createWvpRuntimeOperations({
    collect: async () => { timeoutCollectCalls++; return runtimeOperationStatus(false, true); },
    restartService: async () => ({ code: 0 }),
    sleep: async () => { timeoutSleepCalls++; },
  });
  const timeoutResult = await timeoutOps.restart();
  assert.strictEqual(timeoutResult.ok, false);
  assert.strictEqual(timeoutCollectCalls, 16);
  assert.strictEqual(timeoutSleepCalls, 15);

  const unsafeFailure = {
    ok: false, sshCode: -1, stdout: 'secret stdout', stderr: 'password stderr',
    command: 'wvp-pro.service', raw: 'raw', password: 'password', secret: 'secret',
    status: Object.assign(runtimeOperationStatus(false, false).status, {
      summary: 'secret',
      checks: { service: { healthy: false, summary: 'password secret' } },
    }),
  };
  let failureCollectCalls = 0;
  const failureOps = createWvpRuntimeOperations({
    collect: async () => failureCollectCalls++ === 0 ? runtimeOperationStatus(false, true) : unsafeFailure,
    restartService: async () => ({ code: 2, stdout: 'secret', stderr: 'password', command: 'raw' }),
    sleep: async () => { throw new Error('failed restart must not poll'); },
  });
  const failureResult = await failureOps.restart();
  assert.strictEqual(failureResult.ok, false);
  assert.strictEqual(failureResult.restartCode, 2);
  assert.strictEqual(failureResult.statusCode, 503);
  assert.strictEqual(/stdout|stderr|command|raw|password|secret/i.test(JSON.stringify(failureResult)), false);

  let genericFailureCollectCalls = 0;
  const genericFailureOps = createWvpRuntimeOperations({
    collect: async () => genericFailureCollectCalls++ === 0 ? runtimeOperationStatus(true, true) : runtimeOperationStatus(false, true),
    restartService: async () => ({ code: 2 }),
    sleep: async () => { throw new Error('普通失败不得轮询'); },
  });
  const genericFailureResult = await genericFailureOps.restart();
  assert.strictEqual(genericFailureResult.ok, false);
  assert.strictEqual(genericFailureResult.restartCode, 2);
  assert.strictEqual(genericFailureResult.statusCode, 502);
  assert.strictEqual(genericFailureResult.status.checks.service.healthy, false);

  const collectTimeoutOps = createWvpRuntimeOperations({
    timeoutMs: 5,
    collect: async () => Object.assign(runtimeOperationStatus(false, true), { timedOut: true }),
    restartService: async () => ({ code: 0 }),
    sleep: async () => {},
  });
  const collectTimeoutStatus = await collectTimeoutOps.readStatus();
  assert.strictEqual(collectTimeoutStatus.status.status, 'unavailable');
  assert.strictEqual(collectTimeoutStatus.status.ready, false);
  const collectTimeoutRestart = await collectTimeoutOps.restart();
  assert.strictEqual(collectTimeoutRestart.statusCode, 504);
  assert.strictEqual(collectTimeoutRestart.ok, false);

  const restartTimeoutOps = createWvpRuntimeOperations({
    timeoutMs: 5,
    collect: async () => runtimeOperationStatus(true, true),
    restartService: async () => ({ code: -1, timedOut: true }),
    sleep: async () => {},
  });
  const restartTimeoutResult = await restartTimeoutOps.restart();
  assert.strictEqual(restartTimeoutResult.statusCode, 504);
  assert.strictEqual(restartTimeoutResult.ok, false);
  assert.strictEqual(restartTimeoutResult.status.status, 'unavailable');

  let pollTimeoutCollectCalls = 0;
  const pollTimeoutOps = createWvpRuntimeOperations({
    timeoutMs: 5,
    collect: async () => pollTimeoutCollectCalls++ === 0 ? runtimeOperationStatus(false, true) : Object.assign(runtimeOperationStatus(false, true), { timedOut: true }),
    restartService: async () => ({ code: 0 }),
    sleep: async () => {},
  });
  const pollTimeoutResult = await pollTimeoutOps.restart();
  assert.strictEqual(pollTimeoutResult.statusCode, 504);
  assert.strictEqual(pollTimeoutResult.ok, false);

  let probeTimeoutRestartCalls = 0;
  let probeTimeoutSleepCalls = 0;
  const probeTimeoutOps = createWvpRuntimeOperations({
    collect: async () => Object.assign(runtimeOperationStatus(false, true), { timedOut: true }),
    restartService: async () => { probeTimeoutRestartCalls++; return { code: 0 }; },
    sleep: async () => { probeTimeoutSleepCalls++; },
  });
  const probeTimeoutResult = await probeTimeoutOps.restart();
  assert.strictEqual(probeTimeoutResult.statusCode, 504);
  assert.strictEqual(probeTimeoutResult.ok, false);
  assert.strictEqual(probeTimeoutRestartCalls, 0);
  assert.strictEqual(probeTimeoutSleepCalls, 0);

  const sshUnavailable = runtimeOperationStatus(false, false);
  sshUnavailable.ok = false;
  sshUnavailable.sshCode = -1;
  const sshUnavailableResult = await createWvpRuntimeOperations({
    collect: async () => sshUnavailable,
    restartService: async () => { throw new Error('SSH 不可用时不得重启'); },
    sleep: async () => { throw new Error('SSH 不可用时不得轮询'); },
  }).restart();
  assert.strictEqual(sshUnavailableResult.statusCode, 503);
  assert.strictEqual(sshUnavailableResult.restartCode, -1);

  let clock = 0;
  const collectTimeouts = [];
  const deadlineSleepCalls = [];
  const deadlineResult = await createWvpRuntimeOperations({
    timeoutMs: 1200,
    restartDeadlineMs: 2500,
    now: () => clock,
    collect: async (options) => {
      collectTimeouts.push(options.timeoutMs);
      return runtimeOperationStatus(false, true);
    },
    restartService: async (_command, options) => {
      assert.strictEqual(options.timeoutMs, 1200);
      return { code: 0 };
    },
    sleep: async (ms) => { deadlineSleepCalls.push(ms); clock += ms; },
  }).restart();
  assert.strictEqual(deadlineResult.statusCode, 504);
  assert.strictEqual(deadlineResult.ok, false);
  assert.deepStrictEqual(collectTimeouts, [1200, 1200, 500]);
  assert.deepStrictEqual(deadlineSleepCalls, [1000, 1000, 500]);
}

[
  ['service', ['service.active', 'service.enabled']],
  ['legacyService', ['legacyService.active', 'legacyService.enabled']],
  ['listeners', ['listeners.java_wvp', 'listeners.http_18080', 'listeners.sip_5060']],
  ['datasource', ['datasource.postgresDriver', 'datasource.postgresUrl', 'datasource.postgresDialect', 'datasource.mysqlUrl']],
  ['database', ['database.wvp_app_connections', 'database.wvp_device_rows', 'database.wvp_channel_rows', 'database.wvp_log_rows']],
  ['logs', ['logs.db_error_lines']],
].forEach(([checkName, keys]) => {
  keys.forEach((missingKey) => {
    const missing = validProbeText.split('\n').filter((line) => line.indexOf(missingKey + '=') !== 0).join('\n');
    assert.strictEqual(parseWvpRuntimeProbe(missing).checks[checkName].healthy, false, missingKey);
  });
});
assert.strictEqual(runtime.validatePlaybackRange('', '').ok, false);
assert.strictEqual(runtime.validatePlaybackRange('2026-07-13T12:10', '2026-07-13T12:00').ok, false);
assert.strictEqual(runtime.validatePlaybackRange('2026-07-13T00:00', '2026-07-14T00:00:01').ok, false);
assert.strictEqual(runtime.validatePlaybackRange('2026-02-30T10:00', '2026-02-30T10:10').ok, false);
assert.deepStrictEqual(
  runtime.validatePlaybackRange('2026-07-13T12:00', '2026-07-13T12:10'),
  { ok: true, startTime: '2026-07-13T12:00', endTime: '2026-07-13T12:10' }
);
assert.strictEqual(runtime.validatePlaybackRange('2026-07-13T12:00:00', '2026-07-13T12:10:30').ok, true);

assert.strictEqual(
  runtime.stopPath('dcim source/1', 'live', 'device 1', 'channel/1', ''),
  '/api/dcim%20source%2F1-video/play/stop/device%201/channel%2F1'
);
assert.strictEqual(
  runtime.stopPath('webssh', 'live', 'device 1', 'channel/1', ''),
  '/api/webssh-video/play/stop/device%201/channel%2F1'
);
assert.strictEqual(
  runtime.stopPath('dcim source/1', 'playback', '', '', 'device 1/channel 1'),
  '/api/dcim%20source%2F1-video/playback/stop/device%201%2Fchannel%201'
);
assert.strictEqual(
  runtime.stopPath('webssh', 'playback', '', '', 'device 1/channel 1'),
  '/api/webssh-video/playback/stop/device%201%2Fchannel%201'
);

const browser = { window: {} };
vm.runInNewContext(require('fs').readFileSync(require.resolve('../video/assets/js/video-runtime'), 'utf8'), browser);
assert.strictEqual(typeof browser.window.DcimVideoRuntime.validatePlaybackRange, 'function');
assert.strictEqual(typeof browser.window.DcimVideoRuntime.stopPath, 'function');

const dbPage = fs.readFileSync(path.join(__dirname, '..', 'db', 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dcim-wvp-runtime.js'), 'utf8');
assert.strictEqual(/async function withTimeout\(/.test(runtimeSource), false, 'WVP 编排不得只用 Promise.race 宣告超时');
assert.ok(
  /const runSshCommand = createSshCommandRunner\(Client\);[\s\S]*?function sshExecCommand\(cfg, cmd, callback\) \{\s*return runSshCommand\(cfg, cmd, callback\);\s*\}/.test(serverSource),
  'SSH 命令必须委托给可取消的受控执行器'
);
assert.ok(
  /function sshRun\(cmd, options\) \{[\s\S]*?const timeoutMs = Number\(options && options\.timeoutMs\);[\s\S]*?commandTimeoutMs: Number\.isFinite\(timeoutMs\)/.test(serverSource),
  'SSH 运行器必须把调用方超时传给命令执行层'
);
assert.ok(
  /async function collectWvpRuntimeStatus\(options\) \{[\s\S]*?sshRun\(runInContainerCmd\(cfg\.container, probe\), options\)/.test(serverSource),
  'WVP 状态探测必须使用受控 SSH 超时'
);
assert.ok(
  /restartService: \(command, options\) => sshRun\(runInContainerCmd\(cfg\.container,[\s\S]*?\), options\)/.test(serverSource),
  'WVP 重启必须使用受控 SSH 超时'
);
assert.ok(/function openWvpRuntimeModal\(\)\s*\{[\s\S]*?renderWvpRuntimeStatus\(null\);/.test(dbPage));
assert.ok(/renderWvpRuntimeStatus\(r\.ok \? r\.status : \(r\.status \|\| null\)\);/.test(dbPage));
const loadWvpRuntimeStatusSource = /async function loadWvpRuntimeStatus\(\) \{([\s\S]*?)\n    \}\n\n    function wvpRestartFeedback/.exec(dbPage);
assert.ok(loadWvpRuntimeStatusSource);
assert.ok(/catch \(_e\) \{\s*renderWvpRuntimeStatus\(null\);[\s\S]*?状态不可用/.test(loadWvpRuntimeStatusSource[1]));
const feedbackStart = dbPage.indexOf('function wvpRestartFeedback(result)');
const feedbackEnd = dbPage.indexOf('// WVP_RESTART_FEEDBACK_END');
assert.ok(feedbackStart !== -1 && feedbackEnd > feedbackStart);
const feedbackContext = {};
vm.runInNewContext(dbPage.slice(feedbackStart, feedbackEnd) + '\nthis.applyWvpRestartFeedback = applyWvpRestartFeedback;', feedbackContext);
const feedbackBox = { innerHTML: '' };
const expiredFeedback = feedbackContext.applyWvpRestartFeedback(feedbackBox, { ok: false, message: '请先登录' });
assert.strictEqual(expiredFeedback.success, false);
assert.strictEqual(expiredFeedback.message, '登录已过期，请重新登录');
assert.ok(/登录已过期，请重新登录/.test(feedbackBox.innerHTML));
assert.strictEqual(/旧服务冲突|状态不可用/.test(feedbackBox.innerHTML), false);
assert.strictEqual(feedbackContext.wvpRestartFeedback({ ok: false, restartCode: 75 }).message, '旧服务冲突，未执行重启。');
assert.strictEqual(feedbackContext.wvpRestartFeedback({ ok: false, statusCode: 504 }).message, '探测超时，未继续轮询。');
assert.strictEqual(feedbackContext.wvpRestartFeedback({ ok: false, statusCode: 503 }).message, '状态不可用，未执行重启。');
assert.strictEqual(/r\.restartCode === null \|\| r\.restartCode === 75/.test(dbPage), false);

const command = wvpRuntimeProbeCommand();
assert.ok(/service\.active=/.test(command));
assert.ok(/listeners\.java_wvp=/.test(command));
assert.ok(/listeners\.http_18080=/.test(command));
assert.ok(/listeners\.sip_5060=/.test(command));
assert.ok(/datasource\.postgresDriver=/.test(command));
assert.ok(/database\.wvp_app_connections=/.test(command));
assert.ok(/logs\.db_error_lines=/.test(command));
assert.ok(/jdbc:postgresql:\/\/127\.0\.0\.1:5432\/dcim/.test(command));
assert.ok(/:5060\(\[\[:space:\]\]\|\$\)/.test(command));
assert.ok(/:18080\(\[\[:space:\]\]\|\$\)/.test(command));
assert.ok(/wvp-opengauss\.service/.test(command));
assert.ok(!/pgrep -af 'java\.\*wvp'/.test(command));
assert.ok(/ps -eo args/.test(command));
assert.ok(/\[w\]vp-pro-2\.6\.9-06021439\.jar/.test(command));
assert.ok(/grep -c/.test(command));
assert.ok(/awk/.test(command));
assert.ok(!/\$\(\s*\(/.test(command));
assert.ok(/journalctl -u wvp-opengauss\.service --since '10 min ago'/.test(command));
assert.ok(/journalctl_status/.test(command));
assert.ok(/logs\.db_error_lines=-1/.test(command));
assert.ok(/omm|gsql/.test(command));
assert.ok(/\/www\/media\/wvp-GB28181-pro\/target\/classes\/application-dev\.yml/.test(command));
assert.ok(!/\/opt\/wvp\/config/.test(command));
assert.ok(/export GAUSSHOME=/.test(command));
assert.ok(/export PATH=\$GAUSSHOME\/bin:\$PATH/.test(command));
assert.ok(/export LD_LIBRARY_PATH=\$GAUSSHOME\/lib:\$LD_LIBRARY_PATH/.test(command));
assert.ok(/gsql -d dcim/.test(command));
assert.ok(/usename=.*wvp_app/.test(command));
assert.ok(/datname=.*dcim/.test(command));
assert.ok(!/application_name/.test(command));
assert.ok(!/gsql -d wvp/.test(command));
assert.ok(/\^\[\[:space:\]\]\*driver-class-name:\[\[:space:\]\]\*org\[\.\]postgresql\[\.\]Driver/.test(command));
assert.ok(/\^\[\[:space:\]\]\*helper-dialect:\[\[:space:\]\]\*postgresql/.test(command));
assert.ok(/\^\[\[:space:\]\]\*url:\[\[:space:\]\]\*jdbc:mysql:/.test(command));
assert.ok(/\[\[:space:\]\]\*\(#\.\*\)\?\$/.test(command));
assert.ok(!/(?:^|[;&| ])(?:head|cat|sed)(?:\s|$)/.test(command));
assert.ok(!/WVP_DB_PASSWORD/.test(command));
assert.ok((command.match(/\|\| true/g) || []).length >= 12);

const shellPath = path.join(os.tmpdir(), 'dcim-wvp-probe-' + process.pid + '.sh');
fs.writeFileSync(shellPath, '#!/bin/sh\n' + command + '\n', 'utf8');
const shellCheck = childProcess.spawnSync('sh', ['-n', shellPath], { encoding: 'utf8' });
try {
  if (shellCheck.error && shellCheck.error.code === 'ENOENT') {
    console.log('sh -n skipped: sh not found');
  } else {
    assert.strictEqual(shellCheck.status, 0, (shellCheck.stderr || '') + (shellCheck.stdout || ''));
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcim-wvp-journal-'));
    const stubJournalctl = path.join(stubDir, 'journalctl');
    fs.writeFileSync(stubJournalctl, '#!/bin/sh\nexit 7\n', 'utf8');
    fs.chmodSync(stubJournalctl, 0o755);
    const execution = childProcess.spawnSync('sh', [shellPath], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { PATH: stubDir + path.delimiter + process.env.PATH }),
    });
    try {
      assert.strictEqual(execution.status, 0, (execution.stderr || '') + (execution.stdout || ''));
      assert.ok(/logs\.db_error_lines=-1/.test(execution.stdout));
      assert.strictEqual(parseWvpRuntimeProbe(execution.stdout).checks.logs.healthy, false);
    } finally {
      try { fs.unlinkSync(stubJournalctl); } catch (error) {}
      try { fs.rmdirSync(stubDir); } catch (error) {}
    }
  }
} finally {
  try { fs.unlinkSync(shellPath); } catch (error) {}
}

runWvpRuntimeOperationTests().then(runSshCommandTimeoutTests).then(runSshCommandLateEventTests).then(runWvpRuntimeRouteContractTests).then(runDcimVideoConnectionRouteContractTests).then(runDcimVideoConnectionRaceTests).then(runDcimVideoAtomicWriteTests).then(runDcimVideoConnectionUiTests).then(() => {
  console.log('dcim wvp opengauss tests: PASS');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
