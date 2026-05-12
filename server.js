const express = require('express');
const fs = require('fs');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const wssSerial = new WebSocket.Server({ noServer: true });
const wssTcp = new WebSocket.Server({ noServer: true });

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
  } else if (pathname === '/ws/tcp') {
    wssTcp.handleUpgrade(request, socket, head, function (ws) {
      wssTcp.emit('connection', ws, request);
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

// ===================== TCP 客户端桥接（浏览器 ↔ /ws/tcp ↔ 远端 TCP 服务）=====================
//
// 协议：浏览器 ↔ /ws/tcp
//   上行：{ type: 'open',  payload: { host, port, connectTimeoutMs? } }
//         { type: 'input', payload: { encoding: 'base64'|'utf8', data } }
//         { type: 'close' }
//   下行：{ type: 'status', payload: { state, host, port, remoteAddress?, reason? } }
//         { type: 'output', payload: { encoding: 'base64', data } }
//         { type: 'error',  payload: { message } }

function isValidTcpHost(h) {
  if (typeof h !== 'string') return false;
  const s = h.trim();
  if (!s || s.length > 253) return false;
  // 允许 IPv4 / IPv6 / 合法主机名；阻止明显异常字符
  return /^[A-Za-z0-9._:\-\[\]]+$/.test(s);
}

function normalizeTcpPort(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 65535 || Math.floor(n) !== n) return null;
  return n;
}

wssTcp.on('connection', function (ws) {
  let socket = null;
  let connectedTarget = null;

  function send(type, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: type, payload: payload }));
    } catch (_err) {}
  }

  function teardown(reason) {
    const prev = connectedTarget;
    connectedTarget = null;
    if (socket) {
      try { socket.destroy(); } catch (_err) {}
      socket = null;
    }
    if (prev) {
      send('status', { state: 'closed', host: prev.host, port: prev.port, reason: reason || '' });
    } else {
      send('status', { state: 'closed', reason: reason || '' });
    }
  }

  ws.on('message', function (raw) {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch (_err) { return; }
    const payload = msg && msg.payload ? msg.payload : {};

    if (msg.type === 'open') {
      if (socket) {
        send('error', { message: '连接已存在，请先关闭' });
        return;
      }
      const host = String(payload.host || '').trim();
      const port = normalizeTcpPort(payload.port);
      if (!isValidTcpHost(host)) {
        send('error', { message: '无效的主机地址：' + host });
        return;
      }
      if (port == null) {
        send('error', { message: '无效的端口号：' + payload.port });
        return;
      }
      const connectTimeoutMs = Math.max(500, Math.min(60000, Number(payload.connectTimeoutMs) || 5000));

      send('status', { state: 'connecting', host: host, port: port });

      socket = new net.Socket();
      socket.setNoDelay(true);
      let connectTimer = setTimeout(function () {
        if (socket && !connectedTarget) {
          send('error', { message: '连接超时' });
          teardown('timeout');
        }
      }, connectTimeoutMs);

      socket.on('connect', function () {
        clearTimeout(connectTimer);
        connectedTarget = { host: host, port: port };
        send('status', {
          state: 'opened',
          host: host,
          port: port,
          remoteAddress: socket.remoteAddress || '',
          remotePort: socket.remotePort || 0,
        });
      });

      socket.on('data', function (chunk) {
        send('output', { encoding: 'base64', data: chunk.toString('base64') });
      });

      socket.on('error', function (err) {
        clearTimeout(connectTimer);
        send('error', { message: 'TCP 错误：' + err.message });
      });

      socket.on('close', function (hadError) {
        clearTimeout(connectTimer);
        teardown(hadError ? 'transport-error' : 'remote-close');
      });

      try {
        socket.connect(port, host);
      } catch (err) {
        clearTimeout(connectTimer);
        send('error', { message: '发起连接失败：' + err.message });
        teardown('connect-failed');
      }
      return;
    }

    if (msg.type === 'input') {
      if (!socket || !connectedTarget) {
        send('error', { message: 'TCP 未连接' });
        return;
      }
      let buf;
      if (payload.encoding === 'base64') {
        buf = Buffer.from(String(payload.data || ''), 'base64');
      } else {
        buf = Buffer.from(String(payload.data || msg.data || ''), 'utf8');
      }
      if (!buf.length) return;
      try { socket.write(buf); } catch (err) {
        send('error', { message: '发送失败：' + err.message });
      }
      return;
    }

    if (msg.type === 'close') {
      teardown('client-close');
      return;
    }
  });

  ws.on('close', function () {
    teardown('ws-close');
  });
});

// ===== docker 自动重启模块 =====
// 目的：解决系统开机后 docker 偶发启动异常——服务起来时若启用，倒计时后本机执行 systemctl restart docker。
(function setupDockerRestart() {
  const path = require('path');

  const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'docker-restart.json');
  const CONFIG_PATH = process.env.DOCKER_RESTART_CONFIG || DEFAULT_CONFIG_PATH;
  const LOG_PATH = process.env.DOCKER_RESTART_LOG
    || path.join(__dirname, '..', 'logs', 'docker-restart.log');
  const MIN_SEC = 10;
  const MAX_SEC = 3600;

  const defaults = { enabled: false, countdownSec: 60, lastResult: null };
  let config = Object.assign({}, defaults);
  let timer = null;
  let deadlineMs = 0;
  let running = false;

  // 服务器本地时间字符串 "YYYY-MM-DD HH:mm:ss"，避免落盘/推给前端的是 UTC（Z 结尾）跟实际差 8 小时
  function localStamp(d) {
    d = d || new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function readConfig() {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      config = {
        enabled: Boolean(parsed.enabled),
        countdownSec: clampSec(Number(parsed.countdownSec) || defaults.countdownSec),
        lastResult: parsed.lastResult || null,
      };
    } catch (_err) {
      config = Object.assign({}, defaults);
    }
  }

  function writeConfig() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.error('[docker-restart] 写配置失败:', err.message);
    }
  }

  function clampSec(v) {
    if (!Number.isFinite(v)) return defaults.countdownSec;
    return Math.max(MIN_SEC, Math.min(MAX_SEC, Math.floor(v)));
  }

  function appendLog(line) {
    const stamp = localStamp();
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, `[${stamp}] ${line}\n`, 'utf8');
    } catch (_err) {}
  }

  function cancelTimer(reason) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      deadlineMs = 0;
      appendLog(`倒计时取消：${reason || ''}`.trim());
    }
  }

  function scheduleCountdown(reason) {
    cancelTimer('replaced');
    if (!config.enabled) return;
    const sec = config.countdownSec;
    deadlineMs = Date.now() + sec * 1000;
    appendLog(`倒计时开始：${sec}s，触发来源=${reason || 'unknown'}`);
    timer = setTimeout(function () {
      timer = null;
      deadlineMs = 0;
      runRestart('countdown');
    }, sec * 1000);
  }

  function runRestart(trigger) {
    if (running) return Promise.resolve({ ok: false, message: 'already-running' });
    running = true;
    const startedAt = localStamp();
    appendLog(`执行 systemctl restart docker（触发=${trigger}）`);
    return new Promise(function (resolve) {
      const child = spawn('systemctl', ['restart', 'docker']);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', function (b) { stdout += b.toString('utf8'); });
      child.stderr.on('data', function (b) { stderr += b.toString('utf8'); });
      child.on('close', function (code) {
        running = false;
        const ok = code === 0;
        const finishedAt = localStamp();
        const result = {
          ok: ok,
          exitCode: code,
          trigger: trigger,
          startedAt: startedAt,
          finishedAt: finishedAt,
          stdout: stdout.slice(-2000),
          stderr: stderr.slice(-2000),
        };
        config.lastResult = result;
        writeConfig();
        appendLog(`执行完成 exit=${code} ok=${ok}`);
        resolve(result);
      });
      child.on('error', function (err) {
        running = false;
        const result = {
          ok: false,
          exitCode: null,
          trigger: trigger,
          startedAt: startedAt,
          finishedAt: localStamp(),
          stdout: '',
          stderr: 'spawn error: ' + err.message,
        };
        config.lastResult = result;
        writeConfig();
        appendLog(`执行错误：${err.message}`);
        resolve(result);
      });
    });
  }

  function publicState() {
    const remainingMs = deadlineMs ? Math.max(0, deadlineMs - Date.now()) : 0;
    return {
      enabled: config.enabled,
      countdownSec: config.countdownSec,
      counting: Boolean(timer),
      remainingSec: Math.ceil(remainingMs / 1000),
      running: running,
      lastResult: config.lastResult,
    };
  }

  app.use(express.json({ limit: '32kb' }));

  app.get('/api/docker-restart/config', function (_req, res) {
    res.json(publicState());
  });

  app.put('/api/docker-restart/config', function (req, res) {
    const body = req.body || {};
    const prevEnabled = config.enabled;
    if (typeof body.enabled === 'boolean') config.enabled = body.enabled;
    if (body.countdownSec !== undefined) config.countdownSec = clampSec(Number(body.countdownSec));
    writeConfig();
    if (!config.enabled) {
      cancelTimer('config-disabled');
    } else if (!prevEnabled && config.enabled) {
      scheduleCountdown('config-enabled');
    }
    res.json(publicState());
  });

  app.post('/api/docker-restart/cancel', function (_req, res) {
    cancelTimer('user-cancel');
    res.json(publicState());
  });

  app.post('/api/docker-restart/trigger', function (_req, res) {
    cancelTimer('manual-trigger');
    runRestart('manual').then(function () { res.json(publicState()); });
  });

  app.post('/api/docker-restart/restart-countdown', function (_req, res) {
    scheduleCountdown('manual-restart');
    res.json(publicState());
  });

  app.get('/api/docker-restart/log', function (_req, res) {
    try {
      const raw = fs.readFileSync(LOG_PATH, 'utf8');
      const tail = raw.split('\n').slice(-200).join('\n');
      res.type('text/plain').send(tail);
    } catch (_err) {
      res.type('text/plain').send('');
    }
  });

  readConfig();
  if (config.enabled) scheduleCountdown('service-start');
  appendLog(`服务启动，enabled=${config.enabled} countdown=${config.countdownSec}s`);
})();

// ===== 信创短信猫 - 数据库连接模块 =====
// 目的：给"短信猫"功能提供一条可配置、可持久化、可开机自启的 MySQL 连接
(function setupSmsDb() {
  const path = require('path');
  let mysql;
  try { mysql = require('mysql2/promise'); } catch (_e) { mysql = null; }

  const CONFIG_DIR = path.join(__dirname, 'config');
  const CONFIG_PATH = process.env.SMS_DB_CONFIG || path.join(CONFIG_DIR, 'sms-db.json');
  const LOG_PATH = process.env.SMS_DB_LOG || path.join(__dirname, 'logs', 'sms-db.log');

  const defaults = {
    host: '127.0.0.1',
    port: 3306,
    database: '',
    user: '',
    password: '',
    autoStart: false, // 上次手动"连接成功"后置 true；手动"断开"后置 false
  };
  let cfg = Object.assign({}, defaults);
  let pool = null;
  let connected = false;
  let lastError = '';
  let lastConnectedAt = '';
  let lastAttempt = null; // 最近一次"连接"请求的参数（不含密码），不落盘

  function localStamp(d) {
    d = d || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, `[${localStamp()}] ${line}\n`, 'utf8');
    } catch (_e) {}
  }

  function readCfg() {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      cfg = Object.assign({}, defaults, parsed);
    } catch (_e) { cfg = Object.assign({}, defaults); }
  }

  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      // 密码在里面，尽量收紧权限；非 root 或 Windows 会忽略错误
      try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_e) {}
    } catch (err) {
      console.error('[sms-db] 写配置失败:', err.message);
    }
  }

  function publicStatus() {
    const display = lastAttempt || cfg;
    return {
      connected,
      autoStart: !!cfg.autoStart,
      host: display.host,
      port: display.port,
      user: display.user,
      database: display.database,
      lastError,
      lastConnectedAt,
      driverReady: !!mysql,
    };
  }

  async function closePool(reason) {
    if (pool) {
      const old = pool;
      pool = null;
      connected = false;
      try { await old.end(); } catch (_e) {}
      appendLog(`已断开：${reason || ''}`.trim());
    } else {
      connected = false;
    }
  }

  async function openPool(options) {
    if (!mysql) throw new Error('mysql2 驱动未安装');
    await closePool('reconnect');
    const p = mysql.createPool({
      host: options.host,
      port: Number(options.port) || 3306,
      user: options.user,
      password: options.password,
      database: options.database || undefined,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 8000,
    });
    // 立即拿一条连接做探活，失败就扔异常
    const conn = await p.getConnection();
    try { await conn.ping(); } finally { conn.release(); }
    pool = p;
    connected = true;
    lastError = '';
    lastConnectedAt = localStamp();
    return p;
  }

  async function tryAutoStart() {
    if (!cfg.autoStart) { appendLog('未开启 autoStart，跳过自启'); return; }
    if (!cfg.host || !cfg.user) { appendLog('配置不完整，跳过自启'); return; }
    try {
      await openPool(cfg);
      appendLog(`自启成功：${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database || '-'}`);
    } catch (err) {
      lastError = err.message;
      appendLog(`自启失败：${err.message}`);
    }
  }

  app.get('/api/sms/db/status', function (_req, res) {
    res.json(publicStatus());
  });

  app.post('/api/sms/db/connect', async function (req, res) {
    const body = req.body || {};
    const host = String(body.host || '').trim() || defaults.host;
    const port = Number(body.port) || defaults.port;
    const user = String(body.user || '').trim();
    const password = String(body.password || '');
    const database = String(body.database || '').trim();
    if (!user) return res.status(400).json({ ok: false, message: '用户名不能为空' });
    if (!mysql) return res.status(500).json({ ok: false, message: 'mysql2 驱动未安装' });
    lastAttempt = { host, port, user, database };
    try {
      await openPool({ host, port, user, password, database });
      cfg = Object.assign({}, cfg, { host, port, user, password, database, autoStart: true });
      writeCfg();
      appendLog(`手动连接成功：${user}@${host}:${port}/${database || '-'}`);
      res.json({ ok: true, status: publicStatus() });
    } catch (err) {
      lastError = err.message;
      appendLog(`手动连接失败：${err.message}（尝试 ${user}@${host}:${port}/${database || '-'}）`);
      res.status(500).json({ ok: false, message: err.message, status: publicStatus() });
    }
  });

  app.post('/api/sms/db/disconnect', async function (_req, res) {
    await closePool('manual-disconnect');
    cfg.autoStart = false;
    writeCfg();
    appendLog('手动断开，已关闭 autoStart');
    res.json({ ok: true, status: publicStatus() });
  });

  readCfg();
  tryAutoStart().catch(() => {});

  // 对外暴露一个只读入口，方便后续短信猫推送模块复用同一连接池
  global.__smsDbGetPool = function () { return pool; };
})();

// ===== 信创短信猫 - 数据库监测「新告警提示」 =====
(function setupSmsMonitor() {
  const path = require('path');

  const CONFIG_PATH = process.env.SMS_MONITOR_CONFIG
    || path.join(__dirname, 'config', 'sms-monitor.json');
  const LOG_PATH = process.env.SMS_MONITOR_LOG
    || path.join(__dirname, 'logs', 'sms-monitor.log');

  const TABLE = 'dcim-alarmlist';
  const MIN_INTERVAL = 1;
  const MAX_INTERVAL = 3600;
  const MAX_BUFFER = 500;
  // 新告警插入后 TextMessage 会由另一个进程异步填充，约 2-3 秒。
  // 在此之前先不往前端推，挂在 pending 里每轮轮询复查；超过这个时长兜底推出。
  const MAX_PENDING_SEC = 30;

  const defaults = { enabled: true, intervalSec: 3, bufferSize: 200 };
  let cfg = Object.assign({}, defaults);
  let timer = null;
  let polling = false;
  let lastSeenId = 0;
  let alarmBuffer = [];        // [{ clientId, row }]
  let nextClientId = 1;
  // 等待 TextMessage 填充的新告警：Map<id, { firstSeenMs, row }>
  let pendingAlarms = new Map();
  // 告警解除：按 CancelTime 增量，不看 id（同一条 id 被 UPDATE）
  let lastCancelMs = 0;        // 时间戳毫秒，作为游标
  let cancelBuffer = [];       // [{ clientId, row }]
  let nextCancelClientId = 1;
  let totalCancelled = 0;
  let lastError = '';
  let lastPollAt = '';
  let totalFetched = 0;

  function localStamp(d) {
    d = d || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, `[${localStamp()}] ${line}\n`, 'utf8');
    } catch (_e) {}
  }
  function clamp(v, min, max, dft) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dft;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }
  function readCfg() {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      cfg = {
        enabled: Boolean(parsed.enabled),
        intervalSec: clamp(parsed.intervalSec, MIN_INTERVAL, MAX_INTERVAL, defaults.intervalSec),
        bufferSize: clamp(parsed.bufferSize, 10, MAX_BUFFER, defaults.bufferSize),
      };
    } catch (_e) {
      cfg = Object.assign({}, defaults);
    }
  }
  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.error('[sms-monitor] 写配置失败:', err.message);
    }
  }
  function getPool() {
    return typeof global.__smsDbGetPool === 'function' ? global.__smsDbGetPool() : null;
  }

  async function initLastSeenId() {
    const pool = getPool();
    if (!pool) return;
    try {
      const [rows] = await pool.query('SELECT COALESCE(MAX(id),0) AS maxId FROM `' + TABLE + '`');
      lastSeenId = Number(rows[0] && rows[0].maxId) || 0;
      // 同时把 CancelTime 游标对齐到当前最大值，避免首次把历史解除全部当成新事件
      const [c] = await pool.query('SELECT MAX(CancelTime) AS maxT FROM `' + TABLE + '` WHERE CancelTime IS NOT NULL');
      const maxT = c[0] && c[0].maxT;
      lastCancelMs = maxT ? new Date(maxT).getTime() : 0;
      appendLog(`初始化 lastSeenId=${lastSeenId} lastCancelMs=${lastCancelMs}`);
    } catch (err) {
      lastError = err.message;
      appendLog(`初始化失败：${err.message}`);
    }
  }

  async function pollOnce() {
    if (polling) return;
    const pool = getPool();
    if (!pool) { lastError = '数据库未连接'; return; }
    polling = true;
    try {
      if (lastSeenId === 0 && lastCancelMs === 0) await initLastSeenId();

      // 1) 新告警：id > lastSeenId，但 TextMessage 可能稍后由其它进程填充，
      //    所以 TextMessage 为空时先入 pending，等下次轮询再查。
      const [rows] = await pool.query(
        'SELECT * FROM `' + TABLE + '` WHERE id > ? ORDER BY id ASC LIMIT 200',
        [lastSeenId]
      );
      lastPollAt = localStamp();
      if (rows && rows.length) {
        const nowMs = Date.now();
        for (const row of rows) {
          const text = row.TextMessage;
          if (text != null && String(text).trim() !== '') {
            alarmBuffer.push({ clientId: nextClientId++, row });
          } else {
            pendingAlarms.set(Number(row.id), { firstSeenMs: nowMs, row });
          }
          if (Number(row.id) > lastSeenId) lastSeenId = Number(row.id);
        }
        totalFetched += rows.length;
        appendLog(`新增 ${rows.length} 条，lastSeenId=${lastSeenId}，其中 pending=${pendingAlarms.size}`);
      }

      // 1.5) 复查 pending：TextMessage 已填或超时则 flush 进 alarmBuffer
      if (pendingAlarms.size) {
        const ids = Array.from(pendingAlarms.keys());
        const placeholders = ids.map(function () { return '?'; }).join(',');
        const [fresh] = await pool.query(
          'SELECT * FROM `' + TABLE + '` WHERE id IN (' + placeholders + ')',
          ids
        );
        const byId = new Map();
        (fresh || []).forEach(function (r) { byId.set(Number(r.id), r); });
        const nowMs = Date.now();
        for (const id of ids) {
          const p = pendingAlarms.get(id);
          const latest = byId.get(id) || p.row;
          const text = latest.TextMessage;
          const filled = text != null && String(text).trim() !== '';
          const timeout = (nowMs - p.firstSeenMs) / 1000 >= MAX_PENDING_SEC;
          if (filled || timeout) {
            alarmBuffer.push({ clientId: nextClientId++, row: latest });
            pendingAlarms.delete(id);
            if (timeout && !filled) {
              appendLog(`id=${id} 等待 TextMessage 超时 ${MAX_PENDING_SEC}s，兜底放行`);
            }
          }
        }
      }
      if (alarmBuffer.length > cfg.bufferSize) {
        alarmBuffer = alarmBuffer.slice(-cfg.bufferSize);
      }

      // 2) 告警解除：CancelTime > lastCancelMs
      const cursorDate = lastCancelMs > 0 ? new Date(lastCancelMs) : new Date(0);
      const [cancels] = await pool.query(
        'SELECT * FROM `' + TABLE + '` WHERE CancelTime IS NOT NULL AND CancelTime > ? ORDER BY CancelTime ASC LIMIT 200',
        [cursorDate]
      );
      if (cancels && cancels.length) {
        for (const row of cancels) {
          const t = row.CancelTime ? new Date(row.CancelTime).getTime() : 0;
          // 防御：游标相等时跳过（mysql2 的 > 已能排除相等，这里多一层保险）
          if (t && t <= lastCancelMs) continue;
          cancelBuffer.push({ clientId: nextCancelClientId++, row });
          if (t > lastCancelMs) lastCancelMs = t;
        }
        if (cancelBuffer.length > cfg.bufferSize) {
          cancelBuffer = cancelBuffer.slice(-cfg.bufferSize);
        }
        totalCancelled += cancels.length;
        appendLog(`解除 ${cancels.length} 条，lastCancelMs=${lastCancelMs}`);
      }

      lastError = '';
    } catch (err) {
      lastError = err.message;
      appendLog(`轮询失败：${err.message}`);
    } finally {
      polling = false;
    }
  }

  function scheduleTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    if (!cfg.enabled) return;
    const ms = Math.max(MIN_INTERVAL * 1000, cfg.intervalSec * 1000);
    timer = setInterval(() => { pollOnce().catch(() => {}); }, ms);
  }

  function publicState() {
    return {
      enabled: cfg.enabled,
      intervalSec: cfg.intervalSec,
      bufferSize: cfg.bufferSize,
      lastSeenId: lastSeenId,
      bufferCount: alarmBuffer.length,
      pendingCount: pendingAlarms.size,
      totalFetched: totalFetched,
      lastCancelMs: lastCancelMs,
      cancelBufferCount: cancelBuffer.length,
      totalCancelled: totalCancelled,
      lastPollAt: lastPollAt,
      lastError: lastError,
      dbConnected: !!getPool(),
      table: TABLE,
    };
  }

  app.get('/api/sms/monitor/config', function (_req, res) {
    res.json(publicState());
  });

  app.put('/api/sms/monitor/config', function (req, res) {
    const body = req.body || {};
    if ('enabled' in body) cfg.enabled = Boolean(body.enabled);
    if ('intervalSec' in body) cfg.intervalSec = clamp(body.intervalSec, MIN_INTERVAL, MAX_INTERVAL, cfg.intervalSec);
    if ('bufferSize' in body) cfg.bufferSize = clamp(body.bufferSize, 10, MAX_BUFFER, cfg.bufferSize);
    writeCfg();
    scheduleTimer();
    appendLog(`配置更新 enabled=${cfg.enabled} interval=${cfg.intervalSec}s buffer=${cfg.bufferSize}`);
    res.json(publicState());
  });

  app.get('/api/sms/monitor/recent', function (req, res) {
    const sinceClientId = Number(req.query.sinceClientId) || 0;
    const items = alarmBuffer.filter(function (e) { return e.clientId > sinceClientId; });
    const lastClientId = alarmBuffer.length
      ? alarmBuffer[alarmBuffer.length - 1].clientId
      : sinceClientId;
    res.json({ state: publicState(), items: items, lastClientId: lastClientId });
  });

  app.get('/api/sms/monitor/cancels', function (req, res) {
    const sinceClientId = Number(req.query.sinceClientId) || 0;
    const items = cancelBuffer.filter(function (e) { return e.clientId > sinceClientId; });
    const lastClientId = cancelBuffer.length
      ? cancelBuffer[cancelBuffer.length - 1].clientId
      : sinceClientId;
    res.json({ state: publicState(), items: items, lastClientId: lastClientId });
  });

  app.post('/api/sms/monitor/clear', function (req, res) {
    const scope = String((req.query && req.query.scope) || 'all');
    if (scope === 'all' || scope === 'alarms') alarmBuffer = [];
    if (scope === 'all' || scope === 'cancels') cancelBuffer = [];
    res.json(publicState());
  });

  readCfg();
  setTimeout(function () {
    initLastSeenId().catch(() => {});
    scheduleTimer();
    if (cfg.enabled) pollOnce().catch(() => {});
    appendLog(`服务启动：enabled=${cfg.enabled} interval=${cfg.intervalSec}s`);
  }, 1500);
})();

const port = Number(process.env.PORT || 3000);
server.listen(port, function () {
  console.log('Web SSH running at http://0.0.0.0:' + port);
});
