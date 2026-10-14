'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const modulePath = path.join(__dirname, '../lib/kingbase-manager.js');
assert(fs.existsSync(modulePath), '需要人大金仓适配器');
const kb = require(modulePath);

async function main() {
  const calls = [];
  let ended = 0;
  class Client {
    constructor(config) { this.config = config; }
    async connect() { calls.push(this.config); }
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql === 'bad') throw new Error('SQL failed');
      return { fields: [{ name: 'n' }], rows: [{ n: 1 }, { n: 2 }], rowCount: 2, command: 'SELECT' };
    }
    async end() { ended++; }
  }
  const manager = kb.createManager({ Client }, () => ({ host: 'db.example', port: 54321, username: 'dcim', password: 'secret', database: 'dcim' }));
  const result = await manager.query('SELECT 1', 1, 'other');
  assert.equal(calls[0].database, 'other', '所选数据库必须传递给连接');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rowCount, 2);
  assert(result.notice);
  assert.equal(ended, 1);
  await assert.rejects(manager.query('bad'), /SQL failed/);
  assert.equal(ended, 2, '失败也关闭连接');
  calls.length = 0;
  await manager.tables('other');
  assert.equal(calls[0].database, 'other');
  assert(calls[1].sql.includes('schemaname AS schema'));
  calls.length = 0;
  await manager.table('other', 'Mixed"Table', "custom' schema");
  assert.deepEqual(calls[1].values, ["custom' schema", 'Mixed"Table']);
  assert(calls.some(x => x.sql && x.sql.includes('"custom\' schema"."Mixed""Table"')));
  assert.equal(kb.quoteIdentifier('a"b'), '"a""b"');
  assert.throws(() => kb.quoteIdentifier('a\0b'), /名称/);
  const config = Object.assign({}, kb.defaults, { password: "p'$(touch /tmp/nope)", username: 'dcim' });
  const dump = kb.nativeCommand(config, 'backup', 'dcim', '/tmp/kb.dump');
  assert(dump.includes('sys_dump'));
  assert(dump.includes('-F c'));
  assert(dump.includes('KINGBASE_PASSWORD='));
  assert(dump.includes("'p'\\''$(touch /tmp/nope)'"), '密码必须完整 shell 引用');
  assert(kb.nativeCommand(config, 'restore', 'dcim', '/tmp/kb.dump').includes('--exit-on-error --single-transaction'));
  assert.throws(() => kb.nativeCommand(config, 'backup', '../escape', '/tmp/a'), /数据库名/);
  assert.throws(() => kb.nativeCommand(config, 'invalid', 'dcim', '/tmp/a'), /操作/);
  const safe = kb.redact(Object.assign({}, config, { ssh: { host: 'ssh.example', password: 'ssh-secret' } }));
  assert.equal(safe.password, '***');
  assert.equal(safe.ssh.password, '***');
  assert(safe.ssh.hasPassword);
  assert(!JSON.stringify(safe).includes('ssh-secret'));
  console.log('kingbase adapter: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
