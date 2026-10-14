'use strict';
const crypto = require('crypto');
const MAX_BYTES = 1024 * 1024;
const q = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
function safePath(value) {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(value) || value.split('/').includes('..') || value === '/') throw new Error('授权或数据库目录非法');
  return value.replace(/\/+$/, '');
}
function parseLicenseInfo(raw) {
  const fields = Object.create(null);
  let filePath = '';
  for (const line of String(raw || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s*-{3,}\s*/);
    if (parts.length < 2) continue;
    if (parts[0] === 'License Type') filePath = parts[1];
    else fields[parts[0]] = parts.length > 2 ? parts.slice(2).join(' --- ') : parts[1];
  }
  return { fields, path: filePath };
}
function decodeUpload(name, content) {
  if (name !== 'license.dat') throw new Error('只允许上传 license.dat 授权文件');
  if (typeof content !== 'string' || !content || content.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('授权文件不能为空或超过 1MB');
  if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) throw new Error('无效的 Base64 文件内容');
  const buffer = Buffer.from(content, 'base64');
  if (!buffer.length || buffer.length > MAX_BYTES || buffer.toString('base64') !== content) throw new Error('授权文件内容或大小非法');
  const text = buffer.toString('utf8').trim();
  const match = /^-+BEGIN (KINGASE|KINGBASE)\.LICENSE\.([0-9.]+) PRIVATE KEY-+\r?\n([A-Za-z0-9+/=\r\n]+?)(?:\r?\n-+MD5SUM-+\r?\n[A-Za-z0-9+/=]+)?\r?\n-+END \1\.LICENSE\.\2 PRIVATE KEY-+(?:\r?\n[\s\S]*)?$/.exec(text);
  if (text.includes('\0') || text.includes('\ufffd') || !match || match[3].replace(/\s/g, '').length < 128) throw new Error('文件内容不是支持的金仓授权格式');
  return buffer;
}
function createLicenseManager(deps) {
  let busy = false;
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  function context() { return JSON.parse(JSON.stringify(deps.getContext())); }
  function cleanError(error, ctx) {
    let text = String(error && error.message || error || '操作失败');
    [ctx.db.password, ctx.ssh && ctx.ssh.password].filter(Boolean).forEach(p => { text = text.split(p).join('***'); });
    return text.slice(0, 500);
  }
  function inContainer(ctx, command) { return 'docker exec ' + q(ctx.container) + ' sh -c ' + q(command); }
  async function run(ctx, command, message, timeoutMs) {
    const result = await deps.run(command, ctx, timeoutMs || 15000);
    if (!result || result.code !== 0) throw new Error(message);
    return String(result.stdout || '').trim();
  }
  async function query(ctx) {
    const result = await deps.query("SELECT get_license_info() AS info, get_license_validdays() AS days, version() AS version, current_setting('data_directory') AS data_directory, pg_postmaster_start_time() AS started_at", ctx);
    const row = result.rows && result.rows[0];
    if (!row || !row.info) throw new Error('数据库未返回授权信息');
    const info = parseLicenseInfo(row.info);
    const days = row.days == null ? null : Number(row.days);
    return { fields: info.fields, path: info.path, raw: String(row.info), daysLeft: Number.isFinite(days) ? days : null,
      dbVersion: row.version || '', dataDirectory: row.data_directory, startedAt: String(row.started_at),
      floatingDate: info.fields['浮动基准日期'] === '启用' };
  }
  async function probe(ctx, filePath) {
    safePath(filePath);
    const text = await run(ctx, inContainer(ctx, 'if [ -f ' + q(filePath) + ' ]; then stat -c ' + q('%s|%Y|%u|%g|%a') + ' ' + q(filePath) + '; else printf MISSING; fi'), 'SSH 探测授权文件失败');
    if (text === 'MISSING') return { exists: false, path: filePath };
    const parts = text.split('|');
    if (parts.length !== 5 || !parts.every(p => /^\d+$/.test(p))) throw new Error('授权文件属性无效');
    return { exists: true, path: filePath, size: Number(parts[0]), mtime: Number(parts[1]) * 1000,
      uid: parts[2], gid: parts[3], owner: parts[2] + ':' + parts[3], mode: parts[4] };
  }
  async function read() {
    const ctx = context();
    let license = null, licenseError = '', keyFile = null, fileError = '';
    try { license = await query(ctx); } catch (e) { licenseError = cleanError(e, ctx); }
    try { keyFile = await probe(ctx, (license && license.path) || safePath(ctx.db.binDir) + '/license.dat'); }
    catch (e) { fileError = cleanError(e, ctx); }
    return { ok: !!license, license, licenseError, keyFile, fileError, busy };
  }
  async function upload(body) {
    if (body.confirmRestart !== true) throw new Error('请确认替换授权文件并重启数据库');
    const buffer = decodeUpload(body.fileName, body.contentBase64);
    if (busy) { const e = new Error('已有金仓授权更新正在进行'); e.statusCode = 409; throw e; }
    const ctx = context();
    busy = true;
    const token = crypto.randomBytes(12).toString('hex');
    const hostDir = '/tmp/webssh-kingbase-license-' + token;
    const hostFile = hostDir + '/license.dat';
    let target, staging, backup, original, restartCommand, replaced = false;
    async function ready(expectedSerial, requireNewStart) {
      let last;
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          const value = await query(ctx);
          if (value.fields['License序列号'] !== expectedSerial) throw new Error('数据库读取的授权序列号与文件不一致');
          if (requireNewStart && value.startedAt === original.startedAt) throw new Error('数据库启动时间未变化，无法确认重启成功');
          return value;
        } catch (e) { last = e; }
        if (attempt < 11) await sleep(1000);
      }
      throw last || new Error('数据库恢复超时');
    }
    try {
      original = await query(ctx);
      const bin = safePath(ctx.db.binDir);
      target = safePath(original.path);
      if (target !== bin + '/license.dat') throw new Error('当前授权文件与配置的 bin 目录不一致，请先核对连接信息');
      const data = safePath(original.dataDirectory);
      const oldFile = await probe(ctx, target);
      if (!oldFile.exists || !original.fields['License序列号']) throw new Error('无法确认旧授权文件，停止更新');
      await run(ctx, inContainer(ctx, 'test ! -L ' + q(target)), '授权文件为符号链接，请先核对实际文件位置');
      const owner = await run(ctx, inContainer(ctx, 'stat -c ' + q('%u|%g') + ' ' + q(data)), '无法确定数据库运行用户');
      if (!/^[1-9]\d*\|\d+$/.test(owner)) throw new Error('数据库运行用户非法或为 root');
      restartCommand = 'docker exec --user ' + q(owner.replace('|', ':')) + ' ' + q(ctx.container) +
        ' env ' + q('LD_LIBRARY_PATH=' + bin + '/../lib') + ' ' + q(bin + '/sys_ctl') +
        ' restart -D ' + q(data) + ' -m fast -w -t 90';
      staging = target + '.upload.' + token;
      backup = target + '.bak.' + new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '.' + token;
      await run(ctx, 'mkdir -m 700 ' + q(hostDir), '创建上传临时目录失败');
      await deps.put(buffer, hostFile, ctx);
      await run(ctx, 'docker cp ' + q(hostFile) + ' ' + q(ctx.container + ':' + staging), '上传到容器失败');
      const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
      await run(ctx, inContainer(ctx, 'printf ' + q('%s\n') + ' ' + q(checksum + '  ' + staging) + ' | sha256sum -c -'), '上传文件校验失败');
      const parsed = await run(ctx, inContainer(ctx, q(bin + '/license_parser_tool') + ' ' + q(staging)), '金仓原生工具校验授权文件失败');
      const serial = /^licenseSN\s+yes\s+(\S+)/m.exec(parsed);
      if (!serial || !/^productLine\s+yes\s+KingbaseES\b/m.test(parsed)) throw new Error('金仓工具未解析出有效产品与授权序列号');
      await run(ctx, inContainer(ctx, 'cp -p ' + q(target) + ' ' + q(backup) + ' && cmp -s ' + q(target) + ' ' + q(backup)), '备份旧授权失败，未替换');
      await run(ctx, inContainer(ctx, 'chown ' + q(oldFile.owner) + ' ' + q(staging) + ' && chmod 600 ' + q(staging)), '设置授权文件权限失败');
      // 从尝试原子替换起按可能已替换处理，覆盖 SSH 中断导致结果不确定的情况。
      replaced = true;
      await run(ctx, inContainer(ctx, 'mv -f ' + q(staging) + ' ' + q(target)), '替换授权文件失败');
      await run(ctx, restartCommand, '金仓重启失败', 110000);
      const license = await ready(serial[1], true);
      const keyFile = await probe(ctx, target);
      if (deps.log) deps.log('kingbase license updated bytes=' + buffer.length + ' backup=' + backup);
      return { ok: true, uploaded: buffer.length, backup, restarted: true, license, keyFile };
    } catch (error) {
      const result = new Error(cleanError(error, ctx));
      if (replaced) {
        try {
          await run(ctx, inContainer(ctx, 'cp -p ' + q(backup) + ' ' + q(staging) + ' && mv -f ' + q(staging) + ' ' + q(target)), '恢复旧授权文件失败');
          await run(ctx, restartCommand, '恢复旧授权后数据库重启失败', 110000);
          await ready(original.fields['License序列号'], false);
          result.rollback = { ok: true, backup };
          result.message += '；已恢复旧授权并验证数据库可用';
        } catch (rollbackError) {
          result.rollback = { ok: false, backup, message: cleanError(rollbackError, ctx) };
          result.message += '；自动恢复未完成，请使用备份人工恢复';
        }
      }
      if (deps.log) deps.log('kingbase license update failed rollback=' + (result.rollback ? result.rollback.ok : 'not-needed'));
      throw result;
    } finally {
      try {
        if (staging) await deps.run(inContainer(ctx, 'rm -f ' + q(staging)), ctx, 10000);
        await deps.run('rm -f ' + q(hostFile) + '; rmdir ' + q(hostDir), ctx, 10000);
      } catch (_e) {}
      busy = false;
    }
  }
  return { read, upload, isBusy: () => busy };
}
function registerLicenseRoutes(app, deps) {
  app.get('/api/db-manager/kingbase/license', async (req, res) => {
    if (!deps.authorize(req, res, false)) return;
    try { res.json(await deps.manager.read()); }
    catch (_e) { res.status(400).json({ ok: false, message: '读取授权信息失败，请检查连接配置' }); }
  });
  app.post('/api/db-manager/kingbase/upload-license', async (req, res) => {
    if (!deps.authorize(req, res, true)) return;
    const headers = req.headers || {};
    if (headers['sec-fetch-site'] === 'cross-site' ||
        (headers.origin && headers.origin !== req.protocol + '://' + headers.host)) {
      return res.status(403).json({ ok: false, message: '拒绝跨站授权上传请求' });
    }
    try { res.json(await deps.manager.upload(req.body || {})); }
    catch (e) { res.status(e.statusCode || 400).json({ ok: false, message: e.message, rollback: e.rollback || null }); }
  });
}
module.exports = { parseLicenseInfo, decodeUpload, createLicenseManager, registerLicenseRoutes };
