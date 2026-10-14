'use strict';

const assert = require('assert');
const EventEmitter = require('events');

const { createDockerScheduledRestart } = require('../lib/docker-scheduled-restart');

assert.strictEqual(require('../lib/docker-scheduled-restart').clampInterval(10080), 10080,
  '定时重启间隔上限应支持 10080 分钟（7 天）');

function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: function () { return now; },
    setTimeout: function (fn, delay) {
      const id = nextId++;
      timers.set(id, { fn: fn, due: now + delay });
      return id;
    },
    clearTimeout: function (id) { timers.delete(id); },
    pending: function () { return Array.from(timers.values()); },
    advance: async function (ms) {
      now += ms;
      const due = Array.from(timers.entries()).filter(function (entry) { return entry[1].due <= now; });
      due.forEach(function (entry) { timers.delete(entry[0]); entry[1].fn(); });
      await new Promise(function (resolve) { setImmediate(resolve); });
    },
  };
}

function createChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

async function closeChild(child, code) {
  child.emit('close', code);
  await new Promise(function (resolve) { setImmediate(resolve); });
}

(async function () {
  const clock = createClock();
  const children = [];
  const saved = [];
  const logs = [];
  let config = { enabled: false, intervalMinutes: 2, lastResult: null };
  const scheduler = createDockerScheduledRestart({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    loadConfig: function () { return config; },
    saveConfig: function (next) { config = Object.assign({}, next); saved.push(config); },
    appendLog: function (line) { logs.push(line); },
    spawn: function () {
      const child = createChild();
      children.push(child);
      return child;
    },
  });

  assert.deepStrictEqual(scheduler.getState(), {
    enabled: false,
    intervalMinutes: 2,
    intervalSec: 120,
    counting: false,
    remainingSec: 0,
    running: false,
    nextRunAt: null,
    lastResult: null,
  });

  scheduler.updateConfig({ enabled: true, intervalMinutes: 2 });
  assert.strictEqual(scheduler.getState().counting, true);
  assert.strictEqual(scheduler.getState().remainingSec, 120);
  assert.strictEqual(clock.pending().length, 1);
  assert.ok(saved.length >= 1);

  await clock.advance(120000);
  assert.strictEqual(scheduler.getState().running, true);
  assert.strictEqual(children.length, 1);
  await closeChild(children[0], 0);
  assert.strictEqual(scheduler.getState().lastResult.ok, true);
  assert.strictEqual(scheduler.getState().counting, true, '成功重启后必须自动进入下一轮倒计时');
  assert.strictEqual(scheduler.getState().remainingSec, 120);
  assert.strictEqual(clock.pending().length, 1);
  assert.ok(logs.some(function (line) { return line.indexOf('下一轮倒计时') >= 0; }));

  scheduler.cancel();
  assert.strictEqual(scheduler.getState().counting, false);
  assert.strictEqual(clock.pending().length, 0);
  scheduler.restartCountdown();
  assert.strictEqual(scheduler.getState().counting, true);

  await clock.advance(120000);
  await closeChild(children[1], 1);
  assert.strictEqual(scheduler.getState().lastResult.ok, false);
  assert.strictEqual(scheduler.getState().counting, false, '重启失败后必须暂停循环，避免无限重试');
  assert.strictEqual(clock.pending().length, 0);

  scheduler.updateConfig({ enabled: true, intervalMinutes: 3 });
  const first = scheduler.trigger();
  const second = await scheduler.trigger();
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.message, 'already-running');
  await closeChild(children[2], 0);
  await first;
  assert.strictEqual(scheduler.getState().intervalMinutes, 3);
  assert.strictEqual(scheduler.getState().counting, true);

  scheduler.updateConfig({ enabled: false });
  assert.strictEqual(scheduler.getState().counting, false);
  assert.strictEqual(scheduler.getState().enabled, false);
  console.log('docker scheduled restart: passed');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
