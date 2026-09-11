'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { matches, FIELDS } = require('./wecom-alarms');
const transport = require('./wecom-transport');
const application = require('./wecom-application');
const clone = value => JSON.parse(JSON.stringify(value));
const defaults = () => ({ enabled: false, channel: 'webhook', application: application.defaults(), webhook: '', pollIntervalSec: 30, recovery: true,
  filters: { areas: [], devices: [], levels: [], keyword: '' }, fields: {} });
function initial() { return { version: 1, config: defaults(), source: '', initialized: false, since: 0, seen: {}, queue: [], logs: [], lastSendAt: 0 }; }
class Forwarder {
  constructor(options) {
    this.options = options; this.now = options.now || Date.now; this.data = initial(); this.busy = false; this.sending = false;
    this.appClient = options.appClient || application.createClient();
    this.error = ''; this.historyError = ''; this.fatal = ''; this.lastPollAt = ''; this.nextPoll = 0; this.timer = null;
    try {
      const data = JSON.parse(fs.readFileSync(options.file, 'utf8'));
      if (data.version !== 1 || !data.config || !data.seen || !Array.isArray(data.queue) || !Array.isArray(data.logs)) throw new Error('invalid-state');
      const c = data.config;
      if (c.channel == null) c.channel = 'webhook';
      if (c.application == null) c.application = application.defaults();
      if (!['webhook', 'application'].includes(c.channel) || !c.application || Object.keys(application.defaults()).some(k => typeof c.application[k] !== 'string')) throw new Error('invalid-state');
      if (typeof c.enabled !== 'boolean' || typeof c.recovery !== 'boolean' || typeof c.webhook !== 'string' ||
          !Number.isInteger(c.pollIntervalSec) || c.pollIntervalSec < 10 || c.pollIntervalSec > 3600 ||
          !c.filters || !['areas', 'devices', 'levels'].every(k => Array.isArray(c.filters[k]) && c.filters[k].every(v => typeof v === 'string')) ||
          typeof c.filters.keyword !== 'string' || !c.fields || typeof c.fields !== 'object' ||
          typeof data.initialized !== 'boolean' || typeof data.source !== 'string' || !Number.isFinite(data.since) || !Number.isFinite(data.lastSendAt) ||
          data.queue.some(e => !e.id || !e.alarm || !e.alarm.key || !['new', 'recovery'].includes(e.type) || !Number.isFinite(e.due) || !Number.isInteger(e.attempts)) ||
          Object.keys(data.seen).some(k => !data.seen[k] || !data.seen[k].alarm || data.seen[k].alarm.key !== k)) throw new Error('invalid-state');
      if (c.webhook) transport.validateWebhook(c.webhook);
      if (c.enabled) this.validateDestination(c);
      this.data = data;
    } catch (e) { if (e.code !== 'ENOENT') this.fatal = '转发状态文件无法读取，已停止自动发送，请检查文件'; }
  }
  save(next) {
    const file = this.options.file, temp = file + '.tmp';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let fd;
    try {
      fd = fs.openSync(temp, 'w', 0o600);
      fs.writeFileSync(fd, JSON.stringify(next), 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
      fs.renameSync(temp, file);
    } catch (e) {
      if (fd != null) fs.closeSync(fd);
      this.fatal = '转发状态保存失败，已停止自动发送';
      throw new Error(this.fatal);
    }
    this.data = next;
  }
  validateDestination(c) { if (c.channel === 'application') application.validate(c.application, true); else if (!c.webhook) throw new Error('请先保存群机器人 Webhook'); }
  config() { const c = clone(this.data.config); c.hasWebhook = !!c.webhook; c.webhook = ''; c.application.hasSecret = !!c.application.secret; c.application.secret = ''; return c; }
  configure(input) {
    if (this.fatal) throw new Error(this.fatal);
    if (this.busy || this.sending) throw new Error('正在采集或发送，请稍后保存');
    const next = clone(this.data), c = next.config;
    if (input.channel != null) { if (!['webhook', 'application'].includes(input.channel)) throw new Error('发送通道无效'); c.channel = input.channel; }
    if (input.application != null) {
      if (typeof input.application !== 'object' || Array.isArray(input.application)) throw new Error('应用配置无效');
      for (const key of Object.keys(application.defaults())) {
        if (input.application[key] == null) continue;
        if (typeof input.application[key] !== 'string' || input.application[key].length > 2000) throw new Error('应用配置无效');
        if (key !== 'secret' || input.application[key].trim()) c.application[key] = input.application[key].trim();
      }
    }
    if (input.enabled != null) { if (typeof input.enabled !== 'boolean') throw new Error('启用状态无效'); c.enabled = input.enabled; }
    if (input.webhook) c.webhook = transport.validateWebhook(input.webhook);
    if (input.pollIntervalSec != null) {
      const n = Number(input.pollIntervalSec);
      if (!Number.isInteger(n) || n < 10 || n > 3600) throw new Error('采集间隔应为 10–3600 秒');
      c.pollIntervalSec = n;
    }
    if (input.recovery != null) { if (typeof input.recovery !== 'boolean') throw new Error('恢复通知配置无效'); c.recovery = input.recovery; }
    if (input.filters) {
      for (const key of ['areas', 'devices', 'levels']) {
        if (!Array.isArray(input.filters[key]) || input.filters[key].length > 100 || input.filters[key].some(x => typeof x !== 'string' || !x.trim() || x.length > 200)) throw new Error('筛选条件无效');
        c.filters[key] = Array.from(new Set(input.filters[key].map(x => x.trim())));
      }
      if (typeof input.filters.keyword !== 'string' || input.filters.keyword.length > 200) throw new Error('关键词无效');
      c.filters.keyword = input.filters.keyword.trim();
    }
    if (input.fields) {
      if (typeof input.fields !== 'object' || Array.isArray(input.fields)) throw new Error('字段映射无效');
      c.fields = {};
      for (const key of Object.keys(input.fields)) {
        if (!FIELDS[key] || typeof input.fields[key] !== 'string' || !/^[\w\u4e00-\u9fff-]{0,80}$/.test(input.fields[key])) throw new Error('字段映射无效');
        if (input.fields[key]) c.fields[key] = input.fields[key];
      }
    }
    const destination = x => JSON.stringify([x.channel, x.channel === 'application' ?
      [x.application.corpId, x.application.agentId, x.application.toUser, x.application.toParty, x.application.toTag] : x.webhook]);
    if (next.queue.length && destination(c) !== destination(this.data.config)) throw new Error('发送队列尚未清空，请先处理待发送及失败消息再切换通道或接收对象');
    if (c.enabled) this.validateDestination(c);
    if (c.webhook !== this.data.config.webhook && next.queue.length && c.enabled) throw new Error('请先停用自动转发，再更换机器人');
    if (JSON.stringify(c.fields) !== JSON.stringify(this.data.config.fields) && next.initialized) throw new Error('已建立基线后不能修改字段映射');
    this.save(next); this.nextPoll = 0; return this.config();
  }
  status() {
    return { enabled: this.data.config.enabled, running: this.data.config.enabled && !this.fatal, initialized: this.data.initialized,
      collecting: this.busy, sending: this.sending, pending: this.data.queue.filter(e => !e.dead).length,
      failed: this.data.queue.filter(e => e.dead).length, lastPollAt: this.lastPollAt,
      lastError: this.fatal || this.error || this.data.lastSendError || '', recoveryError: this.historyError, tracked: Object.keys(this.data.seen).length };
  }
  logs() { return clone(this.data.logs).reverse(); }
  log(next, entry) {
    next.logs.push(Object.assign({ at: new Date(this.now()).toISOString() }, entry));
    next.logs = next.logs.slice(-500);
  }
  async preview() {
    const result = await this.options.collect(this.data.config, this.historySince());
    return { total: result.live.length, matched: result.live.filter(a => matches(a, this.data.config.filters)).length,
      rows: result.live.slice(0, 50), recoveryError: result.historyError || '' };
  }
  historySince() {
    let since = this.data.since;
    Object.keys(this.data.seen).forEach(key => {
      const record = this.data.seen[key];
      if (record.notify && !record.recovery) since = Math.min(since, Date.parse(record.alarm.startedAt));
    });
    return since;
  }
  async poll() {
    if (this.busy || this.fatal || !this.data.config.enabled) return;
    this.busy = true;
    try {
      const source = this.options.sourceId();
      if (this.data.source && source !== this.data.source) throw new Error('DCIM 数据源已变更，请恢复原连接后继续转发');
      const result = await this.options.collect(clone(this.data.config), this.historySince());
      if (source !== this.options.sourceId()) throw new Error('采集期间 DCIM 数据源发生变化，本轮结果已丢弃');
      const next = clone(this.data), first = !next.initialized, now = this.now();
      const incoming = new Map();
      result.live.concat((result.history || []).filter(a => a.recoveredAt)).forEach(a => {
        const old = incoming.get(a.key);
        if (!old || a.recoveredAt) incoming.set(a.key, a);
      });
      const enqueue = (type, a) => {
        if (next.queue.length >= 5000) throw new Error('发送队列已满（5000 条），请处理失败消息');
        next.queue.push({ id: crypto.randomBytes(12).toString('hex'), type, alarm: a, attempts: 0, due: now, dead: false });
      };
      incoming.forEach(a => {
        let record = next.seen[a.key];
        if (!record) {
          const eligible = !first && matches(a, next.config.filters) && (!a.recoveredAt || Date.parse(a.startedAt) >= next.since);
          record = next.seen[a.key] = { alarm: a, notify: eligible, recovery: false, lastSeen: now };
          if (eligible) enqueue('new', a);
        }
        record.lastSeen = now;
        if (a.recoveredAt) {
          if (!record.recovery && record.notify && next.config.recovery) enqueue('recovery', a);
          record.recovery = true;
        }
      });
      next.source = source; next.initialized = true;
      if (!result.historyError) next.since = now;
      // Keep unresolved events; resolved records are retained for 30 days.
      const queued = new Set(next.queue.map(e => e.alarm && e.alarm.key));
      Object.keys(next.seen).forEach(k => { const r = next.seen[k]; if (r.recovery && r.lastSeen < now - 30 * 86400000 && !queued.has(k)) delete next.seen[k]; });
      if (Object.keys(next.seen).length > 50000) throw new Error('告警状态超过 50000 条，请归档状态后继续');
      this.save(next); this.lastPollAt = new Date(now).toISOString(); this.error = ''; this.historyError = result.historyError || '';
    } catch (e) {
      this.error = e.message;
      if (!this.fatal) { const next = clone(this.data); this.log(next, { type: 'collect', result: 'failed', message: this.error }); this.save(next); }
    } finally { this.busy = false; }
  }
  async deliver(event, test) {
    this.sending = true;
    try {
      let next = clone(this.data); next.lastSendAt = this.now(); this.save(next);
      let error = null;
      try {
        const c = this.data.config, payload = transport.buildMessage(event);
        if (event.type === 'test' && c.channel === 'application') payload.text.content = payload.text.content.replace('群机器人连接测试', '自建应用连接测试');
        if (c.channel === 'application') await this.appClient.send(c.application, payload);
        else await (this.options.send || transport.send)(c.webhook, payload);
      } catch (e) { error = e; }
      next = clone(this.data);
      next.lastSendError = error ? this.safeError(error.message) : '';
      this.log(next, { type: event.type, channel: next.config.channel, result: error ? 'failed' : 'sent', eventId: event.id || '',
        alarmId: event.alarm ? event.alarm.id : '', device: event.alarm ? event.alarm.device : '',
        message: error ? this.safeError(error.message) : '企业微信已接收', attempt: (event.attempts || 0) + 1 });
      const queued = next.queue.find(e => e.id === event.id);
      if (queued) {
        if (!error) next.queue = next.queue.filter(e => e.id !== event.id);
        else { queued.attempts++; queued.dead = error.retryable === false || queued.attempts >= 6; queued.due = this.now() + Math.min(3600000, 30000 * Math.pow(2, queued.attempts - 1)); }
      }
      this.save(next);
      if (error && test) throw new Error(this.safeError(error.message));
    } finally { this.sending = false; }
  }
  safeError(message) {
    const key = this.data.config.webhook ? new URL(this.data.config.webhook).searchParams.get('key') : '';
    let text = String(message || '发送失败').replace(/https?:\/\/\S+/g, '[地址已隐藏]');
    if (key) text = text.split(key).join('[密钥已隐藏]');
    const secret = this.data.config.application.secret;
    if (secret) text = text.split(secret).join('[密钥已隐藏]');
    return text.slice(0, 300);
  }
  async drain() {
    if (this.fatal || this.sending || !this.data.config.enabled || this.now() - this.data.lastSendAt < 4000) return;
    if (this.data.source && this.data.source !== this.options.sourceId()) return;
    const event = this.data.queue.find((e, i, list) => !e.dead && e.due <= this.now() &&
      (e.type !== 'recovery' || !list.some(other => other.type === 'new' && other.alarm.key === e.alarm.key)));
    if (event) await this.deliver(event, false);
  }
  async test() {
    if (this.fatal) throw new Error(this.fatal);
    this.validateDestination(this.data.config);
    if (this.sending || this.now() - this.data.lastSendAt < 4000) throw new Error('发送频率受限，请 4 秒后重试');
    await this.deliver({ type: 'test' }, true);
  }
  async credentials() {
    if (this.fatal) throw new Error(this.fatal);
    if (this.data.config.channel !== 'application') throw new Error('请先选择并保存自建应用通道');
    await this.appClient.credentials(clone(this.data.config.application));
  }
  retry() {
    if (this.fatal || this.sending) throw new Error(this.fatal || '正在发送，请稍后重试');
    const next = clone(this.data); next.queue.forEach(e => { if (e.dead) { e.dead = false; e.attempts = 0; e.due = this.now(); } }); this.save(next);
  }
  reset() {
    if (this.fatal) throw new Error(this.fatal);
    if (this.data.config.enabled || this.busy || this.sending) throw new Error('请先停用自动转发，并等待当前采集和发送结束');
    if (this.data.queue.length) throw new Error('仍有待发送或失败消息，请先处理队列');
    const next = clone(this.data); next.seen = {}; next.initialized = false; next.since = 0; next.source = '';
    this.log(next, { type: 'reset', result: 'saved', message: '基线已重置，下次启用建立新基线' });
    this.save(next); this.error = ''; this.historyError = ''; this.lastPollAt = '';
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.now() >= this.nextPoll) { this.nextPoll = this.now() + this.data.config.pollIntervalSec * 1000; this.poll().catch(e => { this.error = e.message; }); }
      this.drain().catch(e => { this.error = e.message; });
    }, 1000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}
module.exports = { Forwarder };
