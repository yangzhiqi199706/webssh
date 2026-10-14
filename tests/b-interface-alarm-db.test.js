'use strict';
const assert = require('assert'), db = require('../proto-conv/b-interface-alarm-db');
(async () => {
  const calls = [], options = { localHost: host => host === '192.168.50.61', execute: async (args, input) => {
    calls.push({ args, input });
    return args.includes('cat') ? JSON.stringify({ type: 'mysql', name: 'dcim', user: 'dcim', password: 'PRIVATE_PASSWORD', host: '127.0.0.1' }) :
      JSON.stringify({ kind: 'type', id: '5', name: '设备连接异常' }) + '\n' + JSON.stringify({ kind: 'rule', ruleId: '7', deviceId: '3', baseName: '断线', type: 5 });
  } };
  const result = await db.read({ baseUrl: 'http://192.168.50.61:8082' }, ['3', '3'], options);
  assert.strictEqual(result.rules.length, 1); assert.deepStrictEqual(result.deviceIds, ['3']); assert.strictEqual(result.types['5'], '设备连接异常');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_PASSWORD'));
  assert.ok(!calls[1].args.join(' ').includes('PRIVATE_PASSWORD')); assert.ok(calls[1].input.startsWith('PRIVATE_PASSWORD\n'));
  assert.ok(calls[1].input.includes('PREPARE') && calls[1].input.includes('USING @b_device_ids'));
  assert.ok(!/INSERT |UPDATE |DELETE |ALTER |DROP /i.test(calls[1].input));
  const before = calls.length;
  for (const ids of [[], ['3);DROP TABLE x'], ['0'], ['-1'], Array(501).fill('3')]) await assert.rejects(() => db.read({ baseUrl: 'http://192.168.50.61' }, ids, options));
  await assert.rejects(() => db.read({ baseUrl: 'http://other-host' }, ['3'], options), /同一台/); assert.strictEqual(calls.length, before);
  await assert.rejects(() => db.read({ baseUrl: 'http://192.168.50.61' }, ['3'], Object.assign({}, options, { execute: async () => 'not json' })), /配置格式/);
  await assert.rejects(() => db.read({ baseUrl: 'http://192.168.50.61' }, ['3'], { localHost: () => true, execute: async args => args.includes('cat') ? JSON.stringify({ type: 'opengauss' }) : '' }), /MySQL/);
  const bad = Object.assign({}, options, { execute: async args => args.includes('cat') ? JSON.stringify({ type: 'mysql', name: 'dcim', user: 'dcim', password: 'x\ny' }) : '' });
  await assert.rejects(() => db.read({ baseUrl: 'http://192.168.50.61' }, ['3'], bad), /配置/);
  const other = Object.assign({}, options, { execute: async (args, input) => args.includes('cat') ? options.execute(args, input) : JSON.stringify({ kind: 'rule', deviceId: '4' }) });
  await assert.rejects(() => db.read({ baseUrl: 'http://192.168.50.61' }, ['3'], other), /范围/);
  assert.strictEqual(db.localHost('127.0.0.1'), true);
  assert.strictEqual(db.localHost('[::1]'), true);
  await assert.rejects(() => db.read({ baseUrl: 'ftp://192.168.50.61' }, ['3'], options), /HTTP/);
  const tooMany = Object.assign({}, options, { execute: async (args,input) => args.includes('cat') ? options.execute(args,input) : Array(10001).fill(JSON.stringify({ kind: 'rule', deviceId: '3' })).join('\n') });
  await assert.rejects(() => db.read({ baseUrl: 'http://192.168.50.61' }, ['3'], tooMany), /10000/);
  await require('./b-interface-alarm-db-paths.test')();
  console.log('PASS alarm DB read: local source, strict scope, container mysql, prepared SELECT, stdin secrets, profile and response guards');
})().catch(e => { console.error(e); process.exitCode = 1; });
