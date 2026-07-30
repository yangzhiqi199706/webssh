'use strict';

const assert = require('assert');
const timerModule = require('../lib/ssh-idle-timer');

let nextId = 0;
const pending = new Map();
let fired = 0;

function fakeSetTimeout(fn, ms) {
  const id = ++nextId;
  pending.set(id, {
    ms: ms,
    fn: function () {
      pending.delete(id);
      fn();
    },
  });
  return id;
}

function fakeClearTimeout(id) {
  pending.delete(id);
}

const timer = timerModule.createIdleTimer({
  timeoutMs: 60000,
  onIdle: function () { fired += 1; },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
});

timer.touch();
const firstId = nextId;
timer.touch();
const secondId = nextId;

assert.strictEqual(pending.has(firstId), false);
assert.strictEqual(pending.get(secondId).ms, 60000);
pending.get(secondId).fn();
assert.strictEqual(fired, 1);

const cancellable = timerModule.createIdleTimer({
  timeoutMs: 60000,
  onIdle: function () { fired += 1; },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
});
cancellable.touch();
cancellable.cancel();
assert.strictEqual(pending.size, 0);
cancellable.touch();
assert.strictEqual(pending.size, 0);

console.log('ssh idle timer: OK');
