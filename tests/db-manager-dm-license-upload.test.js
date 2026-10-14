'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '../db/index.html'), 'utf8');
const querySource = source.slice(source.indexOf('  async function queryDmLicense('), source.indexOf('  async function probeDmKey('));
const uploadSource = source.slice(source.indexOf('  async function uploadDmKey('), source.indexOf('  async function uploadDmApacheVhosts('));
const serviceSource = source.slice(source.indexOf('  async function serviceAction('), source.indexOf('  async function backupDatabase('));
const routeSource = source.slice(source.indexOf("  app.post('/api/db-manager/dm/upload-key'"), source.indexOf("  app.post('/api/db-manager/dm/upload-httpd-vhosts'"));
// 合成二进制样本，不把真实授权或客户信息写入仓库。
const binary = Buffer.alloc(648, 0x80);
binary.writeUInt32LE(286, 0);
const content = binary.toString('base64');
const original = Buffer.from('previous encrypted license');
const tempDirs = [];

function fixture(failure, hasOriginal) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-license-test-'));
  tempDirs.push(directory);
  const events = [];
  let staged, active = hasOriginal === false ? null : Buffer.from(original), backup;
  let loaded = false, connections = 0, closed = 0, applied = false, restored = false;
  const rejection = {
    mac: 'license MAC address mismatch', hardware: 'license CPU/platform mismatch',
    expired: 'license expired', damaged: 'invalid license data',
    load: 'lic info is different between dm.key and sysinfo. db-secret',
    rollback: 'lic info is different between dm.key and sysinfo. db-secret',
    'restore-corrupt': 'invalid license data', 'recovery-read': 'license MAC address mismatch',
  };
  const license = { SERIES_NO: 'TEST-NEW', EXPIRED_DATE: '2027-03-25', PRODUCT_TYPE: 'DM8', SERVER_SERIES_NAME: '企业版' };
  if (failure === 'same-serial-disconnect') {
    Object.keys(license).forEach(key => { delete license[key]; });
    Object.assign(license, { SERIES_NO: 'TEST-OLD', MAX_SESSIONS: 1 });
  }
  const context = {
    Buffer, Date, Object, String, Number, Error, Promise, RegExp,
    fs, path, require, __dirname: directory,
    cfg: { container: 'dcim', ssh: { host: 'test-host', password: 'ssh-secret' }, databases: { dm: { password: 'db-secret', host: 'test-db' } } },
    DM_KEY_PATH: '/home/dmdba/dmdbms/bin/dm.key',
    dmKeyUploadBusy: false,
    app: { post: (_url, handler) => { context.route = handler; } },
    stampForFile: () => 'test-stamp',
    shellEscape: value => "'" + String(value).replace(/'/g, "'\\''") + "'",
    runInContainerCmd: (_container, command) => 'IN_CONTAINER ' + command,
    buildDmConnectUrl: () => 'dm://test-connection',
    getDbCfg: () => ({ systemdUnit: 'DmServiceDMSERVER.service' }),
    dbRuntime: () => ({ container: 'dcim', ssh: {} }),
    appendLog: message => events.push('LOG ' + message),
    sftpUpload: async local => { events.push('SFTP'); staged = fs.readFileSync(local); if (failure === 'sftp') throw new Error('SFTP failed'); },
    sshRun: async (command, options) => {
      assert.strictEqual(options.timeoutMs, 15000, '远端操作必须有超时限制');
      events.push(command);
      if (/systemctl|restart|upd_lic/.test(command)) throw new Error('不得启停数据库或自动升级安全状态');
      if (command.includes('DM_KEY_BACKUP_CREATED')) {
        if (failure === 'backup') return { code: 1, stdout: '', stderr: 'backup denied' };
        backup = active && Buffer.from(active);
        return { code: 0, stdout: active ? 'DM_KEY_BACKUP_CREATED' + (command.includes('sha256sum') ? '\n' + crypto.createHash('sha256').update(backup).digest('hex') + '  backup.key' : '') : 'DM_KEY_NO_ORIGINAL', stderr: '' };
      }
      if (command.includes('sha256sum')) {
        const data = command.includes("'" + context.DM_KEY_PATH + "'") ? active : staged;
        return { code: 0, stdout: (failure === 'checksum' ? '0'.repeat(64) : crypto.createHash('sha256').update(data).digest('hex')) + '  checked.key', stderr: '' };
      }
      if (command.includes('install -o dmdba')) {
        if (failure === 'install') return { code: 1, stdout: '', stderr: 'install failed' };
        active = Buffer.from(staged);
        applied = true;
      }
      if (command.includes('cp -a ') && !command.includes('DM_KEY_BACKUP_CREATED')) {
        if (failure === 'rollback') return { code: 1, stdout: '', stderr: 'restore denied' };
        active = failure === 'restore-corrupt' ? Buffer.from('corrupt rollback') : backup && Buffer.from(backup);
        restored = true;
      }
      if (command.includes('rm -f ') && command.includes("'" + context.DM_KEY_PATH + "'")) { active = null; restored = true; }
      if (failure === 'copy' && command.startsWith('docker cp ')) return { code: 1, stdout: '', stderr: 'copy failed' };
      return { code: 0, stdout: '', stderr: '' };
    },
    dmdbLib: {
      OUT_FORMAT_OBJECT: 1,
      getConnection: async url => {
        events.push('CONNECT ' + url);
        connections++;
        if (failure === 'preflight') throw new Error('database unavailable');
        return {
          execute: async sql => {
            events.push('SQL ' + sql);
            if (sql.includes('SP_LOAD_LIC_INFO')) {
              if (active === null || (active && active.equals(original))) {
                if (failure === 'recovery-load') throw new Error('old license reload failed');
                loaded = false;
                return { rows: [] };
              }
              if (rejection[failure]) throw new Error(rejection[failure]);
              if (failure === 'unsupported') throw new Error('SP_LOAD_LIC_INFO not found');
              loaded = true;
              if (failure === 'load-disconnect' || failure === 'recovery-load' || failure === 'same-serial-disconnect') throw new Error('connection lost after loading');
            }
            if (sql.includes('V$LICENSE')) {
              if (applied && restored && failure === 'recovery-read') throw new Error('database unavailable after restore');
              if (loaded && failure === 'verify') throw new Error('license query failed');
              if (!applied && failure === 'empty-baseline') return { rows: [] };
              return { rows: loaded && failure === 'empty-license' ? [] : [loaded ? license : { SERIES_NO: 'TEST-OLD', MAX_SESSIONS: 100 }] };
            }
            if (loaded && failure === 'sql' && sql === 'SELECT 1 FROM DUAL') throw new Error('normal SQL failed');
            return { rows: [{ BANNER: 'DM Database Server 64 V8' }] };
          },
          close: async () => { closed++; },
        };
      },
    },
  };
  vm.runInNewContext(querySource + uploadSource + serviceSource + routeSource + '\nthis.upload = uploadDmKey; this.serviceAction = serviceAction;', context);
  return { upload: context.upload, events, context, active: () => active, connections: () => connections, closed: () => closed, directory };
}

(async () => {
  const success = fixture();
  const result = await success.upload(content);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.loaded, true);
  assert.strictEqual(result.restarted, false);
  assert.strictEqual(result.license.fields.SERIES_NO, 'TEST-NEW');
  assert(success.events.some(x => /^CONNECT .*connectTimeout=5000.*socketTimeout=10000.*sessionTimeout=10/.test(x)), '授权加载必须使用驱动超时，避免失败后一直占用新 key');
  assert.deepStrictEqual(success.active(), binary, '二进制授权应逐字节保留');
  assert(success.events.indexOf('SQL SELECT * FROM V$LICENSE') < success.events.indexOf('SFTP'), '不可连接时不得改授权');
  assert(success.events.findIndex(x => x.includes('DM_KEY_BACKUP_CREATED')) < success.events.findIndex(x => x.includes('install -o dmdba')));
  assert.strictEqual(success.closed(), success.connections(), '所有连接必须关闭');
  assert.strictEqual(fs.readdirSync(path.join(success.directory, 'tmp', 'dm-key')).length, 0, '本地临时文件应清理');
  assert(!success.events.some(x => /systemctl|upd_lic|前 200 字节/.test(x)));
  if (process.env.DM_LICENSE_TEST_FILE) {
    const actual = fs.readFileSync(process.env.DM_LICENSE_TEST_FILE);
    const f = fixture();
    await f.upload(actual.toString('base64'));
    assert.deepStrictEqual(f.active(), actual, '真实二进制授权必须被接受且完整传输');
  }

  for (const invalid of ['', '%%%', 'AAAA=', 'AB==', Buffer.alloc(1048577).toString('base64')]) {
    const f = fixture();
    await assert.rejects(f.upload(invalid), /为空|Base64|1MB/);
    assert.strictEqual(f.events.length, 0, '非法输入不得触发远端操作');
  }
  for (const failure of ['preflight', 'empty-baseline', 'sftp', 'copy', 'checksum', 'backup']) {
    const f = fixture(failure);
    await assert.rejects(f.upload(content));
    assert.deepStrictEqual(f.active(), original, failure + '失败不得覆盖原授权');
    assert(!f.events.some(x => x.includes('install -o dmdba')));
    assert.strictEqual(f.context.dmKeyUploadBusy, false);
  }
  for (const failure of ['install', 'load', 'unsupported', 'mac', 'hardware', 'expired', 'damaged', 'load-disconnect', 'verify', 'empty-license', 'sql', 'same-serial-disconnect']) {
    const f = fixture(failure);
    await assert.rejects(f.upload(content), error => {
      assert(error.rollback && error.rollback.ok, failure + '失败应恢复原文件');
      assert.strictEqual(error.rollback.fileRestored, true, '应校验恢复后的文件');
      assert.strictEqual(error.rollback.databaseVerified, true, '应验证数据库仍可查询');
      assert.strictEqual(error.rollback.licenseRestored, true, '应验证运行中的原授权');
      assert(!error.message.includes('db-secret'));
      return true;
    });
    assert.deepStrictEqual(f.active(), original);
    assert.strictEqual(f.context.dmKeyUploadBusy, false);
    if (failure === 'same-serial-disconnect') assert.strictEqual(f.events.filter(x => x === 'SQL CALL SP_LOAD_LIC_INFO();').length, 2, '序列号相同但权限变化也必须重载原授权');
    assert(!f.events.some(x => /systemctl|upd_lic/.test(x)), '任何失败都不能启停数据库');
  }
  const noOriginal = fixture('load', false);
  await assert.rejects(noOriginal.upload(content), e => e.rollback && e.rollback.ok && !e.rollback.backup);
  assert.strictEqual(noOriginal.active(), null, '默认授权模式失败时应撤下新 key');
  const defaultDisconnect = fixture('load-disconnect', false);
  await assert.rejects(defaultDisconnect.upload(content), e => e.rollback && e.rollback.ok && e.rollback.licenseRestored);
  assert.strictEqual(defaultDisconnect.active(), null);
  const restoreFailed = fixture('rollback');
  await assert.rejects(restoreFailed.upload(content), e => e.rollback && !e.rollback.ok && !!e.rollback.backup);
  for (const failure of ['restore-corrupt', 'recovery-read', 'recovery-load']) {
    const f = fixture(failure);
    await assert.rejects(f.upload(content), e => {
      assert(e.rollback && !e.rollback.ok, failure + '不能误报已恢复正常');
      assert(!/原授权和数据库查询已验证正常/.test(e.message));
      assert(/人工|未确认/.test(e.message));
      return true;
    });
    assert.strictEqual(f.context.dmKeyUploadBusy, false);
  }
  assert(success.events.some(x => /install.*mv -f/.test(x)), '应在同目录准备文件后原子替换，避免原文件被截断');
  const concurrent = fixture();
  const pending = concurrent.upload(content);
  await assert.rejects(concurrent.upload(content), e => e.statusCode === 409);
  await assert.rejects(concurrent.context.serviceAction('dm', 'stop'), /授权更新进行中/);
  let httpStatus = 200, response;
  const res = { status(code) { httpStatus = code; return this; }, json(body) { response = body; } };
  await concurrent.context.route({ body: { contentBase64: content } }, res);
  assert.strictEqual(httpStatus, 409);
  assert.strictEqual(response.ok, false);
  await pending;
  assert.strictEqual(concurrent.context.dmKeyUploadBusy, false);
  const failedRoute = fixture('load');
  await failedRoute.context.route({ body: { contentBase64: content } }, res);
  assert.strictEqual(httpStatus, 400);
  assert.strictEqual(response.ok, false);
  assert(response.rollback.ok);

  const dmUi = ui.slice(ui.indexOf('上传新 dm.key'), ui.indexOf('<!-- 达梦卡片：Apache'));
  const handler = ui.slice(ui.indexOf("$('btnUploadDmKey').addEventListener"), ui.indexOf('// ========== 达梦卡片：Apache'));
  assert(!/重启|业务中断/.test(dmUi + handler), '上传 UI 不应再承诺或执行服务重启');
  assert(handler.includes('r.loaded'), '界面必须展示加载状态');
  assert(handler.includes('r.rollback.databaseVerified'), '界面必须分别显示文件恢复及数据库验证结果');
  // 在临时目录实际执行生产流程生成的 shell，补充远端边界模拟未覆盖的语法/原子替换验证。
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  if (fs.existsSync(bash)) {
    const shellCase = fixture('mac');
    await assert.rejects(shellCase.upload(content));
    const shellDir = path.join(shellCase.directory, 'shell');
    fs.mkdirSync(shellDir);
    fs.writeFileSync(path.join(shellDir, 'dm.key'), original);
    fs.writeFileSync(path.join(shellDir, 'incoming.key'), binary);
    const commands = shellCase.events.filter(x => x.startsWith('IN_CONTAINER set -e;'));
    assert.strictEqual(commands.length, 3, '备份/安装/恢复应各执行一次');
    commands.forEach((command, index) => {
      const script = command.replace('IN_CONTAINER ', '').replace(/\/home\/dmdba\/dmdbms\/bin\//g, '')
        .replace(/\/tmp\/dm\.key\.stage-[^']+/g, 'incoming.key');
      assert(!/\/home\/|\/tmp\//.test(script), 'shell 测试仅使用临时工作目录里的相对路径');
      // Git Bash 没有 Linux 的 dmdba/dinstall 账号，仅剥离此两项，保留 install/cp/mv/sha256sum。
      const executed = require('child_process').spawnSync(bash, ['--noprofile', '--norc', '-s'], {
        input: 'set -e\ninstall() { shift 4; command install "$@"; }\n' + script + '\n',
        cwd: shellDir, encoding: 'utf8', timeout: 5000,
      });
      assert.strictEqual(executed.status, 0, executed.stderr);
      assert.deepStrictEqual(fs.readFileSync(path.join(shellDir, 'dm.key')), index === 1 ? binary : original);
    });
    console.log('DM backup/install/restore shell execution in temporary directory: OK');
  }
  console.log('DM binary license upload, loading, rollback, concurrency and UI: OK');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  tempDirs.forEach(directory => {
    const resolved = path.resolve(directory);
    assert.strictEqual(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('dm-license-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
});
