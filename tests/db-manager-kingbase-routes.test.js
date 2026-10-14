'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const start = source.indexOf('(function setupDbManager()');
const end = source.indexOf('\nconst port = Number(process.env.PORT', start);
const routes = {};
const calls = [];
let failDump = false;
let account = { role: 'admin' };
class PgClient {
  constructor(config) { calls.push(config); }
  on() {}
  async connect() {}
  async query(sql, values) {
    calls.push({ sql, values });
    return { fields: [{ name: 'name' }], rows: [{ name: 'demo', schema: 'custom' }], rowCount: 1 };
  }
  async end() {}
}
const context = {
  requireAccount(req, res) { if (!account) { res.status(401).json({ok:false}); return null; } return account; },
  require: id => id === 'pg' ? { Client: PgClient } : require(id.startsWith('.') ? path.join(root, id) : id),
  fs: Object.assign({}, fs, { readFileSync: () => { throw new Error('no config'); }, mkdirSync() {}, writeFileSync() {}, chmodSync() {}, appendFileSync() {} }),
  __dirname: root, process: { env: {} }, console, Buffer, setTimeout, clearTimeout, registerWvpRuntimeRoutes() {},
  isAuthed() { return true; }, global: {}, app: Object.fromEntries(['get', 'put', 'post', 'delete'].map(method => [method, (url, handler) => { routes[method + ' ' + url] = handler; }])),
  shellEscape: s => "'" + String(s).replace(/'/g, "'\\''") + "'",
  sshExecCommand: (config, command, cb) => {
    calls.push({ ssh: config, command });
    cb(null, failDump && command.includes('sys_dump')
      ? { code: 1, stdout: '', stderr: 'dump failed secret ssh-secret' }
      : { code: 0, stdout: 'active', stderr: '' });
  },
};
vm.runInNewContext(source.slice(start, end), context);
async function request(method, url, body, params, query) {
  let response; let status = 200;
  const res = { json: value => { response = JSON.parse(JSON.stringify(value)); }, status: value => { status = value; return res; } };
  await routes[method + ' ' + url]({ body: body || {}, params: params || {}, query: query || {} }, res);
  return { status, body: response };
}
async function main() {
  account = null;
  assert.equal((await request('get', '/api/db-manager/kingbase/license')).status, 401);
  account = {role:'user'};
  assert.equal((await request('post', '/api/db-manager/kingbase/upload-license')).status, 403);
  account = {role:'admin'};
  let r = await request('get', '/api/db-manager/config');
  assert(r.body.config.databases.kingbase, '配置接口应包含人大金仓');
  await request('put', '/api/db-manager/config', { databases: { kingbase: {
    host: 'kb.example', database: 'dcim', password: 'secret',
    ssh: { host: 'kb-ssh.example', username: 'root', password: 'ssh-secret' }, container: 'kingbase-container',
  } } });
  r = await request('get', '/api/db-manager/config');
  assert.equal(r.body.config.databases.kingbase.ssh.password, '***');
  assert.equal(r.body.config.ssh.host, '192.168.0.60', '独立金仓 SSH 不覆盖原三库配置');
  await request('put', '/api/db-manager/config', { databases: { kingbase: { password: '', ssh: { password: '***' } } } });
  assert.equal(context.global.__dbMgr.getCfg().databases.kingbase.password, 'secret');
  assert.equal(context.global.__dbMgr.getCfg().databases.kingbase.ssh.password, 'ssh-secret');
  calls.length = 0;
  r = await request('post', '/api/db-manager/query', { db: 'kingbase', sql: 'SELECT 1' });
  assert(r.body.ok);
  assert.equal(calls[0].host, 'kb.example');
  calls.length = 0;
  r = await request('get', '/api/db-manager/tables/:db/:database', null, { db: 'kingbase', database: 'other' });
  assert(r.body.ok);
  assert.equal(calls[0].database, 'other');
  assert.equal(r.body.tables[0].schema, 'custom');
  calls.length = 0;
  r = await request('get', '/api/db-manager/table/:db/:database/:table', null, { db: 'kingbase', database: 'other', table: 'Mixed Table' }, { schema: 'custom' });
  assert(r.body.ok);
  assert.deepEqual(calls[1].values, ['custom', 'Mixed Table']);
  calls.length = 0;
  r = await request('post', '/api/db-manager/service/:db/:action', null, { db: 'kingbase', action: 'status' });
  assert(r.body.ok);
  assert.equal(calls[0].ssh.host, 'kb-ssh.example');
  assert(calls[0].command.includes('kingbase-container'));
  calls.length = 0;
  r = await request('post', '/api/db-manager/backup', { db: 'kingbase', database: '../escape' });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0, '非法路径不得执行远程命令');
  failDump = true;
  r = await request('post', '/api/db-manager/backup', { db: 'kingbase', database: 'dcim' });
  assert.equal(r.status, 400);
  assert(!r.body.message.includes('secret'), '命令失败信息必须脱敏');
  assert.equal(calls.filter(c => c.command.includes('rmdir')).length, 2, '失败后清理容器和宿主临时目录');
  assert(calls.every(c => c.ssh.host === 'kb-ssh.example'));
  console.log('kingbase routes: OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
