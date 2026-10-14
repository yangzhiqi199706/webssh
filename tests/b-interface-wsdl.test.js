'use strict';
const assert = require('assert'), http = require('http'), express = require('express');
const fs = require('fs'), path = require('path'), os = require('os');
const p = require('../proto-conv/b-interface-protocol');
const { Forwarder } = require('../proto-conv/b-interface-forwarder');
const { register } = require('../proto-conv/b-interface-routes');
function get(port, url, role, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method: method || 'GET', headers: { 'X-Role': role || '', Host: 'untrusted.example' } }, res => {
      let text = ''; res.on('data', b => { text += b; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }); req.on('error', reject); req.end();
  });
}
function inspect(xml, name, soap, endpoint) {
  const root = p.parse(xml);
  assert.strictEqual(root.name, 'definitions'); assert.strictEqual(root.uri, 'http://schemas.xmlsoap.org/wsdl/');
  assert.strictEqual(root.attrs.targetNamespace, soap.namespace);
  const schema = p.child(p.child(root, 'types'), 'schema');
  assert.strictEqual(schema.attrs.elementFormDefault, 'unqualified');
  const request = p.children(schema, 'element').find(e => e.attrs.name === soap.method);
  const response = p.children(schema, 'element').find(e => e.attrs.name === soap.method + 'Response');
  const field = el => p.child(p.child(p.child(el, 'complexType'), 'sequence'), 'element');
  assert.strictEqual(field(request).attrs.name, soap.parameter); assert.strictEqual(field(request).attrs.type, 'xsd:string');
  assert.strictEqual(field(response).attrs.name, soap.result);
  const binding = p.children(root, 'binding')[0], protocol = p.child(binding, 'binding');
  assert.strictEqual(protocol.uri, soap.version === '1.2' ? 'http://schemas.xmlsoap.org/wsdl/soap12/' : 'http://schemas.xmlsoap.org/wsdl/soap/');
  assert.strictEqual(protocol.attrs.style, 'document');
  assert.strictEqual(p.child(p.child(binding, 'operation'), 'operation').attrs.soapAction, soap.action);
  const service = p.child(root, 'service'); assert.strictEqual(service.attrs.name, name);
  assert.strictEqual(p.child(p.child(service, 'port'), 'address').attrs.location, endpoint);
  assert.ok(!xml.includes('PASSWORD_FIXTURE') && !xml.includes('USER_FIXTURE') && !xml.includes('DEVICE_PRIVATE'), 'WSDL must not disclose credentials or device mappings');
  assert.ok(!xml.includes('schemaLocation='), 'WSDL import must work offline');
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b-soap-http-'));
  const manager = new Forwarder({ file: path.join(dir, 'config.json'), sourceId: () => 'fixture', collect: async () => ({ samples: [], alarms: [] }) });
  const app = express(); app.use(express.json());
  register(app, manager, (req, res) => { if (!req.get('X-Role')) { res.status(401).json({ ok: false }); return null; } return { role: req.get('X-Role') }; }, {});
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const webPort = server.address().port, api = '/api/proto-conv/b-interface/wsdl/';
  try {
    await manager.configure({ enabled: false, suIp: '127.0.0.1', port: 8079, userName: 'USER_FIXTURE', password: 'PASSWORD_FIXTURE',
      scUrls: ['http://127.0.0.1:8089/services/SCService'], devices: [{ deviceId: 'DEVICE_PRIVATE', bDeviceId: '10001', params: [] }] });
    let r = await get(webPort, api + 'su', 'viewer');
    assert.strictEqual(r.status, 200, 'logged-in viewer should download SU WSDL while forwarding is disabled');
    assert.ok(r.headers['content-type'].includes('xml'));
    assert.ok(r.headers['content-disposition'].includes('attachment') && r.headers['content-disposition'].includes('SUService.wsdl'));
    inspect(r.text, 'SUService', manager.rawConfig().soap, 'http://127.0.0.1:8079/services/SUService');
    r = await get(webPort, api + 'sc', 'operator'); assert.strictEqual(r.status, 200);
    inspect(r.text, 'SCService', manager.rawConfig().soap, 'http://127.0.0.1:8089/services/SCService');
    assert.strictEqual((await get(webPort, api + 'su')).status, 401);
    assert.strictEqual((await get(webPort, api + 'other', 'viewer')).status, 400);
    await manager.configure({ soap: { version: '1.2', namespace: 'urn:test?a=1&b=2', method: 'sendXml', parameter: 'payload', result: 'resultXml', action: 'urn:send?a=1&b=2' } });
    r = await get(webPort, api + 'su', 'viewer'); inspect(r.text, 'SUService', manager.rawConfig().soap, 'http://127.0.0.1:8079/services/SUService');
    await manager.configure({ suIp: '' }); assert.strictEqual((await get(webPort, api + 'su', 'viewer')).status, 400);
    await manager.configure({ suIp: '127.0.0.1', scUrls: [] }); assert.strictEqual((await get(webPort, api + 'sc', 'viewer')).status, 400);

    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const suPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
    await manager.configure({ enabled: true, host: '127.0.0.1', suIp: '127.0.0.1', suId: '001122AABBCC', port: suPort, allowedIps: ['127.0.0.1'],
      scUrls: ['http://127.0.0.1:8089/SCService'], devices: [{ deviceId: 'DEVICE_PRIVATE', bDeviceId: '10001', params: [{ type: 'AI', paraName: 'temperature', signalId: '100200100100' }] }] });
    const beforeHeartbeat = manager.lastHeartbeat, beforeLogs = manager.logs().length;
    for (const query of ['?wsdl', '?WSDL', '?WsDl']) {
      r = await get(suPort, '/services/SUService' + query);
      assert.strictEqual(r.status, 200); inspect(r.text, 'SUService', manager.rawConfig().soap, 'http://127.0.0.1:' + suPort + '/services/SUService');
      assert.strictEqual(r.headers['cache-control'], 'no-store'); assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    }
    r = await get(suPort, '/services/SUService?wsdl', null, 'HEAD'); assert.strictEqual(r.status, 200); assert.strictEqual(r.text, '');
    assert.strictEqual(manager.lastHeartbeat, beforeHeartbeat, 'metadata downloads must not count as SC heartbeat');
    assert.strictEqual(manager.logs().length, beforeLogs, 'metadata downloads must not create query logs');
    assert.strictEqual((await get(suPort, '/services/SUService?wsdl&other=1')).status, 404);
    assert.strictEqual((await get(suPort, '/services/SUService')).status, 404);
    await manager.configure({ allowedIps: ['192.0.2.9'] });
    assert.strictEqual((await get(suPort, '/services/SUService?wsdl')).status, 403, 'WSDL must keep the existing SC IP whitelist');
    console.log('PASS WSDL downloads: saved SOAP bindings, offline schema, auth, privacy, disabled mode, SU HTTP GET/HEAD, whitelist and heartbeat isolation');
  } finally { await manager.stop(false); await new Promise(resolve => server.close(resolve)); require('./helpers/b-interface-cleanup')(dir); }
})().catch(e => { console.error(e); process.exitCode = 1; });
