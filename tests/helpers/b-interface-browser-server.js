'use strict';
// Local browser fixture only: no SSH, DCIM network calls or live config changes.
const express = require('express'), path = require('path');
const { defaults } = require('../../proto-conv/b-interface-forwarder');
const count = Number(process.env.B_UI_DEVICE_COUNT || 500), points = Number(process.env.B_UI_POINT_COUNT || 20);
let config = JSON.parse(JSON.stringify(defaults));
config.hasPassword = true; config.userName = 'fixture'; config.suId = '001122AABBCC'; config.suIp = '127.0.0.1';
config.scUrls = ['http://127.0.0.1:8079/services/SCService'];
function createCatalog(count, points) { return Array.from({ length: count }, (_v, i) => {
  const type = String(100 + Math.floor(i / 100));
  return { deviceId: String(i + 3), deviceName: '1办3号楼' + (i + 1) + '号温湿度', groupId: '1', serverCode: '1', bDeviceId: type + String(i % 100).padStart(2, '0'), rId: 'asset-' + (i + 3),
    params: Array.from({ length: points }, (_p, j) => ({ type: j % 2 ? 'DI' : 'AI', dataType: j % 2 ? '开关量' : '模拟量', paraName: '参数' + (j + 1), alarmName: '', signalId: type + '2' + String(j).padStart(3, '0') + '01000' })) };
}); }
let catalog = createCatalog(count, points);
config.devices = JSON.parse(JSON.stringify(catalog));
const saved = []; const app = express(); app.use(express.json({ limit: '16mb' }));
app.post('/fixture/reset', (req, res) => {
  catalog = createCatalog(Number(req.body.count || count), Number(req.body.points || points));
  config.enabled = req.body.enabled === true;
  config.devices = JSON.parse(JSON.stringify(catalog)); saved.length = 0; res.json({ ok: true });
});
app.post('/fixture/wrong-types', (_req, res) => {
  config.devices.forEach(d => d.params.forEach(p => { p.type = 'AI'; })); res.json({ ok: true });
});
app.post('/fixture/add-alarm', (_req, res) => {
  config.devices[0].params.push({ type: 'ALARM', alarmName: '高温告警', signalId: '100220777701' }); res.json({ ok: true });
});
function status() { return { enabled: false, running: false, registered: false, pending: 0, devices: config.devices.length, points: config.devices.reduce((n, d) => n + d.params.length, 0), lastError: '' }; }
app.get('/api/proto-conv/b-interface/config', (req, res) => res.json({ ok: true, config, status: status(), canManage: req.get('X-Fixture-Role') !== 'viewer' }));
app.get('/api/proto-conv/b-interface/status', (_req, res) => res.json({ ok: true, status: status() }));
app.get('/api/proto-conv/b-interface/alarm-definitions-source', (_req, res) => res.json({ ok: true, sourceId: 'fixture' }));
app.post('/api/proto-conv/b-interface/alarm-definitions', (req, res) => {
  const ids = require('../../proto-conv/b-interface-alarm-db').validateIds(req.body.deviceIds);
  const rules = [];
  ids.forEach(id => {
    for (let n = 1; n <= 30; n++) rules.push({ deviceId: id, ruleId: id + '-' + n, baseName: '测试参数' + n, type: 0, upper: '40', lower: '10' });
    rules.push({ deviceId: id, ruleId: id + '-duplicate1', baseName: '重复', type: 5 }, { deviceId: id, ruleId: id + '-duplicate2', baseName: '重复', type: 5 });
  });
  res.json({ ok: true, definitions: Object.assign(require('../../proto-conv/b-interface-alarm-definitions').build({ source: 'fixture', deviceIds: ids, rules, types: { 1: '高于阈值', 2: '低于阈值', 3: '告警', 5: '设备连接异常' } }), { sourceId: 'fixture' }) });
});
app.get('/api/proto-conv/b-interface/query-requests', (_req, res) => res.json({ ok: true, requests: require('../../proto-conv/b-interface-query-requests').all(config) }));
app.get('/api/proto-conv/b-interface/mock-login-ack', (_req, res) => {
  try { res.json({ ok: true, name: 'LOGIN_ACK', code: 102, xml: require('../../proto-conv/b-interface-protocol').mockLoginAck(config) }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
app.get('/api/proto-conv/b-interface/mock-ack-script', (_req, res) => {
  try { res.json(Object.assign({ ok: true }, require('../../proto-conv/b-interface-mock-ack').generate(config))); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
app.post('/api/proto-conv/b-interface/query-preview/:type', (req, res) => {
  const p = require('../../proto-conv/b-interface-protocol'), q = require('../../proto-conv/b-interface-query-requests').generate(config, req.params.type);
  res.json({ ok: true, request: q, cachedAt: Date.now(), response: p.envelope(p.packet('Response', q.name + '_ACK', q.code + 1, p.identity(config) + '<Values><DeviceList><Device Id="10001"><Signal Id="100200001000" Value="25.5"/></Device></DeviceList></Values>'), config.soap, true) });
});
app.get('/api/proto-conv/b-interface/wsdl/:service', (req, res) => {
  res.type('text/xml').send(require('../../proto-conv/b-interface-wsdl').generate(config, req.params.service));
});
app.put('/api/proto-conv/b-interface/config', (req, res) => { saved.push(req.body); config = Object.assign({}, config, req.body, { hasPassword: true, password: '' }); res.json({ ok: true, config, status: status() }); });
app.get('/api/proto-conv/b-interface/inherited-devices', (_req, res) => res.json({ ok: true, devices: catalog }));
app.post('/api/proto-conv/b-interface/device', (req, res) => res.json({ ok: true, device: Object.assign({}, catalog.find(v => v.deviceId === req.body.deviceId) || catalog[0], { groupId: req.body.groupId, serverCode: req.body.serverCode || '1' }) }));
app.get('/fixture/saved', (_req, res) => res.json(saved));
app.get('/api/proto-conv/config', (_req, res) => res.json({ ok: true, config: { baseUrl: 'http://127.0.0.1', userName: '', userLsh: '1', timeoutMs: 8000, pathMap: {} } }));
app.get('/api/*', (_req, res) => res.json({ ok: true, config: {}, status: { enabled: false }, data: [] }));
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.use(express.static(path.resolve(__dirname, '../..')));
const server = app.listen(Number(process.env.B_UI_PORT || 3037), '127.0.0.1', () => console.log('B interface fixture: ' + count + ' devices / ' + points + ' points per device on ' + server.address().port));
