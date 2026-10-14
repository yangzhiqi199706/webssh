'use strict';
const fs = require('fs');
const path = require('path');
const worker = fs.readFileSync(path.join(__dirname, 'dcim-settings-worker.py'), 'utf8');
const defaults = { host: '192.168.50.61', port: 22, username: 'root', password: '', directory: '/dcim/python/src/collection/config', container: 'dcim' };
function normalize(input, old) {
  const c = Object.assign({}, defaults, old);
  ['host', 'username', 'directory', 'container'].forEach(k => { if (input[k] !== undefined) c[k] = String(input[k]).trim(); });
  if (input.port !== undefined) c.port = Number(input.port);
  if (input.password) c.password = String(input.password);
  if (!/^[a-zA-Z0-9._:-]{1,253}$/.test(c.host) || !/^[a-zA-Z0-9_.-]{1,64}$/.test(c.username) || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw new Error('SSH连接信息无效');
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(c.directory) || c.directory.split('/').includes('..') || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(c.container)) throw new Error('目录或容器名称无效');
  return c;
}
function register(app, deps) {
  const file = path.join(deps.configDir, 'dcim-settings.json');
  let config = Object.assign({}, defaults);
  let configError = false;
  try { if (fs.existsSync(file)) config = normalize(JSON.parse(fs.readFileSync(file, 'utf8')), defaults); }
  catch (_) { configError = true; }
  let active = false;
  function publicConfig() { return Object.assign({}, config, { password: '', hasPassword: !!config.password, invalidConfig: configError }); }
  function exec(command, timeout) {
    if (configError || !config.password) return Promise.reject(new Error('请先保存有效的SSH连接信息'));
    return new Promise((resolve, reject) => deps.runSsh(Object.assign({}, config, { commandTimeoutMs: timeout || 15000 }), command, (err, result) => {
      if (err || !result || result.code !== 0) return reject(new Error('SSH操作失败，请检查连接、权限及目标服务'));
      resolve(result.stdout);
    }));
  }
  function route(method, url, handler) {
    app[method]('/api/dcim-settings' + url, async function (req, res) {
      const session = deps.requireAccount(req, res);
      if (!session) return;
      if (session.role !== 'admin') return res.status(403).json({ ok: false, message: '仅管理员可管理DCIM设置' });
      res.setHeader('Cache-Control', 'no-store');
      if (method !== 'get') {
        if (req.get('Sec-Fetch-Site') === 'cross-site') return res.status(403).json({ ok: false, message: '不允许跨站操作' });
        if (req.get('Origin') && req.get('Origin') !== req.protocol + '://' + req.get('Host')) return res.status(403).json({ ok: false, message: '不允许跨站操作' });
      }
      if (active) return res.status(409).json({ ok: false, message: 'DCIM设置操作正在进行，请稍后重试' });
      active = true;
      try { res.json({ ok: true, data: await handler(req) }); }
      catch (err) { res.status(400).json({ ok: false, message: err.code ? '配置操作失败，请检查服务端文件权限和磁盘空间' : err.message }); }
      finally { active = false; }
    });
  }
  async function remote(action, body) {
    if (!config.password) throw new Error('请先配置SSH连接密码');
    const request = Object.assign({}, body, { action: action, directory: config.directory });
    const payload = Buffer.from(JSON.stringify(request)).toString('base64');
    if (payload.length > 200000) throw new Error('请求内容过大');
    const output = await exec("python3 - '" + payload + "' <<'WEBSSH_DCIM_PY'\n" + worker + '\nWEBSSH_DCIM_PY');
    let reply;
    try { reply = JSON.parse(output); } catch (_) { throw new Error('目标主机返回格式异常'); }
    if (!reply.ok) throw new Error(reply.message || '配置操作失败');
    return reply.data;
  }
  route('get', '/connection', () => publicConfig());
  route('put', '/connection', req => {
    const next = normalize(req.body || {}, config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
    config = next;
    configError = false;
    return publicConfig();
  });
  route('get', '/files', () => remote('list', {}));
  route('get', '/snapshot', () => remote('snapshot', {}));
  route('get', '/file', req => remote('read', { name: req.query.name }));
  route('put', '/file', req => remote('save', req.body || {}));
  route('post', '/restart', async req => {
    if (!req.body || req.body.confirm !== true) throw new Error('请确认重启采集服务');
    const status = await exec('docker exec ' + config.container + ' systemctl restart dcim && docker exec ' + config.container + ' systemctl is-active dcim', 45000);
    if (status.trim() !== 'active') throw new Error('服务未进入active状态，请检查目标日志');
    return { state: 'active' };
  });
}
module.exports = { register, normalize };
