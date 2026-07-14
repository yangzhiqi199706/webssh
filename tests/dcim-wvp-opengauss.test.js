'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const http = require('http');
const net = require('net');
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
const sanitizeDcimVideoSystemConfig = extractServerFunction('sanitizeDcimVideoSystemConfig');
const registerVideoSystemConfigRoute = extractServerFunction('registerVideoSystemConfigRoute');
const setupDcimVideoConnectionSource = extractVideoFunction('setupDcimVideoConnection');
const renderDcimVideoConfigSource = extractVideoFunction('renderConfig');
const upgradePayloadEntries = extractScriptFunction('scripts/deploy-upgrade.js', 'upgradePayloadEntries');
const protocolMainSyncEntries = extractScriptFunction('scripts/deploy-protocol.js', 'protocolMainSyncEntries');
const createMainSyncDirectorySwap = extractScriptFunction('scripts/deploy-protocol.js', 'createMainSyncDirectorySwap');
const createMainSyncReleasePlan = extractScriptFunction('scripts/deploy-protocol.js', 'createMainSyncReleasePlan');
const recoverMainSyncRelease = extractScriptFunction('scripts/deploy-protocol.js', 'recoverMainSyncRelease');
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

function requestJson(app, pathname, method, payload, timeoutMs, requestHeaders) {
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
        headers: Object.assign({}, requestHeaders || {}, payload === undefined ? {} : { 'content-type': 'application/json' }),
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
      request.setTimeout(timeoutMs || 1000, function () {
        request.destroy(new Error('HTTP request timed out'));
      });
      request.on('error', function (error) { closeAnd(function () { reject(error); }); });
      request.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
  });
}

function postJson(app, pathname) {
  return requestJson(app, pathname, 'POST');
}

async function runLiveStreamGenerationRouteTests() {
  const createLiveStreamGenerationRegistry = extractServerFunction('createLiveStreamGenerationRegistry');
  const registerLivePlaybackRoutes = extractServerFunction('registerLivePlaybackRoutes');

  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function (onResolve, onReject) {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise: promise, resolve: resolve, reject: reject };
  }

  function upstreamStart(source) {
    return {
      ok: true,
      status: 200,
      data: { code: 0, data: { app: 'rtp', stream: source + '-live', flv: '/live.flv', hls: '/live.m3u8' } },
    };
  }

  function upstreamStop() {
    return { ok: true, status: 200, data: { code: 0, msg: 'stopped' } };
  }

  async function waitFor(check, message) {
    for (let turn = 0; turn < 20; turn++) {
      if (check()) return;
      await new Promise(function (resolve) { setImmediate(resolve); });
    }
    throw new Error(message);
  }

  let registryNow = 0;
  const boundedRegistry = createLiveStreamGenerationRegistry({
    instanceId: 'bounded-test',
    maxEntries: 2,
    ttlMs: 1000,
    now: function () { return registryNow; },
  });
  assert.strictEqual(boundedRegistry.issue('dcim', 'device-1', 'channel-1'), 'bounded-test:1');
  assert.strictEqual(boundedRegistry.issue('dcim', 'device-2', 'channel-2'), 'bounded-test:2');
  registryNow = 30 * 60 * 1000;
  assert.strictEqual(
    boundedRegistry.issue('webssh', 'device-1', 'channel-1'),
    null,
    '活跃 generation 达到容量上限后必须拒绝新起播，而不是淘汰仍可能活跃的键'
  );
  assert.strictEqual(boundedRegistry.size(), 2, '实时点播代次存储必须受最大条目数限制');
  assert.strictEqual(
    boundedRegistry.matches('dcim', 'device-1', 'channel-1', 'bounded-test:1'),
    true,
    '当前活跃 generation 即使超过旧的 30 分钟 TTL 也不得静默消失'
  );
  assert.strictEqual(boundedRegistry.clearIfCurrent('dcim', 'device-1', 'channel-1', 'bounded-test:1'), true);
  assert.strictEqual(
    boundedRegistry.issue('webssh', 'device-1', 'channel-1'),
    'bounded-test:3',
    '匹配停流清理后必须释放容量给新的起播'
  );

  const queueRegistry = createLiveStreamGenerationRegistry({ instanceId: 'queue-test', maxEntries: 2 });
  await queueRegistry.enqueue('dcim', 'device-1', 'channel-1', function () {
    return Promise.reject(new Error('queue test rejection'));
  }).then(function () {
    throw new Error('队列拒绝必须向调用方传递');
  }, function () {});
  let laterQueueOperationRan = false;
  await queueRegistry.enqueue('dcim', 'device-1', 'channel-1', function () {
    laterQueueOperationRan = true;
    return Promise.resolve();
  });
  assert.strictEqual(laterQueueOperationRan, true, '同 key 前一项拒绝后，后续队列项仍必须执行');
  assert.strictEqual(queueRegistry.queueSize(), 0, '队列完成后必须移除自身，不能保留 Promise 尾链');

  const pendingCapacityRegistry = createLiveStreamGenerationRegistry({
    instanceId: 'pending-capacity-test',
    maxEntries: 1,
  });
  const heldQueueOperation = deferred();
  let heldQueueOperationRan = false;
  const heldQueueRequest = pendingCapacityRegistry.enqueue('dcim', 'device-1', 'channel-1', function () {
    heldQueueOperationRan = true;
    return heldQueueOperation.promise;
  });
  await waitFor(function () { return heldQueueOperationRan; }, '容量测试的首个队列操作未执行');
  assert.strictEqual(pendingCapacityRegistry.pendingFor('dcim', 'device-1', 'channel-1'), 1, '同 key 待处理数必须计入首个挂起操作');
  assert.strictEqual(pendingCapacityRegistry.pendingCount(), 1, '全局待处理数必须计入首个挂起操作');
  for (let index = 0; index < 3; index++) {
    let rejectedOperationRan = false;
    await pendingCapacityRegistry.enqueue('dcim', 'device-1', 'channel-1', function () {
      rejectedOperationRan = true;
      return Promise.resolve();
    }).then(function () {
      throw new Error('同 key 超限操作必须被拒绝');
    }, function (error) {
      assert.strictEqual(error.code, 'LIVE_STREAM_QUEUE_FULL', '同 key 超限必须返回可识别的容量错误');
    });
    assert.strictEqual(rejectedOperationRan, false, '同 key 超限操作不得进入队列执行');
    assert.strictEqual(pendingCapacityRegistry.pendingFor('dcim', 'device-1', 'channel-1'), 1, '同 key 连续超限不得突破待处理上限');
    assert.strictEqual(pendingCapacityRegistry.pendingCount(), 1, '同 key 连续超限不得突破全局待处理上限');
  }
  await pendingCapacityRegistry.enqueue('dcim', 'device-2', 'channel-1', function () {
    throw new Error('全局超限操作不得执行');
  }).then(function () {
    throw new Error('全局超限操作必须被拒绝');
  }, function (error) {
    assert.strictEqual(error.code, 'LIVE_STREAM_QUEUE_FULL', '全局超限必须返回可识别的容量错误');
  });
  assert.strictEqual(pendingCapacityRegistry.pendingFor('dcim', 'device-2', 'channel-1'), 0, '全局超限不得为其他 key 预留待处理槽位');
  assert.strictEqual(pendingCapacityRegistry.pendingCount(), 1, '全局超限不得增加待处理总数');
  heldQueueOperation.resolve();
  await heldQueueRequest;
  assert.strictEqual(pendingCapacityRegistry.pendingFor('dcim', 'device-1', 'channel-1'), 0, '挂起操作完成后必须释放同 key 待处理计数');
  assert.strictEqual(pendingCapacityRegistry.pendingCount(), 0, '挂起操作完成后必须释放全局待处理计数');

  let recoveryOperationRan = false;
  await pendingCapacityRegistry.enqueue('dcim', 'device-1', 'channel-1', function () {
    recoveryOperationRan = true;
    return Promise.resolve();
  });
  assert.strictEqual(recoveryOperationRan, true, '容量释放后正常新操作必须继续执行');
  assert.strictEqual(pendingCapacityRegistry.pendingCount(), 0, '正常新操作完成后不得残留待处理计数');

  await pendingCapacityRegistry.enqueue('dcim', 'device-1', 'channel-1', function () {
    throw new Error('queue test throw');
  }).then(function () {
    throw new Error('队列抛错必须向调用方传递');
  }, function () {});
  assert.strictEqual(pendingCapacityRegistry.pendingCount(), 0, '队列操作抛错后必须释放待处理计数');
  await pendingCapacityRegistry.enqueue('dcim', 'device-1', 'channel-1', function () {
    return Promise.reject(new Error('queue test rejection after capacity'));
  }).then(function () {
    throw new Error('队列拒绝必须向调用方传递');
  }, function () {});
  assert.strictEqual(pendingCapacityRegistry.pendingCount(), 0, '队列操作拒绝后必须释放待处理计数');

  const fairQueueRegistry = createLiveStreamGenerationRegistry({
    instanceId: 'fair-queue-test',
    maxEntries: 4,
  });
  const heldFairOperation = deferred();
  let heldFairOperationRan = false;
  const firstFairRequest = fairQueueRegistry.enqueue('dcim', 'device-1', 'channel-1', function () {
    heldFairOperationRan = true;
    return heldFairOperation.promise;
  });
  await waitFor(function () { return heldFairOperationRan; }, '公平性测试的首个队列操作未执行');
  const secondFairRequest = fairQueueRegistry.enqueue('dcim', 'device-1', 'channel-1', function () {
    return Promise.resolve();
  });
  assert.strictEqual(fairQueueRegistry.pendingFor('dcim', 'device-1', 'channel-1'), 2, '同 key 的待处理数必须受其独立配额约束');
  assert.strictEqual(fairQueueRegistry.canEnqueue('dcim', 'device-1', 'channel-1'), false, '同 key 达到配额后不得继续占用全局槽位');
  let differentKeyOperationRan = false;
  await fairQueueRegistry.enqueue('dcim', 'device-2', 'channel-1', function () {
    differentKeyOperationRan = true;
    return Promise.resolve();
  });
  assert.strictEqual(differentKeyOperationRan, true, '同 key 达到配额后不同 key 必须仍可入队执行');
  heldFairOperation.resolve();
  await firstFairRequest;
  await secondFairRequest;
  assert.strictEqual(fairQueueRegistry.pendingCount(), 0, '不同 key 并发与同 key 串行完成后必须回收全部待处理计数');

  for (const source of ['dcim', 'webssh']) {
    const routeApp = express();
    const registry = createLiveStreamGenerationRegistry({
      instanceId: source + '-route-test',
      maxEntries: 8,
      ttlMs: 60000,
    });
    const upstreamCalls = [];
    registerLivePlaybackRoutes(routeApp, {
      source: source,
      pathPrefix: '/api/' + source + '-video',
      liveGenerations: registry,
      rewriteToProxy: function (url) { return '/media-' + source + url; },
      callWithAuth: async function (method, urlPath) {
        upstreamCalls.push({ method: method, urlPath: urlPath });
        if (urlPath.indexOf('/api/play/start/') === 0) {
          return upstreamStart(source);
        }
        return upstreamStop();
      },
    });

    const basePath = '/api/' + source + '-video/play/device-1/channel-1';
    const stopPath = '/api/' + source + '-video/play/stop/device-1/channel-1';
    const firstStart = await requestJson(routeApp, basePath, 'POST');
    const secondStart = await requestJson(routeApp, basePath, 'POST');
    assert.strictEqual(firstStart.statusCode, 200, source + ' 第一次实时点播必须成功');
    assert.strictEqual(secondStart.statusCode, 200, source + ' 第二次实时点播必须成功');
    assert.strictEqual(firstStart.body.ok, true);
    assert.strictEqual(secondStart.body.ok, true);
    assert.ok(firstStart.body.liveGeneration, source + ' 起播响应必须返回 liveGeneration');
    assert.ok(secondStart.body.liveGeneration, source + ' 第二次起播响应必须返回 liveGeneration');
    assert.notStrictEqual(firstStart.body.liveGeneration, secondStart.body.liveGeneration, source + ' 每次起播必须生成新代次');

    const staleStop = await requestJson(
      routeApp,
      stopPath + '?liveGeneration=' + encodeURIComponent(firstStart.body.liveGeneration),
      'POST'
    );
    assert.strictEqual(staleStop.statusCode, 200, source + ' 旧 stop 必须安全返回');
    assert.strictEqual(staleStop.body.ok, true, source + ' 旧 stop 必须返回 ok');
    assert.strictEqual(staleStop.body.stale, true, source + ' 旧 stop 必须标记为过时代次');
    assert.strictEqual(
      upstreamCalls.filter(function (call) { return call.urlPath.indexOf('/api/play/stop/') === 0; }).length,
      0,
      source + ' 新起播已到达后，旧 stop 绝不能调用 WVP stop'
    );

    const currentStop = await requestJson(
      routeApp,
      stopPath,
      'POST',
      undefined,
      undefined,
      { 'x-live-generation': secondStart.body.liveGeneration }
    );
    assert.strictEqual(currentStop.statusCode, 200, source + ' 当前代次 stop 必须成功');
    assert.strictEqual(currentStop.body.ok, true, source + ' 当前代次 stop 必须返回 ok');
    assert.strictEqual(
      upstreamCalls.filter(function (call) { return call.urlPath.indexOf('/api/play/stop/') === 0; }).length,
      1,
      source + ' 当前代次 stop 必须且只能调用一次 WVP stop'
    );

    const thirdStart = await requestJson(routeApp, basePath, 'POST');
    const legacyStop = await requestJson(routeApp, stopPath, 'POST');
    assert.strictEqual(thirdStart.body.ok, true, source + ' 旧客户端兼容前需要先成功起播');
    assert.strictEqual(legacyStop.body.ok, true, source + ' 不带代次的旧客户端 stop 必须兼容');
    assert.strictEqual(
      upstreamCalls.filter(function (call) { return call.urlPath.indexOf('/api/play/stop/') === 0; }).length,
      2,
      source + ' 不带代次的旧客户端 stop 必须调用 WVP stop'
    );
    assert.strictEqual(registry.queueSize(), 0, source + ' 所有实时请求完成后不得残留队列项');

    const capacityApp = express();
    const capacityRegistry = createLiveStreamGenerationRegistry({
      instanceId: source + '-capacity-test',
      maxEntries: 1,
    });
    const capacityCalls = [];
    registerLivePlaybackRoutes(capacityApp, {
      source: source,
      pathPrefix: '/api/' + source + '-capacity-video',
      liveGenerations: capacityRegistry,
      rewriteToProxy: function (url) { return url; },
      callWithAuth: async function (method, urlPath) {
        capacityCalls.push({ method: method, urlPath: urlPath });
        return upstreamStart(source);
      },
    });
    const capacityFirst = await requestJson(capacityApp, '/api/' + source + '-capacity-video/play/device-1/channel-1', 'POST');
    const capacityRejected = await requestJson(capacityApp, '/api/' + source + '-capacity-video/play/device-2/channel-2', 'POST');
    assert.strictEqual(capacityFirst.body.ok, true, source + ' 容量测试的第一个起播必须成功');
    assert.strictEqual(capacityRejected.statusCode, 503, source + ' 活跃键已满时新起播必须返回 503');
    assert.strictEqual(capacityRejected.body.ok, false, source + ' 容量已满必须明确拒绝');
    assert.strictEqual(capacityCalls.length, 1, source + ' 容量拒绝不得调用上游起播');

    const queueCapacityApp = express();
    const queueCapacityRegistry = createLiveStreamGenerationRegistry({
      instanceId: source + '-queue-capacity-test',
      maxEntries: 1,
    });
    const queueCapacityCalls = [];
    const delayedQueueStart = deferred();
    registerLivePlaybackRoutes(queueCapacityApp, {
      source: source,
      pathPrefix: '/api/' + source + '-queue-capacity-video',
      liveGenerations: queueCapacityRegistry,
      rewriteToProxy: function (url) { return url; },
      callWithAuth: async function (method, urlPath) {
        queueCapacityCalls.push({ method: method, urlPath: urlPath });
        if (queueCapacityCalls.length === 1) return delayedQueueStart.promise;
        return upstreamStart(source);
      },
    });
    const queueCapacityPath = '/api/' + source + '-queue-capacity-video/play/device-1/channel-1';
    const heldStart = requestJson(queueCapacityApp, queueCapacityPath, 'POST');
    await waitFor(function () { return queueCapacityCalls.length === 1; }, source + ' 容量测试的首个起播未进入上游');
    const queueRejectedStart = await requestJson(queueCapacityApp, queueCapacityPath, 'POST');
    assert.strictEqual(queueRejectedStart.statusCode, 503, source + ' 队列满时起播必须立即返回 503');
    assert.deepStrictEqual(
      queueRejectedStart.body,
      { ok: false, status: 503, message: '实时点播请求繁忙，请稍后重试' },
      source + ' 队列满时不得向客户端泄露内部异常'
    );
    assert.strictEqual(queueCapacityCalls.length, 1, source + ' 队列满时不得调用上游起播');
    assert.strictEqual(queueCapacityRegistry.pendingCount(), 1, source + ' 队列满时全局待处理数必须保持上限');
    delayedQueueStart.resolve(upstreamStart(source));
    assert.strictEqual((await heldStart).body.ok, true, source + ' 挂起起播释放后必须成功完成');
    assert.strictEqual(queueCapacityRegistry.pendingCount(), 0, source + ' 挂起起播释放后必须回收待处理计数');
    const recoveredStart = await requestJson(queueCapacityApp, queueCapacityPath, 'POST');
    assert.strictEqual(recoveredStart.body.ok, true, source + ' 队列容量释放后新起播必须继续成功');

    const failedStartApp = express();
    const failedStartRegistry = createLiveStreamGenerationRegistry({
      instanceId: source + '-failed-start-test',
      maxEntries: 1,
    });
    registerLivePlaybackRoutes(failedStartApp, {
      source: source,
      pathPrefix: '/api/' + source + '-failed-start-video',
      liveGenerations: failedStartRegistry,
      rewriteToProxy: function (url) { return url; },
      callWithAuth: async function () {
        return { ok: false, status: 502, message: 'upstream start failed', data: { code: -1, msg: 'upstream start failed' } };
      },
    });
    const failedStart = await requestJson(failedStartApp, '/api/' + source + '-failed-start-video/play/device-1/channel-1', 'POST');
    assert.strictEqual(failedStart.body.ok, false, source + ' 上游起播失败必须向客户端报告失败');
    assert.strictEqual(failedStartRegistry.size(), 0, source + ' 上游起播失败必须清除预留的 generation');

    const restartCleanupApp = express();
    const restartCleanupRegistry = createLiveStreamGenerationRegistry({
      instanceId: source + '-restart-test',
      maxEntries: 2,
    });
    const restartCleanupCalls = [];
    registerLivePlaybackRoutes(restartCleanupApp, {
      source: source,
      pathPrefix: '/api/' + source + '-restart-video',
      liveGenerations: restartCleanupRegistry,
      rewriteToProxy: function (url) { return url; },
      callWithAuth: async function (method, urlPath) {
        restartCleanupCalls.push({ method: method, urlPath: urlPath });
        return upstreamStop();
      },
    });
    const restartCleanup = await requestJson(
      restartCleanupApp,
      '/api/' + source + '-restart-video/play/stop/device-1/channel-1?liveGeneration=before-restart:1',
      'POST'
    );
    assert.strictEqual(restartCleanup.body.ok, true, source + ' 服务重启后带 generation 的 stop 必须兼容清理');
    assert.strictEqual(restartCleanup.body.stale, undefined, source + ' 未知 generation 不能被误判为 stale');
    assert.strictEqual(restartCleanupCalls.length, 1, source + ' 服务重启后带 generation 的 stop 必须调用上游');

    const stopThenStartApp = express();
    const stopThenStartRegistry = createLiveStreamGenerationRegistry({
      instanceId: source + '-stop-then-start-test',
      maxEntries: 4,
    });
    const stopThenStartCalls = [];
    const delayedStop = deferred();
    registerLivePlaybackRoutes(stopThenStartApp, {
      source: source,
      pathPrefix: '/api/' + source + '-stop-then-start-video',
      liveGenerations: stopThenStartRegistry,
      rewriteToProxy: function (url) { return url; },
      callWithAuth: async function (method, urlPath) {
        stopThenStartCalls.push({ method: method, urlPath: urlPath });
        if (urlPath.indexOf('/api/play/stop/') === 0) return delayedStop.promise;
        return upstreamStart(source);
      },
    });
    const orderedBasePath = '/api/' + source + '-stop-then-start-video/play/device-1/channel-1';
    const orderedStopPath = '/api/' + source + '-stop-then-start-video/play/stop/device-1/channel-1';
    const orderedFirstStart = await requestJson(stopThenStartApp, orderedBasePath, 'POST');
    const orderedStop = requestJson(
      stopThenStartApp,
      orderedStopPath + '?liveGeneration=' + encodeURIComponent(orderedFirstStart.body.liveGeneration),
      'POST'
    );
    await waitFor(function () {
      return stopThenStartCalls.filter(function (call) { return call.urlPath.indexOf('/api/play/stop/') === 0; }).length === 1;
    }, source + ' G1 stop 未进入上游');
    const orderedSecondStart = requestJson(stopThenStartApp, orderedBasePath, 'POST');
    await new Promise(function (resolve) { setImmediate(resolve); });
    assert.strictEqual(
      stopThenStartCalls.filter(function (call) { return call.urlPath.indexOf('/api/play/start/') === 0; }).length,
      1,
      source + ' G1 stop 已通过比对并等待上游时，G2 start 不得并发调用上游'
    );
    delayedStop.resolve(upstreamStop());
    assert.strictEqual((await orderedStop).body.ok, true, source + ' G1 stop 必须完成');
    assert.strictEqual((await orderedSecondStart).body.ok, true, source + ' G2 start 必须在 G1 stop 后成功');
    assert.deepStrictEqual(
      stopThenStartCalls.map(function (call) { return call.urlPath.replace('/api/play/', ''); }),
      [
        'start/device-1/channel-1',
        'stop/device-1/channel-1',
        'start/device-1/channel-1',
      ],
      source + ' 同 key 的 G1 stop 与 G2 start 必须按上游调用顺序串行'
    );
    assert.strictEqual(stopThenStartRegistry.queueSize(), 0, source + ' G1/G2 交错完成后队列必须清空');

    const startThenStopApp = express();
    const startThenStopRegistry = createLiveStreamGenerationRegistry({
      instanceId: source + '-start-then-stop-test',
      maxEntries: 4,
    });
    const startThenStopCalls = [];
    const delayedSecondStart = deferred();
    let startCallCount = 0;
    registerLivePlaybackRoutes(startThenStopApp, {
      source: source,
      pathPrefix: '/api/' + source + '-start-then-stop-video',
      liveGenerations: startThenStopRegistry,
      rewriteToProxy: function (url) { return url; },
      callWithAuth: async function (method, urlPath) {
        startThenStopCalls.push({ method: method, urlPath: urlPath });
        if (urlPath.indexOf('/api/play/start/') === 0) {
          startCallCount++;
          if (startCallCount === 2) return delayedSecondStart.promise;
          return upstreamStart(source);
        }
        return upstreamStop();
      },
    });
    const newerBasePath = '/api/' + source + '-start-then-stop-video/play/device-1/channel-1';
    const newerStopPath = '/api/' + source + '-start-then-stop-video/play/stop/device-1/channel-1';
    const newerFirstStart = await requestJson(startThenStopApp, newerBasePath, 'POST');
    const newerSecondStart = requestJson(startThenStopApp, newerBasePath, 'POST');
    await waitFor(function () { return startCallCount === 2; }, source + ' G2 start 未进入上游');
    const staleOldStop = requestJson(
      startThenStopApp,
      newerStopPath + '?liveGeneration=' + encodeURIComponent(newerFirstStart.body.liveGeneration),
      'POST'
    );
    delayedSecondStart.resolve(upstreamStart(source));
    assert.strictEqual((await newerSecondStart).body.ok, true, source + ' G2 start 必须成功');
    const staleOldStopResponse = await staleOldStop;
    assert.strictEqual(staleOldStopResponse.body.ok, true, source + ' G1 旧 stop 必须安全完成');
    assert.strictEqual(staleOldStopResponse.body.stale, true, source + ' G2 先进入时 G1 stop 必须被识别为 stale');
    assert.strictEqual(
      startThenStopCalls.filter(function (call) { return call.urlPath.indexOf('/api/play/stop/') === 0; }).length,
      0,
      source + ' G2 start 先进入时 G1 stop 绝不能调用上游'
    );

    const parallelApp = express();
    const parallelRegistry = createLiveStreamGenerationRegistry({
      instanceId: source + '-parallel-test',
      maxEntries: 4,
    });
    const slowStart = deferred();
    const parallelCalls = [];
    registerLivePlaybackRoutes(parallelApp, {
      source: source,
      pathPrefix: '/api/' + source + '-parallel-video',
      liveGenerations: parallelRegistry,
      rewriteToProxy: function (url) { return url; },
      callWithAuth: async function (method, urlPath) {
        parallelCalls.push({ method: method, urlPath: urlPath });
        if (urlPath.indexOf('device-1') !== -1) return slowStart.promise;
        return upstreamStart(source);
      },
    });
    const slowRequest = requestJson(parallelApp, '/api/' + source + '-parallel-video/play/device-1/channel-1', 'POST');
    await waitFor(function () { return parallelCalls.length === 1; }, source + ' 慢起播未进入上游');
    const fastRequest = requestJson(parallelApp, '/api/' + source + '-parallel-video/play/device-2/channel-2', 'POST');
    await waitFor(function () { return parallelCalls.length === 2; }, source + ' 不同 key 的起播被错误阻塞');
    assert.strictEqual((await fastRequest).body.ok, true, source + ' 不同 key 必须可以并行完成');
    slowStart.resolve(upstreamStart(source));
    assert.strictEqual((await slowRequest).body.ok, true, source + ' 慢起播最终必须成功');
  }
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

async function runDcimVideoSystemConfigRedactionTests() {
  const sensitiveValues = [
    'fixture-password-value',
    'fixture-pass-word-value',
    'fixture-secret-value',
    'fixture-token-value',
    'fixture-access-token-value',
    'fixture-authorization-value',
    'fixture-private-key-value',
    'fixture-auth-pwd-value',
    'fixture-auth-pwd-uppercase-value',
    'fixture-auth-pwd-underscore-value',
    'fixture-auth-pass-value',
    'fixture-auth-key-value',
  ];
  const upstreamConfig = {
    sip: {
      id: '34020000002000000001',
      domain: '3402000000',
      port: 5060,
      password: sensitiveValues[0],
      nested: {
        passWord: sensitiveValues[1],
        secret: sensitiveValues[2],
        token: sensitiveValues[3],
        accessToken: sensitiveValues[4],
        authorization: sensitiveValues[5],
        privateKey: sensitiveValues[6],
        authPwd: sensitiveValues[7],
        AUTH_PWD: sensitiveValues[8],
        auth_pwd: sensitiveValues[9],
        authPass: sensitiveValues[10],
        authKey: sensitiveValues[11],
        array: [{ auth_pwd: sensitiveValues[9] }],
        extra: JSON.stringify({ authPwd: sensitiveValues[7], mode: 'keep' }),
      },
    },
    version: { version: '2.6.9' },
  };
  const upstreamResponse = { code: 0, data: upstreamConfig };
  const upstreamFailureMessage = '上游原始错误 authPwd=' + sensitiveValues[7];
  const sanitized = sanitizeDcimVideoSystemConfig(upstreamConfig);
  assert.notStrictEqual(sanitized, upstreamConfig);
  assert.strictEqual(sanitized.sip.password, '***');
  assert.strictEqual(sanitized.sip.nested.passWord, '***');
  assert.strictEqual(sanitized.sip.nested.secret, '***');
  assert.strictEqual(sanitized.sip.nested.token, '***');
  assert.strictEqual(sanitized.sip.nested.accessToken, '***');
  assert.strictEqual(sanitized.sip.nested.authorization, '***');
  assert.strictEqual(sanitized.sip.nested.privateKey, '***');
  assert.strictEqual(sanitized.sip.nested.authPwd, '***');
  assert.strictEqual(sanitized.sip.nested.AUTH_PWD, '***');
  assert.strictEqual(sanitized.sip.nested.auth_pwd, '***');
  assert.strictEqual(sanitized.sip.nested.authPass, '***');
  assert.strictEqual(sanitized.sip.nested.authKey, '***');
  assert.strictEqual(sanitized.sip.nested.array[0].auth_pwd, '***');
  assert.deepStrictEqual(JSON.parse(sanitized.sip.nested.extra), { authPwd: '***', mode: 'keep' });
  assert.strictEqual(sanitized.sip.id, upstreamConfig.sip.id);
  assert.strictEqual(sanitized.sip.domain, upstreamConfig.sip.domain);
  assert.strictEqual(sanitized.sip.port, upstreamConfig.sip.port);
  assert.strictEqual(JSON.stringify(sanitized).includes(sensitiveValues[0]), false);
  assert.strictEqual(upstreamConfig.sip.password, sensitiveValues[0]);
  assert.strictEqual(upstreamConfig.sip.nested.token, sensitiveValues[3]);
  assert.strictEqual(upstreamConfig.sip.nested.authPwd, sensitiveValues[7]);
  assert.strictEqual(upstreamConfig.sip.nested.array[0].auth_pwd, sensitiveValues[9]);
  assert.strictEqual(upstreamConfig.sip.nested.extra, JSON.stringify({ authPwd: sensitiveValues[7], mode: 'keep' }));
  const sanitizedRawConfig = sanitizeDcimVideoSystemConfig(JSON.stringify(upstreamConfig));
  sensitiveValues.forEach(function (value) {
    assert.strictEqual(JSON.stringify(sanitizedRawConfig).includes(value), false, '原始 JSON 文本也不得保留敏感值');
  });

  const circularConfig = { id: 'preserve-circular-id', authPwd: sensitiveValues[7] };
  circularConfig.self = circularConfig;
  let circularSanitized;
  assert.doesNotThrow(function () {
    circularSanitized = sanitizeDcimVideoSystemConfig(circularConfig);
  });
  assert.strictEqual(circularSanitized.id, circularConfig.id);
  assert.strictEqual(circularSanitized.authPwd, '***');
  assert.strictEqual(circularSanitized.self, '***');
  assert.strictEqual(circularConfig.self, circularConfig);

  const sharedNestedConfig = { id: 'preserve-shared-id', authPwd: sensitiveValues[7] };
  const sharedReferenceConfig = { first: sharedNestedConfig, second: sharedNestedConfig };
  const sharedReferenceSanitized = sanitizeDcimVideoSystemConfig(sharedReferenceConfig);
  assert.strictEqual(sharedReferenceSanitized.first.id, 'preserve-shared-id');
  assert.strictEqual(sharedReferenceSanitized.first.authPwd, '***');
  assert.strictEqual(sharedReferenceSanitized.second.id, 'preserve-shared-id');
  assert.strictEqual(sharedReferenceSanitized.second.authPwd, '***');
  assert.strictEqual(sharedReferenceConfig.first, sharedNestedConfig);
  assert.strictEqual(sharedReferenceConfig.second, sharedNestedConfig);

  const getterConfig = { id: 'preserve-getter-id' };
  Object.defineProperty(getterConfig, 'throwingValue', {
    configurable: true,
    enumerable: true,
    get: function () { throw new Error('getter ' + sensitiveValues[7]); },
  });
  let getterSanitized;
  assert.doesNotThrow(function () {
    getterSanitized = sanitizeDcimVideoSystemConfig(getterConfig);
  });
  assert.strictEqual(getterSanitized.id, getterConfig.id);
  assert.strictEqual(getterSanitized.throwingValue, '***');
  assert.strictEqual(JSON.stringify(getterSanitized).includes(sensitiveValues[7]), false);
  assert.strictEqual(typeof Object.getOwnPropertyDescriptor(getterConfig, 'throwingValue').get, 'function');

  const routeApp = express();
  registerVideoSystemConfigRoute(routeApp, {
    path: '/api/dcim-video/config',
    callWithAuth: async function () {
      return { ok: true, status: 200, data: upstreamResponse };
    },
    sanitizeSystemConfig: sanitizeDcimVideoSystemConfig,
  });
  const response = await requestJson(routeApp, '/api/dcim-video/config', 'GET');
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.body.ok, true);
  sensitiveValues.forEach(function (value) {
    assert.strictEqual(JSON.stringify(response.body).includes(value), false, '路由响应不得包含上游敏感值');
  });
  assert.strictEqual(response.body.data.sip.id, upstreamConfig.sip.id);
  assert.strictEqual(response.body.data.sip.domain, upstreamConfig.sip.domain);
  assert.strictEqual(response.body.data.sip.port, upstreamConfig.sip.port);
  assert.deepStrictEqual(JSON.parse(response.body.data.sip.nested.extra), { authPwd: '***', mode: 'keep' });

  const plainTextSensitiveValues = [
    'plain-auth-pwd-value',
    'plain-password-value',
    'plain-token-value',
    'plain-secret-value',
  ];
  const ordinaryDescription = 'diagnostic connection state is ready';
  const plainTextSuccessConfig = {
    description: 'diagnostic authPwd=' + plainTextSensitiveValues[0],
    details: 'password: ' + plainTextSensitiveValues[1],
    trace: 'token=' + plainTextSensitiveValues[2],
    note: 'secret: ' + plainTextSensitiveValues[3],
    ordinaryDescription: ordinaryDescription,
  };
  const plainTextSuccessApp = express();
  registerVideoSystemConfigRoute(plainTextSuccessApp, {
    path: '/api/dcim-video/config',
    callWithAuth: async function () {
      return {
        ok: true,
        status: 200,
        data: { code: 0, data: plainTextSuccessConfig },
      };
    },
    sanitizeSystemConfig: sanitizeDcimVideoSystemConfig,
  });
  const plainTextSuccess = await requestJson(plainTextSuccessApp, '/api/dcim-video/config', 'GET');
  assert.strictEqual(plainTextSuccess.statusCode, 200);
  assert.strictEqual(plainTextSuccess.body.ok, true);
  assert.strictEqual(plainTextSuccess.body.data.description, '***');
  assert.strictEqual(plainTextSuccess.body.data.details, '***');
  assert.strictEqual(plainTextSuccess.body.data.trace, '***');
  assert.strictEqual(plainTextSuccess.body.data.note, '***');
  assert.strictEqual(plainTextSuccess.body.data.ordinaryDescription, ordinaryDescription);
  plainTextSensitiveValues.forEach(function (value) {
    assert.strictEqual(JSON.stringify(plainTextSuccess.body).includes(value), false, 'dcim 成功响应不得包含纯文本凭据');
  });

  const plainTextFailureMessage = 'upstream diagnostic authPwd=' + plainTextSensitiveValues[0];
  const plainTextFailureData = {
    msg: 'upstream error authPwd: ' + plainTextSensitiveValues[0],
    details: 'password=' + plainTextSensitiveValues[1],
    trace: 'token: ' + plainTextSensitiveValues[2],
    note: 'secret=' + plainTextSensitiveValues[3],
    ordinaryDescription: ordinaryDescription,
  };
  const plainTextFailureApp = express();
  registerVideoSystemConfigRoute(plainTextFailureApp, {
    path: '/api/webssh-video/config',
    callWithAuth: async function () {
      return {
        ok: false,
        status: 502,
        message: plainTextFailureMessage,
        data: plainTextFailureData,
      };
    },
    sanitizeSystemConfig: sanitizeDcimVideoSystemConfig,
  });
  const plainTextFailure = await requestJson(plainTextFailureApp, '/api/webssh-video/config', 'GET');
  assert.strictEqual(plainTextFailure.statusCode, 200);
  assert.strictEqual(plainTextFailure.body.ok, false);
  assert.strictEqual(plainTextFailure.body.message, '读取 WVP 配置失败');
  assert.strictEqual(plainTextFailure.body.data.msg, '***');
  assert.strictEqual(plainTextFailure.body.data.details, '***');
  assert.strictEqual(plainTextFailure.body.data.trace, '***');
  assert.strictEqual(plainTextFailure.body.data.note, '***');
  assert.strictEqual(plainTextFailure.body.data.ordinaryDescription, ordinaryDescription);
  assert.strictEqual(JSON.stringify(plainTextFailure.body).includes(plainTextFailureMessage), false);
  plainTextSensitiveValues.forEach(function (value) {
    assert.strictEqual(JSON.stringify(plainTextFailure.body).includes(value), false, 'webssh 失败响应不得包含纯文本凭据');
  });

  const dcimFailureApp = express();
  registerVideoSystemConfigRoute(dcimFailureApp, {
    path: '/api/dcim-video/config',
    callWithAuth: async function () {
      return { ok: false, status: 502, message: upstreamFailureMessage, data: upstreamConfig };
    },
    sanitizeSystemConfig: sanitizeDcimVideoSystemConfig,
  });
  const dcimFailure = await requestJson(dcimFailureApp, '/api/dcim-video/config', 'GET');
  assert.strictEqual(dcimFailure.statusCode, 200);
  assert.strictEqual(dcimFailure.body.ok, false);
  assert.strictEqual(dcimFailure.body.message, '读取 WVP 配置失败');
  assert.strictEqual(JSON.stringify(dcimFailure.body).includes(upstreamFailureMessage), false);
  sensitiveValues.forEach(function (value) {
    assert.strictEqual(JSON.stringify(dcimFailure.body).includes(value), false, 'dcim 失败响应不得包含上游敏感值');
  });
  assert.strictEqual(dcimFailure.body.data.sip.id, upstreamConfig.sip.id);
  assert.deepStrictEqual(JSON.parse(dcimFailure.body.data.sip.nested.extra), { authPwd: '***', mode: 'keep' });

  const websshSuccessApp = express();
  registerVideoSystemConfigRoute(websshSuccessApp, {
    path: '/api/webssh-video/config',
    callWithAuth: async function () {
      return { ok: true, status: 200, data: upstreamResponse };
    },
    sanitizeSystemConfig: sanitizeDcimVideoSystemConfig,
  });
  const websshSuccess = await requestJson(websshSuccessApp, '/api/webssh-video/config', 'GET');
  assert.strictEqual(websshSuccess.statusCode, 200);
  assert.strictEqual(websshSuccess.body.ok, true);
  sensitiveValues.forEach(function (value) {
    assert.strictEqual(JSON.stringify(websshSuccess.body).includes(value), false, 'webssh 成功响应不得包含上游敏感值');
  });
  assert.strictEqual(websshSuccess.body.data.sip.id, upstreamConfig.sip.id);
  assert.strictEqual(websshSuccess.body.data.sip.port, upstreamConfig.sip.port);
  assert.deepStrictEqual(JSON.parse(websshSuccess.body.data.sip.nested.extra), { authPwd: '***', mode: 'keep' });

  const websshFailureApp = express();
  registerVideoSystemConfigRoute(websshFailureApp, {
    path: '/api/webssh-video/config',
    callWithAuth: async function () {
      return { ok: false, status: 502, message: upstreamFailureMessage, data: upstreamConfig };
    },
    sanitizeSystemConfig: sanitizeDcimVideoSystemConfig,
  });
  const websshFailure = await requestJson(websshFailureApp, '/api/webssh-video/config', 'GET');
  assert.strictEqual(websshFailure.statusCode, 200);
  assert.strictEqual(websshFailure.body.ok, false);
  assert.strictEqual(websshFailure.body.message, '读取 WVP 配置失败');
  assert.strictEqual(JSON.stringify(websshFailure.body).includes(upstreamFailureMessage), false);
  sensitiveValues.forEach(function (value) {
    assert.strictEqual(JSON.stringify(websshFailure.body).includes(value), false, 'webssh 失败响应不得包含上游敏感值');
  });
  assert.strictEqual(websshFailure.body.data.sip.id, upstreamConfig.sip.id);
  assert.strictEqual(websshFailure.body.data.sip.port, upstreamConfig.sip.port);
  assert.deepStrictEqual(JSON.parse(websshFailure.body.data.sip.nested.extra), { authPwd: '***', mode: 'keep' });

  const circularHttpConfig = { id: 'http-circular-id', authPwd: sensitiveValues[7] };
  circularHttpConfig.self = circularHttpConfig;
  const getterHttpConfig = { id: 'http-getter-id' };
  Object.defineProperty(getterHttpConfig, 'throwingValue', {
    configurable: true,
    enumerable: true,
    get: function () { throw new Error('getter ' + sensitiveValues[7]); },
  });
  const unusualResponses = await Promise.all([
    { label: 'dcim-circular', path: '/api/dcim-video/config', config: circularHttpConfig },
    { label: 'webssh-circular', path: '/api/webssh-video/config', config: circularHttpConfig },
    { label: 'dcim-getter', path: '/api/dcim-video/config', config: getterHttpConfig },
    { label: 'webssh-getter', path: '/api/webssh-video/config', config: getterHttpConfig },
  ].map(function (fixture) {
    const unusualApp = express();
    registerVideoSystemConfigRoute(unusualApp, {
      path: fixture.path,
      callWithAuth: async function () {
        return { ok: true, status: 200, data: { code: 0, data: fixture.config } };
      },
      sanitizeSystemConfig: sanitizeDcimVideoSystemConfig,
    });
    return requestJson(unusualApp, fixture.path, 'GET', undefined, 500);
  }));
  unusualResponses.forEach(function (unusualResponse) {
    assert.strictEqual(unusualResponse.statusCode, 200);
    assert.strictEqual(unusualResponse.body.ok, true);
    assert.strictEqual(JSON.stringify(unusualResponse.body).includes(sensitiveValues[7]), false);
    assert.ok(/^http-(circular|getter)-id$/.test(unusualResponse.body.data.id));
  });

  const rejectedApp = express();
  const rejectedUpstreamError = 'upstream rejected authPwd=' + sensitiveValues[7];
  registerVideoSystemConfigRoute(rejectedApp, {
    path: '/api/rejected-config',
    callWithAuth: async function () { throw new Error(rejectedUpstreamError); },
    sanitizeSystemConfig: sanitizeDcimVideoSystemConfig,
  });
  const rejectedResponse = await requestJson(rejectedApp, '/api/rejected-config', 'GET', undefined, 500);
  assert.strictEqual(rejectedResponse.statusCode, 200);
  assert.deepStrictEqual(rejectedResponse.body, {
    ok: false,
    message: '读取 WVP 配置失败',
    data: '***',
  });
  assert.strictEqual(JSON.stringify(rejectedResponse.body).includes(rejectedUpstreamError), false);

  const configRouteSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.strictEqual(configRouteSource.includes('function registerDcimVideoSystemConfigRoute('), false);
  assert.strictEqual(configRouteSource.includes('function registerWebsshVideoSystemConfigRoute('), false);
  assert.strictEqual((configRouteSource.match(/registerVideoSystemConfigRoute\(app, \{/g) || []).length, 2);

  const tableBody = { innerHTML: '' };
  const elements = {
    dcimCfgTable: { querySelector: function () { return tableBody; } },
    dcimCfgHint: { textContent: '', className: '' },
    cfgSrcTag: { hidden: true, textContent: '', className: '' },
  };
  const renderContext = {
    $: function (id) { return elements[id]; },
    esc: function (value) { return String(value == null ? '' : value); },
  };
  vm.runInNewContext(renderDcimVideoConfigSource + '\nthis.renderConfig = renderConfig;', renderContext);
  renderContext.renderConfig(upstreamConfig, 'dcim');
  sensitiveValues.forEach(function (value) {
    assert.strictEqual(tableBody.innerHTML.includes(value), false, '视频渲染 DOM 不得包含上游敏感值');
  });
  assert.ok(tableBody.innerHTML.includes(upstreamConfig.sip.id));
  assert.ok(tableBody.innerHTML.includes(upstreamConfig.sip.domain));
  assert.ok(tableBody.innerHTML.includes(String(upstreamConfig.sip.port)));
  assert.ok(tableBody.innerHTML.includes('鉴权密码'));
  assert.ok(tableBody.innerHTML.includes('已脱敏'));
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

async function runProtocolMainSyncRollbackFailureTests() {
  const originalError = new Error('原始部署失败：主壳探活失败');
  const scenarios = [
    {
      name: '恢复复制返回非零',
      stage: '恢复主壳内容',
      responses: [{ code: 1, stdout: '', stderr: 'cp failed' }],
      expectedCalls: 1,
    },
    {
      name: '回滚重启返回非零',
      stage: '重启主服务',
      responses: [{ code: 0, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: 'restart failed' }],
      expectedCalls: 2,
    },
    {
      name: '回滚服务未 active',
      stage: '确认主服务状态',
      responses: [
        { code: 0, stdout: '', stderr: '' },
        { code: 0, stdout: '', stderr: '' },
        { code: 0, stdout: 'inactive\n', stderr: '' },
      ],
      expectedCalls: 3,
    },
    {
      name: '回滚健康检查非 200',
      stage: '确认主服务健康检查',
      responses: [
        { code: 0, stdout: '', stderr: '' },
        { code: 0, stdout: '', stderr: '' },
        { code: 0, stdout: 'active\n', stderr: '' },
        { code: 0, stdout: '503', stderr: '' },
      ],
      expectedCalls: 4,
    },
  ];

  for (const scenario of scenarios) {
    const releasePlan = createMainSyncReleasePlan('/opt/webssh/app', 'rollback-test', 'webssh', 3010);
    const calls = [];
    let responseIndex = 0;
    const runExec = async function (_conn, command, options) {
      calls.push({ command: command, options: options });
      return scenario.responses[responseIndex++];
    };
    let failure;
    try {
      await recoverMainSyncRelease({}, runExec, releasePlan, originalError);
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, scenario.name + ' 必须抛出回滚失败');
    assert.ok(failure.message.indexOf('回滚失败') !== -1, scenario.name + ' 必须明确标记回滚失败');
    assert.ok(failure.message.indexOf(scenario.stage) !== -1, scenario.name + ' 必须说明失败阶段');
    assert.ok(failure.message.indexOf(originalError.message) !== -1, scenario.name + ' 必须保留原始部署失败上下文');
    assert.strictEqual(calls.length, scenario.expectedCalls, scenario.name + ' 失败后不得继续执行后续操作');
    calls.forEach(function (call) {
      assert.strictEqual(call.options && call.options.allowNonZero, true, scenario.name + ' 必须收集命令输出后显式判定');
    });
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
  let anonymousReadCalls = 0;
  let anonymousControllerCalls = 0;
  const anonymousApp = express();
  registerWvpRuntimeRoutes(anonymousApp, {
    runtimeOperations: {
      readStatus: async () => {
        anonymousReadCalls++;
        return runtimeOperationStatus(true, true);
      },
      restart: async () => { anonymousControllerCalls++; throw new Error('匿名请求不得重启'); },
    },
    isAuthed: () => false,
    appendLog: () => {},
    runtimeSummary: () => '',
  });
  const anonymousStatusResponse = await requestJson(anonymousApp, '/api/db-manager/opengauss/wvp/runtime-status', 'GET');
  assert.strictEqual(anonymousStatusResponse.statusCode, 401);
  assert.deepStrictEqual(anonymousStatusResponse.body, { ok: false, message: '请先登录' });
  assert.strictEqual(anonymousReadCalls, 0);
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

  for (const failedCheck of ['datasource', 'database', 'logs']) {
    const degradedRuntime = runtimeOperationStatus(true, true);
    degradedRuntime.status.status = 'unhealthy';
    degradedRuntime.status.ready = false;
    degradedRuntime.status.checks[failedCheck].healthy = false;
    const healthSequence = [runtimeOperationStatus(true, true), degradedRuntime];
    let healthSequenceIndex = 0;
    const degradedOps = createWvpRuntimeOperations({
      collect: async () => healthSequence[healthSequenceIndex++] || degradedRuntime,
      restartService: async () => ({ code: 0 }),
      sleep: async () => {},
    });
    const degradedApp = express();
    registerWvpRuntimeRoutes(degradedApp, {
      runtimeOperations: degradedOps,
      isAuthed: () => true,
      appendLog: () => {},
      runtimeSummary: () => '',
    });
    const degradedResponse = await postJson(degradedApp, '/api/db-manager/opengauss/wvp/restart');
    assert.strictEqual(degradedResponse.statusCode, 502, failedCheck + ' 失败时不得报告重启成功');
    assert.strictEqual(degradedResponse.body.ok, false, failedCheck + ' 失败时 ok 必须为 false');
    assert.strictEqual(degradedResponse.body.status.ready, false, failedCheck + ' 失败时运行态不得就绪');
    assert.strictEqual(degradedResponse.body.status.checks[failedCheck].healthy, false, failedCheck + ' 检查结果必须保留');
  }

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

const createVideoPlaybackController = vm.runInNewContext(
  '(' + extractVideoFunction('createVideoPlaybackController') + ')',
  { Promise: Promise, encodeURIComponent: encodeURIComponent }
);
const buildTilePlayerConfig = vm.runInNewContext(
  '(' + extractVideoFunction('buildTilePlayerConfig') + ')',
  {}
);
const tileStopPathForState = vm.runInNewContext(
  '(' + extractVideoFunction('tileStopPathForState') + ')',
  { encodeURIComponent: encodeURIComponent }
);
const replaceTileStream = vm.runInNewContext(
  '(' + extractVideoFunction('replaceTileStream') + ')',
  {}
);
const stopEndedPlayback = vm.runInNewContext(
  '(' + extractVideoFunction('stopEndedPlayback') + ')',
  {}
);
const releaseTileStream = vm.runInNewContext(
  '(' + extractVideoFunction('releaseTileStream') + ')',
  {
    Promise: Promise,
    clearTimeout: clearTimeout,
    setTimeout: setTimeout,
    tileStopPathForState: tileStopPathForState,
  }
);
const handleTilePlaybackFailure = vm.runInNewContext(
  '(' + extractVideoFunction('handleTilePlaybackFailure') + ')',
  {}
);
const stopTilesForPageHide = vm.runInNewContext(
  '(' + extractVideoFunction('stopTilesForPageHide') + ')',
  {}
);
const loadVideoSource = extractVideoFunction('loadSource');

function createPlaybackSelect(value) {
  return {
    value: value || '',
    disabled: false,
    options: [],
    replaceChildren: function () { this.options = []; },
    appendChild: function (option) { this.options.push(option); },
  };
}

function createPlaybackElements() {
  return {
    device: createPlaybackSelect(),
    channel: createPlaybackSelect(),
    start: { value: '2026-07-13T10:00' },
    end: { value: '2026-07-13T10:10' },
    speed: { value: '2' },
    hint: { textContent: '', className: '' },
  };
}

function createPlaybackControllerHarness(overrides) {
  const options = overrides || {};
  const elements = options.elements || createPlaybackElements();
  let source = options.source || 'dcim';
  let sourceEpoch = options.sourceEpoch || 1;
  let activeTile = options.activeTile || null;
  const tiles = options.tiles || (activeTile ? [activeTile] : []);
  const controller = createVideoPlaybackController({
    elements: elements,
    runtime: runtime,
    fetch: options.fetch || function () { throw new Error('unexpected fetch'); },
    createOption: function (value, text) { return { value: value, textContent: text }; },
    getSource: function () { return source; },
    getSourceEpoch: function () { return sourceEpoch; },
    getActiveTile: function () { return activeTile; },
    getTiles: function () { return tiles; },
    getTileRevision: function (tile) { return tile.revision || 0; },
    replaceTile: options.replaceTile || function (tile, params) { tile.play(params); },
  });
  return {
    controller: controller,
    elements: elements,
    setSource: function (value) { source = value; },
    setSourceEpoch: function (value) { sourceEpoch = value; },
    setActiveTile: function (tile) { activeTile = tile; },
  };
}

function createVideoSourceLoadHarness() {
  const elements = {
    btnLoadDcim: { disabled: false, textContent: '加载 dcim' },
    dcimPanels: { hidden: true },
    dcimCfgHint: { textContent: '' },
    dcimDevHint: { textContent: '' },
  };
  const playbackCalls = [];
  const renderCalls = [];
  const context = {
    Promise: Promise,
    currentSource: 'webssh',
    sourceEpoch: 7,
    sourceRequestEpoch: 0,
    tiles: [],
    hint: { textContent: '当前数据源：webssh（5070）' },
    playbackController: { setDevices: function (list, source) { playbackCalls.push({ list: list, source: source }); } },
    $: function (id) { return elements[id]; },
    renderConfig: function (_cfg, source) { renderCalls.push({ type: 'config', source: source }); },
    renderDevices: function (_list, _total, source) { renderCalls.push({ type: 'devices', source: source }); },
    refreshDcimStatus: function () {},
    refreshWebsshStatus: function () {},
    fetch: function (url) {
      const result = url.indexOf('/config') !== -1
        ? { ok: true, data: { sip: {} } }
        : { ok: false, message: 'dcim 设备加载失败' };
      return Promise.resolve({ json: function () { return Promise.resolve(result); } });
    },
  };
  vm.runInNewContext(loadVideoSource, context);
  return {
    loadSource: context.loadSource,
    getCurrentSource: function () { return context.currentSource; },
    getSourceEpoch: function () { return context.sourceEpoch; },
    playbackCalls: playbackCalls,
    renderCalls: renderCalls,
    elements: elements,
  };
}

async function runVideoSourceLoadFailureTests() {
  const harness = createVideoSourceLoadHarness();
  harness.loadSource('dcim', 'btnLoadDcim');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.strictEqual(harness.getCurrentSource(), 'webssh');
  assert.strictEqual(harness.getSourceEpoch(), 7);
  assert.deepStrictEqual(harness.playbackCalls, []);
  assert.deepStrictEqual(harness.renderCalls, []);
  assert.strictEqual(harness.elements.dcimDevHint.textContent, '加载失败：dcim 设备加载失败');
}

function freeLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function requestVideoVendor(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: port, path: '/video/vendor/flv.min.js' }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
  });
}

async function runVideoVendorStaticTests() {
  const vendorPath = path.join(__dirname, '..', 'video', 'vendor', 'flv.min.js');
  assert.strictEqual(fs.existsSync(vendorPath), true, 'video vendor 必须包含 flv.min.js');
  const vendorSource = fs.readFileSync(vendorPath, 'utf8');
  assert.ok(vendorSource.length > 100000, 'flv.min.js 不得为空或截断');

  const port = await freeLocalPort();
  const child = childProcess.spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: 'ignore',
  });
  let response;
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        response = await requestVideoVendor(port);
        break;
      } catch (_error) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(response, '本地 server.js 未在限定时间内响应 video vendor 路由');
    assert.strictEqual(response.statusCode, 200, 'video vendor 静态路由必须返回 200');
    assert.ok(response.body.length > 100000, '静态路由返回的 flv.min.js 不得为空或截断');
  } finally {
    child.kill();
  }

  const browserWindow = {
    navigator: { userAgent: 'Mozilla/5.0' },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
  };
  browserWindow.window = browserWindow;
  const browserContext = {
    window: browserWindow,
    self: browserWindow,
    navigator: browserWindow.navigator,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
  };
  vm.runInNewContext(vendorSource, browserContext, { filename: 'flv.min.js' });
  assert.strictEqual(typeof browserWindow.flvjs.createPlayer, 'function');
  assert.strictEqual(typeof browserWindow.flvjs.isSupported, 'function');
}

async function runVideoPlaybackUiTests() {
  const playbackPlayerConfig = buildTilePlayerConfig({ flvUrl: '/media/record.flv', mode: 'playback' });
  assert.strictEqual(playbackPlayerConfig.type, 'flv');
  assert.strictEqual(playbackPlayerConfig.url, '/media/record.flv');
  assert.strictEqual(playbackPlayerConfig.isLive, false);
  assert.strictEqual(playbackPlayerConfig.hasAudio, false);
  assert.strictEqual(buildTilePlayerConfig({ flvUrl: '/media/live.flv', mode: 'live' }).isLive, true);
  assert.strictEqual(
    tileStopPathForState({ source: 'dcim', mode: 'playback', streamKey: 'rtp/record-1' }, runtime),
    '/api/dcim-video/playback/stop/rtp%2Frecord-1'
  );
  assert.strictEqual(
    tileStopPathForState({
      source: 'webssh', mode: 'live', deviceId: 'device 1', channelId: 'channel/1', liveGeneration: 'webssh generation/1',
    }, runtime),
    '/api/webssh-video/play/stop/device%201/channel%2F1?liveGeneration=webssh%20generation%2F1'
  );
  assert.strictEqual(
    tileStopPathForState({
      source: 'dcim', mode: 'playback', streamKey: 'rtp/record-2', liveGeneration: 'must-not-reach-playback',
    }, runtime),
    '/api/dcim-video/playback/stop/rtp%2Frecord-2'
  );
  const replacementCalls = [];
  replaceTileStream({
    streamKey: 'old-stream',
    stop: function () { replacementCalls.push('stop'); },
    play: function () { replacementCalls.push('play'); },
  }, { streamKey: 'new-stream' });
  assert.deepStrictEqual(replacementCalls, ['stop', 'play']);
  const endedCalls = [];
  assert.strictEqual(stopEndedPlayback({ mode: 'playback', stop: function () { endedCalls.push('stop'); } }), true);
  assert.strictEqual(stopEndedPlayback({ mode: 'live', stop: function () { endedCalls.push('live-stop'); } }), false);
  assert.deepStrictEqual(endedCalls, ['stop']);
  const playbackStopRequests = [];
  const failedPlaybackTile = {
    source: 'dcim', mode: 'playback', deviceId: 'device-1', channelId: 'channel-1', streamKey: 'record/1', revision: 4,
    _destroyPlayer: function () { this.destroyed = true; },
  };
  const playbackFailureHint = { message: '', state: '' };
  failedPlaybackTile.stop = function () {
    releaseTileStream(this, runtime, function (url, options) {
      playbackStopRequests.push({ url: url, options: options });
      return { catch: function () {} };
    });
  };
  assert.strictEqual(handleTilePlaybackFailure(failedPlaybackTile, '回放播放器不可用', function (message, state) {
    playbackFailureHint.message = message;
    playbackFailureHint.state = state;
  }), true);
  assert.strictEqual(failedPlaybackTile.destroyed, true);
  assert.strictEqual(failedPlaybackTile.mode, 'live');
  assert.strictEqual(failedPlaybackTile.streamKey, null);
  assert.strictEqual(failedPlaybackTile.deviceId, null);
  assert.strictEqual(failedPlaybackTile.revision, 5);
  assert.strictEqual(playbackStopRequests.length, 1);
  assert.strictEqual(playbackStopRequests[0].url, '/api/dcim-video/playback/stop/record%2F1');
  assert.strictEqual(playbackStopRequests[0].options.method, 'POST');
  assert.deepStrictEqual(playbackFailureHint, { message: '回放播放器不可用', state: 'err' });
  const realtimeStopRequests = [];
  const liveFailureTile = {
    source: 'webssh', mode: 'live', deviceId: 'device-2', channelId: 'channel/2', streamKey: 'live-stream',
    liveGeneration: 'webssh-live-generation', revision: 3,
    _destroyPlayer: function () { this.destroyed = true; },
  };
  liveFailureTile.stop = function () {
    releaseTileStream(this, runtime, function (url, options) {
      realtimeStopRequests.push({ url: url, options: options });
      return { catch: function () {} };
    });
  };
  let realtimeHintCalled = false;
  assert.strictEqual(handleTilePlaybackFailure(liveFailureTile, '实时播放器错误', function () {
    realtimeHintCalled = true;
  }), true);
  assert.strictEqual(liveFailureTile.destroyed, true);
  assert.strictEqual(liveFailureTile.mode, 'live');
  assert.strictEqual(liveFailureTile.deviceId, null);
  assert.strictEqual(liveFailureTile.revision, 4);
  assert.strictEqual(realtimeStopRequests.length, 1);
  assert.strictEqual(realtimeStopRequests[0].url, '/api/webssh-video/play/stop/device-2/channel%2F2?liveGeneration=webssh-live-generation');
  assert.strictEqual(realtimeStopRequests[0].options.method, 'POST');
  assert.strictEqual(realtimeHintCalled, false);

  const unloadRequests = [];
  function makeUnloadTile(source, mode, deviceId, channelId, streamKey) {
    const tile = {
      source: source, mode: mode, deviceId: deviceId, channelId: channelId, streamKey: streamKey, revision: 0,
      _destroyPlayer: function () {},
    };
    tile.stop = function (options) {
      releaseTileStream(this, runtime, function (url, requestOptions) {
        unloadRequests.push({ url: url, options: requestOptions });
        return { catch: function () {} };
      }, options);
    };
    return tile;
  }
  const unloadLiveTile = makeUnloadTile('dcim', 'live', 'device-3', 'channel/3', 'live-3');
  const unloadPlaybackTile = makeUnloadTile('webssh', 'playback', 'device-4', 'channel-4', 'record/4');
  stopTilesForPageHide([unloadLiveTile, unloadPlaybackTile]);
  assert.strictEqual(unloadRequests.length, 2);
  assert.strictEqual(unloadRequests[0].url, '/api/dcim-video/play/stop/device-3/channel%2F3');
  assert.strictEqual(unloadRequests[1].url, '/api/webssh-video/playback/stop/record%2F4');
  unloadRequests.forEach(function (request) {
    assert.strictEqual(request.options.method, 'POST');
    assert.strictEqual(request.options.keepalive, true);
  });
  const beaconCalls = [];
  const beaconTile = makeUnloadTile('dcim', 'playback', 'device-5', 'channel-5', 'record/5');
  releaseTileStream(beaconTile, runtime, function () {
    throw new Error('sendBeacon 成功时不得调用 fetch');
  }, {
    unload: true,
    navigator: {
      sendBeacon: function (url, data) { beaconCalls.push({ url: url, data: data }); return true; },
    },
  });
  assert.strictEqual(beaconCalls.length, 1);
  assert.strictEqual(beaconCalls[0].url, '/api/dcim-video/playback/stop/record%2F5');

  const validationHarness = createPlaybackControllerHarness();
  validationHarness.controller.setDevices([{ deviceId: 'd1', name: '设备一' }], 'dcim');
  assert.strictEqual(await validationHarness.controller.start(), false);
  assert.strictEqual(validationHarness.elements.hint.textContent, '请选择回放设备');
  validationHarness.elements.device.value = 'd1';
  assert.strictEqual(await validationHarness.controller.start(), false);
  assert.strictEqual(validationHarness.elements.hint.textContent, '请选择回放通道');
  validationHarness.elements.channel.value = 'c1';
  validationHarness.elements.end.value = '2026-07-13T09:59';
  assert.strictEqual(await validationHarness.controller.start(), false);
  assert.strictEqual(validationHarness.elements.hint.textContent, '播放时间范围必须有效、顺序正确且不超过24小时');

  const channelRequests = [];
  const channelHarness = createPlaybackControllerHarness({
    fetch: function (url) {
      channelRequests.push(url);
      return Promise.resolve({ json: function () { return Promise.resolve({
        ok: true,
        list: [
          { channelId: 'offline', name: '离线通道', status: 'OFF' },
          { channelId: 'online-2', name: '在线二', status: 'on' },
          { channelId: 'online-1', name: '在线一', status: 'ON' },
        ],
      }); } });
    },
  });
  channelHarness.controller.setDevices([{ deviceId: 'd1', name: '设备一' }], 'dcim');
  channelHarness.elements.device.value = 'd1';
  assert.strictEqual(await channelHarness.controller.loadChannels(), true);
  assert.deepStrictEqual(channelRequests, ['/api/dcim-video/channels?deviceId=d1&page=1&count=200']);
  assert.deepStrictEqual(channelHarness.elements.channel.options.map(function (option) { return option.value; }), ['', 'online-2', 'online-1', 'offline']);

  const requests = [];
  const targetTile = { revision: 0, mode: 'live', streamKey: 'old-live', playCalls: [] };
  const startHarness = createPlaybackControllerHarness({
    activeTile: targetTile,
    fetch: function (url, options) {
      requests.push({ url: url, options: options });
      return Promise.resolve({ json: function () { return Promise.resolve({
        ok: true, flvUrl: '/media-dcim/rtp/record-1.live.flv', streamKey: 'rtp/record-1',
      }); } });
    },
    replaceTile: function (tile, params) { tile.playCalls.push(params); },
  });
  startHarness.controller.setDevices([{ deviceId: 'd1', name: '设备一' }], 'dcim');
  startHarness.elements.device.value = 'd1';
  startHarness.elements.channel.value = 'c1';
  startHarness.elements.channel.options = [{ value: 'c1', textContent: '通道一' }];
  assert.strictEqual(await startHarness.controller.start(), true);
  assert.strictEqual(requests[0].url, '/api/dcim-video/playback/start/d1/c1');
  assert.strictEqual(requests[0].options.method, 'POST');
  assert.deepStrictEqual(JSON.parse(requests[0].options.body), { startTime: '2026-07-13T10:00', endTime: '2026-07-13T10:10' });
  assert.strictEqual(targetTile.playCalls.length, 1);
  assert.strictEqual(targetTile.playCalls[0].mode, 'playback');

  const controlRequests = [];
  const playbackTile = { mode: 'playback', source: 'webssh', streamKey: 'record/1', revision: 0 };
  const controlHarness = createPlaybackControllerHarness({
    activeTile: playbackTile,
    fetch: function (url, options) {
      controlRequests.push({ url: url, options: options });
      return Promise.resolve({ json: function () { return Promise.resolve({ ok: true }); } });
    },
  });
  assert.strictEqual(await controlHarness.controller.control('pause'), true);
  assert.strictEqual(await controlHarness.controller.control('play'), true);
  assert.strictEqual(await controlHarness.controller.control('scale'), true);
  assert.deepStrictEqual(controlRequests.map(function (request) { return request.url; }), [
    '/api/webssh-video/playback/control/record%2F1/pause',
    '/api/webssh-video/playback/control/record%2F1/play',
    '/api/webssh-video/playback/control/record%2F1/scale',
  ]);
  assert.deepStrictEqual(JSON.parse(controlRequests[2].options.body), { value: '2' });
  controlHarness.setActiveTile({ mode: 'live', source: 'webssh', streamKey: 'live-1' });
  assert.strictEqual(await controlHarness.controller.control('pause'), false);
  assert.strictEqual(controlHarness.elements.hint.textContent, '请先选择正在回放的分屏');
  assert.strictEqual(controlRequests.length, 3);

  let resolveChannelRequest;
  const channelRaceHarness = createPlaybackControllerHarness({
    fetch: function () {
      return new Promise(function (resolve) { resolveChannelRequest = resolve; });
    },
  });
  channelRaceHarness.controller.setDevices([{ deviceId: 'd1', name: '设备一' }], 'dcim');
  channelRaceHarness.elements.device.value = 'd1';
  const staleChannels = channelRaceHarness.controller.loadChannels();
  channelRaceHarness.setSource('webssh');
  channelRaceHarness.setSourceEpoch(2);
  resolveChannelRequest({ json: function () { return Promise.resolve({ ok: true, list: [{ channelId: 'stale', status: 'ON' }] }); } });
  assert.strictEqual(await staleChannels, false);
  assert.deepStrictEqual(channelRaceHarness.elements.channel.options.map(function (option) { return option.value; }), ['']);

  let resolveStartRequest;
  const staleTile = { revision: 0, playCalls: [] };
  const otherTile = { revision: 0, playCalls: [] };
  const staleStartHarness = createPlaybackControllerHarness({
    activeTile: staleTile,
    tiles: [staleTile, otherTile],
    fetch: function () {
      return new Promise(function (resolve) { resolveStartRequest = resolve; });
    },
    replaceTile: function (tile, params) { tile.playCalls.push(params); },
  });
  staleStartHarness.controller.setDevices([{ deviceId: 'd1', name: '设备一' }], 'dcim');
  staleStartHarness.elements.device.value = 'd1';
  staleStartHarness.elements.channel.value = 'c1';
  staleStartHarness.elements.channel.options = [{ value: 'c1', textContent: '通道一' }];
  const staleStart = staleStartHarness.controller.start();
  staleStartHarness.setSource('webssh');
  staleStartHarness.setSourceEpoch(2);
  staleTile.revision++;
  staleStartHarness.setActiveTile(otherTile);
  resolveStartRequest({ json: function () { return Promise.resolve({ ok: true, flvUrl: '/stale.flv', streamKey: 'stale' }); } });
  assert.strictEqual(await staleStart, false);
  assert.strictEqual(staleTile.playCalls.length, 0);
  assert.strictEqual(otherTile.playCalls.length, 0);

  let resolveOwnedStaleStart;
  const ownedPlaybackStopRequests = [];
  const ownedPlaybackTile = {
    revision: 0,
    source: 'dcim',
    mode: 'playback',
    streamKey: 'shared/record',
    playCalls: [],
  };
  const ownedPlaybackHarness = createPlaybackControllerHarness({
    activeTile: ownedPlaybackTile,
    fetch: function (url, options) {
      if (url.indexOf('/playback/start/') !== -1) {
        return new Promise(function (resolve) { resolveOwnedStaleStart = resolve; });
      }
      ownedPlaybackStopRequests.push({ url: url, options: options });
      return Promise.resolve({ json: function () { return Promise.resolve({ ok: true }); } });
    },
    replaceTile: function (tile, params) { tile.playCalls.push(params); },
  });
  ownedPlaybackHarness.controller.setDevices([{ deviceId: 'd1', name: '设备一' }], 'dcim');
  ownedPlaybackHarness.elements.device.value = 'd1';
  ownedPlaybackHarness.elements.channel.value = 'c1';
  ownedPlaybackHarness.elements.channel.options = [{ value: 'c1', textContent: '通道一' }];
  const ownedStaleStart = ownedPlaybackHarness.controller.start();
  ownedPlaybackTile.revision++;
  resolveOwnedStaleStart({ json: function () { return Promise.resolve({
    ok: true,
    flvUrl: '/shared.flv',
    streamKey: 'shared/record',
  }); } });
  assert.strictEqual(await ownedStaleStart, false);
  assert.deepStrictEqual(ownedPlaybackStopRequests, [], '过期响应不得停止活动 Tile 已持有的回放流');

  let resolveChangedFormStart;
  const changedFormRequests = [];
  const changedFormTile = { revision: 0, playCalls: [] };
  const changedFormHarness = createPlaybackControllerHarness({
    activeTile: changedFormTile,
    fetch: function (url, options) {
      changedFormRequests.push({ url: url, options: options });
      if (url.indexOf('/playback/start/') !== -1) {
        return new Promise(function (resolve) { resolveChangedFormStart = resolve; });
      }
      return Promise.resolve({ json: function () { return Promise.resolve({ ok: true }); } });
    },
    replaceTile: function (tile, params) { tile.playCalls.push(params); },
  });
  changedFormHarness.controller.setDevices([
    { deviceId: 'device-a', name: '设备 A' },
    { deviceId: 'device-b', name: '设备 B' },
  ], 'dcim');
  changedFormHarness.elements.device.value = 'device-a';
  changedFormHarness.elements.channel.value = 'channel-a';
  changedFormHarness.elements.channel.options = [{ value: 'channel-a', textContent: '通道 A' }];
  const changedFormStart = changedFormHarness.controller.start();
  changedFormHarness.elements.device.value = 'device-b';
  changedFormHarness.elements.channel.value = 'channel-b';
  changedFormHarness.elements.start.value = '2026-07-13T10:01';
  changedFormHarness.elements.end.value = '2026-07-13T10:20';
  resolveChangedFormStart({ json: function () { return Promise.resolve({ ok: true, flvUrl: '/old.flv', streamKey: 'old/record' }); } });
  assert.strictEqual(await changedFormStart, false);
  assert.strictEqual(changedFormTile.playCalls.length, 0);
  assert.strictEqual(changedFormRequests[1].url, '/api/dcim-video/playback/stop/old%2Frecord');
  assert.strictEqual(changedFormRequests[1].options.method, 'POST');

  let resolveFixedTileStart;
  const fixedTile = { revision: 0, playCalls: [] };
  const changedActiveTile = { revision: 0, playCalls: [] };
  const fixedTileHarness = createPlaybackControllerHarness({
    activeTile: fixedTile,
    tiles: [fixedTile, changedActiveTile],
    fetch: function () {
      return new Promise(function (resolve) { resolveFixedTileStart = resolve; });
    },
    replaceTile: function (tile, params) { tile.playCalls.push(params); },
  });
  fixedTileHarness.controller.setDevices([{ deviceId: 'd1', name: '设备一' }], 'dcim');
  fixedTileHarness.elements.device.value = 'd1';
  fixedTileHarness.elements.channel.value = 'c1';
  fixedTileHarness.elements.channel.options = [{ value: 'c1', textContent: '通道一' }];
  const fixedTileStart = fixedTileHarness.controller.start();
  fixedTileHarness.setActiveTile(changedActiveTile);
  resolveFixedTileStart({ json: function () { return Promise.resolve({ ok: true, flvUrl: '/record.flv', streamKey: 'record-2' }); } });
  assert.strictEqual(await fixedTileStart, true);
  assert.strictEqual(fixedTile.playCalls.length, 1);
  assert.strictEqual(changedActiveTile.playCalls.length, 0);
}

async function runLiveTileReplacementRaceTests() {
  const prepareTileForReplacement = vm.runInNewContext(
    '(' + extractVideoFunction('prepareTileForReplacement') + ')',
    { Promise: Promise }
  );
  const calls = [];
  let releaseStop;
  const tile = {
    revision: 0,
    source: 'dcim',
    mode: 'live',
    deviceId: 'device-1',
    channelId: 'channel-1',
    streamKey: 'old-live',
    stop: function () {
      calls.push('stop');
      return new Promise(function (resolve) { releaseStop = resolve; });
    },
    play: function (params) {
      calls.push('play:' + params.streamKey);
      this.revision++;
      this.source = params.source;
      this.mode = params.mode;
      this.deviceId = params.deviceId;
      this.channelId = params.channelId;
      this.streamKey = params.streamKey;
    },
  };
  const context = {
    Promise: Promise,
    encodeURIComponent: encodeURIComponent,
    currentSource: 'dcim',
    sourceEpoch: 1,
    activeIdx: 0,
    tiles: [tile],
    hint: { textContent: '' },
    window: { DcimVideoRuntime: runtime },
    tileStopPathForState: tileStopPathForState,
    replaceTileStream: function (target, params) { target.play(params); return true; },
    prepareTileForReplacement: prepareTileForReplacement,
    fetch: function (url) {
      if (url.indexOf('/channels?') !== -1) {
        return Promise.resolve({ json: function () { return Promise.resolve({
          ok: true,
          list: [{ channelId: 'channel-1', name: '通道一', status: 'ON' }],
        }); } });
      }
      if (url.indexOf('/play/') !== -1) {
        calls.push('start');
        return new Promise(function () {});
      }
      throw new Error('意外请求: ' + url);
    },
  };
  const livePlaySource = extractVideoFunction('playFromDevice');
  vm.runInNewContext(livePlaySource + '\nthis.playFromDevice = playFromDevice;', context);

  context.playFromDevice('device-1', '设备一');
  context.playFromDevice('device-1', '设备一');
  for (let turn = 0; turn < 5; turn++) await new Promise(function (resolve) { setImmediate(resolve); });
  assert.deepStrictEqual(calls, ['stop'], '旧流 stop 完成前不得发送新的实时点播');

  releaseStop();
  for (let turn = 0; turn < 5; turn++) await new Promise(function (resolve) { setImmediate(resolve); });
  assert.deepStrictEqual(calls, ['stop', 'start'], '连续双击只允许最新请求在 stop 后发起点播');
}

async function runLiveGenerationUiTests() {
  const targetTile = {
    revision: 0,
    source: null,
    mode: 'live',
    deviceId: null,
    channelId: null,
    streamKey: null,
    liveGeneration: null,
    _liveStartRequestId: 0,
    _liveStartPending: null,
    play: function (params) {
      this.source = params.source;
      this.mode = params.mode;
      this.deviceId = params.deviceId;
      this.channelId = params.channelId;
      this.streamKey = params.streamKey;
      this.liveGeneration = params.liveGeneration;
    },
  };
  const context = {
    Promise: Promise,
    encodeURIComponent: encodeURIComponent,
    currentSource: 'dcim',
    sourceEpoch: 1,
    activeIdx: 0,
    tiles: [targetTile],
    hint: { textContent: '' },
    window: { DcimVideoRuntime: runtime },
    tileStopPathForState: tileStopPathForState,
    replaceTileStream: replaceTileStream,
    prepareTileForReplacement: function () { return Promise.resolve({ state: 'empty' }); },
    fetch: function (url) {
      if (url.indexOf('/channels?') !== -1) {
        return Promise.resolve({ json: function () { return Promise.resolve({
          ok: true,
          list: [{ channelId: 'channel-1', name: '通道一', status: 'ON' }],
        }); } });
      }
      if (url.indexOf('/play/device-1/channel-1') !== -1) {
        return Promise.resolve({ json: function () { return Promise.resolve({
          ok: true,
          flvUrl: '/media-dcim/rtp/live.flv',
          streamKey: 'rtp/live',
          liveGeneration: 'dcim-generation-2',
        }); } });
      }
      throw new Error('意外请求: ' + url);
    },
  };
  const livePlaySource = extractVideoFunction('playFromDevice');
  vm.runInNewContext(livePlaySource + '\nthis.playFromDevice = playFromDevice;', context);

  context.playFromDevice('device-1', '设备一');
  for (let turn = 0; turn < 5; turn++) await new Promise(function (resolve) { setImmediate(resolve); });
  assert.strictEqual(targetTile.liveGeneration, 'dcim-generation-2', 'Tile 必须保存起播响应的 liveGeneration');
  assert.strictEqual(
    tileStopPathForState(targetTile, runtime),
    '/api/dcim-video/play/stop/device-1/channel-1?liveGeneration=dcim-generation-2',
    '实时 Tile stop 必须携带保存的 liveGeneration'
  );
}

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

runWvpRuntimeOperationTests().then(runSshCommandTimeoutTests).then(runSshCommandLateEventTests).then(runWvpRuntimeRouteContractTests).then(runDcimVideoConnectionRouteContractTests).then(runDcimVideoSystemConfigRedactionTests).then(runDcimVideoConnectionRaceTests).then(runDcimVideoAtomicWriteTests).then(runDcimVideoConnectionUiTests).then(runLiveStreamGenerationRouteTests).then(runVideoVendorStaticTests).then(runVideoSourceLoadFailureTests).then(runVideoPlaybackUiTests).then(runLiveTileReplacementRaceTests).then(runLiveGenerationUiTests).then(runProtocolMainSyncRollbackFailureTests).then(() => {
  console.log('dcim wvp opengauss tests: PASS');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
