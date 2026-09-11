'use strict';
const assert = require('assert');
const { loadOptions } = require('../proto-conv/wecom-options');
(async () => {
  const helper = { getCfg: () => ({ userLsh: '1' }), callUpstream: async args => ({ ok: true, data: { code: 100, data:
    args.key === 'GetNewAllAreasKey' ? { info: [{ Zonesubname: 'Room' }] } :
    args.key === 'GetDeviceListKey' ? [{ DeviceName: 'Idle UPS' }] :
    [{ AlarmID: 'a', AlarmTime: '2026-09-09 08:00:00', DeviceName: 'UPS', ZoneSubName: 'Room', AlarmLevel: '4' }]
  } }) };
  const result = await loadOptions(helper, {});
  assert.deepStrictEqual(result.areas, ['Room']);
  assert.ok(result.devices.includes('Idle UPS')); assert.ok(result.devices.includes('UPS'));
  assert.deepStrictEqual(result.levels, ['4']); assert.deepStrictEqual(result.warnings, []);
  helper.callUpstream = async () => ({ ok: false });
  const failed = await loadOptions(helper, {}); assert.ok(failed.warnings.length); assert.deepStrictEqual(failed.levels, []);
  console.log('PASS WeCom options discovery and failure reporting');
})().catch(e => { console.error(e); process.exitCode = 1; });
