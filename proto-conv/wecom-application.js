'use strict';
const https = require('https');
const crypto = require('crypto');
const defaults = () => ({ corpId: '', agentId: '', secret: '', toUser: '', toParty: '', toTag: '' });
function validate(a, recipients) {
  if (!a || !/^[\w-]{1,100}$/.test(a.corpId) || !/^[1-9]\d{0,9}$/.test(a.agentId) || typeof a.secret !== 'string' || !a.secret || a.secret.length > 512) throw new Error('请填写有效的 CorpID、AgentID 和 Secret');
  if (recipients && !a.toUser && !a.toParty && !a.toTag) throw new Error('请至少填写一种接收对象');
  for (const key of ['toUser', 'toParty', 'toTag']) {
    if (typeof a[key] !== 'string' || a[key].length > 2000 || (a[key] && !(key === 'toUser' ? /^[\w@.-]+(?:\|[\w@.-]+)*$/ : /^\d+(?:\|\d+)*$/).test(a[key]))) throw new Error('接收对象格式错误，请使用 | 分隔 ID');
  }
  if (a.toUser.includes('@all') && a.toUser !== '@all') throw new Error('@all 必须单独填写');
}
function error(code) {
  const hints = { 40013: '企业 ID 无效', 40001: 'Secret 或凭证无效', 40014: '访问凭证无效', 42001: '访问凭证过期', 60020: '出口公网 IP 不在应用可信 IP 列表', 60011: '接收人不在应用可见范围', 81013: '接收对象全部无效', 40003: '成员 ID 无效', 40054: '部门 ID 无效', 40068: '标签 ID 无效', 301002: '缺少应用访问权限', 45009: '调用频率超限' };
  return Object.assign(new Error('企业微信应用错误 ' + (Number.isInteger(code) ? code : 'unknown') + '：' + (hints[code] || '请核对应用权限、接收对象及企业微信配置')), { retryable: code === -1 || code === 45009 });
}
function request(url, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? Buffer.from(JSON.stringify(payload)) : null;
    const req = https.request(url, { method: body ? 'POST' : 'GET', rejectUnauthorized: true,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {} }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy(new Error('response-too-large')); });
      res.on('error', () => reject(Object.assign(new Error('企业微信响应中断'), { retryable: true })));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error('企业微信 HTTP ' + res.statusCode), { retryable: res.statusCode === 429 || res.statusCode >= 500 }));
        try { const data = JSON.parse(text); if (!data || typeof data !== 'object') throw Error(); resolve(data); }
        catch (_e) { reject(Object.assign(new Error('企业微信响应格式错误'), { retryable: true })); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), 10000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', e => reject(Object.assign(new Error(e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' ? '企业微信域名解析失败，请检查宿主机 DNS' : '企业微信网络连接失败或超时'), { retryable: true })));
    req.end(body);
  });
}
function createClient(fetchJSON, now) {
  fetchJSON = fetchJSON || request; now = now || Date.now;
  let cached = null, pending = null;
  async function token(a) {
    const key = crypto.createHash('sha256').update(a.corpId + '\0' + a.secret).digest('hex');
    if (cached && cached.key === key && cached.until > now()) return cached.value;
    if (pending && pending.key === key) return pending.promise;
    const job = { key };
    job.promise = (async () => {
      const r = await fetchJSON('https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=' + encodeURIComponent(a.corpId) + '&corpsecret=' + encodeURIComponent(a.secret));
      if (r.errcode !== 0) throw error(r.errcode);
      if (typeof r.access_token !== 'string' || !r.access_token || !Number.isFinite(r.expires_in) || r.expires_in <= 0) throw new Error('企业微信凭证响应无效');
      cached = { key, value: r.access_token, until: now() + Math.max(0, r.expires_in - 120) * 1000 };
      return cached.value;
    })();
    pending = job;
    try { return await job.promise; } finally { if (pending === job) pending = null; }
  }
  return {
    credentials: async a => { validate(a, false); await token(a); },
    send: async (a, payload) => {
      validate(a, true);
      for (let attempt = 0; attempt < 2; attempt++) {
        const value = await token(a);
        const r = await fetchJSON('https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=' + encodeURIComponent(value), {
          touser: a.toUser, toparty: a.toParty, totag: a.toTag, agentid: Number(a.agentId), msgtype: 'text', text: payload.text,
          enable_duplicate_check: 1, duplicate_check_interval: 1800
        });
        if ([40014, 42001].includes(r.errcode) && attempt === 0) { cached = null; continue; }
        if (r.errcode !== 0) throw error(r.errcode);
        if (r.invaliduser || r.invalidparty || r.invalidtag || r.unlicenseduser) throw Object.assign(new Error('部分接收对象无效或无许可，其他对象可能已接收；请核对应用可见范围及成员/部门/标签 ID'), { retryable: false });
        return;
      }
    }
  };
}
module.exports = { defaults, validate, createClient };
