'use strict';
const assert = require('assert');
const cp = require('child_process');
const db = require('../proto-conv/b-interface-alarm-db');
const primary = '/www/dbconfig.json';
const collection = '/www/python/src/collection/dbconfig.json';
const web = '/www/wwwroot/localhost_8086/wwwroot/dbconfig.json';
const profile = JSON.stringify({ type: 'mysql', host: '127.0.0.1', port: 3306,
  name: 'dcim', user: 'dcim', password: 'PRIVATE_PASSWORD' });
const rows = JSON.stringify({ kind: 'rule', ruleId: '7', deviceId: '3', baseName: '断线' });

// Docker is the external boundary; exercise the real reader and execFile error handling.
async function scenario(handler, verify) {
  const original = cp.execFile, calls = [];
  cp.execFile = (file, args, options, callback) => {
    assert.strictEqual(file, 'docker');
    return { stdin: { on: () => {}, end: input => {
      calls.push({ args, input });
      Promise.resolve().then(() => handler(args, input)).then(result => {
        callback(result.error || null, result.stdout || '', result.stderr || '');
      }).catch(error => callback(error, '', ''));
    } } };
  };
  try {
    await verify(() => db.read({ baseUrl: 'http://127.0.0.1' }, ['3']), calls);
  } finally { cp.execFile = original; }
}
function missing(file) {
  return { error: Object.assign(new Error('child failed'), { code: 1 }),
    stderr: 'cat: ' + file + ': No such file or directory\n' };
}
function isConfig(args) { return args.includes('cat'); }

async function runTests() {
  await scenario(args => ({ stdout: isConfig(args) ? profile : rows }), async (read, calls) => {
    assert.strictEqual((await read()).rules.length, 1);
    assert.deepStrictEqual(calls.filter(c => isConfig(c.args)).map(c => c.args.slice(-1)[0]), [primary]);
  });
  await scenario(args => isConfig(args) && args.slice(-1)[0] === primary ? missing(primary) :
    { stdout: isConfig(args) ? profile : rows }, async (read, calls) => {
    assert.strictEqual((await read()).rules.length, 1, 'ARM 缺少主配置时应使用采集端配置');
    assert.deepStrictEqual(calls.filter(c => isConfig(c.args)).map(c => c.args.slice(-1)[0]), [primary, collection]);
    assert.ok(calls[calls.length - 1].input.startsWith('PRIVATE_PASSWORD\n'));
    assert.ok(!calls.some(c => c.args.join(' ').includes('PRIVATE_PASSWORD')));
  });
  await scenario(args => isConfig(args) && args.slice(-1)[0] !== web ? missing(args.slice(-1)[0]) :
    { stdout: isConfig(args) ? '\uFEFF' + profile + '\n' : rows }, async read => {
    assert.strictEqual((await read()).rules.length, 1, '8086 候选配置应兼容 UTF-8 BOM');
  });
  await scenario(args => isConfig(args) ? missing(args.slice(-1)[0]) : { stdout: rows }, async (read, calls) => {
    await assert.rejects(read, e => /未找到.*数据库配置/.test(e.message) && e.message.includes(collection));
    assert.strictEqual(calls.length, 3);
  });
  for (const invalid of ['not JSON PRIVATE_PASSWORD', 'null', '[]']) {
    await scenario(() => ({ stdout: invalid }), async (read, calls) => {
      await assert.rejects(read, e => /配置格式/.test(e.message) && e.message.includes(primary) && !e.message.includes('PRIVATE_PASSWORD'));
      assert.strictEqual(calls.length, 1, '配置损坏不能切换到其他数据源');
    });
  }
  await scenario(() => ({ error: Object.assign(new Error('denied'), { code: 1 }),
    stderr: 'cat: ' + primary + ': Permission denied\n' }), async (read, calls) => {
    await assert.rejects(read, /权限/); assert.strictEqual(calls.length, 1);
  });
  await scenario(() => ({ error: Object.assign(new Error('no docker'), { code: 'ENOENT' }) }), async (read, calls) => {
    await assert.rejects(read, /Docker.*命令/); assert.strictEqual(calls.length, 1);
  });
  await scenario(() => ({ error: Object.assign(new Error('failed'), { code: 1 }),
    stderr: 'Error response from daemon: No such container: dcim' }), async (read, calls) => {
    await assert.rejects(read, /dcim.*容器.*不存在/); assert.strictEqual(calls.length, 1);
  });
  await scenario(() => ({ error: Object.assign(new Error('failed'), { code: 1 }),
    stderr: 'Error response from daemon: Container abc is not running' }), async (read, calls) => {
    await assert.rejects(read, /容器.*未运行/); assert.strictEqual(calls.length, 1);
  });
  for (const failure of [
    { error: Object.assign(new Error('timeout'), { killed: true }), match: /超时/ },
    { error: Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), match: /缓冲区/ },
    { error: Object.assign(new Error('PRIVATE_PASSWORD'), { code: 1 }), stderr: 'ERROR 1045 PRIVATE_PASSWORD', match: /1045.*认证/ },
    { error: Object.assign(new Error('PRIVATE_PASSWORD'), { code: 1 }), stderr: 'ERROR 1054 PRIVATE_PASSWORD', match: /1054.*字段/ },
    { error: Object.assign(new Error('PRIVATE_PASSWORD'), { code: 1 }), stderr: 'unclassified PRIVATE_PASSWORD', match: /MySQL 查询失败/ }
  ]) {
    await scenario(args => isConfig(args) ? { stdout: profile } : failure, async read => {
      await assert.rejects(read, e => failure.match.test(e.message) && !e.message.includes('PRIVATE_PASSWORD'));
    });
  }
  console.log('PASS alarm DB paths: x86 priority, ARM fallback, BOM, fail-closed profiles, safe Docker/MySQL errors');
}
module.exports = runTests;
if (require.main === module) runTests().catch(e => { console.error(e); process.exitCode = 1; });
