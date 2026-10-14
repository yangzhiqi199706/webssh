'use strict';
const fs = require('fs');
function alarmMatches(devices, alarm) {
  const direct = [], legacy = [];
  devices.forEach(d => {
    if (alarm.deviceId ? d.deviceId !== alarm.deviceId : !alarm.deviceName || d.deviceName !== alarm.deviceName) return;
    d.params.filter(s => s.type === 'ALARM').forEach(s => {
      if (s.alarmName === alarm.name) direct.push({ d, s });
      else if (Array.isArray(alarm.legacyNames) && alarm.legacyNames.includes(s.alarmName)) legacy.push({ d, s });
    });
  });
  return direct.length ? direct : legacy;
}
const path = require('path');
const net = require('net');
const http = require('http');
const os = require('os');
const p = require('./b-interface-protocol');
const transport = require('./b-interface-transport');
const wsdl = require('./b-interface-wsdl');
const clone = v => JSON.parse(JSON.stringify(v));
const defaults = { enabled: false, scUrls: [], allowedIps: [], host: '0.0.0.0', port: 8080, servicePath: '/services/SUService',
  suId: '', suRId: '', suIp: '', userName: '', password: '', vendor: 'WEBSSH', model: 'DCIM-BRIDGE', hardVer: '1.0', suVer: '3.0',
  longitude: 0, latitude: 0, pollSec: 10, retrySec: 60, heartbeatSec: 60, timeoutMs: 8000, verifyTls: true, configTime: '',
  soap: { version: '1.1', namespace: 'http://server.webservice.hnust.cn.com', method: 'invoke', parameter: 'xmlData', result: 'invokeReturn', action: '' },
  devices: [], alarmFields: {} };
function fail(message) { throw new Error(message); }
function text(v, name, max, pattern) {
  if (typeof v !== 'string' || Buffer.byteLength(v) > max || /[\x00-\x1f<>]/.test(v) || pattern && !pattern.test(v)) fail(name + ' 格式或长度错误');
  return v;
}
function integer(v, name, min, max) { if (!Number.isInteger(v) || v < min || v > max) fail(name + ' 范围应为 ' + min + '–' + max); return v; }
function ip(v) { return String(v || '').replace(/^::ffff:/, ''); }
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('配置格式错误');
  const c = Object.assign(clone(defaults), input); c.soap = Object.assign({}, defaults.soap, input.soap);
  Object.keys(c).forEach(k => { if (!(k in defaults)) delete c[k]; });
  ['enabled', 'verifyTls'].forEach(k => { if (typeof c[k] !== 'boolean') fail(k + ' 必须为布尔值'); });
  integer(c.port, 'SU 服务端口', 1024, 65535); integer(c.pollSec, '采集周期', 5, 3600); integer(c.retrySec, '注册重试周期', 60, 600);
  integer(c.heartbeatSec, '心跳周期', 10, 3600); integer(c.timeoutMs, '请求超时', 1000, 60000);
  text(c.servicePath, '服务路径', 100, /^\/[A-Za-z0-9_/-]+$/);
  if (!net.isIP(c.host)) fail('监听地址必须为 IP');
  if (!Array.isArray(c.allowedIps) || c.allowedIps.length > 50 || c.allowedIps.some(v => !net.isIP(v))) fail('上级 IP 白名单错误');
  c.allowedIps = Array.from(new Set(c.allowedIps.map(ip)));
  if (!Array.isArray(c.scUrls) || c.scUrls.length > 3) fail('注册地址最多三个');
  c.scUrls = c.scUrls.map(v => {
    text(v, 'SC 地址', 500); let u; try { u = new URL(v); } catch (_e) { fail('SC 地址无效'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) fail('SC 地址仅支持无凭据的 HTTP/HTTPS');
    return u.href;
  });
  [['suId', 12], ['suRId', 120], ['suIp', 15], ['userName', 20], ['password', 20], ['vendor', 50], ['model', 20], ['hardVer', 20], ['suVer', 20], ['configTime', 19]].forEach(a => text(c[a[0]], a[0], a[1]));
  if (c.suId && !/^[A-Fa-f0-9]{12}$/.test(c.suId)) fail('SUId 必须为 12 位 MAC 十六进制编码（无分隔符）');
  c.suId = c.suId.toUpperCase();
  if (c.suIp && net.isIP(c.suIp) !== 4) fail('SU 内网地址必须为 IPv4');
  if (!Number.isFinite(c.longitude) || c.longitude < -180 || c.longitude > 180 || !Number.isFinite(c.latitude) || c.latitude < -90 || c.latitude > 90) fail('经纬度错误');
  if (!['1.1', '1.2'].includes(c.soap.version)) fail('SOAP 版本错误');
  text(c.soap.namespace, 'SOAP 命名空间', 200, /^(?:https?:\/\/|urn:)/);
  ['method', 'parameter', 'result'].forEach(k => text(c.soap[k], 'SOAP ' + k, 50, /^[A-Za-z_][A-Za-z0-9_]*$/));
  text(c.soap.action, 'SOAPAction', 200); if (/["\r\n]/.test(c.soap.action)) fail('SOAPAction 含无效字符');
  if (!Array.isArray(c.devices) || c.devices.length > 500) fail('设备列表错误（最多 500）');
  const dcimIds = new Set(), bIds = new Set(); let total = 0;
  c.devices = c.devices.map(d => {
    if (!d || typeof d !== 'object') fail('设备配置错误');
    const out = {};
    [['deviceId', 80], ['deviceName', 200], ['groupId', 80], ['serverCode', 80], ['bDeviceId', 5], ['rId', 120], ['vendor', 10], ['model', 20], ['batchNo', 20], ['mfd', 10], ['controllerType', 20], ['softwareVersion', 10]].forEach(a => { out[a[0]] = text(d[a[0]] == null ? '' : d[a[0]], a[0], a[1]); });
    if (!out.deviceId || !/^\d{5}$/.test(out.bDeviceId) || dcimIds.has(out.deviceId) || bIds.has(out.bDeviceId)) fail('设备 ID 缺失、重复或 B 设备编码不是五位数字');
    dcimIds.add(out.deviceId); bIds.add(out.bDeviceId);
    if (!Array.isArray(d.params) || d.params.length > 1000) fail('测点列表错误');
    const ids = new Set(), sources = new Set();
    out.params = d.params.map(s => {
      if (!s || !['AI', 'DI', 'ALARM'].includes(s.type)) fail('测点类型错误');
      const point = { type: s.type, paraName: text(s.paraName || '', 'DCIM 参数名', 200), alarmName: text(s.alarmName || '', 'DCIM 告警名称', 300), signalId: text(s.signalId || '', '联通监控信息 ID', 12) };
      if (!/^\d{12}$/.test(point.signalId) || ids.has(point.signalId.slice(0, 10))) fail('监控信息 ID 必须为 12 位数字且同设备不可重复');
      if (point.signalId.slice(0, 3) !== out.bDeviceId.slice(0, 3)) fail('监控信息 ID 的设备类型必须与五位设备编码一致');
      if (point.type !== 'ALARM' && point.signalId.slice(-2) !== '00') fail('遥测/遥信映射请填写末两位为 00 的基准 ID');
      const source = point.type + ':' + (point.type === 'ALARM' ? point.alarmName : point.paraName);
      if (!source.split(':').slice(1).join(':') || sources.has(source)) fail('DCIM 参数或告警名称缺失/重复');
      ids.add(point.signalId.slice(0, 10)); sources.add(source); total++;
      return point;
    });
    return out;
  });
  if (total > 10000) fail('测点总数最多 10000');
  if (!c.alarmFields || typeof c.alarmFields !== 'object' || Array.isArray(c.alarmFields)) fail('告警字段映射必须为对象');
  const fields = {}; ['id', 'startedAt', 'recoveredAt', 'device', 'area', 'level', 'content', 'deviceId', 'alarmName', 'value'].forEach(k => { if (c.alarmFields[k]) fields[k] = text(c.alarmFields[k], '告警字段名', 80, /^[A-Za-z_][A-Za-z0-9_]*$/); }); c.alarmFields = fields;
  if (c.enabled && (!c.suId || !c.suIp || !c.userName || !c.password || !c.scUrls.length || !c.allowedIps.length || !total)) fail('启用前请填写 SU、SC 地址、账号、IP 白名单以及设备测点映射');
  return c;
}
function emptyState() { return { seq: 0, events: {}, pending: [], lastPollAt: 0, sourceId: '' }; }
function validateState(state) {
  if (!state || !Number.isInteger(state.seq) || state.seq < 0 || state.seq > 4294967295 || !Number.isFinite(state.lastPollAt) || state.lastPollAt < 0 || typeof state.sourceId !== 'string' ||
      !Array.isArray(state.pending) || state.pending.length > 10000 || !state.events || typeof state.events !== 'object' || Array.isArray(state.events) || Object.keys(state.events).length > 20000) fail('持久状态错误');
  function serial(v) { return typeof v === 'string' && /^\d{10}$/.test(v) && Number(v) >= 1 && Number(v) <= 4294967295; }
  function alarm(a) {
    if (!a || typeof a !== 'object' || !/^[A-Za-z0-9_-]{1,128}$/.test(a.key) || !serial(a.serial) || !/^\d{5}$/.test(a.bDeviceId) || !/^\d{12}$/.test(a.signalId) ||
        !['BEGIN', 'END'].includes(a.flag) || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(a.time) || !Number.isFinite(Date.parse(a.time.replace(' ', 'T') + '+08:00')) || typeof a.rId !== 'string' || typeof a.desc !== 'string' || Buffer.byteLength(a.desc) > 40 || a.value !== '' && !Number.isFinite(a.value)) fail('持久告警格式错误');
  }
  Object.keys(state.events).forEach(k => {
    const e = state.events[k];
    if (!e || typeof e !== 'object' || !serial(e.serial) || typeof e.ended !== 'boolean' || !Number.isFinite(e.started) || !Number.isFinite(e.endAt) || e.ended && e.endAt < e.started) fail('持久告警事件错误');
    alarm(e.alarm); if (e.alarm.key !== k || e.alarm.serial !== e.serial || e.alarm.flag !== 'BEGIN') fail('持久告警关联错误');
  });
  state.pending.forEach(a => { alarm(a); if (!state.events[a.key] || state.events[a.key].serial !== a.serial) fail('持久队列关联错误'); });
  return state;
}
class Forwarder {
  constructor(options) {
    this.options = options; this.now = options.now || Date.now; this.cfg = clone(defaults); this.state = emptyState();
    this.send = options.send || transport.request; this.collect = options.collect;
    this.cache = { samples: [], at: 0 }; this.entries = []; this.server = null; this.timer = null; this.registered = false;
    this.lastHeartbeat = 0; this.registeredAt = 0; this.nextLoginAt = 0; this.targetIndex = 0; this.loginFailures = 0; this.assignedUrl = ''; this.lastError = ''; this.queue = Promise.resolve(); this.loadError = '';
    if (fs.existsSync(options.file)) {
      try {
        if (fs.statSync(options.file).size > 64 * 1024 * 1024) fail('持久文件超过限制');
        const stored = JSON.parse(fs.readFileSync(options.file, 'utf8')); this.cfg = validate(stored.config);
        this.state = validateState(stored.state); this.state.pending.forEach(a => { a.history = true; });
      } catch (_e) { this.cfg = clone(defaults); this.state = emptyState(); this.loadError = 'B 接口配置或状态损坏，已停用；请检查备份后恢复文件'; this.lastError = this.loadError; }
    }
  }
  exclusive(fn) { const job = this.queue.then(fn); this.queue = job.catch(() => {}); return job; }
  rawConfig() { return clone(this.cfg); }
  config() { const c = this.rawConfig(); c.hasPassword = !!c.password; c.password = ''; return c; }
  status() { return { enabled: this.cfg.enabled, running: !!this.server && this.server.listening, registered: this.registered, pending: this.state.pending.length,
    devices: this.cfg.devices.length, points: this.cfg.devices.reduce((n, d) => n + d.params.length, 0), cachedAt: this.cache.at, lastPollAt: this.state.lastPollAt,
    lastHeartbeat: this.lastHeartbeat, lastError: this.safeError(this.lastError), endpoint: this.cfg.suIp ? 'http://' + this.cfg.suIp + ':' + this.cfg.port + this.cfg.servicePath : '', targetIndex: this.targetIndex + 1 };
  }
  safeError(message) { let out = String(message || ''); if (this.cfg.password) out = out.split(this.cfg.password).join('***'); return out.slice(0, 300); }
  log(name, result, message) { this.entries.push({ at: p.stamp(this.now()), name, result, message: this.safeError(message) }); if (this.entries.length > 200) this.entries.shift(); }
  logs() { return clone(this.entries); }
  save(config, state) {
    const target = this.options.file, temp = target + '.tmp'; fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify({ version: 1, config, state }, null, 2), { mode: 0o600 }); fs.chmodSync(temp, 0o600); fs.renameSync(temp, target); fs.chmodSync(target, 0o600);
  }
  configure(input) { return this.exclusive(async () => {
    if (this.loadError) fail(this.loadError);
    const merged = Object.assign(this.rawConfig(), input, { soap: Object.assign({}, this.cfg.soap, input.soap) });
    if (input.password === '' || input.password === '***') merged.password = this.cfg.password;
    const next = validate(merged);
    const identityChanged = JSON.stringify([next.suId, next.suRId, next.scUrls, next.devices, next.alarmFields]) !== JSON.stringify([this.cfg.suId, this.cfg.suRId, this.cfg.scUrls, this.cfg.devices, this.cfg.alarmFields]);
    const currentSource = this.options.sourceId();
    const rebindSource = !this.state.sourceId || next.enabled && this.state.sourceId !== currentSource;
    if ((identityChanged || rebindSource) && this.state.pending.length) fail('有未确认告警，不能切换 SU、上级、数据源或映射；先恢复连接发送完成');
    const state = clone(this.state);
    if (identityChanged || rebindSource) { state.events = {}; state.lastPollAt = 0; }
    if (rebindSource) state.sourceId = currentSource;
    if (identityChanged || !next.configTime) next.configTime = p.stamp(this.now());
    // Persist first: a failed write must leave the existing running configuration intact.
    this.save(next, state); await this._stop(false); this.cfg = next; this.state = state; this.lastError = '';
    if (identityChanged || rebindSource) this.cache = { samples: [], at: 0 };
    this.log('CONFIG', 'success', next.enabled ? '已启用 B 接口转发' : '已保存，转发停用');
    if (next.enabled) await this._start();
    return this.config();
  }); }
  start() { return this.exclusive(() => this._start()); }
  async _start() {
    if (!this.cfg.enabled || this.server || this.loadError) return;
    validate(this.cfg); this.registered = false; this.nextLoginAt = 0; this.targetIndex = 0; this.loginFailures = 0; this.assignedUrl = '';
    const server = http.createServer((req, res) => this.receive(req, res)); this.server = server;
    server.requestTimeout = this.cfg.timeoutMs + 2000; server.headersTimeout = Math.max(10000, this.cfg.timeoutMs + 2000);
    server.setTimeout(this.cfg.timeoutMs + 2000, socket => socket.destroy()); server.maxConnections = 32;
    await new Promise((resolve, reject) => {
      server.once('error', e => { this.server = null; this.lastError = 'SU 监听失败：' + e.code; reject(new Error(this.lastError)); });
      server.listen(this.cfg.port, this.cfg.host, resolve);
    });
    server.on('error', e => { this.lastError = 'SU 监听异常：' + e.code; this.log('LISTEN', 'failed', this.lastError); });
    this.log('LISTEN', 'success', 'SU 服务已监听端口 ' + this.cfg.port); this.schedule();
  }
  stop(logout) { return this.exclusive(() => this._stop(logout !== false)); }
  async _stop(logout) {
    clearTimeout(this.timer); this.timer = null;
    if (logout && this.registered) { try { await this.transmit(p.packet('Request', 'LOGOUT', 103, p.identity(this.cfg))); } catch (_e) {} }
    this.registered = false;
    if (this.server) { const server = this.server; this.server = null; await new Promise(resolve => server.close(resolve)); }
  }
  schedule() {
    clearTimeout(this.timer);
    if (!this.server || !this.cfg.enabled) return;
    this.timer = setTimeout(() => { this.cycle(false).catch(() => {}).finally(() => this.schedule()); }, Math.min(this.cfg.pollSec, this.cfg.retrySec, this.cfg.heartbeatSec) * 1000);
    if (this.timer.unref) this.timer.unref();
  }
  target() { return this.assignedUrl || this.cfg.scUrls[this.targetIndex]; }
  async transmit(xml) {
    const m = p.message(xml);
    try { const reply = await this.send(this.target(), xml, this.cfg); p.ack(reply, m.name, m.code, this.cfg.suId); this.log(m.name, 'success', '业务 ACK 已确认'); return reply; }
    catch (e) { this.log(m.name, 'failed', e.message); throw e; }
  }
  cycle(force) { return this.exclusive(async () => { try { return await this._cycle(force !== false); } catch (e) { this.lastError = this.safeError(e.message); this.log('POLL', 'failed', e.message); throw e; } }); }
  async _cycle(force) {
    if (!this.cfg.enabled) return;
    if (this.state.sourceId !== this.options.sourceId()) { this.registered = false; this.cache = { samples: [], at: 0 }; fail('DCIM 数据源已变化，请重新保存 B 接口配置'); }
    const now = this.now();
    if (this.registered && now - (this.lastHeartbeat || this.registeredAt) > this.cfg.heartbeatSec * 3000) { this.registered = false; this.assignedUrl = ''; this.nextLoginAt = 0; this.log('HEARTBEAT', 'failed', '连续三个心跳周期未收到 SC 查询，重新注册'); }
    if (!this.registered && now >= this.nextLoginAt) {
      try { await this.transmit(p.login(this.cfg)); this.registered = true; this.registeredAt = now; this.lastHeartbeat = 0; this.loginFailures = 0; this.lastError = ''; }
      catch (e) { this.lastError = e.message; this.nextLoginAt = now + this.cfg.retrySec * 1000; if (++this.loginFailures >= 3) { this.targetIndex = (this.targetIndex + 1) % this.cfg.scUrls.length; this.loginFailures = 0; } }
    }
    // Old history has priority and can be delivered even if DCIM is temporarily down.
    const deliveryFailed = this.registered && !await this.flush();
    if (!force && this.cache.at && now - this.state.lastPollAt < this.cfg.pollSec * 1000) return;
    const snapshot = await this.collect(this.cfg, this.historySince(), now);
    if (this.state.sourceId !== this.options.sourceId()) fail('DCIM 数据源在采集期间发生变化');
    const state = clone(this.state); let unmapped = 0;
    for (const alarm of snapshot.alarms) {
      const matches = alarmMatches(this.cfg.devices, alarm);
      if (matches.length !== 1) { unmapped++; continue; }
      const start = Date.parse(alarm.startedAt), end = Date.parse(alarm.recoveredAt);
      if (!Number.isFinite(start)) fail('告警发生时间错误');
      let event = state.events[alarm.key];
      // An extended recovery query may return previously finished, unrelated history.
      if (!event && Number.isFinite(end) && Math.max(start, end) < this.state.lastPollAt - 60000) continue;
      if (!event) {
        if (Object.keys(state.events).length >= 20000) fail('告警状态容量已满，请检查上级 ACK');
        state.seq = state.seq >= 4294967295 ? 1 : state.seq + 1;
        event = { serial: String(state.seq).padStart(10, '0'), ended: false, started: start, endAt: 0 };
        state.events[alarm.key] = event;
        event.alarm = this.event(alarm, matches[0], event.serial, 'BEGIN', start);
        state.pending.push(Object.assign({}, event.alarm, { history: !this.registered || deliveryFailed || !!alarm.recoveredAt }));
      }
      if (Number.isFinite(end) && end >= start && end <= now && !event.ended) {
        event.ended = true; event.endAt = end;
        state.pending.push(Object.assign(this.event(alarm, matches[0], event.serial, 'END', end), { history: !this.registered || deliveryFailed }));
      }
    }
    if (state.pending.length > 10000) fail('待确认告警超过 10000 条，采集暂停且未覆盖原状态');
    const queued = new Set(state.pending.map(a => a.key));
    Object.keys(state.events).forEach(k => { const e = state.events[k]; if (e.ended && e.endAt < now - 30 * 86400000 && !queued.has(k)) delete state.events[k]; });
    state.lastPollAt = now; this.save(this.cfg, state); this.state = state; this.cache = { samples: snapshot.samples, at: now };
    if (unmapped) this.log('MAPPING', 'skipped', unmapped + ' 条告警未找到唯一设备和名称映射，未转发');
    const sourceErrors = snapshot.errors || [], sourceWarnings = snapshot.warnings || [];
    if (sourceWarnings.length) this.log('SOURCE', 'fallback', sourceWarnings.slice(0, 3).join('；'));
    const partialError = sourceErrors.length ? '部分设备采集失败（' + sourceErrors.length + '）：' + sourceErrors.slice(0, 3).join('；') : '';
    if (partialError) this.log('POLL', 'partial', partialError);
    if (!this.registered) return;
    if (!deliveryFailed && await this.flush()) this.lastError = partialError;
  }
  async flush() {
    let failed = false;
    // Bound each cycle, preserving FIFO so END cannot overtake BEGIN.
    for (let n = 0; n < 100 && this.state.pending.length; n++) {
      const a = this.state.pending[0], name = a.history ? 'SEND_HISALARM' : 'SEND_ALARM', code = a.history ? 605 : 603;
      try {
        await this.transmit(p.alarms(this.cfg, [a], name, code));
        const next = clone(this.state); next.pending.shift(); this.save(this.cfg, next); this.state = next;
      } catch (e) {
        failed = true; this.lastError = e.message; const next = clone(this.state); next.pending.forEach(item => { item.history = true; }); this.save(this.cfg, next); this.state = next; break;
      }
    }
    return !failed;
  }
  event(alarm, mapping, serial, flag, time) { return { key: alarm.key, serial, bDeviceId: mapping.d.bDeviceId, rId: mapping.d.rId, signalId: mapping.s.signalId,
    time: p.stamp(time), value: alarm.value == null ? '' : alarm.value, flag, desc: p.truncate(alarm.desc || alarm.name, 40) }; }
  historySince() {
    let since = this.state.lastPollAt || null;
    Object.keys(this.state.events).forEach(k => { const e = this.state.events[k]; if (!e.ended) since = since == null ? e.started : Math.min(since, e.started); });
    return since;
  }
  samples() { return this.cache.at && this.now() - this.cache.at <= this.cfg.pollSec * 3000 && this.state.sourceId === this.options.sourceId() ? this.cache.samples : []; }
  preview() { return this.exclusive(async () => {
    const snapshot = await this.collect(this.cfg, this.historySince(), this.now());
    return { ai: p.data(this.cfg, snapshot.samples, 'AI', 'GET_AIDATA_ACK', 202), di: p.data(this.cfg, snapshot.samples, 'DI', 'GET_DIDATA_ACK', 302), alarms: snapshot.alarms.length, warnings: snapshot.warnings || [], errors: snapshot.errors || [] };
  }); }
  receive(req, res) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Connection', 'close');
    if (!this.cfg.allowedIps.includes(ip(req.socket.remoteAddress))) { res.writeHead(403); res.end('SC IP not allowed'); req.resume(); return; }
    const wsdlRequest = req.url.split('?')[0] === this.cfg.servicePath && req.url.slice(this.cfg.servicePath.length).toLowerCase() === '?wsdl';
    if ((req.method === 'GET' || req.method === 'HEAD') && wsdlRequest && this.cfg.enabled) {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Disposition': 'inline; filename="SUService.wsdl"' });
      res.end(req.method === 'HEAD' ? undefined : wsdl.generate(this.cfg, 'su')); req.resume(); return;
    }
    if (req.url !== this.cfg.servicePath || req.method !== 'POST') { res.writeHead(404); res.end(); req.resume(); return; }
    if (!this.cfg.enabled) { res.writeHead(503); res.end(); req.resume(); return; }
    if (!/^(?:text\/xml|application\/soap\+xml)(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { res.writeHead(415); res.end(); req.resume(); return; }
    let size = 0; const chunks = [];
    req.on('data', b => { size += b.length; if (size > p.LIMIT) { res.writeHead(413); res.end(); req.destroy(); } else chunks.push(b); });
    req.on('error', () => {});
    req.on('end', () => {
      if (size > p.LIMIT || res.writableEnded) return;
      try {
        const cfg = this.cfg;
        const m = p.message(p.unwrap(Buffer.concat(chunks).toString('utf8'), cfg.soap));
        if (m.root !== 'Request' || p.value(m.info, 'SUId').toUpperCase() !== cfg.suId || p.value(m.info, 'SURId') && p.value(m.info, 'SURId') !== cfg.suRId) fail('SU 身份不匹配');
        const xml = this.respond(m); this.lastHeartbeat = this.now(); this.log(m.name, 'received', 'SC 查询已处理');
        res.writeHead(200, { 'Content-Type': cfg.soap.version === '1.2' ? 'application/soap+xml; charset=utf-8' : 'text/xml; charset=utf-8' }); res.end(p.envelope(xml, cfg.soap, true));
      } catch (e) { this.log('SOAP', 'failed', e.message); res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(this.safeError(e.message)); }
    });
  }
  respond(m) {
    const cfg = this.cfg, id = p.identity(cfg), queryCodes = { GET_AIDATA: 201, GET_DIDATA: 301, GET_ALARM: 601, GET_SUINFO: 901, SET_IP: 105 };
    if (queryCodes[m.name] && queryCodes[m.name] !== m.code) fail('报文名称与类型代号不匹配');
    if (m.name === 'GET_AIDATA' || m.name === 'GET_DIDATA') return p.data(cfg, this.samples(), m.name === 'GET_AIDATA' ? 'AI' : 'DI', m.name + '_ACK', m.code + 1, m.info, p.stamp(this.cache.at || this.now()));
    if (m.name === 'GET_SUINFO') return p.packet('Response', 'GET_SUINFO_ACK', 902, id + '<TSUStatus>' + p.tag('CPUUsage', Math.min(100, os.loadavg()[0] / Math.max(1, os.cpus().length) * 100).toFixed(2)) + p.tag('MEMUsage', ((1 - os.freemem() / os.totalmem()) * 100).toFixed(2)) + '</TSUStatus><Result>1</Result>');
    if (m.name === 'SET_IP') {
      const address = p.value(m.info, 'SCIP');
      if (net.isIP(address) !== 4 || !cfg.allowedIps.includes(address)) return p.packet('Response', 'SET_IP_ACK', 106, id + '<Result>0</Result>');
      const target = new URL(cfg.scUrls[this.targetIndex]); target.hostname = address; this.assignedUrl = target.href;
      return p.packet('Response', 'SET_IP_ACK', 106, id + '<Result>1</Result>');
    }
    if (m.name === 'GET_ALARM') {
      if (!this.cache.at || this.now() - this.cache.at > cfg.pollSec * 3000 || this.state.sourceId !== this.options.sourceId()) return p.packet('Response', 'GET_ALARM_ACK', 602, id + '<Result>0</Result>');
      const active = [];
      // Keep the original BEGIN representation after it has been acknowledged.
      Object.keys(this.state.events).forEach(key => {
        const e = this.state.events[key];
        if (!e.ended && e.alarm && p.selected(m.info, { bDeviceId: e.alarm.bDeviceId, rId: e.alarm.rId }, e.alarm)) active.push(e.alarm);
      });
      return p.alarms(cfg, active, 'GET_ALARM_ACK', 602, 'Response');
    }
    this.log(m.name, 'unsupported', '本次转发未实现此指令');
    return p.packet('Response', m.name + '_ACK', m.code + 1, id + '<Result>0</Result>');
  }
}
module.exports = { Forwarder, validate, defaults, alarmMatches };
