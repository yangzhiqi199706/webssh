'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');
const { SerialBridgeManager, createDefaultSerialBridgeConfig } = require('../serial/bridge-manager');

function manager(options) {
  const config = createDefaultSerialBridgeConfig();
  Object.assign(config.ports[0], { devicePath: '/dev/ttyS0', type: 0 });
  return new SerialBridgeManager(Object.assign({ config, fs: { existsSync: () => true },
    configureSerial: () => Promise.resolve(),
    openSerial: () => ({ readable: new PassThrough(), writable: new PassThrough() }) }, options));
}

async function staleStart() {
  let release, calls = 0;
  const m = manager({ configureSerial: () => ++calls === 1 ? new Promise(r => { release = r; }) : Promise.resolve() });
  const old = m.start(1).catch(e => e);
  await m.stop(1);
  await m.start(1);
  release();
  await old;
  const state = m.getStatus()[0].state;
  await m.stopAll();
  assert.strictEqual(state, 'running', 'old start must not close replacement');
}

async function disconnect() {
  let socket, connections = 0;
  const m = manager({ net: { createConnection: () => {
    connections++;
    socket = new EventEmitter();
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    const current = socket;
    process.nextTick(() => current.emit('connect'));
    return socket;
  } } });
  Object.assign(m.config.ports[0], { type: 11, targetHost: 'localhost', targetPort: 9000 });
  await m.start(1);
  socket.emit('close');
  await new Promise(r => setImmediate(r));
  const state = m.getStatus()[0].state;
  await m.start(1);
  await m.stopAll();
  assert.strictEqual(state, 'stopped', 'disconnected bridge must stop');
  assert.strictEqual(connections, 2, 'start must reconnect');
}

async function reservation() {
  const source = fs.readFileSync(require('path').join(__dirname, '../server.js'), 'utf8');
  const block = source.slice(source.indexOf('function serialBridgePortById'), source.indexOf('function startPersistedSerialBridges'));
  let rejectStart;
  const locks = new Map();
  const context = { serialLocks: locks, serialBridgeManager: {
    getConfig: () => ({ ports: [{ id: 1, devicePath: '/dev/ttyS0' }] }),
    getStatus: () => [],
    start: () => new Promise((_r, reject) => { rejectStart = reject; })
  } };
  vm.createContext(context);
  vm.runInContext(block, context);
  const pending = context.startSerialBridge(1).catch(e => e);
  const reserved = locks.has('/dev/ttyS0');
  const replacement = { type: 'debug' };
  locks.set('/dev/ttyS0', replacement);
  rejectStart(new Error('cancelled'));
  await pending;
  assert.ok(reserved, 'reserve device before asynchronous start');
  assert.strictEqual(locks.get('/dev/ttyS0'), replacement, 'failure must preserve another owner');
}

(async () => {
  let failed = false;
  for (const test of [staleStart, disconnect, reservation]) {
    try { await test(); console.log(test.name + ': passed'); }
    catch (e) { failed = true; console.error(test.name + ': ' + e.message); }
  }
  if (failed) process.exitCode = 1;
})();
