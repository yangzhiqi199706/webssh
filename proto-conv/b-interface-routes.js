'use strict';
const wsdl = require('./b-interface-wsdl');
const queryRequests = require('./b-interface-query-requests');
const protocol = require('./b-interface-protocol');
const mockAck = require('./b-interface-mock-ack');
function register(app, manager, requireAccount, source) {
  const prefix = '/api/proto-conv/b-interface/';
  function route(method, name, write, handler) {
    app[method](prefix + name, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const session = requireAccount(req, res); if (!session) return;
      const canManage = session.role === 'admin' || session.role === 'operator';
      if (write && !canManage) return res.status(403).json({ ok: false, message: '仅管理员和运维人员可配置 B 接口转发' });
      if (method !== 'get' && req.get('Origin')) {
        let sameOrigin = false;
        try { sameOrigin = new URL(req.get('Origin')).origin === req.protocol + '://' + req.get('Host'); } catch (_e) {}
        if (!sameOrigin) return res.status(403).json({ ok: false, message: '不允许跨站操作' });
      }
      try {
        const result = await handler(req, canManage, res);
        if (!res.headersSent) res.json(Object.assign({ ok: true }, result));
      }
      catch (e) { res.status(400).json({ ok: false, message: manager.safeError(e.message) }); }
    });
  }
  route('get', 'config', false, (_req, canManage) => ({ config: manager.config(), status: manager.status(), canManage }));
  route('get', 'status', false, () => ({ status: manager.status() }));
  route('get', 'logs', false, () => ({ logs: manager.logs() }));
  route('get', 'inherited-devices', false, () => ({ devices: source.inherited() }));
  route('post', 'alarm-definitions', false, async req => {
    const ids = require('./b-interface-alarm-db').validateIds((req.body || {}).deviceIds);
    return { definitions: await source.loadAlarmDefinitions(ids) };
  });
  route('get', 'alarm-definitions-source', false, () => ({ sourceId: source.sourceId() }));
  route('get', 'query-requests', false, () => ({ requests: queryRequests.all(manager.config()) }));
  route('get', 'mock-login-ack', false, () => ({ name: 'LOGIN_ACK', code: 102, xml: protocol.mockLoginAck(manager.config()) }));
  route('get', 'mock-ack-script', false, () => mockAck.generate(manager.config()));
  route('post', 'query-preview/:type', false, req => {
    const config = manager.config(), query = queryRequests.generate(config, req.params.type);
    const message = protocol.message(protocol.unwrap(query.xml, config.soap));
    return { request: query, response: protocol.envelope(manager.respond(message), config.soap, true), cachedAt: manager.status().cachedAt };
  });
  route('get', 'wsdl/:service', false, (req, _canManage, res) => {
    const xml = wsdl.generate(manager.config(), req.params.service);
    const file = req.params.service === 'su' ? 'SUService.wsdl' : 'SCService.wsdl';
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', 'attachment; filename="' + file + '"');
    res.send(xml);
  });
  route('put', 'config', true, async req => ({ config: await manager.configure(req.body || {}), status: manager.status() }));
  route('post', 'preview', false, async () => ({ preview: await manager.preview() }));
  route('post', 'poll', true, async () => { await manager.start(); await manager.cycle(); return { status: manager.status() }; });
  route('post', 'stop', true, async () => { await manager.stop(); return { config: await manager.configure({ enabled: false }), status: manager.status() }; });
  route('post', 'device', false, async req => {
    const b = req.body || {};
    if (typeof b.deviceId !== 'string' || !b.deviceId.trim() || b.deviceId.length > 80 || typeof b.groupId !== 'string' || b.groupId.length > 80 || b.serverCode != null && (typeof b.serverCode !== 'string' || b.serverCode.length > 80)) throw new Error('设备、分组或服务器编号错误');
    return { device: await source.loadDevice(b.deviceId.trim(), b.groupId.trim(), b.serverCode || '1') };
  });
}
module.exports = { register };
