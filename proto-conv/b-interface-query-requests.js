'use strict';
const p = require('./b-interface-protocol');
const profiles = [{ type: 'AI', name: 'GET_AIDATA', code: 201 }, { type: 'DI', name: 'GET_DIDATA', code: 301 }, { type: 'ALARM', name: 'GET_ALARM', code: 601 }];
function generate(config, type) {
  if (!config.suId || !config.suIp) throw new Error('请先填写并保存 SU 编码和 SU 内网地址，再生成查询请求');
  const profile = profiles.find(v => v.type === type);
  if (!profile) throw new Error('查询类型仅支持 AI、DI 或 ALARM');
  let deviceCount = 0, pointCount = 0;
  const devices = config.devices.map(d => {
    const points = d.params.filter(v => v.type === type); if (!points.length) return '';
    deviceCount++; pointCount += points.length;
    const signals = points.map(v => '<Signal Id="' + p.esc(type === 'AI' ? v.signalId : v.signalId.slice(0, 10) + 'FF') + '"/>').join('\n');
    return '<Device Id="' + p.esc(d.bDeviceId) + '" RId="' + p.esc(d.rId) + '">\n' + signals + '\n</Device>';
  }).filter(Boolean).join('\n');
  const info = p.identity(config) + '<DeviceList>' + devices + '</DeviceList>';
  const business = p.packet('Request', profile.name, profile.code, info).replace(/></g, '>\n<');
  // Reuse the actual SOAP wrapper, displaying its string payload as readable CDATA.
  const xml = p.envelope(business, config.soap).replace(p.esc(business), '<![CDATA[\n' + business.replace(/\]\]>/g, ']]]]><![CDATA[>') + '\n]]>');
  if (Buffer.byteLength(xml) > p.LIMIT) throw new Error('查询请求超过 SOAP 2MB 限制，请减少映射数量或缩短设备资管编码');
  const contentType = config.soap.version === '1.2' ? 'application/soap+xml; charset=utf-8; action="' + config.soap.action + '"' : 'text/xml; charset=utf-8';
  return Object.assign({}, profile, { deviceCount, pointCount, endpoint: 'http://' + config.suIp + ':' + config.port + config.servicePath,
    method: 'POST', contentType, soapAction: config.soap.version === '1.1' ? '"' + config.soap.action + '"' : null, xml });
}
function all(config) { return profiles.map(v => generate(config, v.type)); }
module.exports = { generate, all };
