'use strict';
function register(app, manager, requireAccount) {
  const prefix = '/api/proto-conv/wecom/';
  function route(method, name, write, handler) {
    app[method](prefix + name, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const session = requireAccount(req, res);
      if (!session) return;
      const canManage = session.role === 'admin' || session.role === 'operator';
      if (write && !canManage) return res.status(403).json({ ok: false, message: '仅管理员和运维人员可以配置或发送消息' });
      if (method !== 'get' && req.get('Origin')) {
        let sameOrigin = false;
        try { sameOrigin = new URL(req.get('Origin')).origin === req.protocol + '://' + req.get('Host'); } catch (_e) {}
        if (!sameOrigin) return res.status(403).json({ ok: false, message: '不允许跨站操作' });
      }
      try { res.json(Object.assign({ ok: true }, await handler(req, canManage))); }
      catch (e) { res.status(400).json({ ok: false, message: manager.safeError(e.message) }); }
    });
  }
  route('get', 'config', false, (_req, canManage) => ({ config: manager.config(), status: manager.status(), canManage }));
  route('get', 'status', false, () => ({ status: manager.status() }));
  route('get', 'logs', false, () => ({ logs: manager.logs() }));
  route('get', 'options', false, async () => ({ options: await manager.options.loadOptions(manager.config().fields) }));
  route('put', 'config', true, req => ({ config: manager.configure(req.body || {}), status: manager.status() }));
  route('post', 'preview', false, async () => ({ preview: await manager.preview() }));
  route('post', 'test', true, async () => { await manager.test(); return { message: '测试消息已被企业微信接收' }; });
  route('post', 'credentials', true, async () => { await manager.credentials(); return { message: '应用凭证获取成功（尚未发送消息，请继续验证接收对象）' }; });
  route('post', 'retry', true, () => { manager.retry(); return { status: manager.status() }; });
  route('post', 'reset', true, () => { manager.reset(); return { status: manager.status() }; });
}
module.exports = { register };
