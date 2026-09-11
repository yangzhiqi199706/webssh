'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const alarms = require('../proto-conv/wecom-alarms');
const { Forwarder } = require('../proto-conv/wecom-forwarder');
const { validateWebhook, parseReply, buildMessage } = require('../proto-conv/wecom-transport');
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const raw = (id, extra) => Object.assign({ AlarmID: id, AlarmTime: '2026-09-09 08:00:00', DeviceName: 'UPS', ZoneSubName: 'Room', AlarmLevel: '4', AlarmContent: 'Power lost' }, extra);
const normalized = (id, extra) => alarms.normalize(raw(id, extra), {}, Date.parse('2026-09-09T10:00:00+08:00'));
const webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key';
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-wecom-'));
  let now = Date.parse('2026-09-09T10:00:00+08:00');
  let snapshot = { live: [], history: [], historyError: '' };
  let failing = false;
  const sent = [];
  const options = { file: path.join(dir, 'state.json'), now: () => now, sourceId: () => 'source-a',
    collect: async () => snapshot, send: async (url, payload) => { if (failing) throw Object.assign(new Error('timeout'), { retryable: true }); sent.push(payload); } };
  const manager = new Forwarder(options);
  manager.configure({ webhook, enabled: true });
  return { manager, options, sent, set: value => { snapshot = value; }, fail: value => { failing = value; }, advance: () => { now += 61000; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test('strict envelope extraction rejects business errors and malformed lists', () => {
  assert.deepStrictEqual(alarms.extract({ code: 100, data: { rows: [raw('1')], total: 1 } }).rows, [raw('1')]);
  assert.throws(() => alarms.extract({ code: 300, data: [] }));
  assert.throws(() => alarms.extract({ code: 100, data: {} }));
  assert.throws(() => alarms.extract({ data: 'not-json' }));
});
test('recovery requires valid explicit timestamp, never confirmation/status/disappearance', () => {
  assert.strictEqual(normalized('1', { Status: '0', CheckTime: '2026-09-09 09:00:00' }).recoveredAt, '');
  assert.strictEqual(normalized('1', { RecoverTime: '0000-00-00 00:00:00' }).recoveredAt, '');
  assert.strictEqual(normalized('1', { RecoverTime: '2026-09-10 09:00:00' }).recoveredAt, '');
  assert.ok(normalized('1', { RecoverTime: '2026-09-09 09:00:00' }).recoveredAt);
  assert.notStrictEqual(normalized('1').key, normalized('1', { AlarmTime: '2026-09-09 09:00:00' }).key);
  assert.throws(() => alarms.normalize({ DeviceName: 'UPS' }, {}));
});
test('pagination collects all pages and detects repeated pages', async () => {
  let calls = 0;
  const invoke = async () => ({ ok: true, data: { code: 100, data: { rows: [raw(String(++calls))], total: 2 } } });
  assert.strictEqual((await alarms.readPages(invoke, 'GetRealAlarmsKey', {}, {}, 1)).length, 2);
  await assert.rejects(() => alarms.readPages(async () => ({ ok: true, data: { rows: [raw('1')], total: 2 } }), 'GetRealAlarmsKey', {}, {}, 1), /分页/);
});
test('baseline, new alarms, verified recoveries and restart dedupe', async () => {
  const f = fixture();
  try {
    f.set({ live: [normalized('old')], history: [] }); await f.manager.poll(); await f.manager.drain();
    assert.strictEqual(f.sent.length, 0);
    f.set({ live: [normalized('old'), normalized('new')], history: [] }); await f.manager.poll(); await f.manager.drain();
    assert.strictEqual(f.sent.length, 1);
    f.set({ live: [], history: [] }); await f.manager.poll(); f.advance(); await f.manager.drain();
    assert.strictEqual(f.sent.length, 1);
    f.set({ live: [], history: [normalized('new', { RecoverTime: '2026-09-09 09:00:00' }), normalized('old', { RecoverTime: '2026-09-09 09:00:00' })] });
    await f.manager.poll(); await f.manager.drain(); assert.strictEqual(f.sent.length, 2);
    const restarted = new Forwarder(f.options); await restarted.poll(); f.advance(); await restarted.drain(); assert.strictEqual(f.sent.length, 2);
  } finally { f.cleanup(); }
});
test('filters apply to new alarms and retry survives restart', async () => {
  const f = fixture();
  try {
    f.manager.configure({ filters: { areas: ['Room'], devices: ['UPS'], levels: ['4'], keyword: 'Power' } });
    await f.manager.poll();
    f.set({ live: [normalized('ok'), normalized('skip', { AlarmLevel: '1' })], history: [] }); await f.manager.poll();
    f.fail(true); await f.manager.drain(); assert.strictEqual(f.manager.status().pending, 1);
    assert.ok(f.manager.status().lastError.includes('timeout'));
    f.fail(false); f.advance(); const restarted = new Forwarder(f.options); await restarted.drain(); assert.strictEqual(f.sent.length, 1);
    assert.strictEqual(restarted.status().pending, 0);
    assert.strictEqual(restarted.status().lastError, '');
    assert.strictEqual(restarted.logs().filter(x => x.result === 'failed').length, 1);
    assert.strictEqual(restarted.config().webhook, ''); assert.strictEqual(restarted.config().hasWebhook, true);
  } finally { f.cleanup(); }
});
test('preview cannot change baseline and stop prevents queued sends', async () => {
  const f = fixture();
  try {
    await f.manager.preview(); assert.strictEqual(f.manager.status().initialized, false);
    await f.manager.poll(); f.set({ live: [normalized('new')], history: [] }); await f.manager.poll();
    f.manager.configure({ enabled: false }); await f.manager.drain(); assert.strictEqual(f.sent.length, 0);
  } finally { f.cleanup(); }
});
test('official webhook only; HTTP success alone is not send success; messages bounded', () => {
  assert.strictEqual(validateWebhook(webhook), webhook);
  ['http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', 'https://example.com/?key=x', 'https://qyapi.weixin.qq.com.evil.test/?key=x'].forEach(url => assert.throws(() => validateWebhook(url)));
  assert.throws(() => parseReply(200, '{"errcode":40058,"errmsg":"bad"}'));
  assert.throws(() => parseReply(200, '{}'));
  assert.throws(() => parseReply(302, '{"errcode":0}'));
  assert.doesNotThrow(() => parseReply(200, '{"errcode":0}'));
  const msg = buildMessage({ type: 'new', alarm: normalized('1', { AlarmContent: '测'.repeat(4000) }) });
  assert.ok(Buffer.byteLength(msg.text.content, 'utf8') <= 2048);
});
test('DCIM CancelTime is explicit recovery evidence; update_time is not', () => {
  assert.ok(normalized('cancel', { CancelTime: '2026-09-09 09:00:00' }).recoveredAt);
  assert.strictEqual(normalized('active', { update_time: '2026-09-09 09:00:00' }).recoveredAt, '');
});
test('recoveries for long-running alarms keep their original query range', async () => {
  const f = fixture();
  try {
    await f.manager.poll(); f.set({ live: [normalized('new')], history: [] }); await f.manager.poll();
    let since;
    f.manager.options.collect = async (_config, from) => { since = from; return { live: [], history: [] }; };
    await f.manager.poll();
    assert.ok(since <= Date.parse(normalized('new').startedAt));
  } finally { f.cleanup(); }
});
test('failed source responses preserve state; no recovery before successful new send', async () => {
  const f = fixture();
  try {
    await f.manager.poll(); f.set({ live: [normalized('new')], history: [] }); await f.manager.poll();
    f.fail(true); await f.manager.drain();
    f.set({ live: [], history: [normalized('new', { RecoverTime: '2026-09-09 09:00:00' })] }); await f.manager.poll();
    await f.manager.drain(); assert.strictEqual(f.sent.length, 0);
    assert.strictEqual(f.manager.status().pending, 2);
    f.manager.options.collect = async () => { throw new Error('upstream failed'); }; await f.manager.poll();
    assert.strictEqual(f.manager.status().pending, 2);
    f.advance(); f.fail(false); await f.manager.drain(); assert.strictEqual(f.sent.length, 1);
    f.advance(); await f.manager.drain(); assert.strictEqual(f.sent.length, 2);
  } finally { f.cleanup(); }
});
test('stop and reset enables safe data source/field changes, preserving logs', async () => {
  const f = fixture();
  try {
    await f.manager.poll(); assert.throws(() => f.manager.reset(), /停用/);
    f.manager.configure({ enabled: false }); f.manager.reset(); assert.strictEqual(f.manager.status().initialized, false);
    f.manager.configure({ fields: { id: 'EventId' } });
  } finally { f.cleanup(); }
});
test('corrupted config fails closed instead of silently enabling the worker', () => {
  const f = fixture();
  try {
    const invalid = JSON.parse(fs.readFileSync(f.options.file, 'utf8'));
    invalid.config = { enabled: true };
    fs.writeFileSync(f.options.file, JSON.stringify(invalid));
    const manager = new Forwarder(f.options);
    assert.strictEqual(manager.status().running, false);
    assert.throws(() => manager.configure({ enabled: true }), /状态文件/);
  } finally { f.cleanup(); }
});
test('mapping is explicit and UTC identity is stable across source timestamp formats', () => {
  const a = alarms.normalize({ event: '1', happened: '2026-09-09T00:00:00Z', cleared: '2026-09-09T01:00:00Z' }, { id: 'event', startedAt: 'happened', recoveredAt: 'cleared' });
  assert.strictEqual(a.key, normalized('1').key); assert.ok(a.recoveredAt);
});
test('unverified history records do not create new alarm notifications', async () => {
  const f = fixture();
  try {
    await f.manager.poll();
    f.set({ live: [], history: [normalized('unverified-old-history')] });
    await f.manager.poll(); await f.manager.drain(); assert.strictEqual(f.sent.length, 0);
  } finally { f.cleanup(); }
});
test('source changes pause dispatch and malformed state cannot be overwritten', async () => {
  const f = fixture();
  try {
    await f.manager.poll(); f.set({ live: [normalized('new')], history: [] }); await f.manager.poll();
    f.manager.options.sourceId = () => 'other-source'; await f.manager.drain(); assert.strictEqual(f.sent.length, 0);
    await f.manager.poll(); assert.ok(f.manager.status().lastError.includes('数据源'));
    const before = fs.readFileSync(f.options.file, 'utf8');
    fs.writeFileSync(f.options.file, '{broken'); const invalid = new Forwarder(f.options);
    await invalid.poll(); await invalid.drain(); assert.strictEqual(fs.readFileSync(f.options.file, 'utf8'), '{broken');
    fs.writeFileSync(f.options.file, before);
  } finally { f.cleanup(); }
});
(async () => { for (const t of tests) { await t.fn(); console.log('PASS ' + t.name); } })().catch(e => { console.error(e); process.exitCode = 1; });
