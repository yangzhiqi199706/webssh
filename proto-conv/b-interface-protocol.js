'use strict';
// QB/CU 132-2024: business XML inside a configurable SOAP string operation.
const sax = require('sax');
const LIMIT = 2 * 1024 * 1024;
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); }
function tag(n, v) { return '<' + n + '>' + esc(v) + '</' + n + '>'; }
function parse(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > LIMIT || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML 超限或含不允许的声明');
  const parser = sax.parser(true, { xmlns: true, strictEntities: true });
  let root, count = 0;
  const stack = [];
  parser.onopentag = node => {
    if (stack.length >= 64 || ++count > 30000) throw new Error('XML 层级或节点数量超限');
    const item = { name: node.local, uri: node.uri, attrs: Object.create(null), children: [], text: '' };
    Object.keys(node.attributes).forEach(k => { const a = node.attributes[k]; if (!a.prefix) item.attrs[a.local] = a.value; });
    if (stack.length) stack[stack.length - 1].children.push(item);
    else { if (root) throw new Error('XML 只能包含一个根节点'); root = item; }
    stack.push(item);
  };
  parser.ontext = parser.oncdata = t => { if (stack.length) stack[stack.length - 1].text += t; else if (t.trim()) throw new Error('XML 根节点之外含文本'); };
  parser.onclosetag = () => stack.pop();
  try { parser.write(xml).close(); } catch (_e) { throw new Error('XML 格式错误或超出限制'); }
  if (!root) throw new Error('XML 为空');
  return root;
}
function children(n, name) { return n ? n.children.filter(c => c.name === name) : []; }
function child(n, name) { const list = children(n, name); if (list.length > 1) throw new Error('XML 重复字段：' + name); return list[0]; }
function value(n, name) { const c = child(n, name); return c ? c.text.trim() : ''; }
function message(xml) {
  const root = parse(xml);
  if (!['Request', 'Response'].includes(root.name)) throw new Error('B 接口报文根节点错误');
  const pk = child(root, 'PK_Type'), info = child(root, 'Info');
  const name = value(pk, 'Name'), code = Number(value(pk, 'Code'));
  if (!/^[A-Za-z_]+$/.test(name) || !Number.isInteger(code) || code < 1 || !info) throw new Error('B 接口报文头错误');
  return { root: root.name, name, code, info };
}
function envelope(xml, soap, response) {
  const uri = soap.version === '1.2' ? 'http://www.w3.org/2003/05/soap-envelope' : 'http://schemas.xmlsoap.org/soap/envelope/';
  const method = soap.method + (response ? 'Response' : '');
  return '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="' + uri + '" xmlns:b="' + esc(soap.namespace) + '"><s:Body><b:' + method + '>' + tag(response ? soap.result : soap.parameter, xml) + '</b:' + method + '></s:Body></s:Envelope>';
}
function unwrap(xml, soap, response) {
  const root = parse(xml);
  if (root.name !== 'Envelope' || !['http://schemas.xmlsoap.org/soap/envelope/', 'http://www.w3.org/2003/05/soap-envelope'].includes(root.uri)) throw new Error('预期 SOAP Envelope');
  const body = child(root, 'Body');
  if (!body || body.uri !== root.uri || body.children.length !== 1) throw new Error('SOAP Body 格式错误');
  const operation = body.children[0];
  if (operation.name === 'Fault') throw new Error('上级返回 SOAP Fault');
  if (operation.name !== soap.method + (response ? 'Response' : '') || operation.uri !== soap.namespace) throw new Error('SOAP 方法或命名空间不匹配');
  const param = child(operation, response ? soap.result : soap.parameter);
  if (!param || param.children.length || !param.text.trim()) throw new Error('SOAP XML 字符串参数为空或格式错误');
  return param.text.trim();
}
function packet(root, name, code, info) { return '<?xml version="1.0" encoding="UTF-8"?><' + root + '><PK_Type>' + tag('Name', name) + tag('Code', code) + '</PK_Type><Info>' + info + '</Info></' + root + '>'; }
function identity(cfg) { return tag('SUId', cfg.suId) + tag('SURId', cfg.suRId); }
function deviceAttrs(d) { return ['Id', 'RId', 'DeviceVender', 'DeviceType', 'BatchNo', 'MFD', 'ControllerType', 'SoftwareVersion'].map((k, i) => ' ' + k + '="' + esc([d.bDeviceId, d.rId, d.vendor, d.model, d.batchNo, d.mfd, d.controllerType, d.softwareVersion][i]) + '"').join(''); }
function login(cfg) {
  return packet('Request', 'LOGIN', 101, tag('UserName', cfg.userName) + tag('PassWord', cfg.password) + identity(cfg) + tag('SUIP', cfg.suIp) + tag('SUPort', cfg.port) + tag('SUVendor', cfg.vendor) + tag('SUModel', cfg.model) + tag('SUHardVer', cfg.hardVer) + tag('SUConfigTime', cfg.configTime) + '<Location>' + tag('Longitude', cfg.longitude) + tag('Latitude', cfg.latitude) + '</Location><DeviceList>' + cfg.devices.map(d => '<Device' + deviceAttrs(d) + '/>').join('') + '</DeviceList>' + tag('SUVer', cfg.suVer));
}
function mockLoginAck(cfg) {
  if (!/^[0-9A-Fa-f]{12}$/.test(cfg.suId || '')) throw new Error('请先填写并保存 12 位 SU 编码，再复制 LOGIN_ACK 响应');
  const xml = packet('Response', 'LOGIN_ACK', 102, tag('SUId', cfg.suId) + '<RightLevel>1</RightLevel>').replace(/></g, '>\n<');
  return envelope(xml, cfg.soap, true).replace(esc(xml), '<![CDATA[\n' + xml + '\n]]>');
}
function stamp(ms) { return new Date((ms == null ? Date.now() : ms) + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '); }
function selected(info, device, signal) {
  const list = child(info, 'DeviceList');
  if (!list || !list.children.length) return true;
  return children(list, 'Device').some(d => {
    if (d.attrs.Id && d.attrs.Id !== device.bDeviceId || d.attrs.RId && d.attrs.RId !== device.rId) return false;
    const signals = children(d, 'Signal');
    return !signals.length || signals.some(s => !s.attrs.Id || s.attrs.Id.slice(0, 10) === signal.signalId.slice(0, 10));
  });
}
function signalId(point, val) {
  if (point.type !== 'DI') return point.signalId;
  const state = val == null || !Number.isInteger(Number(val)) || Number(val) < 0 || Number(val) > 99 ? 'FF' : String(Number(val)).padStart(2, '0');
  return point.signalId.slice(0, 10) + state;
}
function data(cfg, samples, type, name, code, filter, reportTime) {
  const devices = cfg.devices.map(d => {
    const signals = d.params.filter(s => s.type === type && selected(filter, d, s)).map(s => {
      const sample = samples.find(v => v.deviceId === d.deviceId && v.paraName === s.paraName);
      const val = sample && sample.value != null && Number.isFinite(Number(sample.value)) ? Number(sample.value) : null;
      return '<Signal Id="' + signalId(s, val) + '"' + (type === 'AI' ? ' Value="' + esc(val) + '"' : '') + '/>';
    }).join('');
    return signals ? '<Device' + deviceAttrs(d) + '>' + signals + '</Device>' : '';
  }).join('');
  return packet('Response', name, code, identity(cfg) + tag('ReportTime', reportTime || stamp()) + '<Values><DeviceList>' + devices + '</DeviceList></Values>');
}
function truncate(text, max) { let out = ''; for (const c of String(text || '').replace(/[<>]/g, '')) { if (Buffer.byteLength(out + c) > max) break; out += c; } return out; }
function alarms(cfg, list, name, code, root) {
  const body = list.map(a => '<TAlarm>' + tag('SerialNo', a.serial) + tag('DeviceId', a.bDeviceId) + tag('DeviceRId', a.rId) + '<Signal Id="' + esc(a.signalId) + '"/>' + tag('AlarmTime', a.time) + tag('TriggerVal', a.value) + tag('AlarmFlag', a.flag) + tag('AlarmDesc', truncate(a.desc, 40)) + '</TAlarm>').join('');
  return packet(root || 'Request', name || 'SEND_ALARM', code || 603, identity(cfg) + '<Values><TAlarmList>' + body + '</TAlarmList></Values>');
}
function ack(xml, requestName, code, suId) {
  const m = message(xml);
  if (m.root !== 'Response' || m.name !== requestName + '_ACK' || m.code !== code + 1) throw new Error('上级业务 ACK 类型不匹配');
  if (value(m.info, 'SUId') && value(m.info, 'SUId') !== suId) throw new Error('上级 ACK SUId 不匹配');
  if (requestName === 'LOGIN') {
    if (!['1', '2'].includes(value(m.info, 'RightLevel'))) throw new Error('上级拒绝注册（RightLevel）');
  } else if (!['1', 'SUCCESS'].includes(value(m.info, 'Result'))) throw new Error('上级业务 ACK 返回失败');
  return true;
}
module.exports = { LIMIT, esc, tag, parse, child, children, value, message, envelope, unwrap, packet, identity, login, mockLoginAck, stamp, selected, signalId, data, alarms, ack, truncate };
