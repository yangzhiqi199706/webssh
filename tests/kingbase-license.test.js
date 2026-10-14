'use strict';
const assert = require('assert');
const fs = require('fs');
const file = require('path').join(__dirname, '../lib/kingbase-license.js');
assert(fs.existsSync(file), '需要人大金仓授权管理模块');
const { parseLicenseInfo, decodeUpload, createLicenseManager, registerLicenseRoutes } = require(file);
const raw = 'License Type --- /opt/kes/bin/license.dat\nLicense序列号 --- 启用 --- TEST-SERIAL\n用户名称 --- 启用 --- 测试客户\n有效期间 --- 启用 --- 90\n浮动基准日期 ------ 启用';
const valid = Buffer.from('-----BEGIN KINGASE.LICENSE.3.0 PRIVATE KEY-----\n' + 'A'.repeat(256) + '\n-----END KINGASE.LICENSE.3.0 PRIVATE KEY-----').toString('base64');
const parsed = parseLicenseInfo(raw);
const nativeFormat = Buffer.from('-------------------BEGIN KINGASE.LICENSE.3.0 PRIVATE KEY-------------------\n' + 'A'.repeat(256) + '\n----------------------------------MD5SUM-----------------------------------\n0123456789ABCDEF\n-------------------END KINGASE.LICENSE.3.0 PRIVATE KEY---------------------\n用户名称：测试授权\n有效期间：90天');
assert.deepEqual(decodeUpload('license.dat', nativeFormat.toString('base64')), nativeFormat);
assert.equal(parsed.path, '/opt/kes/bin/license.dat');
assert.equal(parsed.fields['License序列号'], 'TEST-SERIAL');
assert.equal(parsed.fields['浮动基准日期'], '启用');
assert.equal(decodeUpload('license.dat', valid).length, Buffer.from(valid, 'base64').length);
for (const [name, content] of [['../license.dat', valid], ['license.dat', '%%%'], ['license.dat', ''], ['license.dat', Buffer.from('invalid').toString('base64')], ['license.dat', Buffer.alloc(1048577).toString('base64')]]) {
  assert.throws(() => decodeUpload(name, content));
}
function fixture(fail) {
  const events = [];
  let restarts = 0;
  const cfg = { db: { binDir: '/opt/kes/bin', password: 'private-password' }, ssh: { host: 'dedicated-host' }, container: 'dcim' };
  const manager = createLicenseManager({
    getContext: () => cfg,
    query: async () => {
      events.push('query');
      return { rows: [{ info: fail === 'mismatch' && restarts === 1 ? raw.replace('TEST-SERIAL', 'OTHER') : raw,
        days: 90, version: 'Kingbase V8', data_directory: '/data/kingbase', started_at: restarts ? 'new' : 'old' }] };
    },
    run: async (command, context) => {
      assert.equal(context.ssh.host, 'dedicated-host');
      events.push(command);
      if (command.includes('license_parser_tool')) return { code: fail === 'parse' ? 1 : 0, stdout: 'licenseSN yes TEST-SERIAL\nproductLine yes KingbaseES V8', stderr: '' };
      if (command.includes('stat -c')) return { code: 0, stdout: command.includes('/data/kingbase') ? '1001|1001' : '3676|1700000000|1001|1001|644', stderr: '' };
      if (command.includes('sys_ctl') && command.includes('restart')) {
        restarts++;
        return { code: fail === 'rollback' || fail === 'restart' && restarts === 1 ? 1 : 0, stdout: '', stderr: 'private-password' };
      }
      if (fail === 'backup' && command.includes('cp -p') && command.includes('.bak.')) return { code: 1, stdout: '', stderr: 'denied' };
      return { code: 0, stdout: '', stderr: '' };
    },
    put: async () => { events.push('upload-bytes'); },
    sleep: async () => {},
    log: () => {},
  });
  return { manager, events };
}
(async () => {
  const read = await fixture().manager.read();
  assert.equal(read.license.daysLeft, 90);
  assert.equal(read.keyFile.size, 3676);
  for (const reason of ['parse', 'backup']) {
    const f = fixture(reason);
    await assert.rejects(f.manager.upload({ fileName: 'license.dat', contentBase64: valid, confirmRestart: true }));
    assert(!f.events.some(x => x.includes('sys_ctl')), '校验/备份失败不得重启');
    assert(!f.events.some(x => x.includes('mv -f')), '校验/备份失败不得替换');
  }
  for (const reason of ['restart', 'mismatch']) {
    const f = fixture(reason);
    await assert.rejects(f.manager.upload({ fileName: 'license.dat', contentBase64: valid, confirmRestart: true }), e => {
      assert(e.rollback && e.rollback.ok, '替换后失败必须回滚并验证');
      assert(!e.message.includes('private-password'));
      return true;
    });
    assert.equal(f.events.filter(x => x.includes('sys_ctl') && x.includes('restart')).length, 2);
  }
  const f = fixture();
  const broken = fixture('rollback');
  await assert.rejects(broken.manager.upload({fileName:'license.dat',contentBase64:valid,confirmRestart:true}), e => e.rollback && e.rollback.ok === false && !!e.rollback.backup);
  assert.equal(broken.manager.isBusy(), false);
  const concurrent = fixture();
  const pending = concurrent.manager.upload({fileName:'license.dat',contentBase64:valid,confirmRestart:true});
  await assert.rejects(concurrent.manager.upload({fileName:'license.dat',contentBase64:valid,confirmRestart:true}), e => e.statusCode === 409);
  await pending;
  await assert.rejects(f.manager.upload({ fileName: 'license.dat', contentBase64: valid }), /确认/);
  assert.equal(f.events.length, 0);
  const success = await f.manager.upload({ fileName: 'license.dat', contentBase64: valid, confirmRestart: true });
  assert(success.ok && success.restarted && success.backup);
  assert(f.events.findIndex(x => x.includes('license_parser_tool')) < f.events.findIndex(x => x.includes('mv -f')));
  assert(f.events.some(x => x.includes('rm -f')), '应清理临时文件');
  const routes = {};
  let permitted = false, uploads = 0, result, status;
  registerLicenseRoutes({ get: (p,h) => { routes['GET']=h; }, post: (p,h) => { routes['POST']=h; } }, {
    authorize: (_req,res) => { if (!permitted) { res.status(401).json({ok:false}); return false; } return true; },
    manager: { read: async () => ({ok:true}), upload: async () => { uploads++; return {ok:true}; } },
  });
  const response = { status(n) {status=n;return this;}, json(v) {result=v;} };
  await routes.POST({headers:{},body:{}},response);
  assert.equal(status,401); assert.equal(uploads,0);
  permitted=true;status=200;
  await routes.POST({headers:{origin:'http://evil.example',host:'app.example'},protocol:'http',body:{}},response);
  assert.equal(status,403); assert.equal(uploads,0);
  await routes.POST({headers:{origin:'http://app.example',host:'app.example'},protocol:'http',body:{}},response);
  assert.equal(uploads,1);assert(result.ok);
  console.log('Kingbase license parsing, validation, backup, apply and rollback: OK');
})().catch(e => { console.error(e); process.exitCode = 1; });
