const { fork } = require('child_process');
const path = require('path');

function createScanner(options) {
  const opts = options || {};
  const locks = opts.locks || new Map();
  let active = null;
  return function scan(probe) {
    if (active) return Promise.reject(Object.assign(new Error('端口扫描正在进行或工作进程尚未退出，请稍后重试'), { status: 409 }));
    return new Promise(function (resolve, reject) {
      let child;
      try {
        child = (opts.fork || fork)(path.join(__dirname, 'port-scan-worker.js'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
      } catch (err) { reject(err); return; }
      active = child;
      const lock = { type: 'serial-scan' };
      let settled = false;
      let result = null;
      const timer = setTimeout(function () {
        fail(Object.assign(new Error('端口扫描超时，可能有串口驱动无响应'), { status: 504 }));
      }, opts.timeoutMs || 8000);
      function fail(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
        try { child.kill('SIGKILL'); } catch (_) {}
        // 必须等 exit 才释放槽位和设备锁，避免不可中断的驱动调用造成进程堆积。
      }
      function send(message) {
        try { child.send(message, function (err) { if (err) fail(err); }); }
        catch (err) { fail(err); }
      }
      child.on('message', function (message) {
        if (settled || !message) return;
        if (message.type === 'acquire') {
          const allowed = !locks.has(message.path);
          if (allowed) locks.set(message.path, lock);
          send({ type: 'permission', allowed: allowed });
        } else if (message.type === 'release') {
          if (locks.get(message.path) === lock) locks.delete(message.path);
        } else if (message.type === 'result') {
          result = { ports: message.ports, probed: !!probe };
        } else if (message.type === 'error') {
          fail(new Error(message.message || '端口扫描失败'));
        }
      });
      child.on('error', function (err) {
        fail(err);
        if (!child.pid) active = null;
      });
      child.once('exit', function (code) {
        active = null;
        locks.forEach(function (value, key) { if (value === lock) locks.delete(key); });
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 0 && result) resolve(result);
        else reject(new Error('端口扫描进程异常退出'));
      });
      send({ type: 'scan', probe: !!probe, busy: Array.from(locks.keys()) });
    });
  };
}
module.exports = { createScanner };
