'use strict';

const assert = require('assert');
const vm = require('vm');
const {
  mergeDcimVideoConfig,
  publicDcimVideoConfig,
  parseWvpRuntimeProbe,
  wvpRuntimeProbeCommand,
} = require('../lib/dcim-wvp');
const runtime = require('../video/assets/js/video-runtime');

const validProbeText = [
  'service.active=active',
  'service.enabled=enabled',
  'legacyService.active=inactive',
  'legacyService.enabled=disabled',
  'listeners.tcp5060=1',
  'listeners.http18080=1',
  'datasource.driver=org.postgresql.Driver',
  'datasource.url=jdbc:postgresql://127.0.0.1:5432/wvp',
  'datasource.dialect=org.hibernate.dialect.PostgreSQLDialect',
  'datasource.mysqlUrl=jdbc:mysql://127.0.0.1:3306/legacy',
  'database.reachable=ok',
  'logs.recentError=none',
].join('\n');

assert.deepStrictEqual(
  publicDcimVideoConfig(mergeDcimVideoConfig({
    username: 'admin',
    password: 'test-password',
    timeoutMs: 7000,
  }, {})),
  {
    apiBase: 'https://127.0.0.1:8082',
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
assert.throws(() => mergeDcimVideoConfig({ timeoutMs: 999 }, {}), /1000/);
assert.throws(() => mergeDcimVideoConfig({ timeoutMs: 30001 }, {}), /30000/);
assert.strictEqual(mergeDcimVideoConfig({ timeoutMs: 1000 }, {}).timeoutMs, 1000);
assert.strictEqual(mergeDcimVideoConfig({ timeoutMs: 30000 }, {}).timeoutMs, 30000);

const parsed = parseWvpRuntimeProbe(validProbeText);
assert.strictEqual(parsed.status, 'ready');
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
  parseWvpRuntimeProbe(validProbeText.replace('legacyService.enabled=disabled', 'legacyService.enabled=enabled')).restartAllowed,
  false
);

['service.active', 'listeners.tcp5060', 'datasource.driver', 'database.reachable', 'logs.recentError'].forEach((missingKey) => {
  const missing = validProbeText.split('\n').filter((line) => line.indexOf(missingKey + '=') !== 0).join('\n');
  assert.strictEqual(parseWvpRuntimeProbe(missing).checks[missingKey.split('.')[0]].healthy, false, missingKey);
});
assert.strictEqual(runtime.validatePlaybackRange('', '').ok, false);
assert.strictEqual(runtime.validatePlaybackRange('2026-07-13T12:10:00Z', '2026-07-13T12:00:00Z').ok, false);
assert.strictEqual(runtime.validatePlaybackRange('2026-07-13T00:00:00Z', '2026-07-14T00:00:01Z').ok, false);
assert.deepStrictEqual(
  runtime.validatePlaybackRange('2026-07-13T12:00:00Z', '2026-07-13T12:10:00Z'),
  { ok: true, startTime: '2026-07-13T12:00:00Z', endTime: '2026-07-13T12:10:00Z' }
);

assert.strictEqual(
  runtime.stopPath('dcim', 'live', 'device 1', 'channel/1', ''),
  '/api/dcim-video/play/stop/device%201/channel%2F1'
);
assert.strictEqual(
  runtime.stopPath('webssh', 'live', 'device 1', 'channel/1', ''),
  '/api/webssh-video/play/stop/device%201/channel%2F1'
);
assert.strictEqual(
  runtime.stopPath('dcim', 'playback', '', '', 'device 1/channel 1'),
  '/api/dcim-video/playback/stop/device%201%2Fchannel%201'
);
assert.strictEqual(
  runtime.stopPath('webssh', 'playback', '', '', 'device 1/channel 1'),
  '/api/webssh-video/playback/stop/device%201%2Fchannel%201'
);

const browser = { window: {} };
vm.runInNewContext(require('fs').readFileSync(require.resolve('../video/assets/js/video-runtime'), 'utf8'), browser);
assert.strictEqual(typeof browser.window.DcimVideoRuntime.validatePlaybackRange, 'function');
assert.strictEqual(typeof browser.window.DcimVideoRuntime.stopPath, 'function');

const command = wvpRuntimeProbeCommand();
assert.match(command, /service\.active=/);
assert.match(command, /listeners\.tcp5060=/);
assert.match(command, /datasource\.url=/);
assert.match(command, /wvp-opengauss\.service/);
assert.match(command, /jdbc:postgresql:/);
assert.doesNotMatch(command, /WVP_DB_PASSWORD/);
assert.strictEqual(parseWvpRuntimeProbe(command).checks.service.healthy, false);
assert.ok(command.split('&&').every((part) => part.indexOf('|| true') !== -1 || part.indexOf('printf') !== -1));

console.log('dcim wvp opengauss tests: PASS');
