'use strict';

const assert = require('assert');
const {
  mergeDcimVideoConfig,
  publicDcimVideoConfig,
  parseWvpRuntimeProbe,
  wvpRuntimeProbeCommand,
} = require('../lib/dcim-wvp');
const { validatePlaybackRange, stopPath } = require('../video/assets/js/video-runtime');

function completeProbe() {
  return {
    service: { active: true, enabled: true },
    legacyService: { active: false, enabled: false },
    listeners: { tcp5060: true, http18080: true },
    datasource: {
      driver: 'org.postgresql.Driver',
      url: 'jdbc:postgresql://127.0.0.1:5432/wvp',
      dialect: 'org.hibernate.dialect.PostgreSQLDialect',
    },
    database: { reachable: true },
    logs: { recentError: false },
  };
}

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

const parsed = parseWvpRuntimeProbe(completeProbe());
assert.strictEqual(parsed.status, 'ready');
assert.strictEqual(parsed.restartAllowed, true);
assert.ok(parsed.checks.service);
assert.ok(parsed.checks.legacyService);
assert.ok(parsed.checks.listeners);
assert.ok(parsed.checks.datasource);
assert.ok(parsed.checks.database);
assert.ok(parsed.checks.logs);
assert.strictEqual(JSON.stringify(parsed).includes('password'), false);

assert.strictEqual(
  parseWvpRuntimeProbe({ ...completeProbe(), legacyService: { active: 'active', enabled: true } }).restartAllowed,
  false
);
assert.strictEqual(parseWvpRuntimeProbe({}).checks.legacyService.healthy, false);
assert.strictEqual(validatePlaybackRange('', ''), false);
assert.strictEqual(validatePlaybackRange('2026-07-13T12:10:00Z', '2026-07-13T12:00:00Z'), false);
assert.strictEqual(validatePlaybackRange('2026-07-13T00:00:00Z', '2026-07-14T00:00:01Z'), false);
assert.strictEqual(validatePlaybackRange('2026-07-13T12:00:00Z', '2026-07-13T12:10:00Z'), true);

assert.strictEqual(
  stopPath({ provider: 'dcim', kind: 'live', deviceId: 'device-1', channelId: 'channel-1' }),
  '/api/dcim-video/play/stop/device-1/channel-1'
);
assert.strictEqual(
  stopPath({ provider: 'dcim', kind: 'playback', streamKey: 'device 1/channel 1' }),
  '/api/dcim-video/playback/stop/device%201%2Fchannel%201'
);
assert.strictEqual(
  stopPath({ provider: 'webssh', kind: 'playback', streamKey: 'device 1/channel 1' }),
  '/api/webssh/playback/stop/device%201%2Fchannel%201'
);

assert.match(wvpRuntimeProbeCommand(), /wvp-opengauss\.service/);
assert.match(wvpRuntimeProbeCommand(), /jdbc:postgresql:/);
assert.doesNotMatch(wvpRuntimeProbeCommand(), /WVP_DB_PASSWORD/);

console.log('dcim wvp opengauss tests: PASS');
