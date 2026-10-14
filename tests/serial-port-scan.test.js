const assert = require('assert');
const EventEmitter = require('events');
let scanner = {};
try { scanner = require('../serial/port-scanner'); } catch (_) {}
assert.strictEqual(typeof scanner.createScanner, 'function', '扫描必须隔离到有超时的子进程');

(async function () {
  let forks = 0;
  const child = new EventEmitter();
  child.send = function () {};
  child.kill = function () { child.killed = true; };
  const timeoutLocks = new Map();
  const scan = scanner.createScanner({ fork: function () { forks++; return child; }, timeoutMs: 40, locks: timeoutLocks });
  const pending = scan(true);
  child.emit('message', { type: 'acquire', path: '/dev/ttyUSB0' });
  await assert.rejects(scan(true), /扫描.*进行|未退出/);
  let ticked = false;
  setTimeout(function () { ticked = true; }, 5);
  await assert.rejects(pending, /超时/);
  assert(ticked, '扫描等待不能阻塞主线程定时器');
  assert(child.killed);
  await assert.rejects(scan(true), /扫描.*进行|未退出/);
  assert.strictEqual(forks, 1, '未退出的工作进程必须阻止新扫描');
  assert(timeoutLocks.has('/dev/ttyUSB0'), '驱动未退出不能提前释放设备锁');
  child.emit('exit', null, 'SIGKILL');
  assert(!timeoutLocks.has('/dev/ttyUSB0'));

  const locks = new Map();
  const next = new EventEmitter();
  const sent = [];
  next.send = function (m) { sent.push(m); };
  next.kill = function () {};
  const success = scanner.createScanner({ fork: () => next, locks: locks, timeoutMs: 1000 });
  const result = success(true);
  next.emit('message', { type: 'acquire', path: '/dev/ttyS0' });
  assert(locks.has('/dev/ttyS0'));
  assert.strictEqual(sent[sent.length - 1].allowed, true);
  next.emit('message', { type: 'release', path: '/dev/ttyS0' });
  assert(!locks.has('/dev/ttyS0'));
  next.emit('message', { type: 'result', ports: [{ path: '/dev/ttyS0' }] });
  next.emit('exit', 0);
  assert.deepStrictEqual(await result, { ports: [{ path: '/dev/ttyS0' }], probed: true });
  const crashed = success(true);
  next.emit('message', { type: 'acquire', path: '/dev/ttyS1' });
  next.emit('exit', 1);
  await assert.rejects(crashed, /异常退出/);
  assert(!locks.has('/dev/ttyS1'));

  const worker = require('../serial/port-scan-worker');
  const opened = [];
  const fs = {
    constants: require('fs').constants,
    readdirSync: () => ['ttyS0', 'ttyUSB0', 'ttyUSB1', 'unrelated'],
    readFileSync: () => '0: uart:unknown\n',
    openSync: p => { opened.push(p); return 1; }, closeSync: () => {}
  };
  const ports = await worker.scanPorts({ probe: true }, fs, async p => p !== '/dev/ttyUSB1', () => {});
  assert.deepStrictEqual(opened, ['/dev/ttyUSB0']);
  assert.strictEqual(ports[0].probeError, 'uart unknown');
  assert.strictEqual(ports[2].busy, true);

  // 真正创建卡住的子进程；主进程仍必须提供 HTTP 服务，并回收超时任务。
  const http = require('http');
  const realFork = require('child_process').fork;
  let realChild;
  let markBlocked;
  const blocked = new Promise(resolve => { markBlocked = resolve; });
  const isolated = scanner.createScanner({ timeoutMs: 1500, fork: function (_, args, options) {
    realChild = realFork(require('path').join(__dirname, 'helpers/serial-scan-blocked-worker.js'), args, options);
    realChild.on('message', m => { if (m.type === 'blocked') markBlocked(); });
    return realChild;
  } });
  const waiting = assert.rejects(isolated(true), /超时/);
  const server = http.createServer((req, res) => res.end('healthy'));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await Promise.race([blocked, waiting.then(() => { throw Error('worker did not start'); })]);
    const body = await new Promise((resolve, reject) => {
      const request = http.get('http://127.0.0.1:' + server.address().port, res => {
        let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve(data));
      });
      request.on('error', reject);
      request.setTimeout(500, () => request.destroy(new Error('HTTP blocked')));
    });
    assert.strictEqual(body, 'healthy');
    const exited = new Promise(resolve => realChild.once('exit', resolve));
    await waiting;
    await exited;
  } finally {
    realChild.kill('SIGKILL');
    await new Promise(resolve => server.close(resolve));
  }
  if (process.platform === 'win32') {
    assert.deepStrictEqual(await scanner.createScanner()(false), { ports: [], probed: false }, 'Windows 无 /dev 时应正常返回空列表');
  }
  // 运行实际前端请求函数，验证中止超时后解除按钮禁用。
  const ui = require('fs').readFileSync(require('path').join(__dirname, '../serial/assets/js/remote-serial.js'), 'utf8');
  const uiSource = ui.slice(ui.indexOf('    let portsRequestActive'), ui.indexOf('    function portLabel'));
  const buttons = { buttonScanPorts: {}, buttonRefreshPorts: {} };
  const lines = [];
  const context = {
    AbortController, Promise, Date, el: buttons, location: { origin: 'http://localhost' },
    setTimeout: fn => setTimeout(fn, 10), clearTimeout,
    terminal: { writeln: text => lines.push(text) }, state: {}, renderPorts: () => {},
    fetch: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }))
  };
  require('vm').runInNewContext(uiSource, context);
  await context.fetchPorts(true);
  assert.strictEqual(buttons.buttonScanPorts.disabled, false);
  assert.strictEqual(buttons.buttonRefreshPorts.disabled, false);
  assert(lines.some(line => line.includes('请求超时')));
  console.log('serial port scan: passed');
})().catch(function (e) { console.error(e); process.exitCode = 1; });
