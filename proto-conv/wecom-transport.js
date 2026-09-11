'use strict';
const https = require('https');

function validateWebhook(value) {
  let url;
  try { url = new URL(value); } catch (_e) { throw new Error('请输入有效的企业微信群机器人 Webhook'); }
  if (url.protocol !== 'https:' || url.hostname !== 'qyapi.weixin.qq.com' || (url.port && url.port !== '443') ||
      url.pathname !== '/cgi-bin/webhook/send' || url.username || url.password || url.hash ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(url.searchParams.get('key') || '') ||
      Array.from(url.searchParams.keys()).length !== 1) throw new Error('仅支持企业微信官方 HTTPS 群机器人 Webhook');
  return url.href;
}
function parseReply(status, text) {
  let data;
  try { data = JSON.parse(text); } catch (_e) { throw Object.assign(new Error('企业微信响应格式错误'), { retryable: true }); }
  if (status !== 200 || !data || data.errcode !== 0) {
    const code = data && Number.isInteger(data.errcode) ? data.errcode : 'unknown';
    throw Object.assign(new Error('企业微信发送失败：HTTP ' + status + '，错误码 ' + code), {
      retryable: status === 429 || status >= 500 || code === -1 || code === 45009 || code === 'unknown'
    });
  }
}
function short(value, max) {
  let result = '';
  for (const char of String(value || '').replace(/[\r\n\u0000-\u001f]/g, ' ')) {
    if (Buffer.byteLength(result + char, 'utf8') > max) return result + '...';
    result += char;
  }
  return result || '-';
}
function buildMessage(event) {
  if (event.type === 'test') return { msgtype: 'text', text: { content: '【WebSSH 企业微信转发测试】\n群机器人连接测试\n时间：' + new Date().toISOString() } };
  const a = event.alarm;
  return { msgtype: 'text', text: { content: [event.type === 'recovery' ? '【告警恢复】' : '【新增告警】',
    '区域：' + short(a.area, 150), '设备：' + short(a.device, 180), '等级：' + short(a.level, 60),
    '内容：' + short(a.content, 850), '发生时间：' + a.startedAt,
    event.type === 'recovery' ? '恢复时间：' + a.recoveredAt : '', '告警 ID：' + short(a.id, 100)
  ].filter(Boolean).join('\n') } };
}
function send(webhook, payload) {
  const url = validateWebhook(webhook);
  const data = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', rejectUnauthorized: true,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk.toString(); if (body.length > 65536) req.destroy(new Error('response-too-large')); });
      res.on('error', () => reject(Object.assign(new Error('企业微信响应中断'), { retryable: true })));
      res.on('end', () => { try { parseReply(res.statusCode, body); resolve(); } catch (e) { reject(e); } });
    });
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), 10000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', () => reject(Object.assign(new Error('企业微信网络连接失败或超时'), { retryable: true })));
    req.end(data);
  });
}
module.exports = { validateWebhook, parseReply, buildMessage, send };
