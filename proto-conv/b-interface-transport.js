'use strict';
const http = require('http');
const https = require('https');
const p = require('./b-interface-protocol');
function request(url, xml, cfg) {
  return new Promise((resolve, reject) => {
    const body = p.envelope(xml, cfg.soap), address = new URL(url);
    const contentType = cfg.soap.version === '1.2' ? 'application/soap+xml; charset=utf-8; action="' + cfg.soap.action + '"' : 'text/xml; charset=utf-8';
    const headers = { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) };
    if (cfg.soap.version === '1.1') headers.SOAPAction = '"' + cfg.soap.action + '"';
    let timer, settled = false;
    function done(err, result) { if (settled) return; settled = true; clearTimeout(timer); if (err) reject(err); else resolve(result); }
    const req = (address.protocol === 'https:' ? https : http).request(address, { method: 'POST', headers, rejectUnauthorized: cfg.verifyTls !== false }, res => {
      let size = 0; const chunks = [];
      res.on('data', b => { size += b.length; if (size > p.LIMIT) { done(new Error('上级 SOAP 响应超过 2MB')); res.destroy(); req.destroy(); } else chunks.push(b); });
      res.on('error', () => done(new Error('上级 SOAP 响应中断')));
      res.on('aborted', () => done(new Error('上级 SOAP 响应中断')));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return done(new Error('上级 HTTP ' + res.statusCode));
        try { done(null, p.unwrap(Buffer.concat(chunks).toString('utf8'), cfg.soap, true)); } catch (e) { done(e); }
      });
    });
    timer = setTimeout(() => { done(new Error('上级 SOAP 请求超时')); req.destroy(); }, cfg.timeoutMs);
    req.on('error', e => done(new Error('上级 SOAP 连接失败：' + (e.code || 'NETWORK'))));
    req.end(body);
  });
}
module.exports = { request };
