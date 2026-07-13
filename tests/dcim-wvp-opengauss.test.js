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
assert.strictEqual(
  parseWvpRuntimeProbe(validProbeText.replace('listeners.java_wvp=1', 'listeners.java_wvp=0')).checks.listeners.healthy,
  false
);

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
assert.strictEqual(runtime.validatePlaybackRange('2026-07-13T12:10:00Z', '2026-07-13T12:00:00Z').ok, false);
assert.strictEqual(runtime.validatePlaybackRange('2026-07-13T00:00:00Z', '2026-07-14T00:00:01Z').ok, false);
assert.deepStrictEqual(
  runtime.validatePlaybackRange('2026-07-13T12:00:00Z', '2026-07-13T12:10:00Z'),
  { ok: true, startTime: '2026-07-13T12:00:00Z', endTime: '2026-07-13T12:10:00Z' }
);

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

const command = wvpRuntimeProbeCommand();
assert.match(command, /service\.active=/);
assert.match(command, /listeners\.java_wvp=/);
assert.match(command, /listeners\.http_18080=/);
assert.match(command, /listeners\.sip_5060=/);
assert.match(command, /datasource\.postgresDriver=/);
assert.match(command, /database\.wvp_app_connections=/);
assert.match(command, /logs\.db_error_lines=/);
assert.match(command, /jdbc:postgresql:\/\/127\.0\.0\.1:5432\/dcim/);
assert.match(command, /:5060\(\[\[:space:\]\]\|\$\)/);
assert.match(command, /:18080\(\[\[:space:\]\]\|\$\)/);
assert.match(command, /wvp-opengauss\.service/);
assert.match(command, /grep -c/);
assert.match(command, /case/);
assert.match(command, /journalctl -u wvp-opengauss\.service --since '10 min ago'/);
assert.match(command, /omm|gsql/);
assert.match(command, /\/www\/media\/wvp-GB28181-pro\/target\/classes\/application-dev\.yml/);
assert.doesNotMatch(command, /\/opt\/wvp\/config/);
assert.match(command, /export GAUSSHOME=/);
assert.match(command, /export PATH=\$GAUSSHOME\/bin:\$PATH/);
assert.match(command, /export LD_LIBRARY_PATH=\$GAUSSHOME\/lib:\$LD_LIBRARY_PATH/);
assert.match(command, /gsql -d dcim/);
assert.doesNotMatch(command, /gsql -d wvp/);
assert.doesNotMatch(command, /(?:^|[;&| ])(?:head|cat|sed)(?:\s|$)/);
assert.doesNotMatch(command, /WVP_DB_PASSWORD/);
assert.ok((command.match(/\|\| true/g) || []).length >= 12);

console.log('dcim wvp opengauss tests: PASS');
