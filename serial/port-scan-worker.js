// 所有可能等待内核驱动的同步操作仅在独立进程中执行。
async function scanPorts(request, fs, acquire, release) {
  let names;
  try { names = fs.readdirSync('/dev'); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const candidates = names.filter(function (name) { return /^(ttyS|ttyUSB|ttyACM|ttyXRUSB|ttyO)\d+$/.test(name); });
  candidates.sort(function (a, b) { return a.localeCompare(b, 'en', { numeric: true }); });
  const uart = {};
  try {
    fs.readFileSync('/proc/tty/driver/serial', 'utf8').split('\n').forEach(function (line) {
      const match = /^\s*(\d+):\s+uart:(\S+)/.exec(line);
      if (match) uart['ttyS' + match[1]] = match[2];
    });
  } catch (_) {}
  const ports = [];
  for (const name of candidates) {
    const device = '/dev/' + name;
    const entry = { path: device, busy: (request.busy || []).indexOf(device) >= 0, uartType: uart[name] || null,
      kind: name.indexOf('ttyUSB') === 0 ? 'usb' : name.indexOf('ttyACM') === 0 ? 'acm' : 'builtin' };
    if (entry.uartType && entry.uartType.toLowerCase() === 'unknown') {
      entry.openable = false;
      entry.probeError = 'uart unknown';
    } else if (request.probe && !entry.busy) {
      if (!await acquire(device)) entry.busy = true;
      else {
        try {
          const fd = fs.openSync(device, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
          fs.closeSync(fd);
          entry.openable = true;
        } catch (err) { entry.openable = false; entry.probeError = err.code || err.message; }
        finally { release(device); }
      }
    }
    ports.push(entry);
  }
  return ports;
}
if (require.main === module) {
  process.once('message', function (request) {
    function acquire(device) {
      return new Promise(function (resolve) {
        process.once('message', function (message) { resolve(message.type === 'permission' && message.allowed); });
        process.send({ type: 'acquire', path: device });
      });
    }
    scanPorts(request, require('fs'), acquire, function (device) {
      process.send({ type: 'release', path: device });
    }).then(function (ports) {
      process.send({ type: 'result', ports: ports }, function () { process.exit(0); });
    }, function (err) {
      process.send({ type: 'error', message: err.message }, function () { process.exit(1); });
    });
  });
  process.on('disconnect', function () { process.exit(1); });
}
module.exports = { scanPorts };
