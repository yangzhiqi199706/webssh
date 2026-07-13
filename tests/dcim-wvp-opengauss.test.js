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

function postJson(app, pathname) {
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
        method: 'POST',
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
      request.end();
    });
  });
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

runWvpRuntimeOperationTests().then(runSshCommandTimeoutTests).then(runSshCommandLateEventTests).then(runWvpRuntimeRouteContractTests).then(() => {
  console.log('dcim wvp opengauss tests: PASS');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
