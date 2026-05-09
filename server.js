const express = require('express');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const wssSerial = new WebSocket.Server({ noServer: true });

// 统一的 upgrade 分发：按路径把连接交给对应的 WebSocket.Server
server.on('upgrade', function (request, socket, head) {
  const pathname = (request.url || '').split('?')[0];
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, function (ws) {
      wss.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/serial') {
    wssSerial.handleUpgrade(request, socket, head, function (ws) {
      wssSerial.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// 保存当前已打开的串口设备 → 独占锁，防止一个串口被两个 WS 同时打开
const serialLocks = new Map();

app.use(express.static(__dirname));

app.get('/health', function (_req, res) {
  res.json({ ok: true });
});

// 列出服务器上可用的串口设备（/dev/ttyS* 和 /dev/ttyUSB*、/dev/ttyACM*）
// ?probe=1 时会真正尝试 open() 每个端口，分辨"物理存在"和"虚拟幽灵"
app.get('/api/serial/ports', function (req, res) {
  const doProbe = String(req.query.probe || '') === '1';
  const candidates = [];
  function collect(prefix) {
    try {
      const entries = fs.readdirSync('/dev');
      entries.forEach(function (name) {
        if (name.indexOf(prefix) === 0) {
          candidates.push('/dev/' + name);
        }
      });
    } catch (_err) {}
  }
  collect('ttyS');
  collect('ttyUSB');
  collect('ttyACM');
  candidates.sort(function (a, b) {
    const re = /^(.*?)(\d+)$/;
    const ma = re.exec(a);
    const mb = re.exec(b);
    if (ma && mb && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]);
    return a.localeCompare(b);
  });

  // 读 /proc/tty/driver/serial 获取 ttyS* 的 UART 类型（unknown 表示端口号存在但未接物理 UART）
  const uartTypes = {};
  try {
    const raw = fs.readFileSync('/proc/tty/driver/serial', 'utf8');
    raw.split('\n').forEach(function (line) {
      const m = /^\s*(\d+):\s+uart:(\S+)/.exec(line);
      if (m) uartTypes['/dev/ttyS' + m[1]] = m[2];
    });
  } catch (_err) {}

  function probeOpenable(devPath) {
    // 非阻塞打开一次，成功就返回 true；失败记原因
    try {
      const fd = fs.openSync(devPath, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
      fs.closeSync(fd);
      return { openable: true };
    } catch (err) {
      return { openable: false, reason: err.code || err.message };
    }
  }

  const ports = candidates.map(function (p) {
    const busy = serialLocks.has(p);
    const uart = uartTypes[p] || null; // 只有 ttyS* 会有
    const entry = {
      path: p,
      busy: busy,
      uartType: uart,               // 如 '16550A'、'unknown'、null（非 ttyS 或读取失败）
      kind: p.indexOf('/dev/ttyUSB') === 0 ? 'usb'
          : p.indexOf('/dev/ttyACM') === 0 ? 'acm'
          : 'builtin',
    };
    if (doProbe && !busy) {
      // probe 只对当前未占用的端口做，避免打扰正在通信的端口
      const r = probeOpenable(p);
      entry.openable = r.openable;
      if (!r.openable) entry.probeError = r.reason;
    }
    // ttyS* 且 uart=unknown 直接标记为物理不存在（无需 probe 也能判断）
    if (uart && uart.toLowerCase() === 'unknown') {
      entry.openable = false;
      if (!entry.probeError) entry.probeError = 'uart unknown';
    }
    return entry;
  });

  res.json({ ports: ports, probed: doProbe });
});

const demoConfig = {
  host: process.env.SSH_HOST || '127.0.0.1',
  port: Number(process.env.SSH_PORT || 22),
  username: process.env.SSH_USER || 'root',
  password: process.env.SSH_PASSWORD || '',
  privateKey: process.env.SSH_PRIVATE_KEY ? fs.readFileSync(process.env.SSH_PRIVATE_KEY) : undefined,
};

function remoteJoin(basePath, name) {
  if (!basePath || basePath === '/') return '/' + name;
  return basePath.replace(/\/+$/, '') + '/' + name;
}

function remoteDirname(targetPath) {
  if (!targetPath || targetPath === '/') return '/';
  const parts = String(targetPath).split('/').filter(Boolean);
  parts.pop();
  return parts.length ? '/' + parts.join('/') : '/';
}

function isValidRemoteName(name) {
  const trimmed = String(name || '').trim();
  return Boolean(trimmed) && trimmed.indexOf('/') === -1 && trimmed !== '.' && trimmed !== '..';
}

function fileTypeFromLongname(longname) {
  const value = longname || '';
  if (value.indexOf('d') === 0) return 'dir';
  if (value.indexOf('l') === 0) return 'link';
  return 'file';
}

function normalizeSftpEntry(basePath, item) {
  const attrs = item && item.attrs ? item.attrs : {};
  return {
    name: item.filename,
    fullPath: remoteJoin(basePath, item.filename),
    type: fileTypeFromLongname(item.longname),
    size: Number(attrs.size || 0),
    mtime: Number(attrs.mtime || 0),
  };
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(.*?);base64,(.*)$/);
  if (!match) {
    throw new Error('上传内容格式无效');
  }
  return Buffer.from(match[2], 'base64');
}

function detectMimeByName(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.txt') || lower.endsWith('.log') || lower.endsWith('.md')) return 'text/plain';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.html')) return 'text/html';
  if (lower.endsWith('.js')) return 'text/javascript';
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

function isProbablyTextFile(fileName) {
  const lower = String(fileName || '').toLowerCase();
  const editable = ['.txt', '.log', '.md', '.json', '.js', '.ts', '.html', '.css', '.xml', '.yml', '.yaml', '.sh', '.env', '.ini', '.conf', '.py'];
  return editable.some(function (suffix) {
    return lower.endsWith(suffix);
  });
}

function uploadBuffer(sftpClient, targetPath, buffer, callback) {
  const stream = sftpClient.createWriteStream(targetPath);
  let done = false;
  function finish(err) {
    if (done) return;
    done = true;
    callback(err || null);
  }

  stream.on('error', finish);
  stream.on('close', function () {
    finish(null);
  });
  stream.end(buffer);
}

function downloadBuffer(sftpClient, targetPath, callback) {
  const stream = sftpClient.createReadStream(targetPath);
  const chunks = [];
  let done = false;
  function finish(err, buffer) {
    if (done) return;
    done = true;
    callback(err || null, buffer);
  }

  stream.on('data', function (chunk) {
    chunks.push(Buffer.from(chunk));
  });
  stream.on('error', function (err) {
    finish(err);
  });
  stream.on('end', function () {
    finish(null, Buffer.concat(chunks));
  });
}

wss.on('connection', function (ws) {
  const ssh = new Client();
  let stream = null;
  let sftp = null;
  let sshReady = false;

  function send(type, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: type, payload: payload }));
    } catch (_err) {
      // 发送失败不应传导到 pty，避免反压导致服务假死
    }
  }

  function ensureSftp(callback) {
    if (!sshReady) {
      callback(new Error('SSH 尚未就绪'));
      return;
    }
    if (sftp) {
      callback(null, sftp);
      return;
    }
    ssh.sftp(function (err, sftpStream) {
      if (err) {
        callback(err);
        return;
      }
      sftp = sftpStream;
      callback(null, sftp);
    });
  }

  ssh.on('ready', function () {
    sshReady = true;
    send('status', { state: 'connected' });
    ssh.shell({ term: 'xterm-color', cols: 120, rows: 30 }, function (err, shellStream) {
      if (err) {
        send('error', { message: err.message });
        ws.close();
        return;
      }

      stream = shellStream;

      // 背压保护：WebSocket 发送缓冲超过 4MB 时暂停 pty 流，避免 docker exec 之类瞬时大输出把内存和事件循环拖住
      const BACKPRESSURE_HIGH = 4 * 1024 * 1024;
      const BACKPRESSURE_LOW = 1 * 1024 * 1024;
      let paused = false;
      const backpressureTimer = setInterval(function () {
        if (!paused) return;
        if (ws.bufferedAmount <= BACKPRESSURE_LOW) {
          paused = false;
          try { shellStream.resume(); } catch (_err) {}
        }
      }, 200);
      shellStream.on('close', function () { clearInterval(backpressureTimer); });
      ws.on('close', function () { clearInterval(backpressureTimer); });

      shellStream.on('data', function (data) {
        send('output', { data: data.toString('utf8') });
        if (!paused && ws.bufferedAmount >= BACKPRESSURE_HIGH) {
          paused = true;
          try { shellStream.pause(); } catch (_err) {}
        }
      });

      shellStream.on('close', function () {
        send('status', { state: 'closed' });
        ws.close();
      });
    });
  });

  ssh.on('error', function (err) {
    send('error', { message: err.message });
    ws.close();
  });

  ws.on('message', function (raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch (_err) {
      return;
    }

    const payload = msg && msg.payload ? msg.payload : {};

    if (msg.type === 'connect') {
      const cfg = {
        host: payload.host || demoConfig.host,
        port: Number(payload.port || demoConfig.port),
        username: payload.user || demoConfig.username,
      };

      if (payload.auth === 'Password') {
        cfg.password = payload.password || demoConfig.password;
      } else if (payload.keyPath) {
        cfg.privateKey = fs.readFileSync(payload.keyPath);
      } else if (demoConfig.privateKey) {
        cfg.privateKey = demoConfig.privateKey;
      }

      send('status', { state: 'connecting' });
      ssh.connect(cfg);
      return;
    }

    if (msg.type === 'sftp:init') {
      ensureSftp(function (err) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'init',
            message: err.message,
          });
          return;
        }
        send('sftp:ready', {
          requestId: payload.requestId,
          cwd: '/var/www',
        });
      });
      return;
    }

    if (msg.type === 'sftp:list') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'list',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        const targetPath = payload.path || '/';
        sftpClient.readdir(targetPath, function (readErr, items) {
          if (readErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'list',
              path: targetPath,
              message: readErr.message,
            });
            return;
          }

          const entries = (items || []).map(function (item) {
            return normalizeSftpEntry(targetPath, item);
          }).sort(function (a, b) {
            if (a.type === 'dir' && b.type !== 'dir') return -1;
            if (a.type !== 'dir' && b.type === 'dir') return 1;
            return a.name.localeCompare(b.name, 'zh-CN');
          });

          send('sftp:list:result', {
            requestId: payload.requestId,
            path: targetPath,
            entries: entries,
          });
        });
      });
      return;
    }

    if (msg.type === 'sftp:upload') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'upload',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        try {
          const targetPath = payload.path;
          const fileName = payload.fileName || 'upload.bin';
          const buffer = dataUrlToBuffer(payload.content || '');
          uploadBuffer(sftpClient, targetPath, buffer, function (writeErr) {
            if (writeErr) {
              send('sftp:error', {
                requestId: payload.requestId,
                action: 'upload',
                path: targetPath,
                message: writeErr.message,
              });
              return;
            }
            send('sftp:upload:result', {
              requestId: payload.requestId,
              path: targetPath,
              fileName: fileName,
            });
          });
        } catch (uploadErr) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'upload',
            path: payload.path,
            message: uploadErr.message,
          });
        }
      });
      return;
    }

    if (msg.type === 'sftp:download') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'download',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        const targetPath = payload.path;
        const fileName = String(targetPath || '').split('/').filter(Boolean).pop() || 'download.bin';
        downloadBuffer(sftpClient, targetPath, function (readErr, buffer) {
          if (readErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'download',
              path: targetPath,
              message: readErr.message,
            });
            return;
          }

          send('sftp:download:result', {
            requestId: payload.requestId,
            path: targetPath,
            fileName: fileName,
            content: 'data:' + detectMimeByName(fileName) + ';base64,' + buffer.toString('base64'),
          });
        });
      });
      return;
    }

    if (msg.type === 'sftp:createFile') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'createFile',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        const targetPath = payload.path;
        const fileName = String(targetPath || '').split('/').filter(Boolean).pop() || '';
        if (!isValidRemoteName(fileName)) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'createFile',
            path: targetPath,
            message: '文件名无效',
          });
          return;
        }

        uploadBuffer(sftpClient, targetPath, Buffer.from(String(payload.content || ''), 'utf8'), function (writeErr) {
          if (writeErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'createFile',
              path: targetPath,
              message: writeErr.message,
            });
            return;
          }
          send('sftp:createFile:result', {
            requestId: payload.requestId,
            path: targetPath,
            fileName: fileName,
          });
        });
      });
      return;
    }

    if (msg.type === 'sftp:mkdir') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'mkdir',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        const targetPath = payload.path;
        const dirName = String(targetPath || '').split('/').filter(Boolean).pop() || '';
        if (!isValidRemoteName(dirName)) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'mkdir',
            path: targetPath,
            message: '文件夹名无效',
          });
          return;
        }

        sftpClient.mkdir(targetPath, function (mkdirErr) {
          if (mkdirErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'mkdir',
              path: targetPath,
              message: mkdirErr.message,
            });
            return;
          }
          send('sftp:mkdir:result', {
            requestId: payload.requestId,
            path: targetPath,
            dirName: dirName,
          });
        });
      });
      return;
    }

    if (msg.type === 'sftp:delete') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'delete',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        if (payload.entryType !== 'file') {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'delete',
            path: payload.path,
            message: '当前仅支持删除普通文件',
          });
          return;
        }

        sftpClient.unlink(payload.path, function (unlinkErr) {
          if (unlinkErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'delete',
              path: payload.path,
              message: unlinkErr.message,
            });
            return;
          }
          send('sftp:delete:result', {
            requestId: payload.requestId,
            path: payload.path,
          });
        });
      });
      return;
    }

    if (msg.type === 'sftp:rename') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'rename',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        const targetPath = payload.path;
        const newName = String(payload.newName || '').trim();
        if (!newName || newName.indexOf('/') > -1 || newName === '.' || newName === '..') {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'rename',
            path: targetPath,
            message: '新名称无效',
          });
          return;
        }

        const newPath = remoteJoin(remoteDirname(targetPath), newName);
        sftpClient.rename(targetPath, newPath, function (renameErr) {
          if (renameErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'rename',
              path: targetPath,
              message: renameErr.message,
            });
            return;
          }
          send('sftp:rename:result', {
            requestId: payload.requestId,
            path: targetPath,
            newPath: newPath,
            newName: newName,
          });
        });
      });
      return;
    }

    if (msg.type === 'sftp:readText') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'readText',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        const targetPath = payload.path;
        const fileName = String(targetPath || '').split('/').filter(Boolean).pop() || '';
        if (!isProbablyTextFile(fileName)) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'readText',
            path: targetPath,
            message: '当前仅支持编辑文本文件',
          });
          return;
        }

        downloadBuffer(sftpClient, targetPath, function (readErr, buffer) {
          if (readErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'readText',
              path: targetPath,
              message: readErr.message,
            });
            return;
          }
          if (buffer.length > 1024 * 1024) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'readText',
              path: targetPath,
              message: '文件过大，暂不支持在线编辑',
            });
            return;
          }
          send('sftp:readText:result', {
            requestId: payload.requestId,
            path: targetPath,
            content: buffer.toString('utf8'),
            encoding: 'utf8',
          });
        });
      });
      return;
    }

    if (msg.type === 'sftp:writeText') {
      ensureSftp(function (err, sftpClient) {
        if (err) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'writeText',
            path: payload.path,
            message: err.message,
          });
          return;
        }

        const targetPath = payload.path;
        const fileName = String(targetPath || '').split('/').filter(Boolean).pop() || '';
        if (!isProbablyTextFile(fileName)) {
          send('sftp:error', {
            requestId: payload.requestId,
            action: 'writeText',
            path: targetPath,
            message: '当前仅支持编辑文本文件',
          });
          return;
        }

        const buffer = Buffer.from(String(payload.content || ''), 'utf8');
        uploadBuffer(sftpClient, targetPath, buffer, function (writeErr) {
          if (writeErr) {
            send('sftp:error', {
              requestId: payload.requestId,
              action: 'writeText',
              path: targetPath,
              message: writeErr.message,
            });
            return;
          }
          send('sftp:writeText:result', {
            requestId: payload.requestId,
            path: targetPath,
          });
        });
      });
      return;
    }

    if (!stream) return;

    if (msg.type === 'input' && typeof msg.data === 'string') {
      stream.write(msg.data);
      return;
    }

    if (msg.type === 'resize') {
      const cols = Number(msg.cols || 120);
      const rows = Number(msg.rows || 30);
      try {
        stream.setWindow(rows, cols, 0, 0);
      } catch (_err) {}
      return;
    }

    if (msg.type === 'signal') {
      try {
        stream.signal(msg.name);
      } catch (_err) {}
    }
  });

  ws.on('close', function () {
    sftp = null;
    sshReady = false;
    try {
      if (stream) stream.end();
    } catch (_err) {}
    try {
      ssh.end();
    } catch (_err) {}
  });
});

// ===================== 远程串口（WebSocket 桥接 /dev/ttyS*）=====================
//
// 协议：浏览器 ↔ /ws/serial
//   上行：{ type: 'open',  payload: { path, baudRate, dataBits, parity, stopBits } }
//         { type: 'input', data: '...' }       // 发送字节到串口（base64 或 utf8 字符串）
//         { type: 'close' }
//   下行：{ type: 'status', payload: { state, port, baudRate } }
//         { type: 'output', data: '...' }      // 从串口收到的字节（base64）
//         { type: 'error', payload: { message } }

function isValidDevicePath(p) {
  // 只允许打开 /dev/ttyS* 、/dev/ttyUSB* 、/dev/ttyACM*
  return typeof p === 'string' && /^\/dev\/tty(S|USB|ACM)\d+$/.test(p);
}

function normalizeBaud(b) {
  const n = Number(b);
  const allowed = [300, 600, 1200, 1800, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 500000, 921600, 1000000, 1500000, 2000000, 3000000];
  return allowed.indexOf(n) >= 0 ? n : 115200;
}

function buildSttyArgs(device, opts) {
  const args = ['-F', device, 'raw', '-echo', '-echoe', '-echok', '-echoctl', '-echoke'];
  args.push(String(normalizeBaud(opts.baudRate || 115200)));
  // data bits
  const dataBits = Number(opts.dataBits) === 7 ? 'cs7' : 'cs8';
  args.push(dataBits);
  // parity
  const parity = String(opts.parity || 'none').toLowerCase();
  if (parity === 'even') args.push('parenb', '-parodd');
  else if (parity === 'odd') args.push('parenb', 'parodd');
  else args.push('-parenb');
  // stop bits
  if (Number(opts.stopBits) === 2) args.push('cstopb');
  else args.push('-cstopb');
  // 流控：默认关闭
  args.push('-crtscts', '-ixon', '-ixoff');
  // 忽略 modem 控制线（没接 DCD 也能打开）
  args.push('clocal', '-hupcl');
  return args;
}

function runStty(device, opts) {
  return new Promise(function (resolve, reject) {
    const child = spawn('stty', buildSttyArgs(device, opts));
    let stderr = '';
    child.stderr.on('data', function (chunk) { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', function (code) {
      if (code === 0) resolve();
      else reject(new Error('stty 配置失败: ' + (stderr.trim() || ('exit ' + code))));
    });
  });
}

wssSerial.on('connection', function (ws) {
  let deviceStream = null;   // fs.ReadStream + .write
  let writeStream = null;
  let currentPath = null;

  function send(type, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: type, payload: payload }));
    } catch (_err) {
      // 发送失败不应传导到 pty，避免反压导致服务假死
    }
  }

  function closeDevice(reason) {
    if (currentPath) {
      serialLocks.delete(currentPath);
      currentPath = null;
    }
    try { if (deviceStream) deviceStream.destroy(); } catch (_err) {}
    try { if (writeStream) writeStream.end(); } catch (_err) {}
    deviceStream = null;
    writeStream = null;
    send('status', { state: 'closed', reason: reason || '' });
  }

  ws.on('message', function (raw) {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch (_err) { return; }
    const payload = msg && msg.payload ? msg.payload : {};

    if (msg.type === 'open') {
      const devPath = payload.path;
      if (!isValidDevicePath(devPath)) {
        send('error', { message: '无效的设备路径：' + devPath });
        return;
      }
      if (serialLocks.has(devPath)) {
        send('error', { message: devPath + ' 正被其他会话占用' });
        return;
      }
      if (!fs.existsSync(devPath)) {
        send('error', { message: '设备不存在：' + devPath });
        return;
      }

      // 先用 stty 配置，再打开文件描述符
      runStty(devPath, payload).then(function () {
        try {
          deviceStream = fs.createReadStream(devPath, { highWaterMark: 4096 });
          writeStream = fs.createWriteStream(devPath, { flags: 'r+' });
        } catch (err) {
          send('error', { message: '打开串口失败：' + err.message });
          closeDevice('open-failed');
          return;
        }
        currentPath = devPath;
        serialLocks.set(devPath, { since: Date.now() });

        deviceStream.on('data', function (chunk) {
          send('output', { data: chunk.toString('base64'), encoding: 'base64' });
        });
        deviceStream.on('error', function (err) {
          send('error', { message: '串口读取错误：' + err.message });
          closeDevice('read-error');
        });
        deviceStream.on('close', function () {
          closeDevice('device-closed');
        });
        writeStream.on('error', function (err) {
          send('error', { message: '串口写入错误：' + err.message });
        });

        send('status', {
          state: 'opened',
          port: devPath,
          baudRate: normalizeBaud(payload.baudRate || 115200),
        });
      }).catch(function (err) {
        send('error', { message: err.message });
      });
      return;
    }

    if (msg.type === 'input') {
      if (!writeStream) {
        send('error', { message: '串口未打开' });
        return;
      }
      let buf;
      if (payload.encoding === 'base64') {
        buf = Buffer.from(String(payload.data || ''), 'base64');
      } else {
        buf = Buffer.from(String(payload.data || msg.data || ''), 'utf8');
      }
      try { writeStream.write(buf); } catch (err) {
        send('error', { message: '写入失败：' + err.message });
      }
      return;
    }

    if (msg.type === 'close') {
      closeDevice('client-close');
      return;
    }
  });

  ws.on('close', function () {
    closeDevice('ws-close');
  });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, function () {
  console.log('Web SSH running at http://0.0.0.0:' + port);
});
