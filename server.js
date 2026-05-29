const express = require('express');
const fs = require('fs');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const { spawn } = require('child_process');
const httpProxy = require('http-proxy');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const wssSerial = new WebSocket.Server({ noServer: true });
const wssTcp = new WebSocket.Server({ noServer: true });
const wssHa = new WebSocket.Server({ noServer: true });

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
  } else if (pathname === '/ws/ha') {
    wssHa.handleUpgrade(request, socket, head, function (ws) {
      wssHa.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// 保存当前已打开的串口设备 → 独占锁，防止一个串口被两个 WS 同时打开
const serialLocks = new Map();

// ===================== 协议助手反向代理 =====================
// 浏览器 -> Node(3010)/protocol/* -> Flask(127.0.0.1:5000)/protocol/*
// Flask 内部已经把所有路由挂在 /protocol 子路径下（PROTOCOL_PREFIX），所以
// 这里不剥前缀，直接转发即可。
const PROTOCOL_TARGET = process.env.PROTOCOL_TARGET || 'http://127.0.0.1:5000';
const protocolProxy = httpProxy.createProxyServer({
  target: PROTOCOL_TARGET,
  changeOrigin: false,
  ws: false,
  proxyTimeout: 120000,    // 大文件上传/Excel 解析可能耗时
  timeout: 120000,
});
protocolProxy.on('error', function (err, _req, res) {
  if (res && !res.headersSent) {
    try {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: false,
        msg: '协议助手服务未启动或无响应：' + err.message,
        target: PROTOCOL_TARGET,
      }));
    } catch (_) { /* ignore */ }
  }
});

// ===================== 浏览器登录门禁 =====================
// 仅拦截浏览器对 / 与 /index.html 的访问；/api/*、/ws*、/protocol/*、/health 全部放行，
// 这样外部自动化脚本和已经在调 API 的程序不受影响。
//
// 密码 = 服务器当天日期 YYYYMMDD（用服务器时间，避免客户端改时间绕过）
// 登录成功后发 token，token 在内存里维护过期时间。服务重启会丢失，需重登一次。
const AUTH_USER = 'admin';
const authTokens = new Map(); // token -> expireAtMs

function todayPassword() {
  const d = new Date();
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
}

function genToken() {
  // 32 字节随机十六进制串
  return require('crypto').randomBytes(32).toString('hex');
}

function reapTokens() {
  const now = Date.now();
  for (const [t, exp] of authTokens) {
    if (exp <= now) authTokens.delete(t);
  }
}

function isAuthed(req) {
  reapTokens();
  // 优先 cookie，兼容 ?token= 查询参数（页面跳转时使用）
  const cookie = String(req.headers.cookie || '');
  const m = /(?:^|;\s*)webssh_auth=([^;]+)/.exec(cookie);
  let token = m ? decodeURIComponent(m[1]) : '';
  if (!token && req.query && req.query.token) token = String(req.query.token);
  if (!token) return false;
  const exp = authTokens.get(token);
  return exp && exp > Date.now();
}

app.use(express.json({ limit: '32kb' }));

app.post('/api/auth/login', function (req, res) {
  const body = req.body || {};
  const user = String(body.user || '').trim();
  const pwd = String(body.password || '');
  let hours = Number(body.timeoutHours);
  if (!Number.isFinite(hours)) hours = 12;
  hours = Math.max(1, Math.min(720, Math.floor(hours))); // 1h ~ 30 天
  if (user !== AUTH_USER || pwd !== todayPassword()) {
    res.status(401).json({ ok: false, message: '用户名或密码错误' });
    return;
  }
  const token = genToken();
  const expireAt = Date.now() + hours * 3600 * 1000;
  authTokens.set(token, expireAt);
  // 同步设置 HttpOnly cookie，避免被页面 JS 读到。
  // SameSite=Lax + Path=/ 可覆盖所有同源页面；HTTP 场景不能加 Secure。
  res.setHeader('Set-Cookie',
    'webssh_auth=' + encodeURIComponent(token)
    + '; Path=/'
    + '; Expires=' + new Date(expireAt).toUTCString()
    + '; HttpOnly'
    + '; SameSite=Lax'
  );
  res.json({ ok: true, token: token, expireAt: expireAt, timeoutHours: hours });
});

app.get('/api/auth/check', function (req, res) {
  res.json({ ok: isAuthed(req) });
});

app.post('/api/auth/logout', function (req, res) {
  const cookie = String(req.headers.cookie || '');
  const m = /(?:^|;\s*)webssh_auth=([^;]+)/.exec(cookie);
  let token = m ? decodeURIComponent(m[1]) : '';
  if (!token && req.body && req.body.token) token = String(req.body.token);
  if (token) authTokens.delete(token);
  res.setHeader('Set-Cookie',
    'webssh_auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax');
  res.json({ ok: true });
});

// 注意：必须在 express.static 之前注册，否则 /protocol/static/... 会被本目录静态命中
// 用 app.all + 通配，而不是 app.use('/protocol', ...)。
// 因为 app.use(prefix, ...) 会从 req.url 剥掉 prefix，转发到 Flask 时就成了根路径，
// 导致 Flask 的 DispatcherMiddleware 把请求当成根路径兜底 404。
app.all(/^\/protocol(\/.*)?$/, function (req, res) {
  protocolProxy.web(req, res);
});

// 登录页（任何人可访问，没拦截）
app.get('/login', function (_req, res) {
  res.sendFile(require('path').join(__dirname, 'login.html'));
});

// 拦截浏览器对主页的访问：未登录就跳到 /login
// 注意只拦 GET 的 / 和 /index.html，其他 API/WS/静态资源都不动
app.get(['/', '/index.html'], function (req, res, next) {
  if (isAuthed(req)) return next();
  res.redirect(302, '/login');
});

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

// 在已就绪的 ssh2 Client 上跑一条 shell 命令，收集 stdout / stderr / exit code
function runRemoteCommand(sshClient, cmd, callback) {
  let done = false;
  function finish(err, result) {
    if (done) return;
    done = true;
    callback(err || null, result);
  }
  try {
    sshClient.exec(cmd, function (err, stream) {
      if (err) { finish(err); return; }
      let stdout = '';
      let stderr = '';
      stream.on('data', function (data) { stdout += data.toString('utf8'); });
      stream.stderr.on('data', function (data) { stderr += data.toString('utf8'); });
      stream.on('close', function (code, signal) {
        finish(null, { code: typeof code === 'number' ? code : -1, signal: signal || null, stdout: stdout, stderr: stderr });
      });
      stream.on('error', function (e) { finish(e); });
    });
  } catch (e) {
    finish(e);
  }
}

wss.on('connection', function (ws) {
  const ssh = new Client();
  let stream = null;
  let sftp = null;
  let sshReady = false;
  let lifetimeTimer = null; // 连接时长上限：到期后服务端主动断开
  let connectionHours = 0;

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
    // 连接时长上限：到期后由服务端主动断开，前端会清掉密码强制重输
    if (connectionHours > 0) {
      const ms = Math.min(connectionHours * 3600 * 1000, 0x7fffffff);
      lifetimeTimer = setTimeout(function () {
        send('error', { message: '连接时长已达 ' + connectionHours + ' 小时，已自动断开，请重新输入密码登录', code: 'lifetime_expired' });
        try { ssh.end(); } catch (_e) {}
        try { ws.close(); } catch (_e) {}
      }, ms);
    }
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
      ws.on('close', function () {
        clearInterval(backpressureTimer);
        if (lifetimeTimer) { clearTimeout(lifetimeTimer); lifetimeTimer = null; }
      });

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
      // 连接时长（小时）：0 = 不限制；上限 720h（30 天）
      let h = Number(payload.connectionHours);
      if (!Number.isFinite(h) || h < 0) h = 0;
      if (h > 720) h = 720;
      connectionHours = h;

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

    // 8081src 覆盖更新：上传 tar.gz → 备份 → 解压 → 失败回滚
    if (msg.type === 'update:apply') {
      const reqId = payload.requestId;
      const TARGET_DIR = '/dcim/admin/localhost_8081/wwwroot/src';
      const TARGET_PARENT = '/dcim/admin/localhost_8081/wwwroot';
      const MAX_BYTES = 200 * 1024 * 1024;

      const progress = function (line, status) {
        send('update:progress', { requestId: reqId, line: String(line || ''), status: status || null });
      };
      const fail = function (message) {
        send('update:error', { requestId: reqId, message: String(message || '未知错误') });
      };

      if (!sshReady) { fail('SSH 尚未就绪，请先连接服务器'); return; }

      const fileName = String(payload.fileName || '').trim();
      const lower = fileName.toLowerCase();
      if (!fileName) { fail('缺少文件名'); return; }
      if (!(lower.endsWith('.tar.gz') || lower.endsWith('.tgz'))) {
        fail('仅支持 .tar.gz / .tgz 包');
        return;
      }

      let buffer;
      try { buffer = dataUrlToBuffer(payload.content || ''); }
      catch (e) { fail('解析上传内容失败：' + e.message); return; }
      if (!buffer || !buffer.length) { fail('上传内容为空'); return; }
      if (buffer.length > MAX_BYTES) { fail('包大小超过 200MB 上限（实际 ' + buffer.length + ' 字节）'); return; }

      // 时间戳：YYYYMMDDHHMMSS（仅数字，无注入面）
      const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
      const remoteTmp = '/tmp/webssh-update-' + ts + '.tar.gz';
      const backupDir = TARGET_DIR + '.bak-' + ts;

      ensureSftp(function (err, sftpClient) {
        if (err) { fail('打开 SFTP 失败：' + err.message); return; }

        progress('上传中：' + fileName + ' → ' + remoteTmp + '（' + buffer.length + ' 字节）', '上传中');
        uploadBuffer(sftpClient, remoteTmp, buffer, function (writeErr) {
          if (writeErr) { fail('上传失败：' + writeErr.message); return; }
          progress('上传完成，开始备份并解压…', '解压中');

          // 备份 + 解压 + 清理临时包；任何一步失败都触发回滚
          // 注意：脚本内的所有路径都是常量或仅含数字的时间戳，不接收用户可控字符
          const applyScript = [
            'set -e',
            "mkdir -p '" + TARGET_PARENT + "'",
            "if [ -e '" + TARGET_DIR + "' ]; then mv '" + TARGET_DIR + "' '" + backupDir + "'; fi",
            "mkdir -p '" + TARGET_DIR + "'",
            "tar -xzf '" + remoteTmp + "' -C '" + TARGET_DIR + "'",
            "rm -f '" + remoteTmp + "'",
            'echo OK',
          ].join(' && ');

          runRemoteCommand(ssh, "sh -lc '" + applyScript.replace(/'/g, "'\\''") + "'", function (cmdErr, result) {
            if (cmdErr) { fail('执行远端命令失败：' + cmdErr.message); return; }

            if (result.stdout) progress('stdout:\n' + result.stdout.trim());
            if (result.stderr) progress('stderr:\n' + result.stderr.trim());

            if (result.code !== 0) {
              // 解压失败：自动回滚（删掉半成品 src，恢复 backupDir）
              progress('解压失败（exit=' + result.code + '），开始回滚…', '回滚中');
              const rollbackScript = [
                'set -e',
                "rm -rf '" + TARGET_DIR + "'",
                "if [ -e '" + backupDir + "' ]; then mv '" + backupDir + "' '" + TARGET_DIR + "'; fi",
                "rm -f '" + remoteTmp + "'",
                'echo ROLLBACK_OK',
              ].join(' && ');
              runRemoteCommand(ssh, "sh -lc '" + rollbackScript.replace(/'/g, "'\\''") + "'", function (rbErr, rbResult) {
                if (rbErr) {
                  fail('解压失败且回滚异常：' + rbErr.message + '；请手动检查 ' + backupDir);
                  return;
                }
                if (rbResult && rbResult.stdout) progress('rollback stdout:\n' + rbResult.stdout.trim());
                if (rbResult && rbResult.stderr) progress('rollback stderr:\n' + rbResult.stderr.trim());
                fail('解压失败（exit=' + result.code + '），已尝试回滚到备份 ' + backupDir);
              });
              return;
            }

            send('update:result', {
              requestId: reqId,
              targetDir: TARGET_DIR,
              backupDir: backupDir,
              fileName: fileName,
              size: buffer.length,
            });
          });
        });
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
    // 重启 docker 必断 mysql 容器，先通知 sms-db 关池暂停重试，
    // exit 后再启动重试，让 UI 立刻能反映"已断开"，避免 polling 撞运气自愈期间状态错位。
    if (typeof global.__smsDbPrepareForRestart === 'function') {
      try { global.__smsDbPrepareForRestart('docker-restart:' + trigger); } catch (_e) {}
    }
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
        if (typeof global.__smsDbRecover === 'function') {
          try { global.__smsDbRecover('docker-restart:' + trigger + ':exit=' + code); } catch (_e) {}
        }
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
        // spawn 失败也走恢复钩子，让 sms-db 至少把池重新拉起来（mysql 可能并未真的重启）
        if (typeof global.__smsDbRecover === 'function') {
          try { global.__smsDbRecover('docker-restart:' + trigger + ':spawn-error'); } catch (_e) {}
        }
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
      autoRetrying: !!autoRetryTimer,
      autoRetryCount,
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

  // autoStart 后台重试：开机时 mysql 容器可能还没起来，
  // 一次连接失败不放弃，每 5s 复试一次，连上就停。
  // 手动 connect 成功 / disconnect 时也会停。
  const AUTO_RETRY_MS = 5000;
  let autoRetryTimer = null;
  let autoRetryCount = 0;
  function stopAutoRetry(reason) {
    if (autoRetryTimer) {
      clearInterval(autoRetryTimer);
      autoRetryTimer = null;
      if (autoRetryCount > 0) {
        appendLog(`后台重试停止（${reason || '-'}），共试 ${autoRetryCount} 次`);
      }
      autoRetryCount = 0;
    }
  }
  function startAutoRetry() {
    if (autoRetryTimer) return;
    autoRetryCount = 0;
    appendLog(`启用 autoStart 后台重试，每 ${AUTO_RETRY_MS / 1000}s 试一次`);
    autoRetryTimer = setInterval(async function () {
      // 退出条件：autoStart 已关 / 已经连上 / 配置不完整
      if (!cfg.autoStart) { stopAutoRetry('autoStart 已关'); return; }
      if (connected) { stopAutoRetry('已连接'); return; }
      if (!cfg.host || !cfg.user) { stopAutoRetry('配置不完整'); return; }
      autoRetryCount += 1;
      try {
        await openPool(cfg);
        appendLog(`重试第 ${autoRetryCount} 次连接成功：${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database || '-'}`);
        stopAutoRetry('连接成功');
      } catch (err) {
        lastError = err.message;
        // 默认不刷日志（避免每 5s 一行），每 12 次（约 1 分钟）写一次
        if (autoRetryCount === 1 || autoRetryCount % 12 === 0) {
          appendLog(`重试第 ${autoRetryCount} 次仍失败：${err.message}`);
        }
      }
    }, AUTO_RETRY_MS);
  }

  async function tryAutoStart() {
    if (!cfg.autoStart) { appendLog('未开启 autoStart，跳过自启'); return; }
    if (!cfg.host || !cfg.user) { appendLog('配置不完整，跳过自启'); return; }
    try {
      await openPool(cfg);
      appendLog(`自启成功：${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database || '-'}`);
    } catch (err) {
      lastError = err.message;
      appendLog(`自启失败：${err.message}（启用后台重试）`);
      startAutoRetry();
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
    // rememberPassword 默认 true（兼容老前端不传该字段）
    const rememberPassword = body.rememberPassword === undefined ? true : !!body.rememberPassword;
    if (!user) return res.status(400).json({ ok: false, message: '用户名不能为空' });
    if (!mysql) return res.status(500).json({ ok: false, message: 'mysql2 驱动未安装' });
    lastAttempt = { host, port, user, database };
    try {
      await openPool({ host, port, user, password, database });
      if (rememberPassword) {
        // 落盘：密码 + autoStart=true，开机自启
        cfg = Object.assign({}, cfg, { host, port, user, password, database, autoStart: true });
        writeCfg();
        appendLog(`手动连接成功（已记住密码）：${user}@${host}:${port}/${database || '-'}`);
      } else {
        // 不落盘：内存里保留连接参数（推送/查询会用到 host/user/database），但不写文件，
        // 同时显式清空磁盘上的旧密码并关闭 autoStart，防止重启后用旧密码自动连接
        cfg = Object.assign({}, cfg, { host, port, user, database, password: '', autoStart: false });
        writeCfg();
        // 但内存里要保留刚刚用过的密码，否则后台重试 / 推送复用池时拿不到密码
        cfg.password = password;
        appendLog(`手动连接成功（未记住密码，仅本会话有效）：${user}@${host}:${port}/${database || '-'}`);
      }
      stopAutoRetry('手动连接成功');
      res.json({ ok: true, status: publicStatus() });
    } catch (err) {
      lastError = err.message;
      appendLog(`手动连接失败：${err.message}（尝试 ${user}@${host}:${port}/${database || '-'}）`);
      res.status(500).json({ ok: false, message: err.message, status: publicStatus() });
    }
  });

  app.post('/api/sms/db/disconnect', async function (_req, res) {
    stopAutoRetry('手动断开');
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

  // 运行期"连接坏了"的统一入口：监测模块、推送模块拿池查询时遇到网络级错误调用它。
  // 行为：关掉旧池 → 标记 lastError → 如果 autoStart 仍开着就启动后台重试。
  // 节流：1 秒内多个并发查询都报错时，只触发一次 close + retry，避免日志刷屏。
  let _lastBrokenAt = 0;
  global.__smsDbMarkBroken = function (reason) {
    const now = Date.now();
    if (now - _lastBrokenAt < 1000) return;
    _lastBrokenAt = now;
    if (!pool && !connected) {
      // 已经断了的状态，别重复 close，但要确保重试在跑
      if (cfg.autoStart && cfg.host && cfg.user) startAutoRetry();
      return;
    }
    appendLog(`运行期检测到连接异常：${reason || '-'}（关池并启用后台重试）`);
    closePool('runtime-broken: ' + (reason || '')).then(function () {
      lastError = String(reason || 'connection-broken');
      if (cfg.autoStart && cfg.host && cfg.user) startAutoRetry();
    }).catch(function () { /* close 不会抛 */ });
  };

  // docker 重启钩子：重启前主动关池 + 暂停重试，重启后启动重试。
  // 这两步不依赖 autoStart——业务有明确语义：重启 docker 必断 mysql。
  global.__smsDbPrepareForRestart = function (reason) {
    appendLog(`收到重启前钩子：${reason || '-'}（关池并暂停重试）`);
    stopAutoRetry('docker-restart-before');
    return closePool('docker-restart-before').catch(function () {});
  };
  global.__smsDbRecover = function (reason) {
    appendLog(`收到重启后钩子：${reason || '-'}（启动后台重试）`);
    if (!cfg.autoStart) {
      appendLog('autoStart 未开启，重启后跳过自动重连');
      return;
    }
    if (!cfg.host || !cfg.user) {
      appendLog('配置不完整，重启后跳过自动重连');
      return;
    }
    startAutoRetry();
  };
})();

// ===== 双机热备：SSH 长连接 + DB 池 + 3s 心跳 + WebSocket /ws/ha =====
(function setupHa() {
  const path = require('path');
  let mysql;
  try { mysql = require('mysql2/promise'); } catch (_e) { mysql = null; }

  const CONFIG_PATH = process.env.HA_CONFIG || path.join(__dirname, 'config', 'ha.json');
  const LOG_PATH = process.env.HA_LOG || path.join(__dirname, 'logs', 'ha.log');

  const defaults = {
    enabled: false,
    selfRole: 'primary', // primary | standby
    primary: {
      ssh: { host: '192.168.0.22', port: 22, user: 'root', password: '' },
      db:  { host: '192.168.0.22', port: 3306, database: '', user: '', password: '' },
    },
    standby: {
      ssh: { host: '192.168.0.50', port: 22, user: 'root', password: '' },
      db:  { host: '192.168.0.50', port: 3306, database: '', user: '', password: '' },
    },
    // 定时同步：仅 primary 角色 + 主备总开关启用时才会真的跑
    syncSchedule: {
      enabled: false,
      preset: 'daily-3am',                // daily-2am | daily-3am | weekly-sun-3am | custom
      cron: '0 3 * * *',                  // preset=custom 时使用
      skipIfPeerDown: true,                // 备机不可达时跳过本次
      applyStatusMinusOne: true,           // 同步后做 status=-1 假删除（与手动同步一致）
      lastRunAt: '',                       // 上次执行时间
      lastRunResult: '',                   // success | fail | skipped-peer-down | skipped-mutex
      lastRunError: '',
    },
    // 故障接管：仅 standby 角色 + 主备总开关启用时才会真的跑
    failover: {
      enabled: false,                      // 缓冲监测是否启用
      bufferSec: 30,                       // 缓冲时长（秒）
      bufferPreset: '30',                  // 10 | 30 | 60 | 120 | custom
      judgeMode: 'any',                    // any（任一端口不通就算）| both | ip-only
      consecutiveFails: 2,                 // 连续 N 次心跳失败才确认失联
      // 自动让位（已接管态下检测到主机回归 → 自动 reset 让业务回主机）
      autoYieldOnPeerRecover: true,        // 是否启用自动让位
      autoYieldConsecutive: 5,             // 接管态下连续 N 次心跳全通才触发自动让位（默认 5×3s=15s）
      cooldownSec: 60,                     // reset 后的冷却时长（秒）：期间不触发新一轮接管/让位，防震荡
      // 运行期状态
      takenOver: false,                    // 是否已接管（接管后置 true，运维重置才回 false）
      takenOverAt: '',                     // 接管成功时刻
      takenOverError: '',                  // 接管失败原因（最近一次）
      lastFailCount: 0,                    // 当前连续失败次数（监测中实时更新）
    },
    // 主机让位状态：仅 primary 角色被动维护，发现备机已接管时自动停 dcim
    yielded: {
      yieldedToStandby: false,             // 当前是否已让位给备机
      yieldedAt: '',
    },
  };

  function deepMerge(target, src) {
    const out = Object.assign({}, target);
    for (const k of Object.keys(src || {})) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
        out[k] = deepMerge(target[k] || {}, src[k]);
      } else {
        out[k] = src[k];
      }
    }
    return out;
  }

  let cfg = JSON.parse(JSON.stringify(defaults));

  // 状态机
  let pool = null;
  let dbConnected = false;
  let dbLastError = '';
  let dbLastConnectedAt = '';
  let dbAutoRetryTimer = null;
  let dbAutoRetryCount = 0;

  let sshClient = null;          // ssh2 Client 单例
  let sshStatus = 'idle';        // idle | connecting | connected | broken
  let sshLastError = '';
  let sshReconnectTimer = null;
  let sshReconnectDelay = 1000;  // 初始 1s，封顶 5s

  let heartbeatTimer = null;
  let heartbeatProbing = false;
  let lastHeartbeat = { ipOk: false, dbPortOk: false, ts: 0 };
  let lastBroadcastIpOk = null;
  let lastBroadcastDbOk = null;

  // ---------- 数据库同步任务状态 ----------
  // 仅当 selfRole=primary 时允许触发；任何时刻只允许 1 个同步任务在跑
  let syncRunning = false;
  let syncStep = '';            // 当前阶段，便于前端展示进度
  let syncStartedAt = '';
  let syncFinishedAt = '';
  let syncLastResult = '';      // success | fail | ''
  let syncLastError = '';
  const syncSteps = [];         // 本轮所有阶段记录，最多 50 条

  // 最近事件环形队列（用于新连入 ws 一次性下发 snapshot）
  const RECENT_EVENTS_MAX = 200;
  const recentEvents = [];

  // ---------- 工具函数 ----------
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
      cfg = deepMerge(defaults, parsed);
    } catch (_e) {
      cfg = JSON.parse(JSON.stringify(defaults));
    }
  }

  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_e) {}
    } catch (err) {
      console.error('[ha] 写配置失败:', err.message);
    }
  }

  // 隐藏密码用于响应
  function redactCfg(c) {
    const cp = JSON.parse(JSON.stringify(c));
    ['primary', 'standby'].forEach(function (k) {
      if (cp[k]) {
        if (cp[k].ssh) cp[k].ssh.password = cp[k].ssh.password ? '***' : '';
        if (cp[k].db)  cp[k].db.password  = cp[k].db.password  ? '***' : '';
      }
    });
    return cp;
  }

  // 计算"对端"配置：selfRole=primary 时对端是 standby，反之亦然
  function peerOf(cfgIn) {
    const c = cfgIn || cfg;
    return c.selfRole === 'primary' ? c.standby : c.primary;
  }

  function selfOf(cfgIn) {
    const c = cfgIn || cfg;
    return c.selfRole === 'primary' ? c.primary : c.standby;
  }

  // 推送给所有 /ws/ha 客户端
  function broadcast(obj) {
    let payload;
    try { payload = JSON.stringify(obj); } catch (_e) { return; }
    wssHa.clients.forEach(function (ws) {
      if (ws.readyState === 1) {
        try { ws.send(payload); } catch (_e) {}
      }
    });
  }

  function pushEvent(level, msg) {
    const ev = { level, msg, ts: localStamp() };
    recentEvents.push(ev);
    while (recentEvents.length > RECENT_EVENTS_MAX) recentEvents.shift();
    appendLog(`[${level}] ${msg}`);
    broadcast({ type: 'event', data: ev });
  }

  function publicStatus() {
    const peer = peerOf(cfg);
    return {
      enabled: !!cfg.enabled,
      selfRole: cfg.selfRole,
      peer: {
        sshHost: peer.ssh.host, sshPort: peer.ssh.port,
        dbHost:  peer.db.host,  dbPort:  peer.db.port,
        dbDatabase: peer.db.database, dbUser: peer.db.user,
      },
      ssh: { status: sshStatus, lastError: sshLastError },
      db:  {
        connected: dbConnected, lastError: dbLastError, lastConnectedAt: dbLastConnectedAt,
        autoRetrying: !!dbAutoRetryTimer, autoRetryCount: dbAutoRetryCount,
        driverReady: !!mysql,
      },
      heartbeat: lastHeartbeat,
      recentEvents: recentEvents.slice(-50),
      sync: {
        running: syncRunning,
        step: syncStep,
        startedAt: syncStartedAt,
        finishedAt: syncFinishedAt,
        lastResult: syncLastResult,
        lastError: syncLastError,
        steps: syncSteps.slice(-30),
        allowed: cfg.selfRole === 'primary',  // 仅主机可触发
        schedule: {
          enabled: !!(cfg.syncSchedule && cfg.syncSchedule.enabled),
          preset: (cfg.syncSchedule && cfg.syncSchedule.preset) || 'daily-3am',
          cron: effectiveCron(),
          customCron: (cfg.syncSchedule && cfg.syncSchedule.cron) || '0 3 * * *',
          skipIfPeerDown: cfg.syncSchedule ? !!cfg.syncSchedule.skipIfPeerDown : true,
          applyStatusMinusOne: cfg.syncSchedule ? !!cfg.syncSchedule.applyStatusMinusOne : true,
          lastRunAt: (cfg.syncSchedule && cfg.syncSchedule.lastRunAt) || '',
          lastRunResult: (cfg.syncSchedule && cfg.syncSchedule.lastRunResult) || '',
          lastRunError: (cfg.syncSchedule && cfg.syncSchedule.lastRunError) || '',
          nextRunAt: getNextRunAt(),
          running: !!scheduleTimer,
        },
      },
      failover: {
        enabled: !!(cfg.failover && cfg.failover.enabled),
        bufferSec: (cfg.failover && cfg.failover.bufferSec) || 30,
        bufferPreset: (cfg.failover && cfg.failover.bufferPreset) || '30',
        judgeMode: (cfg.failover && cfg.failover.judgeMode) || 'any',
        consecutiveFails: (cfg.failover && cfg.failover.consecutiveFails) || 2,
        autoYieldOnPeerRecover: cfg.failover ? !!cfg.failover.autoYieldOnPeerRecover : true,
        autoYieldConsecutive: (cfg.failover && cfg.failover.autoYieldConsecutive) || 5,
        cooldownSec: (cfg.failover && cfg.failover.cooldownSec != null) ? cfg.failover.cooldownSec : 60,
        cooldownRemainingSec: typeof failoverCooldownUntil !== 'undefined' && failoverCooldownUntil > Date.now()
          ? Math.ceil((failoverCooldownUntil - Date.now()) / 1000) : 0,
        takenOver: !!(cfg.failover && cfg.failover.takenOver),
        takenOverAt: (cfg.failover && cfg.failover.takenOverAt) || '',
        takenOverError: (cfg.failover && cfg.failover.takenOverError) || '',
        state: typeof failoverState !== 'undefined' ? failoverState : 'idle',
        failCount: typeof failoverFailCount !== 'undefined' ? failoverFailCount : 0,
        countdownSec: typeof failoverCountdownSec !== 'undefined' ? failoverCountdownSec : 0,
        running: typeof failoverCheckTimer !== 'undefined' && !!failoverCheckTimer,
        allowed: cfg.selfRole === 'standby' && cfg.enabled,
      },
      yielded: {
        yieldedToStandby: !!(cfg.yielded && cfg.yielded.yieldedToStandby),
        yieldedAt: (cfg.yielded && cfg.yielded.yieldedAt) || '',
        watchRunning: typeof peerWatchTimer !== 'undefined' && !!peerWatchTimer,
      },
    };
  }

  // ---------- cron 工具：匹配 + 计算下次触发时间 ----------
  // 仅支持 5 字段（分 时 日 月 周），每个字段支持 * / */N / a-b / 1,2,3 / 纯数字
  // 不支持 @reboot / @daily / L / W / # 等扩展语法（够用即可，不引入 cron-parser 依赖）
  const PRESET_TO_CRON = {
    'daily-2am': '0 2 * * *',
    'daily-3am': '0 3 * * *',
    'weekly-sun-3am': '0 3 * * 0',
  };

  function matchCronField(field, val, min, max) {
    if (field === '*') return true;
    if (field.includes(',')) {
      return field.split(',').some(function (p) { return matchCronField(p, val, min, max); });
    }
    const stepM = field.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (stepM) {
      const range = stepM[1], step = Number(stepM[2]);
      let lo = min, hi = max;
      if (range !== '*') {
        const rm = range.match(/^(\d+)(?:-(\d+))?$/);
        if (!rm) return false;
        lo = Number(rm[1]); hi = rm[2] ? Number(rm[2]) : max;
      }
      if (val < lo || val > hi) return false;
      return ((val - lo) % step) === 0;
    }
    const rangeM = field.match(/^(\d+)-(\d+)$/);
    if (rangeM) {
      const a = Number(rangeM[1]), b = Number(rangeM[2]);
      return val >= a && val <= b;
    }
    if (/^\d+$/.test(field)) return Number(field) === val;
    return false;
  }

  function cronMatch(expr, date) {
    const fields = String(expr || '').trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const checks = [
      [fields[0], date.getMinutes(),    0, 59],
      [fields[1], date.getHours(),      0, 23],
      [fields[2], date.getDate(),       1, 31],
      [fields[3], date.getMonth() + 1,  1, 12],
      [fields[4], date.getDay(),        0,  6],
    ];
    for (const [f, v, mn, mx] of checks) {
      if (!matchCronField(f, v, mn, mx)) return false;
    }
    return true;
  }

  // 从 from 时间点向后扫描，找下一次 cron 命中的「整分钟」时刻
  // 最多扫 7 天（10080 次循环），找不到返回 null
  function cronNext(expr, from) {
    if (!cronValid(expr)) return null;
    const t = new Date(from || Date.now());
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1); // 从下一分钟开始（本分钟可能已经触发过）
    for (let i = 0; i < 10080; i++) {
      if (cronMatch(expr, t)) return new Date(t);
      t.setMinutes(t.getMinutes() + 1);
    }
    return null;
  }

  function cronValid(expr) {
    const fields = String(expr || '').trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
    // 用一个不可能的 date 做语法检查（任意时间走一遍 matchField，看是否抛错）
    const sampleDate = new Date(2000, 0, 1, 0, 0, 0);
    const sampleVals = [0, 0, 1, 1, 6];
    try {
      for (let i = 0; i < 5; i++) {
        // matchCronField 不会抛错，但能识别非法语法返回 false
        // 我们只校验：字段非空 + 不含异常字符
        if (!/^[\d*\/,\-]+$/.test(fields[i])) return false;
      }
      return true;
    } catch (_e) { return false; }
  }

  function presetToCron(preset, customCron) {
    if (preset === 'custom') return customCron;
    return PRESET_TO_CRON[preset] || PRESET_TO_CRON['daily-3am'];
  }

  // ---------- 定时同步：调度器状态 ----------
  let scheduleTimer = null;
  let scheduleLastTriggerMinute = ''; // YYYY-MM-DDTHH:MM，避免 30s 双 tick 重复触发

  function effectiveCron() {
    const sch = cfg.syncSchedule || {};
    return presetToCron(sch.preset, sch.cron);
  }

  function getNextRunAt() {
    const sch = cfg.syncSchedule || {};
    if (!sch.enabled) return '';
    const expr = effectiveCron();
    if (!cronValid(expr)) return '';
    const next = cronNext(expr, new Date());
    return next ? localStamp(next) : '';
  }

  function startScheduleTimer() {
    if (scheduleTimer) return;
    appendLog('启动定时同步调度器（30s 一 tick）');
    scheduleTimer = setInterval(scheduleTick, 30000);
    // 启动时立刻 tick 一次（覆盖刚好整分钟启动的情况）
    setTimeout(scheduleTick, 1000);
  }
  function stopScheduleTimer(reason) {
    if (scheduleTimer) {
      clearInterval(scheduleTimer);
      scheduleTimer = null;
      appendLog(`停止定时同步调度器（${reason || '-'}）`);
    }
    scheduleLastTriggerMinute = '';
  }

  async function scheduleTick() {
    try {
      const sch = cfg.syncSchedule || {};
      if (!cfg.enabled) return;            // 主备总开关未启用
      if (!sch.enabled) return;            // 定时同步未启用
      if (cfg.selfRole !== 'primary') return; // 仅主机调度

      const now = new Date();
      const minuteKey = now.toISOString().slice(0, 16);
      if (minuteKey === scheduleLastTriggerMinute) return; // 这分钟已处理过

      const expr = effectiveCron();
      if (!cronMatch(expr, now)) return;

      scheduleLastTriggerMinute = minuteKey;

      // 跳过策略
      if (syncRunning) {
        sch.lastRunAt = localStamp();
        sch.lastRunResult = 'skipped-mutex';
        sch.lastRunError = '上次同步未结束';
        pushEvent('warn', '定时同步跳过：上次未结束');
        writeCfg();
        broadcastSnapshot();
        return;
      }
      if (sch.skipIfPeerDown && (!lastHeartbeat.ipOk || !lastHeartbeat.dbPortOk)) {
        sch.lastRunAt = localStamp();
        sch.lastRunResult = 'skipped-peer-down';
        sch.lastRunError = '对端不可达（IP 或 DB 端口）';
        pushEvent('warn', '定时同步跳过：对端不可达');
        writeCfg();
        broadcastSnapshot();
        return;
      }

      pushEvent('info', `定时同步触发（cron: ${expr}）`);
      try {
        await doSyncDb({ skipStatusUpdate: !sch.applyStatusMinusOne });
        sch.lastRunResult = 'success';
        sch.lastRunError = '';
      } catch (err) {
        sch.lastRunResult = 'fail';
        sch.lastRunError = err.message;
        // doSyncDb 内部已 pushEvent('error',...)，不重复推
      }
      sch.lastRunAt = localStamp();
      writeCfg();
      broadcastSnapshot();
    } catch (err) {
      appendLog(`scheduleTick 异常：${err.message}`);
    }
  }

  // ---------- 故障接管：状态机 + 监测循环（仅 standby）----------
  // 状态：idle / monitoring / counting-down / taking-over / taken-over / failed
  let failoverState = 'idle';
  let failoverFailCount = 0;
  let failoverCountdownSec = 0;          // 实时倒计时秒数
  let failoverCountdownTimer = null;     // 1s tick
  let failoverCheckTimer = null;         // 3s tick（与心跳同节奏）
  let failoverInProgress = false;        // 互斥锁：接管动作执行期间
  // 自动让位计数：接管态下连续 N 次心跳全通才触发
  let failoverPeerRecoverCount = 0;
  // 冷却时间戳：reset 完成后 60 秒内不再触发新一轮接管/让位，防震荡
  let failoverCooldownUntil = 0;

  function isPeerAlive() {
    const mode = (cfg.failover && cfg.failover.judgeMode) || 'any';
    const ipOk = !!lastHeartbeat.ipOk;
    const dbOk = !!lastHeartbeat.dbPortOk;
    if (mode === 'both') return ipOk && dbOk;        // 两个都通才算活
    if (mode === 'ip-only') return ipOk;             // 只看 IP
    return ipOk && dbOk;                             // any 模式：等价于"任一不通就算失联"
  }

  function isPeerAliveAny() {
    // judgeMode=any 的语义实现：任一通就视为活；只有都不通才视为失联
    const ipOk = !!lastHeartbeat.ipOk;
    const dbOk = !!lastHeartbeat.dbPortOk;
    return ipOk || dbOk;
  }

  function isPeerDownByMode() {
    const mode = (cfg.failover && cfg.failover.judgeMode) || 'any';
    const ipOk = !!lastHeartbeat.ipOk;
    const dbOk = !!lastHeartbeat.dbPortOk;
    if (mode === 'both') return !ipOk && !dbOk;       // 两个都不通才算失联
    if (mode === 'ip-only') return !ipOk;             // 只看 IP 不通
    return !ipOk || !dbOk;                            // any: 任一不通就算失联
  }

  function startFailoverCheckTimer() {
    if (failoverCheckTimer) return;
    appendLog('启动故障接管监测循环（3s 一 tick）');
    failoverCheckTimer = setInterval(failoverCheckTick, 3000);
    setTimeout(failoverCheckTick, 1500);
  }
  function stopFailoverCheckTimer(reason) {
    if (failoverCheckTimer) {
      clearInterval(failoverCheckTimer);
      failoverCheckTimer = null;
      appendLog(`停止故障接管监测循环（${reason || '-'}）`);
    }
    stopFailoverCountdown('check-timer-stopped');
    failoverFailCount = 0;
  }
  function startFailoverCountdown(initSec) {
    stopFailoverCountdown('restart');
    failoverCountdownSec = Number(initSec) || 30;
    failoverState = 'counting-down';
    pushEvent('warn', `主机失联，进入接管倒计时（${failoverCountdownSec}s）`);
    broadcastSnapshot();
    failoverCountdownTimer = setInterval(function () {
      failoverCountdownSec -= 1;
      if (failoverCountdownSec <= 0) {
        stopFailoverCountdown('zero');
        triggerFailover().catch(function () {});
      } else {
        // 每 5s 推一次进度，避免太密
        if (failoverCountdownSec % 5 === 0) broadcastSnapshot();
      }
    }, 1000);
  }
  function stopFailoverCountdown(reason) {
    if (failoverCountdownTimer) {
      clearInterval(failoverCountdownTimer);
      failoverCountdownTimer = null;
    }
    failoverCountdownSec = 0;
  }

  function failoverCheckTick() {
    try {
      const fo = cfg.failover || {};
      // 必备前提：本机为备机 + 总开关启用 + 缓冲启用
      if (!cfg.enabled || cfg.selfRole !== 'standby' || !fo.enabled) {
        if (failoverState !== 'idle' && failoverState !== 'taken-over') {
          failoverState = 'idle';
          stopFailoverCountdown('disabled');
          broadcastSnapshot();
        }
        return;
      }
      // 接管动作执行中：不并发
      if (failoverInProgress) return;

      // 已接管状态：检测主机端口恢复 → 自动让位
      // 关键时序：主机重启时 SSH 端口比业务 dcim 早 ~20s 上线
      //          只要备机感知到 SSH 或 DB 任一端口通就立即让位（先于主机的 dcim 自启）
      //          → 备机 stop dcim + status=-1 完成时主机的 dcim 还没起 → 0 撕裂
      if (failoverState === 'taken-over') {
        if (!fo.autoYieldOnPeerRecover) return; // 关掉了自动让位
        // SSH 或 DB 任一端口通就算"主机回归"
        const peerAlive = !!lastHeartbeat.ipOk || !!lastHeartbeat.dbPortOk;
        if (peerAlive) {
          failoverPeerRecoverCount += 1;
          const need = Math.max(1, Number(fo.autoYieldConsecutive) || 5);
          if (failoverPeerRecoverCount === 1 || failoverPeerRecoverCount === Math.floor(need / 2)) {
            pushEvent('info', `检测到主机端口恢复（${failoverPeerRecoverCount}/${need}），即将自动让位`);
            broadcastSnapshot();
          }
          if (failoverPeerRecoverCount >= need) {
            failoverPeerRecoverCount = 0;
            pushEvent('warn', '【自动让位】主机已回归，备机自动 UPDATE status=-1 + 停止 dcim 采集');
            doFailoverReset({ reason: 'auto-yield-on-peer-recover' }).catch(function (err) {
              pushEvent('error', '【自动让位】失败：' + err.message);
            });
          }
        } else {
          // 端口又不通了，重置计数
          if (failoverPeerRecoverCount > 0) {
            pushEvent('info', `主机端口又不通，自动让位计数已清零（之前 ${failoverPeerRecoverCount} 次）`);
            failoverPeerRecoverCount = 0;
          }
        }
        return;
      }

      // 冷却期：reset 完成后 60s 内不触发新一轮接管，防止主机恢复时震荡
      if (Date.now() < failoverCooldownUntil) return;

      const peerDown = isPeerDownByMode();
      const need = Math.max(1, Number(fo.consecutiveFails) || 2);

      if (peerDown) {
        failoverFailCount += 1;
        fo.lastFailCount = failoverFailCount;
        if (failoverState === 'monitoring' && failoverFailCount >= need) {
          // 达到连续失败次数 → 启动倒计时
          startFailoverCountdown(fo.bufferSec);
        }
      } else {
        // 主机恢复：失败计数清零；若在倒计时则重置
        if (failoverFailCount > 0) {
          pushEvent('info', `主机心跳恢复（之前累计失败 ${failoverFailCount} 次）`);
        }
        failoverFailCount = 0;
        fo.lastFailCount = 0;
        if (failoverState === 'counting-down') {
          stopFailoverCountdown('peer-recovered');
          failoverState = 'monitoring';
          pushEvent('info', '倒计时已重置');
          broadcastSnapshot();
        }
        if (failoverState === 'idle' && fo.enabled) {
          failoverState = 'monitoring';
        }
      }
    } catch (err) {
      appendLog(`failoverCheckTick 异常：${err.message}`);
    }
  }

  // ---------- 接管动作（doFailover）----------
  // 流程：dry-run 校验 → SSH 二次握手主机（脑裂防护）→ UPDATE status=1 → dcim restart
  async function triggerFailover() {
    if (failoverInProgress) return;
    if (failoverState === 'taken-over') return;
    failoverInProgress = true;
    failoverState = 'taking-over';
    broadcastSnapshot();

    const fo = cfg.failover;
    // 备机视角：自身是 standby，对端是 primary（也就是 cfg.primary）
    // 但接管要操作的是「本机」的 dcim 容器和 db
    const localDb = cfg.standby.db;       // 本机（备机）的 db
    const peerSshCfg = cfg.primary.ssh;   // 对端（主机）的 ssh，仅用于二次握手探测

    let localClient = null;
    try {
      pushEvent('error', '【接管】触发主机失联接管动作');

      // ---------- 1. 脑裂防护：再尝试 SSH 主机一次（深度探测）----------
      pushEvent('info', '【接管】1/5 尝试 SSH 握手主机（脑裂防护）');
      let primarySshAlive = false;
      try {
        const c = await Promise.race([
          newPeerSshClient(peerSshCfg),
          new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 8000); }),
        ]);
        primarySshAlive = true;
        try { c.end(); } catch (_e) {}
      } catch (_e) {
        primarySshAlive = false;
      }
      if (primarySshAlive) {
        // 主机其实活着 → 取消接管，回到监测态
        pushEvent('warn', '【接管】主机 SSH 握手成功，疑似网络分区，取消本次接管');
        failoverState = 'monitoring';
        failoverFailCount = 0;
        return;
      }
      pushEvent('info', '【接管】主机 SSH 握手仍失败，确认主机失联');

      // ---------- 2. 本地 SSH 连接（操作备机自己）----------
      // 备机是本机，理论上不需要 SSH 自己，但为了和接管脚本同构，统一走 ssh2 客户端
      // 用 cfg.standby.ssh 凭据连本机 127.0.0.1 也行，但更稳的是直接 spawn shell
      // 这里用一个简单的 spawn 来跑 docker exec
      pushEvent('info', '【接管】2/5 检查本机 dcim 容器');
      const psResult = await new Promise(function (resolve) {
        const proc = spawn('docker', ['ps', '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let so = '', se = '';
        proc.stdout.on('data', function (d) { so += d.toString('utf8'); });
        proc.stderr.on('data', function (d) { se += d.toString('utf8'); });
        proc.on('close', function (code) { resolve({ code, so, se }); });
        proc.on('error', function () { resolve({ code: -1, so: '', se: 'spawn-error' }); });
      });
      if (psResult.code !== 0 || !/(^|\n)dcim(\n|$)/.test(psResult.so)) {
        throw new Error('本机 dcim 容器未运行：' + (psResult.se || psResult.so).slice(0, 200));
      }

      // ---------- 3. 清空 dcim-alarmlist 表（接管前必做：避免备机基于陈旧告警重复推送/误处理） ----------
      pushEvent('info', '【接管】3/5 清空 dcim-alarmlist 表（DELETE）');
      const clearAlarmOut = await new Promise(function (resolve) {
        const args = [
          'exec', 'dcim', 'mysql',
          '-h', String(localDb.host || '127.0.0.1'),
          '-P', String(localDb.port || 3306),
          '-u', String(localDb.user || ''),
          '--password=' + String(localDb.password || ''),
          '-BN', '-e',
          'USE `' + localDb.database + '`; DELETE FROM `dcim-alarmlist`; SELECT ROW_COUNT() AS affected;',
        ];
        const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let so = '', se = '';
        proc.stdout.on('data', function (d) { so += d.toString('utf8'); });
        proc.stderr.on('data', function (d) { se += d.toString('utf8'); });
        proc.on('close', function (code) { resolve({ code, so, se }); });
        proc.on('error', function () { resolve({ code: -1, so: '', se: 'spawn-error' }); });
      });
      if (clearAlarmOut.code !== 0) {
        throw new Error('清空 dcim-alarmlist 失败 exit=' + clearAlarmOut.code + ': ' + (clearAlarmOut.se || clearAlarmOut.so).slice(0, 300));
      }
      const alarmAffected = (clearAlarmOut.so.trim().split('\n').filter(function (l) { return /^\d+$/.test(l.trim()); }).pop() || '0').trim();
      pushEvent('info', `【接管】dcim-alarmlist 已清空（affected=${alarmAffected}）`);

      // ---------- 4. UPDATE dcim-device.status=1 ----------
      pushEvent('info', '【接管】4/5 UPDATE dcim-device SET status=1');
      const updateOut = await new Promise(function (resolve) {
        const args = [
          'exec', 'dcim', 'mysql',
          '-h', String(localDb.host || '127.0.0.1'),
          '-P', String(localDb.port || 3306),
          '-u', String(localDb.user || ''),
          '--password=' + String(localDb.password || ''),
          '-BN', '-e',
          'USE `' + localDb.database + '`; UPDATE `dcim-device` SET status=1; SELECT ROW_COUNT() AS affected;',
        ];
        const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let so = '', se = '';
        proc.stdout.on('data', function (d) { so += d.toString('utf8'); });
        proc.stderr.on('data', function (d) { se += d.toString('utf8'); });
        proc.on('close', function (code) { resolve({ code, so, se }); });
        proc.on('error', function () { resolve({ code: -1, so: '', se: 'spawn-error' }); });
      });
      if (updateOut.code !== 0) {
        throw new Error('UPDATE 失败 exit=' + updateOut.code + ': ' + (updateOut.se || updateOut.so).slice(0, 300));
      }
      const affected = (updateOut.so.trim().split('\n').filter(function (l) { return /^\d+$/.test(l.trim()); }).pop() || '0').trim();
      pushEvent('info', `【接管】UPDATE 完成（affected=${affected}）`);

      // ---------- 5. 重启本机 dcim 采集 ----------
      pushEvent('info', '【接管】5/5 重启本机 dcim 采集（docker exec dcim systemctl restart dcim）');
      const restartOut = await new Promise(function (resolve) {
        const proc = spawn('docker', ['exec', 'dcim', 'systemctl', 'restart', 'dcim'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let so = '', se = '';
        proc.stdout.on('data', function (d) { so += d.toString('utf8'); });
        proc.stderr.on('data', function (d) { se += d.toString('utf8'); });
        proc.on('close', function (code) { resolve({ code, so, se }); });
        proc.on('error', function () { resolve({ code: -1, so: '', se: 'spawn-error' }); });
      });
      if (restartOut.code !== 0) {
        throw new Error('重启 dcim 失败 exit=' + restartOut.code + ': ' + (restartOut.se || restartOut.so).slice(0, 300));
      }

      // ---------- 5. 标记已接管 ----------
      fo.takenOver = true;
      fo.takenOverAt = localStamp();
      fo.takenOverError = '';
      failoverState = 'taken-over';
      writeCfg();
      pushEvent('error', `【接管】完成：备机已接管业务，请确认主机状态后点「重置接管状态」恢复`);
    } catch (err) {
      fo.takenOver = false;
      fo.takenOverError = err.message;
      failoverState = 'failed';
      writeCfg();
      pushEvent('error', '【接管】失败：' + err.message);
    } finally {
      if (localClient) { try { localClient.end(); } catch (_e) {} }
      failoverInProgress = false;
      broadcastSnapshot();
    }
  }

  // ---------- 接管重置（doFailoverReset）----------
  // 流程：UPDATE status=-1 → 停 dcim → 标记 takenOver=false → 回到 monitoring
  async function doFailoverReset(opts) {
    opts = opts || {};
    const isAuto = opts.reason === 'auto-yield-on-peer-recover';
    const reasonTag = isAuto ? '自动让位' : '重置';
    if (failoverInProgress) throw new Error('接管动作执行中，无法重置');
    if (cfg.selfRole !== 'standby') throw new Error('仅备机可重置接管状态');
    const fo = cfg.failover || {};
    if (!fo.takenOver) throw new Error('当前未处于接管状态，无需重置');

    failoverInProgress = true;
    try {
      pushEvent('info', `【${reasonTag}】1/2 UPDATE dcim-device SET status=-1`);
      const localDb = cfg.standby.db;
      const updateOut = await new Promise(function (resolve) {
        const args = [
          'exec', 'dcim', 'mysql',
          '-h', String(localDb.host || '127.0.0.1'),
          '-P', String(localDb.port || 3306),
          '-u', String(localDb.user || ''),
          '--password=' + String(localDb.password || ''),
          '-BN', '-e',
          'USE `' + localDb.database + '`; UPDATE `dcim-device` SET status=-1; SELECT ROW_COUNT() AS affected;',
        ];
        const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let so = '', se = '';
        proc.stdout.on('data', function (d) { so += d.toString('utf8'); });
        proc.stderr.on('data', function (d) { se += d.toString('utf8'); });
        proc.on('close', function (code) { resolve({ code, so, se }); });
        proc.on('error', function () { resolve({ code: -1, so: '', se: 'spawn-error' }); });
      });
      if (updateOut.code !== 0) {
        throw new Error('UPDATE 失败 exit=' + updateOut.code + ': ' + (updateOut.se || updateOut.so).slice(0, 300));
      }
      const affected = (updateOut.so.trim().split('\n').filter(function (l) { return /^\d+$/.test(l.trim()); }).pop() || '0').trim();
      pushEvent('info', `【${reasonTag}】UPDATE 完成（affected=${affected}）`);

      pushEvent('info', `【${reasonTag}】2/2 停止本机 dcim 采集`);
      const stopOut = await new Promise(function (resolve) {
        const proc = spawn('docker', ['exec', 'dcim', 'systemctl', 'stop', 'dcim'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let so = '', se = '';
        proc.stdout.on('data', function (d) { so += d.toString('utf8'); });
        proc.stderr.on('data', function (d) { se += d.toString('utf8'); });
        proc.on('close', function (code) { resolve({ code, so, se }); });
        proc.on('error', function () { resolve({ code: -1, so: '', se: 'spawn-error' }); });
      });
      if (stopOut.code !== 0) {
        throw new Error('停止 dcim 失败 exit=' + stopOut.code + ': ' + (stopOut.se || stopOut.so).slice(0, 300));
      }

      fo.takenOver = false;
      fo.takenOverAt = '';
      fo.takenOverError = '';
      failoverState = (cfg.enabled && cfg.selfRole === 'standby' && fo.enabled) ? 'monitoring' : 'idle';
      failoverFailCount = 0;
      failoverPeerRecoverCount = 0;
      // 冷却期：reset 完成后 N 秒内不再触发新一轮接管，防止主机抖动导致震荡
      const cooldownSec = Math.max(0, Number(fo.cooldownSec) || 60);
      failoverCooldownUntil = Date.now() + cooldownSec * 1000;
      writeCfg();
      pushEvent('info', `【${reasonTag}】完成：备机已让位（status=-1 + dcim 已停），主机将在 5s 内自动接回业务（${cooldownSec}s 冷却中，期间不再触发接管）`);
    } finally {
      failoverInProgress = false;
      broadcastSnapshot();
    }
  }



  // ---------- TCP 端口探测（IP / DB 端口）----------
  function tcpProbe(host, port, timeoutMs) {
    return new Promise(function (resolve) {
      if (!host || !port) return resolve(false);
      const sock = new net.Socket();
      let done = false;
      const finish = function (ok) {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch (_e) {}
        resolve(!!ok);
      };
      sock.setTimeout(timeoutMs || 1500);
      sock.once('connect', function () { finish(true); });
      sock.once('timeout', function () { finish(false); });
      sock.once('error',   function () { finish(false); });
      try { sock.connect(Number(port), String(host)); }
      catch (_e) { finish(false); }
    });
  }

  // ---------- DB 池：完整复刻 sms 子站的 openPool / closePool / startAutoRetry ----------
  const DB_AUTO_RETRY_MS = 5000;

  async function closeDbPool(reason) {
    if (pool) {
      const old = pool;
      pool = null;
      dbConnected = false;
      try { await old.end(); } catch (_e) {}
      appendLog(`DB 池关闭：${reason || ''}`.trim());
    } else {
      dbConnected = false;
    }
  }

  async function openDbPool(opts) {
    if (!mysql) throw new Error('mysql2 驱动未安装');
    await closeDbPool('reconnect');
    const p = mysql.createPool({
      host: opts.host,
      port: Number(opts.port) || 3306,
      user: opts.user,
      password: opts.password,
      database: opts.database || undefined,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 8000,
    });
    const conn = await p.getConnection();
    try { await conn.ping(); } finally { conn.release(); }
    pool = p;
    dbConnected = true;
    dbLastError = '';
    dbLastConnectedAt = localStamp();
    return p;
  }

  function stopDbAutoRetry(reason) {
    if (dbAutoRetryTimer) {
      clearTimeout(dbAutoRetryTimer);
      dbAutoRetryTimer = null;
      if (dbAutoRetryCount > 0) {
        appendLog(`DB 后台重试停止（${reason || '-'}），共试 ${dbAutoRetryCount} 次`);
      }
      dbAutoRetryCount = 0;
    }
  }
  // 渐进退避：5s × 3 → 15s × 5 → 60s 封顶；
  // 命中 MySQL Host blocked / Access denied 等\"硬错误\"直接跳到 60s，
  // 避免再次踩 max_connect_errors=100 阈值
  function pickDbRetryDelayMs(count, lastErrMsg) {
    const errs = String(lastErrMsg || '').toLowerCase();
    if (errs.includes('blocked because of many connection errors') || errs.includes('access denied')) return 60000;
    if (count < 3)  return 5000;
    if (count < 8)  return 15000;
    return 60000;
  }
  function startDbAutoRetry() {
    if (dbAutoRetryTimer) return;
    dbAutoRetryCount = 0;
    appendLog('启用 DB 后台重试（渐进退避：5s ×3 → 15s ×5 → 60s 封顶）');
    const tick = async function () {
      dbAutoRetryTimer = null;
      const peer = peerOf(cfg);
      if (!cfg.enabled) { stopDbAutoRetry('已关功能'); return; }
      if (dbConnected) { stopDbAutoRetry('已连接'); return; }
      if (!peer.db.host || !peer.db.user) { stopDbAutoRetry('配置不完整'); return; }
      dbAutoRetryCount += 1;
      try {
        await openDbPool(peer.db);
        appendLog(`DB 重试第 ${dbAutoRetryCount} 次成功：${peer.db.user}@${peer.db.host}:${peer.db.port}/${peer.db.database || '-'}`);
        pushEvent('info', `对端数据库已连通（${peer.db.host}:${peer.db.port}）`);
        stopDbAutoRetry('连接成功');
        return;
      } catch (err) {
        dbLastError = err.message;
        if (dbAutoRetryCount === 1 || dbAutoRetryCount % 6 === 0) {
          appendLog(`DB 重试第 ${dbAutoRetryCount} 次仍失败：${err.message}`);
        }
      }
      const next = pickDbRetryDelayMs(dbAutoRetryCount, dbLastError);
      dbAutoRetryTimer = setTimeout(tick, next);
    };
    dbAutoRetryTimer = setTimeout(tick, 5000);
  }

  async function tryStartDb() {
    if (!cfg.enabled) return;
    const peer = peerOf(cfg);
    if (!peer.db.host || !peer.db.user) {
      appendLog('DB 配置不完整，跳过自启');
      return;
    }
    try {
      await openDbPool(peer.db);
      appendLog(`DB 自启成功：${peer.db.user}@${peer.db.host}:${peer.db.port}/${peer.db.database || '-'}`);
      pushEvent('info', `对端数据库已连通（${peer.db.host}:${peer.db.port}）`);
    } catch (err) {
      dbLastError = err.message;
      appendLog(`DB 自启失败：${err.message}（启用后台重试）`);
      pushEvent('warn', `对端数据库连接失败：${err.message}`);
      startDbAutoRetry();
    }
  }

  // ---------- SSH 长连接：单例 + 断线重连 + ssh2 自带 keepalive ----------
  function clearSshReconnectTimer() {
    if (sshReconnectTimer) { clearTimeout(sshReconnectTimer); sshReconnectTimer = null; }
  }

  function closeSshClient(reason) {
    clearSshReconnectTimer();
    if (sshClient) {
      const old = sshClient;
      sshClient = null;
      try { old.removeAllListeners('error'); } catch (_e) {}
      try { old.removeAllListeners('close'); } catch (_e) {}
      try { old.end(); } catch (_e) {}
    }
    sshStatus = 'idle';
    if (reason) appendLog(`SSH 长连接关闭：${reason}`);
  }

  function scheduleSshReconnect(why) {
    if (!cfg.enabled) return;
    if (sshReconnectTimer) return;
    const delay = sshReconnectDelay;
    sshReconnectDelay = Math.min(5000, sshReconnectDelay + 1000);
    appendLog(`SSH 将在 ${delay}ms 后重连：${why || '-'}`);
    sshReconnectTimer = setTimeout(function () {
      sshReconnectTimer = null;
      connectSsh();
    }, delay);
  }

  function connectSsh() {
    if (!cfg.enabled) return;
    const peer = peerOf(cfg);
    if (!peer.ssh.host || !peer.ssh.user) {
      appendLog('SSH 配置不完整，跳过连接');
      return;
    }
    if (sshClient && (sshStatus === 'connected' || sshStatus === 'connecting')) return;

    sshStatus = 'connecting';
    sshLastError = '';
    appendLog(`SSH 开始连接：${peer.ssh.user}@${peer.ssh.host}:${peer.ssh.port}`);
    const c = new Client();
    sshClient = c;

    c.on('ready', function () {
      sshStatus = 'connected';
      sshReconnectDelay = 1000;
      pushEvent('info', `对端 SSH 已建立长连接（${peer.ssh.host}:${peer.ssh.port}）`);
      broadcastSnapshot();
    });
    c.on('error', function (err) {
      sshLastError = err && err.message || String(err);
      sshStatus = 'broken';
      pushEvent('error', `对端 SSH 出错：${sshLastError}`);
      try { c.end(); } catch (_e) {}
      if (sshClient === c) sshClient = null;
      scheduleSshReconnect(sshLastError);
      broadcastSnapshot();
    });
    c.on('close', function () {
      if (sshStatus === 'connected') {
        pushEvent('warn', '对端 SSH 长连接断开');
      }
      sshStatus = 'broken';
      if (sshClient === c) sshClient = null;
      scheduleSshReconnect('connection-closed');
      broadcastSnapshot();
    });

    try {
      c.connect({
        host: peer.ssh.host,
        port: Number(peer.ssh.port) || 22,
        username: peer.ssh.user,
        password: peer.ssh.password || '',
        readyTimeout: 8000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      });
    } catch (err) {
      sshLastError = err && err.message || String(err);
      sshStatus = 'broken';
      pushEvent('error', `对端 SSH 连接抛异常：${sshLastError}`);
      scheduleSshReconnect(sshLastError);
    }
  }

  function broadcastSnapshot() {
    broadcast({ type: 'snapshot', data: publicStatus() });
  }

  // ---------- 心跳：每 3 秒一轮，并发去重 ----------
  function startHeartbeat() {
    if (heartbeatTimer) return;
    appendLog('启动心跳调度（每 3s 一轮）');
    heartbeatTimer = setInterval(async function () {
      if (heartbeatProbing) return;
      if (!cfg.enabled) return;
      heartbeatProbing = true;
      try {
        const peer = peerOf(cfg);
        const [ipOk, dbPortOk] = await Promise.all([
          tcpProbe(peer.ssh.host, peer.ssh.port, 1500),
          tcpProbe(peer.db.host,  peer.db.port,  1500),
        ]);
        const ts = localStamp();
        lastHeartbeat = { ipOk, dbPortOk, ts };
        // 状态变化才推 event
        if (lastBroadcastIpOk !== ipOk) {
          if (lastBroadcastIpOk !== null) {
            pushEvent(ipOk ? 'info' : 'error',
              ipOk ? `对端 IP 已恢复（${peer.ssh.host}:${peer.ssh.port}）`
                   : `对端 IP 不通（${peer.ssh.host}:${peer.ssh.port}）`);
          }
          lastBroadcastIpOk = ipOk;
        }
        if (lastBroadcastDbOk !== dbPortOk) {
          if (lastBroadcastDbOk !== null) {
            pushEvent(dbPortOk ? 'info' : 'warn',
              dbPortOk ? `对端 DB 端口已恢复（${peer.db.host}:${peer.db.port}）`
                       : `对端 DB 端口不通（${peer.db.host}:${peer.db.port}）`);
          }
          lastBroadcastDbOk = dbPortOk;
        }
        // 每轮固定推 heartbeat（让前端可视化"后端还在跑"）
        broadcast({ type: 'heartbeat', data: lastHeartbeat });
      } catch (err) {
        appendLog(`心跳异常：${err.message}`);
      } finally {
        heartbeatProbing = false;
      }
    }, 3000);
  }
  function stopHeartbeat(reason) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      appendLog(`停止心跳调度（${reason || '-'}）`);
    }
    lastBroadcastIpOk = null;
    lastBroadcastDbOk = null;
  }

  // ---------- 总开关：enable / disable ----------
  async function applyEnabled() {
    if (cfg.enabled) {
      pushEvent('info', `双机热备已启用（角色：${cfg.selfRole === 'primary' ? '主机' : '备机'}）`);
      connectSsh();
      tryStartDb().catch(function () {});
      startHeartbeat();
      // 定时同步只在 primary 跑（备机不调度，避免双触发）
      if (cfg.selfRole === 'primary' && cfg.syncSchedule && cfg.syncSchedule.enabled) {
        startScheduleTimer();
      } else {
        stopScheduleTimer('non-primary or disabled');
      }
      // 故障接管监测仅在 standby 跑
      if (cfg.selfRole === 'standby' && cfg.failover && cfg.failover.enabled) {
        if (!cfg.failover.takenOver) {
          failoverState = 'monitoring';
          failoverFailCount = 0;
        } else {
          failoverState = 'taken-over';
        }
        startFailoverCheckTimer();
      } else {
        stopFailoverCheckTimer('non-standby or disabled');
        if (cfg.failover && !cfg.failover.takenOver) failoverState = 'idle';
      }
      // 主机被动监测备机接管状态（仅 primary）
      if (cfg.selfRole === 'primary') {
        startPeerWatchTimer();
      } else {
        stopPeerWatchTimer('non-primary');
      }
    } else {
      pushEvent('info', '双机热备已停用');
      stopHeartbeat('disabled');
      stopDbAutoRetry('disabled');
      await closeDbPool('disabled');
      closeSshClient('disabled');
      stopScheduleTimer('ha disabled');
      stopFailoverCheckTimer('ha disabled');
      stopPeerWatchTimer('ha disabled');
    }
    // enabled / selfRole 等顶层状态变了，主动推一次 snapshot，让所有 ws 客户端立刻刷新
    broadcastSnapshot();
  }

  // ---------- REST API ----------
  app.get('/api/ha/config', function (_req, res) {
    res.json({ ok: true, config: redactCfg(cfg) });
  });

  // PUT /api/ha/config
  // body 中：密码字段为 '***' 表示"保留原值"；空串表示"清空"；其他值表示"覆盖"
  app.put('/api/ha/config', async function (req, res) {
    const body = req.body || {};
    const next = {
      enabled: !!body.enabled,
      selfRole: body.selfRole === 'standby' ? 'standby' : 'primary',
      primary: { ssh: {}, db: {} },
      standby: { ssh: {}, db: {} },
    };
    function pickPair(side) {
      const incoming = body[side] || {};
      const oldSide  = cfg[side] || defaults[side];
      ['ssh', 'db'].forEach(function (kind) {
        const incomingKind = incoming[kind] || {};
        const oldKind      = oldSide[kind] || {};
        const merged = Object.assign({}, oldKind, {
          host: String(incomingKind.host == null ? oldKind.host : incomingKind.host).trim(),
          port: Number(incomingKind.port) || oldKind.port,
          user: String(incomingKind.user == null ? oldKind.user : incomingKind.user).trim(),
        });
        if (kind === 'db') {
          merged.database = String(incomingKind.database == null ? (oldKind.database || '') : incomingKind.database).trim();
        }
        // 密码：'***' 保留旧值，否则用新值
        if (incomingKind.password === undefined || incomingKind.password === '***') {
          merged.password = oldKind.password || '';
        } else {
          merged.password = String(incomingKind.password);
        }
        next[side][kind] = merged;
      });
    }
    pickPair('primary');
    pickPair('standby');

    // 保留原有的 syncSchedule（只有 PUT /api/ha/sync-schedule 可改它）
    next.syncSchedule = cfg.syncSchedule || JSON.parse(JSON.stringify(defaults.syncSchedule));
    // 保留原有的 failover（只有 PUT /api/ha/failover 可改它，takenOver 等运行期状态也保持）
    next.failover = cfg.failover || JSON.parse(JSON.stringify(defaults.failover));
    next.yielded = cfg.yielded || JSON.parse(JSON.stringify(defaults.yielded));

    cfg = next;
    writeCfg();
    pushEvent('info', '配置已更新，重置心跳与连接');

    // 重置：先全停，再按新配置启动
    stopHeartbeat('config-changed');
    stopDbAutoRetry('config-changed');
    await closeDbPool('config-changed');
    closeSshClient('config-changed');

    await applyEnabled();
    res.json({ ok: true, config: redactCfg(cfg), status: publicStatus() });
  });

  app.get('/api/ha/status', function (_req, res) {
    res.json({ ok: true, status: publicStatus() });
  });

  // 临时探测 SSH 凭证（不落盘）
  // 密码字段：'***' 或省略 → 沿用 cfg 里已落盘的密码（需要 body.side='primary'|'standby'）
  app.post('/api/ha/test/ssh', function (req, res) {
    const b = req.body || {};
    const host = String(b.host || '').trim();
    const port = Number(b.port) || 22;
    const user = String(b.user || '').trim();
    let password = String(b.password == null ? '' : b.password);
    if (password === '' || password === '***') {
      const side = b.side === 'standby' ? 'standby' : (b.side === 'primary' ? 'primary' : null);
      if (!side) {
        return res.status(400).json({ ok: false, message: '密码为空时必须指定 side=primary|standby 以使用已保存密码' });
      }
      password = String((cfg[side] && cfg[side].ssh && cfg[side].ssh.password) || '');
      if (!password) {
        return res.status(400).json({ ok: false, message: `${side === 'primary' ? '主' : '备'}服务器尚未保存 SSH 密码，请在密码框中输入后再测试` });
      }
    }
    if (!host || !user) return res.status(400).json({ ok: false, message: 'host/user 必填' });
    const c = new Client();
    let done = false;
    const finish = function (ok, msg) {
      if (done) return;
      done = true;
      try { c.end(); } catch (_e) {}
      res.json({ ok, message: msg || '' });
    };
    c.on('ready', function () { finish(true, '连接成功'); });
    c.on('error', function (err) { finish(false, err && err.message || String(err)); });
    setTimeout(function () { finish(false, '连接超时'); }, 8000);
    try {
      c.connect({ host, port, username: user, password, readyTimeout: 6000 });
    } catch (err) {
      finish(false, err.message);
    }
  });

  // 临时探测 DB 凭证（不落盘）
  // 密码字段：'***' 或省略 → 沿用 cfg 里已落盘的密码（需要 body.side='primary'|'standby'）
  app.post('/api/ha/test/db', async function (req, res) {
    if (!mysql) return res.status(500).json({ ok: false, message: 'mysql2 驱动未安装' });
    const b = req.body || {};
    const host = String(b.host || '').trim();
    const port = Number(b.port) || 3306;
    const user = String(b.user || '').trim();
    let password = String(b.password == null ? '' : b.password);
    if (password === '' || password === '***') {
      const side = b.side === 'standby' ? 'standby' : (b.side === 'primary' ? 'primary' : null);
      if (!side) {
        return res.status(400).json({ ok: false, message: '密码为空时必须指定 side=primary|standby 以使用已保存密码' });
      }
      password = String((cfg[side] && cfg[side].db && cfg[side].db.password) || '');
      if (!password) {
        return res.status(400).json({ ok: false, message: `${side === 'primary' ? '主' : '备'}服务器尚未保存 DB 密码，请在密码框中输入后再测试` });
      }
    }
    const database = String(b.database || '').trim();
    if (!host || !user) return res.status(400).json({ ok: false, message: 'host/user 必填' });
    let p = null;
    try {
      p = mysql.createPool({
        host, port, user, password, database: database || undefined,
        waitForConnections: true, connectionLimit: 1, queueLimit: 0, connectTimeout: 6000,
      });
      const conn = await p.getConnection();
      try { await conn.ping(); } finally { conn.release(); }
      res.json({ ok: true, message: '连接成功' });
    } catch (err) {
      res.json({ ok: false, message: err.message });
    } finally {
      if (p) { try { await p.end(); } catch (_e) {} }
    }
  });

  // 手动重启：重置 SSH 长连接 + DB 池
  app.post('/api/ha/restart', async function (_req, res) {
    if (!cfg.enabled) {
      return res.json({ ok: false, message: '总开关未启用，无需重启' });
    }
    appendLog('收到 /api/ha/restart：重置 SSH + DB');
    pushEvent('info', '手动重置 SSH 与 DB 连接');
    stopDbAutoRetry('manual-restart');
    await closeDbPool('manual-restart');
    closeSshClient('manual-restart');
    setTimeout(function () { applyEnabled().catch(function () {}); }, 200);
    res.json({ ok: true, status: publicStatus() });
  });

  // ---------- 数据库同步：主 22 → 备 50 ----------
  // 流程（用户需求字面）：
  //   1. SSH 进入备机 → docker exec dcim systemctl stop dcim 停采集
  //   2. SSH 进入备机 → 备份当前 dcim 库（gzip dump，写在备机 /opt/webssh/logs/）
  //   3. 在备机容器内执行 UPDATE `dcim-device` SET status=-1
  //   4. 主机上 mysqldump 整个 dcim 库（用 cfg.primary.db 凭据），通过 SSH 通道流到备机的 mysql
  //   5. 不自动重启采集；前端提示用户在备机手动 systemctl start dcim
  //
  // 安全约束：
  //   - 仅当 selfRole === 'primary' 时允许触发
  //   - 任意时刻只允许 1 个同步任务（syncRunning 互斥锁）
  //   - 全部步骤都要 push event 到 ws，前端实时可见
  //   - 任何步骤失败：记录、推 error、退出（不回滚已停的 dcim 服务）

  function recordSyncStep(name, status, msg) {
    const step = { name: name, status: status, msg: msg || '', ts: localStamp() };
    syncSteps.push(step);
    while (syncSteps.length > 50) syncSteps.shift();
    syncStep = name + (status === 'doing' ? '...' : '');
    const lvl = status === 'fail' ? 'error' : (status === 'done' ? 'info' : 'info');
    pushEvent(lvl, `[同步] ${name}：${status === 'doing' ? '执行中' : status === 'done' ? '完成' : '失败'}` + (msg ? '（' + msg + '）' : ''));
    broadcastSnapshot();
  }

  // 在备机上 SSH 执行单条命令；返回 { code, stdout, stderr }
  function peerExec(client, cmd, timeoutMs) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const finish = function (err, val) {
        if (done) return;
        done = true;
        if (err) reject(err); else resolve(val);
      };
      const t = setTimeout(function () { finish(new Error('SSH 命令超时: ' + cmd.slice(0, 80))); }, timeoutMs || 60000);
      client.exec(cmd, function (err, stream) {
        if (err) { clearTimeout(t); return finish(err); }
        let so = '', se = '';
        stream.on('close', function (code) {
          clearTimeout(t);
          finish(null, { code: code, stdout: so, stderr: se });
        }).on('data', function (d) { so += d.toString('utf8'); })
          .stderr.on('data', function (d) { se += d.toString('utf8'); });
      });
    });
  }

  // 把本地一段内容当 stdin 流到对端命令（用于 mysqldump | ssh ... | mysql 模式）
  function peerExecPipe(client, cmd, stdinStream, timeoutMs) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const finish = function (err, val) {
        if (done) return;
        done = true;
        if (err) reject(err); else resolve(val);
      };
      const t = setTimeout(function () { finish(new Error('SSH pipe 超时: ' + cmd.slice(0, 80))); }, timeoutMs || 600000);
      client.exec(cmd, function (err, stream) {
        if (err) { clearTimeout(t); return finish(err); }
        let so = '', se = '';
        stream.on('close', function (code) {
          clearTimeout(t);
          finish(null, { code: code, stdout: so, stderr: se });
        }).on('data', function (d) { so += d.toString('utf8'); })
          .stderr.on('data', function (d) { se += d.toString('utf8'); });
        stdinStream.on('error', function (e) { clearTimeout(t); finish(e); });
        stdinStream.pipe(stream);
      });
    });
  }

  // 用 child_process.spawn 跑 mysqldump，把 stdout 当 readable stream 返回
  // 关键：走 docker exec dcim mysqldump 而不是宿主机 mysqldump
  //   原因：宿主机系统用的是 MariaDB 10.3 mysqldump，跟 MySQL 5.7 不兼容
  //         （MariaDB mysqldump 不会自动跳过 STORED 生成列的 INSERT，导致灌库时报
  //          ERROR 3105 "value specified for generated column ... is not allowed"）
  //         dcim 容器内的 mysqldump 5.7.39 跟主库版本完全一致，会正确处理生成列
  function spawnLocalDump(dbCfg) {
    const args = [
      'exec', 'dcim', 'mysqldump',
      '-h', String(dbCfg.host || '127.0.0.1'),
      '-P', String(dbCfg.port || 3306),
      '-u', String(dbCfg.user || ''),
      '--password=' + String(dbCfg.password || ''),
      '--single-transaction',
      '--quick',
      '--routines',
      '--triggers',
      '--events',
      '--hex-blob',
      // dcim 业务用户通常没 PROCESS 权限，避免 mysqldump 默认尝试 dump tablespace 元数据时 1227 报错
      '--no-tablespaces',
      '--default-character-set=utf8mb4',
      String(dbCfg.database || ''),
    ];
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrBuf = '';
    proc.stderr.on('data', function (d) { stderrBuf += d.toString('utf8'); });
    proc.on('error', function (err) { stderrBuf += 'spawn error: ' + err.message; });
    return { proc: proc, stream: proc.stdout, getStderr: function () { return stderrBuf; } };
  }

  // 建一个一次性 SSH 客户端（本任务专用，不复用心跳的 sshClient——避免互相污染）
  function newPeerSshClient(sshCfg) {
    return new Promise(function (resolve, reject) {
      const c = new Client();
      let done = false;
      const finish = function (err, val) {
        if (done) return;
        done = true;
        if (err) reject(err); else resolve(val);
      };
      c.on('ready', function () { finish(null, c); });
      c.on('error', function (err) { finish(err); });
      try {
        c.connect({
          host: sshCfg.host,
          port: Number(sshCfg.port) || 22,
          username: sshCfg.user,
          password: sshCfg.password || '',
          readyTimeout: 12000,
          keepaliveInterval: 10000,
        });
      } catch (err) { finish(err); }
    });
  }

  async function doSyncDb(opts) {
    opts = opts || {};
    const skipStatusUpdate = !!opts.skipStatusUpdate;
    if (cfg.selfRole !== 'primary') throw new Error('仅当本机角色为「主机」时可触发同步');
    if (syncRunning) throw new Error('已有同步任务在执行');
    if (!cfg.enabled) throw new Error('总开关未启用');
    const peerSsh = cfg.standby.ssh;
    const localDb = cfg.primary.db;
    const peerDb  = cfg.standby.db;
    if (!peerSsh.host || !peerSsh.user) throw new Error('备机 SSH 配置不完整');
    if (!localDb.host || !localDb.user || !localDb.database) throw new Error('主机 DB 配置不完整');
    if (!peerDb.host  || !peerDb.user  || !peerDb.database)  throw new Error('备机 DB 配置不完整');

    // 同步互斥：备机如果已经接管业务，主机灌库会冲掉接管期间的新数据 → 拒绝同步
    try {
      const peerStatus = await fetchPeerStatus(peerSsh.host, PEER_WATCH_PORT, 4000);
      if (peerStatus && peerStatus.ok && peerStatus.status && peerStatus.status.failover && peerStatus.status.failover.takenOver) {
        throw new Error('备机当前处于「已接管」状态，主机同步已被锁定。请先到备机点「重置接管状态」恢复后再同步');
      }
    } catch (err) {
      // 网络异常不阻断同步（备机如果不可达，本来就该 sync）；只有明确读到 takenOver=true 才拒绝
      if (/已接管/.test(err.message)) throw err;
    }

    syncRunning = true;
    syncStartedAt = localStamp();
    syncFinishedAt = '';
    syncLastResult = '';
    syncLastError = '';
    syncSteps.length = 0;
    pushEvent('info', '开始数据库同步：主 → 备');
    broadcastSnapshot();

    let peerClient = null;
    try {
      // ----- 0. 建立到备机的一次性 SSH -----
      recordSyncStep('SSH 连接备机', 'doing');
      peerClient = await newPeerSshClient(peerSsh);
      recordSyncStep('SSH 连接备机', 'done', `${peerSsh.user}@${peerSsh.host}:${peerSsh.port}`);

      // ----- 1. 停采集：docker exec dcim systemctl stop dcim -----
      recordSyncStep('停止备机采集 (docker exec dcim systemctl stop dcim)', 'doing');
      let r = await peerExec(peerClient, 'docker exec dcim systemctl stop dcim 2>&1', 30000);
      if (r.code !== 0) throw new Error(`stop dcim 失败 exit=${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`);
      recordSyncStep('停止备机采集', 'done');

      // ----- 2. 备份备机当前 dcim 库 -----
      const stamp2 = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      const bakPath = `/opt/webssh/logs/ha-sync-bak-${stamp2}.sql.gz`;
      recordSyncStep(`备份备机 dcim 库 → ${bakPath}`, 'doing');
      // 在备机宿主机上 mysqldump（备机宿主机有 mysql 客户端）
      const dumpCmd =
        `mysqldump -h ${peerDb.host} -P ${peerDb.port} -u ${peerDb.user} ` +
        `--password=${peerDb.password || ''} --single-transaction --quick ` +
        `--routines --triggers --events --hex-blob --default-character-set=utf8mb4 ` +
        `${peerDb.database} | gzip -c > ${bakPath} && echo BAK_OK && ls -lh ${bakPath}`;
      r = await peerExec(peerClient, dumpCmd, 600000);
      if (r.code !== 0 || !/BAK_OK/.test(r.stdout)) {
        throw new Error(`备份失败 exit=${r.code}: ${(r.stderr || r.stdout).slice(0, 300)}`);
      }
      recordSyncStep('备份备机 dcim 库', 'done', r.stdout.split('\n').filter(Boolean).pop());

      // ----- 3. 主机 mysqldump | ssh peer "mysql ..." -----
      // 顺序说明：先灌库再 UPDATE。
      //   灌库会把 dcim-device 表 DROP+CREATE+INSERT 整体覆盖（包含主库真实 status 值），
      //   所以 UPDATE 必须在灌库之后执行，才能让备机最终的 status 全为 -1。
      recordSyncStep('主→备 灌库（mysqldump | ssh peer mysql）', 'doing');
      // 关键：sed 过滤掉 dump 里的 DEFINER 子句
      //   场景：主库的视图 / 触发器 / 存储过程 / 事件被 mysqldump 写成
      //         CREATE DEFINER=`root`@`localhost` ... 形式
      //         备机的 dcim 用户没 SUPER 权限，无法把 DEFINER 设为 root，导入时报 1227
      //   做法：剥掉 DEFINER 子句 → 备机自动用当前用户（dcim）当 DEFINER
      //   覆盖三种写法：DEFINER=`x`@`y` / DEFINER='x'@'y' / DEFINER=x@y
      const stripDefinerSed = `sed -E 's/DEFINER=\`[^\`]*\`@\`[^\`]*\`[[:space:]]*//g; s/DEFINER='\\''[^'\\'']*'\\''@'\\''[^'\\'']*'\\''[[:space:]]*//g; s/DEFINER=[^[:space:]]+[[:space:]]+//g; s/SQL SECURITY DEFINER/SQL SECURITY INVOKER/g'`;
      const importCmd =
        `${stripDefinerSed} | ` +
        `mysql -h ${peerDb.host} -P ${peerDb.port} -u ${peerDb.user} ` +
        `--password=${peerDb.password || ''} --default-character-set=utf8mb4 ` +
        `${peerDb.database}`;
      const dump = spawnLocalDump(localDb);
      const importResult = await peerExecPipe(peerClient, importCmd, dump.stream, 1800000); // 30 分钟
      // mysqldump 进程结束码（如果失败 stderr 里会有"Got error"）
      const dumpStderr = dump.getStderr();
      try { dump.proc.kill('SIGTERM'); } catch (_e) {}
      if (importResult.code !== 0) {
        throw new Error(`灌库 mysql 端 exit=${importResult.code}: ${(importResult.stderr || '').slice(0, 300)}`);
      }
      if (dumpStderr && /error/i.test(dumpStderr) && !/Using a password/i.test(dumpStderr)) {
        throw new Error(`mysqldump 报错: ${dumpStderr.slice(0, 300)}`);
      }
      recordSyncStep('主→备 灌库', 'done', '完成');

      // ----- 4. 备机容器内 UPDATE dcim-device.status = -1（必须在灌库后执行）-----
      // 默认必做（与手动同步一致）。skipStatusUpdate=true 时跳过（仅供未来 / 测试用）
      if (skipStatusUpdate) {
        recordSyncStep('备机 UPDATE dcim-device.status=-1', 'done', '已按选项跳过');
      } else {
        recordSyncStep('备机容器内 UPDATE `dcim-device` SET status=-1', 'doing');
        // 注意：表名 dcim-device 含连字符，必须用反引号转义
        const updateSql = "USE \\`" + peerDb.database + "\\`; UPDATE \\`dcim-device\\` SET status=-1; SELECT ROW_COUNT() AS affected;";
        const updateCmd =
          `docker exec dcim mysql -h ${peerDb.host} -P ${peerDb.port} -u ${peerDb.user} ` +
          `--password=${peerDb.password || ''} -BN -e "${updateSql}" 2>&1`;
        r = await peerExec(peerClient, updateCmd, 60000);
        if (r.code !== 0) throw new Error(`UPDATE 失败 exit=${r.code}: ${(r.stderr || r.stdout).slice(0, 300)}`);
        const affectedMatch = (r.stdout.trim().split('\n').filter(function (l) { return /^\d+$/.test(l.trim()); }).pop() || '').trim();
        recordSyncStep('备机 UPDATE dcim-device.status=-1', 'done', `affected=${affectedMatch}`);
      }

      // ----- 5. 完成 -----
      syncLastResult = 'success';
      syncStep = '已完成（请到备机手动 docker exec dcim systemctl start dcim 启动采集）';
      pushEvent('info', '同步完成。请到备机手动启动 dcim 采集（备份: ' + bakPath + '）');
    } catch (err) {
      syncLastResult = 'fail';
      syncLastError = err.message;
      pushEvent('error', '同步失败：' + err.message);
      recordSyncStep(syncStep || '失败', 'fail', err.message);
      throw err;
    } finally {
      if (peerClient) { try { peerClient.end(); } catch (_e) {} }
      syncRunning = false;
      syncFinishedAt = localStamp();
      broadcastSnapshot();
    }
  }

  app.post('/api/ha/sync', function (req, res) {
    if (cfg.selfRole !== 'primary') return res.status(400).json({ ok: false, message: '仅主机可触发同步' });
    if (!cfg.enabled) return res.status(400).json({ ok: false, message: '总开关未启用' });
    if (syncRunning) return res.status(409).json({ ok: false, message: '已有同步任务在执行' });
    // 立即返回 202，任务异步跑
    doSyncDb().catch(function () {}); // 错误已在内部记录
    res.status(202).json({ ok: true, message: '同步任务已启动，状态请看 /api/ha/status' });
  });

  // ---------- 定时同步：调度配置读写 ----------
  app.get('/api/ha/sync-schedule', function (_req, res) {
    const sch = cfg.syncSchedule || {};
    res.json({
      ok: true,
      data: {
        enabled: !!sch.enabled,
        preset: sch.preset || 'daily-3am',
        cron: effectiveCron(),
        customCron: sch.cron || '0 3 * * *',
        skipIfPeerDown: sch.skipIfPeerDown !== false,
        applyStatusMinusOne: sch.applyStatusMinusOne !== false,
        lastRunAt: sch.lastRunAt || '',
        lastRunResult: sch.lastRunResult || '',
        lastRunError: sch.lastRunError || '',
        nextRunAt: getNextRunAt(),
        running: !!scheduleTimer,
        allowed: cfg.selfRole === 'primary' && cfg.enabled,
        presets: Object.keys(PRESET_TO_CRON).concat(['custom']),
      },
    });
  });

  app.put('/api/ha/sync-schedule', function (req, res) {
    const b = req.body || {};
    // 校验 preset
    const validPresets = Object.keys(PRESET_TO_CRON).concat(['custom']);
    const preset = validPresets.indexOf(b.preset) >= 0 ? b.preset : 'daily-3am';
    let customCron = String(b.cron == null ? '' : b.cron).trim();
    if (preset === 'custom') {
      if (!customCron) return res.status(400).json({ ok: false, message: '自定义 cron 不能为空' });
      if (!cronValid(customCron)) return res.status(400).json({ ok: false, message: 'cron 表达式格式不合法（仅支持 5 字段：分 时 日 月 周）' });
    } else {
      // 非 custom 时也保留 customCron（用户切回 custom 时还能找回）
      if (customCron && !cronValid(customCron)) customCron = '0 3 * * *';
      if (!customCron) customCron = '0 3 * * *';
    }
    const next = {
      enabled: !!b.enabled,
      preset,
      cron: customCron,
      skipIfPeerDown: b.skipIfPeerDown !== false,
      applyStatusMinusOne: b.applyStatusMinusOne !== false,
      // 历史记录字段不被前端覆盖，保留原值
      lastRunAt: (cfg.syncSchedule && cfg.syncSchedule.lastRunAt) || '',
      lastRunResult: (cfg.syncSchedule && cfg.syncSchedule.lastRunResult) || '',
      lastRunError: (cfg.syncSchedule && cfg.syncSchedule.lastRunError) || '',
    };
    cfg.syncSchedule = next;
    writeCfg();
    pushEvent('info', `定时同步配置已更新：enabled=${next.enabled} cron=${effectiveCron()}`);

    // 立刻按新配置启停调度器
    stopScheduleTimer('config-changed');
    if (cfg.enabled && cfg.selfRole === 'primary' && next.enabled) {
      startScheduleTimer();
    }
    broadcastSnapshot();
    res.json({ ok: true, data: { ...next, cron: effectiveCron(), customCron, nextRunAt: getNextRunAt(), running: !!scheduleTimer } });
  });

  // ---------- 主机端被动逻辑：监听备机接管状态，自动停/启 dcim ----------
  // 流程：
  //   每 5s 通过 HTTP 查备机 http://<peer>:<port>/api/ha/status
  //   读出 status.failover.takenOver
  //   若 takenOver=true 且本机未让位 → docker exec dcim systemctl stop dcim + 标记 yielded=true
  //   若 takenOver=false 且本机已让位 → docker exec dcim systemctl start dcim + 标记 yielded=false
  let peerWatchTimer = null;
  let peerWatchInProgress = false;
  const PEER_WATCH_PORT = Number(process.env.HA_PEER_WATCH_PORT || 3010);

  function fetchPeerStatus(host, port, timeoutMs) {
    return new Promise(function (resolve) {
      const req = http.get({ host, port, path: '/api/ha/status', timeout: timeoutMs || 4000 }, function (resp) {
        let buf = '';
        resp.on('data', function (d) { buf += d.toString('utf8'); });
        resp.on('end', function () {
          try { resolve(JSON.parse(buf)); }
          catch (_e) { resolve(null); }
        });
      });
      req.on('error', function () { resolve(null); });
      req.on('timeout', function () { try { req.destroy(); } catch (_e) {} resolve(null); });
    });
  }

  function execDockerSimple(args, timeoutMs) {
    return new Promise(function (resolve) {
      const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let so = '', se = '';
      const t = setTimeout(function () { try { proc.kill('SIGTERM'); } catch (_e) {} }, timeoutMs || 30000);
      proc.stdout.on('data', function (d) { so += d.toString('utf8'); });
      proc.stderr.on('data', function (d) { se += d.toString('utf8'); });
      proc.on('close', function (code) { clearTimeout(t); resolve({ code, so, se }); });
      proc.on('error', function () { clearTimeout(t); resolve({ code: -1, so: '', se: 'spawn-error' }); });
    });
  }

  async function peerWatchTick() {
    if (peerWatchInProgress) return;
    peerWatchInProgress = true;
    try {
      if (!cfg.enabled || cfg.selfRole !== 'primary') return;
      const peerHost = cfg.standby && cfg.standby.ssh && cfg.standby.ssh.host;
      if (!peerHost) return;
      const peerStatus = await fetchPeerStatus(peerHost, PEER_WATCH_PORT, 4000);
      if (!peerStatus || !peerStatus.ok || !peerStatus.status) return;
      const peerFo = peerStatus.status.failover || {};
      const peerTakenOver = !!peerFo.takenOver;

      if (!cfg.yielded) cfg.yielded = JSON.parse(JSON.stringify(defaults.yielded));
      const wasYielded = !!cfg.yielded.yieldedToStandby;

      if (peerTakenOver && !wasYielded) {
        // 备机已接管 → 主机让位
        pushEvent('error', '【让位】备机已接管业务，本机自动停止 dcim 采集');
        const r = await execDockerSimple(['exec', 'dcim', 'systemctl', 'stop', 'dcim'], 30000);
        if (r.code === 0) {
          cfg.yielded.yieldedToStandby = true;
          cfg.yielded.yieldedAt = localStamp();
          writeCfg();
          pushEvent('warn', '【让位】完成：本机 dcim 已停止，业务运行在备机');
        } else {
          pushEvent('error', '【让位】停止 dcim 失败：' + ((r.se || r.so) || '').slice(0, 200));
        }
        broadcastSnapshot();
      } else if (!peerTakenOver && wasYielded) {
        // 备机已重置 → 主机收回
        pushEvent('info', '【收回】备机已重置接管状态，本机自动启动 dcim 采集');
        const r = await execDockerSimple(['exec', 'dcim', 'systemctl', 'start', 'dcim'], 30000);
        if (r.code === 0) {
          cfg.yielded.yieldedToStandby = false;
          cfg.yielded.yieldedAt = '';
          writeCfg();
          pushEvent('info', '【收回】完成：本机 dcim 已重新启动');
        } else {
          pushEvent('error', '【收回】启动 dcim 失败：' + ((r.se || r.so) || '').slice(0, 200));
        }
        broadcastSnapshot();
      }
    } catch (err) {
      // 静默：网络异常等不刷屏
    } finally {
      peerWatchInProgress = false;
    }
  }

  function startPeerWatchTimer() {
    if (peerWatchTimer) return;
    appendLog('启动主机被动监测循环（5s 查备机接管状态）');
    peerWatchTimer = setInterval(peerWatchTick, 5000);
    setTimeout(peerWatchTick, 2000);
  }
  function stopPeerWatchTimer(reason) {
    if (peerWatchTimer) {
      clearInterval(peerWatchTimer);
      peerWatchTimer = null;
      appendLog(`停止主机被动监测循环（${reason || '-'}）`);
    }
  }

  // ---------- 故障接管：REST 路由 ----------
  app.get('/api/ha/failover', function (_req, res) {
    const fo = cfg.failover || {};
    res.json({
      ok: true,
      data: {
        enabled: !!fo.enabled,
        bufferSec: Number(fo.bufferSec) || 30,
        bufferPreset: fo.bufferPreset || '30',
        judgeMode: fo.judgeMode || 'any',
        consecutiveFails: Number(fo.consecutiveFails) || 2,
        autoYieldOnPeerRecover: !!fo.autoYieldOnPeerRecover,
        autoYieldConsecutive: Number(fo.autoYieldConsecutive) || 5,
        cooldownSec: fo.cooldownSec != null ? Number(fo.cooldownSec) : 60,
        cooldownRemainingSec: failoverCooldownUntil > Date.now()
          ? Math.ceil((failoverCooldownUntil - Date.now()) / 1000) : 0,
        peerRecoverCount: failoverPeerRecoverCount,
        takenOver: !!fo.takenOver,
        takenOverAt: fo.takenOverAt || '',
        takenOverError: fo.takenOverError || '',
        state: failoverState,
        failCount: failoverFailCount,
        countdownSec: failoverCountdownSec,
        allowed: cfg.selfRole === 'standby' && cfg.enabled,
      },
    });
  });

  app.put('/api/ha/failover', function (req, res) {
    const b = req.body || {};
    const fo = cfg.failover || JSON.parse(JSON.stringify(defaults.failover));
    const before = !!fo.enabled;
    fo.enabled = !!b.enabled;
    if (b.bufferSec !== undefined) {
      const sec = Number(b.bufferSec);
      if (!(sec >= 5 && sec <= 3600)) {
        return res.status(400).json({ ok: false, message: 'bufferSec 必须在 5-3600 之间' });
      }
      fo.bufferSec = sec;
    }
    if (b.bufferPreset !== undefined) fo.bufferPreset = String(b.bufferPreset);
    if (b.judgeMode !== undefined) {
      const m = String(b.judgeMode);
      if (['any', 'both', 'ip-only'].indexOf(m) < 0) {
        return res.status(400).json({ ok: false, message: 'judgeMode 必须是 any/both/ip-only' });
      }
      fo.judgeMode = m;
    }
    if (b.consecutiveFails !== undefined) {
      const n = Number(b.consecutiveFails);
      if (!(n >= 1 && n <= 20)) {
        return res.status(400).json({ ok: false, message: 'consecutiveFails 必须在 1-20 之间' });
      }
      fo.consecutiveFails = n;
    }
    if (b.autoYieldOnPeerRecover !== undefined) {
      fo.autoYieldOnPeerRecover = !!b.autoYieldOnPeerRecover;
    }
    if (b.autoYieldConsecutive !== undefined) {
      const n = Number(b.autoYieldConsecutive);
      if (!(n >= 1 && n <= 60)) {
        return res.status(400).json({ ok: false, message: 'autoYieldConsecutive 必须在 1-60 之间' });
      }
      fo.autoYieldConsecutive = n;
    }
    if (b.cooldownSec !== undefined) {
      const n = Number(b.cooldownSec);
      if (!(n >= 0 && n <= 3600)) {
        return res.status(400).json({ ok: false, message: 'cooldownSec 必须在 0-3600 之间' });
      }
      fo.cooldownSec = n;
    }
    cfg.failover = fo;
    writeCfg();
    pushEvent('info', `故障接管配置已更新：enabled=${fo.enabled} buffer=${fo.bufferSec}s judge=${fo.judgeMode} consecutive=${fo.consecutiveFails} autoYield=${fo.autoYieldOnPeerRecover}/${fo.autoYieldConsecutive} cooldown=${fo.cooldownSec}s`);

    // 启停监测循环（仅 standby + 总开关启用时启动）
    if (cfg.enabled && cfg.selfRole === 'standby' && fo.enabled) {
      if (!fo.takenOver) {
        failoverState = 'monitoring';
        failoverFailCount = 0;
      }
      startFailoverCheckTimer();
    } else {
      stopFailoverCheckTimer('config-changed');
      if (!fo.takenOver) failoverState = 'idle';
    }
    broadcastSnapshot();
    res.json({ ok: true, data: { ...fo, state: failoverState, allowed: cfg.selfRole === 'standby' && cfg.enabled } });
  });

  // 立即停止缓冲监测（不影响已接管状态）
  app.post('/api/ha/failover/stop', function (_req, res) {
    if (!cfg.failover) cfg.failover = JSON.parse(JSON.stringify(defaults.failover));
    cfg.failover.enabled = false;
    writeCfg();
    stopFailoverCheckTimer('manual-stop');
    if (!cfg.failover.takenOver) failoverState = 'idle';
    pushEvent('info', '故障接管监测已停止');
    broadcastSnapshot();
    res.json({ ok: true, data: { state: failoverState } });
  });

  // 重置接管状态：UPDATE status=-1 + 停 dcim
  app.post('/api/ha/failover/reset', async function (_req, res) {
    try {
      await doFailoverReset();
      res.json({ ok: true, message: '已重置接管状态' });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // dry-run 测试：检查接管命令是否能跑通（不真接管）
  // 1) docker ps 看 dcim 容器存在
  // 2) docker exec dcim mysql ... -e "EXPLAIN UPDATE..."（仅校验权限和连通性）
  // 3) 不真重启 dcim
  app.post('/api/ha/failover/test', async function (_req, res) {
    if (cfg.selfRole !== 'standby') return res.status(400).json({ ok: false, message: '仅备机可测试接管' });
    const localDb = cfg.standby.db;
    const checks = { dockerPs: '', mysqlConn: '', updateGrant: '', deleteGrant: '' };
    try {
      // step1: docker ps，确认 dcim 容器存在
      const ps = await execDockerSimple(['ps', '--format', '{{.Names}}'], 15000);
      checks.dockerPs = (ps.code === 0 && /(^|\n)dcim(\n|$)/.test(ps.so))
        ? 'OK'
        : ('FAIL: ' + ((ps.se || ps.so) || 'docker 不可用').slice(0, 200));

      // step2: mysql 连通 + 能 SELECT
      const m = await execDockerSimple([
        'exec', 'dcim', 'mysql',
        '-h', String(localDb.host || '127.0.0.1'),
        '-P', String(localDb.port || 3306),
        '-u', String(localDb.user || ''),
        '--password=' + String(localDb.password || ''),
        '-BN', '-e',
        'USE `' + localDb.database + '`; SELECT COUNT(*) FROM `dcim-device`;',
      ], 15000);
      checks.mysqlConn = (m.code === 0) ? 'OK' : ('FAIL: ' + ((m.se || m.so) || '').slice(0, 200));

      // step3: SHOW GRANTS 看 UPDATE 权限
      const g = await execDockerSimple([
        'exec', 'dcim', 'mysql',
        '-h', String(localDb.host || '127.0.0.1'),
        '-P', String(localDb.port || 3306),
        '-u', String(localDb.user || ''),
        '--password=' + String(localDb.password || ''),
        '-BN', '-e', 'SHOW GRANTS FOR CURRENT_USER();',
      ], 15000);
      if (g.code === 0) {
        const hasUpdate = /\bUPDATE\b|\bALL PRIVILEGES\b/i.test(g.so);
        const hasDelete = /\bDELETE\b|\bALL PRIVILEGES\b/i.test(g.so);
        checks.updateGrant = hasUpdate ? 'OK' : ('FAIL: 当前用户没有 UPDATE 权限\n' + g.so.slice(0, 300));
        checks.deleteGrant = hasDelete ? 'OK' : ('FAIL: 当前用户没有 DELETE 权限（清空 dcim-alarmlist 需要）\n' + g.so.slice(0, 300));
      } else {
        checks.updateGrant = 'FAIL: ' + ((g.se || g.so) || '').slice(0, 200);
        checks.deleteGrant = 'FAIL: ' + ((g.se || g.so) || '').slice(0, 200);
      }

      const allOk = checks.dockerPs === 'OK' && checks.mysqlConn === 'OK' && checks.updateGrant === 'OK' && checks.deleteGrant === 'OK';
      res.json({
        ok: allOk,
        data: checks,
        message: allOk ? '所有校验通过，接管命令应能正常执行' : '部分校验失败，请检查',
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message, data: checks });
    }
  });


  // ---------- MySQL 连接保护调优（max_connect_errors）----------
  // 探测：经 SSH 进对端容器查 mysqld 当前 max_connect_errors 在线值 + my.cnf 落盘值
  // 目标容器名 / cnf 路径 / 重启命令 走可覆盖的 env，默认匹配当前部署
  const TUNE_CONTAINER = process.env.HA_TUNE_CONTAINER || 'dcim';
  const TUNE_CNF_PATH  = process.env.HA_TUNE_CNF_PATH  || '/etc/my.cnf';
  const TUNE_TARGET    = Number(process.env.HA_TUNE_TARGET || 100000);

  // sed 模板：替换 max_connect_errors 一行；如果 my.cnf 里没有这一行，则在 [mysqld] 段后追加
  function buildTuneSed(targetVal) {
    // 1) 已存在该行：替换
    // 2) 不存在：在 [mysqld] 后追加（用 awk 处理更稳）
    return [
      `if grep -qE '^[[:space:]]*max_connect_errors[[:space:]]*=' ${TUNE_CNF_PATH}; then`,
      `  sed -i -E 's/^[[:space:]]*max_connect_errors[[:space:]]*=[[:space:]]*[0-9]+/max_connect_errors = ${targetVal}/' ${TUNE_CNF_PATH};`,
      `else`,
      `  awk 'BEGIN{done=0} /^\\[mysqld\\]/&&!done{print;print "max_connect_errors = ${targetVal}";done=1;next} {print}' ${TUNE_CNF_PATH} > ${TUNE_CNF_PATH}.new && mv ${TUNE_CNF_PATH}.new ${TUNE_CNF_PATH};`,
      `fi`,
    ].join(' ');
  }

  // 探一端的 mysqld：在线值 + my.cnf 落盘值
  async function probeMysqlVar(sshCfg, dbCfg) {
    const c = await newPeerSshClient(sshCfg);
    try {
      // 在线值（用 dcim 用户，普通账号也能 SHOW VARIABLES）
      const q1 = `docker exec ${TUNE_CONTAINER} mysql -u${dbCfg.user} --password=${dbCfg.password || ''} -BN -e "SHOW VARIABLES LIKE 'max_connect_errors';" 2>&1 | tail -1 | awk '{print $2}'`;
      let r = await peerExec(c, q1, 15000);
      const live = (r.stdout || '').trim().split('\n').filter(function (l) { return /^\d+$/.test(l); }).pop() || '';
      // 落盘值
      const q2 = `docker exec ${TUNE_CONTAINER} sh -c "grep -E '^[[:space:]]*max_connect_errors[[:space:]]*=' ${TUNE_CNF_PATH} 2>/dev/null | tail -1 | awk -F= '{gsub(/[[:space:]]/,\\"\\"); print \\$2}'" 2>&1`;
      r = await peerExec(c, q2, 10000);
      const onDisk = (r.stdout || '').trim().split('\n').filter(function (l) { return /^\d+$/.test(l); }).pop() || '';
      return { ok: true, live: live ? Number(live) : null, onDisk: onDisk ? Number(onDisk) : null };
    } catch (err) {
      return { ok: false, message: err.message };
    } finally {
      try { c.end(); } catch (_e) {}
    }
  }

  app.get('/api/ha/mysql-vars', async function (_req, res) {
    if (!cfg.enabled) return res.status(400).json({ ok: false, message: '总开关未启用' });
    const out = { target: TUNE_TARGET };
    out.primary = await probeMysqlVar(cfg.primary.ssh, cfg.primary.db);
    out.standby = await probeMysqlVar(cfg.standby.ssh, cfg.standby.db);
    res.json({ ok: true, data: out });
  });

  // 调优单端：备份 my.cnf → sed/awk 改写 → 重启 mysqld → 校验在线值
  // restart=false 时只改文件不重启（生效要等下次自然重启）
  let tuneRunning = false;
  async function tuneOneSide(label, sshCfg, dbCfg, doRestart) {
    const c = await newPeerSshClient(sshCfg);
    try {
      const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      const bak = `${TUNE_CNF_PATH}.bak-${stamp}`;
      pushEvent('info', `[调优 ${label}] 备份 my.cnf → ${bak}`);
      let r = await peerExec(c, `docker exec ${TUNE_CONTAINER} cp ${TUNE_CNF_PATH} ${bak} && docker exec ${TUNE_CONTAINER} ls -l ${bak}`, 15000);
      if (r.code !== 0) throw new Error(`备份失败: ${(r.stderr || r.stdout).slice(0, 200)}`);

      pushEvent('info', `[调优 ${label}] 改写 max_connect_errors = ${TUNE_TARGET}`);
      const sedScript = buildTuneSed(TUNE_TARGET);
      r = await peerExec(c, `docker exec ${TUNE_CONTAINER} sh -c "${sedScript.replace(/"/g, '\\"')}"`, 15000);
      if (r.code !== 0) throw new Error(`改写失败: ${(r.stderr || r.stdout).slice(0, 200)}`);

      // 校验落盘
      r = await peerExec(c, `docker exec ${TUNE_CONTAINER} grep -E '^[[:space:]]*max_connect_errors' ${TUNE_CNF_PATH}`, 10000);
      const onDisk = (r.stdout || '').trim();
      if (!onDisk.includes(String(TUNE_TARGET))) throw new Error(`落盘校验失败: ${onDisk}`);
      pushEvent('info', `[调优 ${label}] 落盘校验通过：${onDisk}`);

      if (!doRestart) {
        pushEvent('info', `[调优 ${label}] 跳过重启（下次 mysqld 自然重启后生效）`);
        return { ok: true, restarted: false, onDisk: onDisk, bak: bak };
      }

      pushEvent('warn', `[调优 ${label}] 重启 mysqld（dcim 业务会断 1-3s）`);
      r = await peerExec(c, `docker exec ${TUNE_CONTAINER} systemctl restart mysqld`, 60000);
      if (r.code !== 0) throw new Error(`重启 mysqld 失败 exit=${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`);

      // 等 5s 让 mysqld 起来
      await new Promise(function (rs) { setTimeout(rs, 5000); });
      // 在线值校验
      const checkCmd = `docker exec ${TUNE_CONTAINER} mysql -u${dbCfg.user} --password=${dbCfg.password || ''} -BN -e "SHOW VARIABLES LIKE 'max_connect_errors';" 2>&1 | tail -1 | awk '{print $2}'`;
      r = await peerExec(c, checkCmd, 15000);
      const live = (r.stdout || '').trim().split('\n').filter(function (l) { return /^\d+$/.test(l); }).pop() || '';
      if (Number(live) !== TUNE_TARGET) throw new Error(`mysqld 在线值仍是 ${live || '(空)'}, 期望 ${TUNE_TARGET}`);
      pushEvent('info', `[调优 ${label}] mysqld 在线值已生效：max_connect_errors=${live}`);
      return { ok: true, restarted: true, live: Number(live), bak: bak };
    } finally {
      try { c.end(); } catch (_e) {}
    }
  }

  app.post('/api/ha/tune-mysql', async function (req, res) {
    if (!cfg.enabled) return res.status(400).json({ ok: false, message: '总开关未启用' });
    if (tuneRunning) return res.status(409).json({ ok: false, message: '已有调优任务在执行' });
    const body = req.body || {};
    const side = body.side === 'primary' || body.side === 'standby' || body.side === 'both' ? body.side : 'both';
    const restart = body.restart !== false;  // 默认重启

    tuneRunning = true;
    pushEvent('info', `开始 MySQL 调优：side=${side} restart=${restart} target=${TUNE_TARGET}`);
    const result = { side: side, restart: restart, target: TUNE_TARGET };
    try {
      if (side === 'primary' || side === 'both') {
        result.primary = await tuneOneSide('主机', cfg.primary.ssh, cfg.primary.db, restart);
      }
      if (side === 'standby' || side === 'both') {
        result.standby = await tuneOneSide('备机', cfg.standby.ssh, cfg.standby.db, restart);
      }
      pushEvent('info', `MySQL 调优完成：side=${side}`);
      res.json({ ok: true, result: result });
    } catch (err) {
      pushEvent('error', `MySQL 调优失败：${err.message}`);
      res.status(500).json({ ok: false, message: err.message, result: result });
    } finally {
      tuneRunning = false;
    }
  });

  // ---------- WebSocket /ws/ha ----------
  wssHa.on('connection', function (ws) {
    // 新连接立刻推一次全量快照
    try { ws.send(JSON.stringify({ type: 'snapshot', data: publicStatus() })); } catch (_e) {}
    ws.on('message', function (raw) {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (_e) { return; }
      if (msg && msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch (_e) {}
      }
    });
    ws.on('error', function () {});
  });

  // ---------- 自启 ----------
  readCfg();
  appendLog(`服务启动，enabled=${cfg.enabled}, selfRole=${cfg.selfRole}`);
  if (cfg.enabled) {
    // 异步启动，避免阻塞 server.js 主流程
    setTimeout(function () { applyEnabled().catch(function (err) {
      appendLog(`自启失败：${err.message}`);
    }); }, 1000);
  }
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
  // 新告警事件订阅：alarmBuffer 真正落入一条时回调，给短信猫推送模块用
  const alarmListeners = [];
  function notifyAlarmListeners(row) {
    for (const fn of alarmListeners) {
      try { fn(row); } catch (err) { appendLog(`listener 异常：${err.message}`); }
    }
  }
  global.__smsMonitorAddAlarmListener = function (fn) {
    if (typeof fn === 'function' && alarmListeners.indexOf(fn) === -1) {
      alarmListeners.push(fn);
    }
  };
  // 告警解除事件订阅：cancelBuffer 真正落入一条时回调
  const cancelListeners = [];
  function notifyCancelListeners(row) {
    for (const fn of cancelListeners) {
      try { fn(row); } catch (err) { appendLog(`cancel-listener 异常：${err.message}`); }
    }
  }
  global.__smsMonitorAddCancelListener = function (fn) {
    if (typeof fn === 'function' && cancelListeners.indexOf(fn) === -1) {
      cancelListeners.push(fn);
    }
  };

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
      if (isConnectionError(err) && typeof global.__smsDbMarkBroken === 'function') {
        global.__smsDbMarkBroken('monitor-init: ' + (err.code || err.message));
      }
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
            notifyAlarmListeners(row);
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
            notifyAlarmListeners(latest);
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
          notifyCancelListeners(row);
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
      if (isConnectionError(err) && typeof global.__smsDbMarkBroken === 'function') {
        global.__smsDbMarkBroken('monitor: ' + (err.code || err.message));
      }
    } finally {
      polling = false;
    }
  }

  // 网络级 / 协议级错误：mysql2 一旦命中这些 code，池里那条 socket 已经废了。
  // ECONNREFUSED：docker 重启窗口期连不上 3306
  // PROTOCOL_CONNECTION_LOST / ECONNRESET：连接已建立但被对端踢
  // ETIMEDOUT / EHOSTUNREACH / ENOTFOUND：网络/DNS 异常
  // ER_ACCESS_DENIED_ERROR / 语法错误等业务错误不重连，避免错误的密码导致死循环
  function isConnectionError(err) {
    if (!err) return false;
    const code = String(err.code || '').toUpperCase();
    if (code === 'ER_ACCESS_DENIED_ERROR') return false;
    if (['ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ECONNRESET',
         'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND'].indexOf(code) >= 0) return true;
    const msg = String(err.message || '').toLowerCase();
    return msg.indexOf('pool is closed') >= 0
      || msg.indexOf('connect etimedout') >= 0
      || msg.indexOf('connection lost') >= 0;
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

// ===== 信创短信猫 - 推送模块（HTTP API） =====
// 协议：
//  POST {gateway}/cgi-bin/NoticePush  推送通知（短信/电话/全部）
//  POST {gateway}/cgi-bin/NoticeResults  根据 id 列表查询发送结果
//  GET  {gateway}{simStatusPath}  查询 SIM 卡状态（默认 /cgi-bin/SystemStatusSnapshot）
(function setupSmsPush() {
  const path = require('path');
  const crypto = require('crypto');

  const CONFIG_PATH = process.env.SMS_PUSH_CONFIG
    || path.join(__dirname, 'config', 'sms-push.json');
  const LOG_PATH = process.env.SMS_PUSH_LOG
    || path.join(__dirname, 'logs', 'sms-push.log');

  const MAX_HISTORY = 500;
  const PERSON_TABLE = 'dcim-person';
  const NOTIFY_MODE_TABLE = 'dcim-alarmnotifymode';
  const DEFAULT_PATHS = {
    push: '/cgi-bin/NoticePush',
    results: '/cgi-bin/NoticeResults',
    sim: '/cgi-bin/SystemStatusSnapshot',
  };

  const defaults = {
    enabled: false,                         // 推送总开关
    autoPushOnAlarm: false,                 // 是否随新告警自动推送
    autoPushOnCancel: false,                // 是否随告警解除自动推送
    gatewayHost: '192.168.50.199',          // 短信网关 IP
    gatewayPort: 8791,                      // HTTP API 端口
    pushPath: DEFAULT_PATHS.push,
    resultsPath: DEFAULT_PATHS.results,
    simStatusPath: DEFAULT_PATHS.sim,
    type: 'SMS',                            // 手动发送的默认类型；自动推送由 alarmnotifymode 决定
    encoding: 'UTF-8',                      // 'UTF-8' | 'ANSI'
    httpTimeoutMs: 8000,                    // 请求超时
    autoQueryResultIntervalSec: 30,         // 后台周期查询结果
  };

  // ===== 多品牌驱动注册表 =====
  // 每个 driver 提供：name 显示名 / capabilities 能力声明 / defaults 默认参数
  // 以及 callPush(pcfg, payload) / callResults(pcfg, ids) / callSimStatus(pcfg) 的具体实现
  // capabilities.sim=false → 前端隐藏 SIM 卡相关 UI
  // capabilities.results=false → 后台不启动结果轮询
  // 实现还没接入的品牌请把方法保留为 throw new Error('暂未接入...')，UI 层会兜底
  const DRIVERS = {
    xinchuang: {
      name: '信创短信猫',
      capabilities: { sim: true, results: true },
      defaults: defaults,
      // 三个 call 方法在原 callPush/callResults/callSimStatus 函数内联，
      // 这里通过同名包装统一入口，避免大幅改造原代码
      callPush: null, callResults: null, callSimStatus: null,
    },
    // 占位品牌：UI 能选，但后端尚未实现，调用时给出友好错误
    // 之后接入新品牌，复制 xinchuang 这一项，实现 callPush/callResults/callSimStatus 即可
    rixin: {
      name: '日新短信猫（占位）',
      capabilities: { sim: false, results: false },
      defaults: { enabled: false, gatewayHost: '', gatewayPort: 0, type: 'SMS', encoding: 'UTF-8', httpTimeoutMs: 8000 },
      callPush: function () { throw new Error('日新短信猫暂未接入'); },
      callResults: function () { throw new Error('日新短信猫暂未接入'); },
      callSimStatus: function () { throw new Error('日新短信猫暂未接入'); },
    },
  };
  function listBrands() {
    return Object.keys(DRIVERS).map(function (k) {
      return { key: k, name: DRIVERS[k].name, capabilities: Object.assign({}, DRIVERS[k].capabilities) };
    });
  }
  function brandKeyOrFallback(k) {
    return DRIVERS[k] ? k : 'xinchuang';
  }

  // cfgRoot 是磁盘上的整体配置：{ brand, brands: { xinchuang: {...}, rixin: {...} } }
  // cfg 始终是 cfgRoot.brands[cfgRoot.brand] 的引用，让原有所有 cfg.X 读写零改造
  let cfgRoot = { brand: 'xinchuang', brands: { xinchuang: Object.assign({}, defaults) } };
  let cfg = cfgRoot.brands.xinchuang;

  // 发送历史：每条 {id, stime, type, to, text, status, ackTime, error, source}
  // source: 'manual' | 'auto'
  let history = [];
  let resultsTimer = null;
  let lastError = '';
  let totalSent = 0;
  let totalFailed = 0;

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
  function isoZ(d) {
    return (d || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  function genId() {
    // 协议示例 32 位无连字符（如 bceb32ae1f1611f08b3902b910fcb41e），保持兼容
    return crypto.randomBytes(16).toString('hex');
  }
  function clamp(v, min, max, dft) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dft;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }
  function sanitizeRecipients(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const it of arr) {
      const s = String(it == null ? '' : it).trim();
      if (s && /^[0-9+#*\-]{3,32}$/.test(s) && out.indexOf(s) === -1) out.push(s);
    }
    return out;
  }
  function sanitizeIds(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const it of arr) {
      const n = Number(it);
      if (Number.isFinite(n) && n > 0 && out.indexOf(n) === -1) out.push(Math.floor(n));
    }
    return out;
  }
  function getDbPool() {
    return typeof global.__smsDbGetPool === 'function' ? global.__smsDbGetPool() : null;
  }
  // 列出 dcim-person 全部记录（id / 姓名 / 手机号 / GroupId）— 前端"收件人"按钮的只读视图
  async function listPersons() {
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    const [rows] = await pool.query(
      'SELECT id, PersonName, PersonPhone, GroupId FROM `' + PERSON_TABLE + '` ORDER BY id ASC'
    );
    return rows || [];
  }
  // 按 id 数组实时查库，返回 [{id, name, phone}]
  async function resolveRecipientsByIds(ids) {
    const list = sanitizeIds(ids);
    if (!list.length) return [];
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    const placeholders = list.map(function () { return '?'; }).join(',');
    const [rows] = await pool.query(
      'SELECT id, PersonName, PersonPhone FROM `' + PERSON_TABLE + '`'
      + ' WHERE id IN (' + placeholders + ')',
      list
    );
    const out = [];
    for (const r of rows || []) {
      const phone = String(r.PersonPhone == null ? '' : r.PersonPhone).trim();
      if (phone) out.push({ id: r.id, name: r.PersonName, phone: phone });
    }
    return out;
  }
  // 按告警的 NotifyModeID 解析推送目标：
  //   1) 查 alarmnotifymode 拿 PhoneNotify / SMSNotify / UserID
  //   2) UserID 可能是单值或逗号分隔，按 GroupId 模糊匹配 dcim-person
  //      person.GroupId 实际样本是 ",1," 这种前后带逗号包围的格式，
  //      所以匹配条件统一加 ',' 包围两侧再 LIKE，兼容单值和 CSV
  // 返回 { mode, phoneNotify, smsNotify, userIds: string[], persons: [{id,name,phone,groupId}] }
  // mode === null 表示 alarmnotifymode 里没有这个 id
  async function resolveByNotifyMode(modeId) {
    const id = Number(modeId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    const [rows] = await pool.query(
      'SELECT id, AlarmName, PhoneNotify, SMSNotify, UserID FROM `' + NOTIFY_MODE_TABLE + '` WHERE id = ?',
      [id]
    );
    const mode = rows && rows[0];
    if (!mode) return null;
    const phoneNotify = Number(mode.PhoneNotify) === 1;
    const smsNotify = Number(mode.SMSNotify) === 1;
    const userIdRaw = String(mode.UserID == null ? '' : mode.UserID).trim();
    const userIds = userIdRaw
      ? userIdRaw.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; })
      : [];
    let persons = [];
    if (userIds.length) {
      // 用 OR + LIKE，兼容 person.GroupId = ",1,2," 这类多组场景
      const where = userIds.map(function () {
        return "CONCAT(',', `GroupId`, ',') LIKE CONCAT('%,', ?, ',%')";
      }).join(' OR ');
      const [pRows] = await pool.query(
        'SELECT id, PersonName, PersonPhone, GroupId FROM `' + PERSON_TABLE + '`'
        + ' WHERE PersonPhone IS NOT NULL AND PersonPhone <> \'\' AND (' + where + ')'
        + ' ORDER BY id ASC',
        userIds
      );
      const seen = new Set();
      for (const r of pRows || []) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const phone = String(r.PersonPhone == null ? '' : r.PersonPhone).trim();
        if (!phone) continue;
        persons.push({ id: r.id, name: r.PersonName, phone: phone, groupId: r.GroupId });
      }
    }
    return {
      mode: { id: mode.id, alarmName: mode.AlarmName, phoneNotify: phoneNotify, smsNotify: smsNotify, userId: userIdRaw },
      phoneNotify: phoneNotify,
      smsNotify: smsNotify,
      userIds: userIds,
      persons: persons,
    };
  }
  // 把单个品牌的扁平参数 normalize 一遍：填默认 + clamp 越界值
  function normalizeBrandCfg(brandKey, raw) {
    const drv = DRIVERS[brandKey] || DRIVERS.xinchuang;
    const dft = drv.defaults || defaults;
    const merged = Object.assign({}, dft, raw || {});
    if ('gatewayPort' in merged) merged.gatewayPort = clamp(merged.gatewayPort, 1, 65535, dft.gatewayPort || 8791);
    if ('httpTimeoutMs' in merged) merged.httpTimeoutMs = clamp(merged.httpTimeoutMs, 1000, 60000, dft.httpTimeoutMs || 8000);
    if ('autoQueryResultIntervalSec' in merged) {
      merged.autoQueryResultIntervalSec = clamp(merged.autoQueryResultIntervalSec, 5, 600, dft.autoQueryResultIntervalSec || 30);
    }
    if (brandKey === 'xinchuang') {
      merged.pushPath = merged.pushPath || DEFAULT_PATHS.push;
      merged.resultsPath = merged.resultsPath || DEFAULT_PATHS.results;
      merged.simStatusPath = merged.simStatusPath || DEFAULT_PATHS.sim;
    }
    merged.enabled = !!merged.enabled;
    merged.autoPushOnAlarm = !!merged.autoPushOnAlarm;
    merged.autoPushOnCancel = !!merged.autoPushOnCancel;
    delete merged.recipients;
    delete merged.recipientIds;
    return merged;
  }

  // 强制单品牌互斥：当某品牌 enabled=true 时，把其他品牌的 enabled 一律置 false
  function enforceSingleEnabled(activeKey) {
    Object.keys(cfgRoot.brands).forEach(function (k) {
      if (k !== activeKey && cfgRoot.brands[k]) cfgRoot.brands[k].enabled = false;
    });
  }
  // 把 cfg 引用切到目标品牌，确保后续所有 cfg.X 读到的是新品牌的参数
  function activateBrand(brandKey) {
    const key = brandKeyOrFallback(brandKey);
    if (!cfgRoot.brands[key]) cfgRoot.brands[key] = normalizeBrandCfg(key, {});
    cfgRoot.brand = key;
    cfg = cfgRoot.brands[key];
    return key;
  }

  function readCfg() {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      // 兼容三种写法：① 新结构 { brand, brands:{} }；② 老的扁平结构（迁移到 xinchuang）；③ 文件不存在
      if (parsed && parsed.brands && typeof parsed.brands === 'object') {
        cfgRoot = { brand: brandKeyOrFallback(parsed.brand), brands: {} };
        Object.keys(parsed.brands).forEach(function (k) {
          if (DRIVERS[k]) cfgRoot.brands[k] = normalizeBrandCfg(k, parsed.brands[k]);
        });
        if (!cfgRoot.brands[cfgRoot.brand]) cfgRoot.brands[cfgRoot.brand] = normalizeBrandCfg(cfgRoot.brand, {});
      } else if (parsed && typeof parsed === 'object') {
        // 旧扁平配置：整体迁移到 xinchuang
        cfgRoot = { brand: 'xinchuang', brands: { xinchuang: normalizeBrandCfg('xinchuang', parsed) } };
        appendLog('检测到旧版扁平配置，已迁移到 brands.xinchuang');
      }
    } catch (_e) {
      cfgRoot = { brand: 'xinchuang', brands: { xinchuang: normalizeBrandCfg('xinchuang', {}) } };
    }
    activateBrand(cfgRoot.brand);
    enforceSingleEnabled(cfgRoot.brand);
  }
  function writeCfg() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfgRoot, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.error('[sms-push] 写配置失败:', err.message);
    }
  }
  function pushHistory(entry) {
    history.push(entry);
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  }
  function findHistoryById(id) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].id === id) return history[i];
    }
    return null;
  }

  // 通用 HTTP 请求（无外部依赖，只用 node:http）
  function httpRequest(opts, body) {
    return new Promise(function (resolve, reject) {
      const req = http.request({
        host: opts.host,
        port: opts.port,
        path: opts.path,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        timeout: opts.timeout || 8000,
      }, function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          const buf = Buffer.concat(chunks);
          resolve({ statusCode: res.statusCode, headers: res.headers, body: buf });
        });
      });
      req.on('error', reject);
      req.on('timeout', function () {
        req.destroy(new Error('请求超时 ' + (opts.timeout || 8000) + 'ms'));
      });
      if (body != null) req.write(body);
      req.end();
    });
  }

  // ===== 信创品牌的真实实现：填回 DRIVERS.xinchuang 的 callXxx =====
  // 参数 pcfg 是该品牌当前的配置对象（不是全局 cfg），便于将来同时对多个品牌发起调用
  DRIVERS.xinchuang.callPush = async function (pcfg, payload) {
    if (!pcfg.gatewayHost) throw new Error('网关 IP 未配置');
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    return httpRequest({
      host: pcfg.gatewayHost, port: pcfg.gatewayPort,
      path: pcfg.pushPath || DEFAULT_PATHS.push, method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length },
      timeout: pcfg.httpTimeoutMs,
    }, data);
  };
  DRIVERS.xinchuang.callResults = async function (pcfg, ids) {
    if (!pcfg.gatewayHost) throw new Error('网关 IP 未配置');
    const data = Buffer.from(JSON.stringify(ids), 'utf8');
    return httpRequest({
      host: pcfg.gatewayHost, port: pcfg.gatewayPort,
      path: pcfg.resultsPath || DEFAULT_PATHS.results, method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length },
      timeout: pcfg.httpTimeoutMs,
    }, data);
  };
  DRIVERS.xinchuang.callSimStatus = async function (pcfg) {
    if (!pcfg.gatewayHost) throw new Error('网关 IP 未配置');
    return httpRequest({
      host: pcfg.gatewayHost, port: pcfg.gatewayPort,
      path: pcfg.simStatusPath || DEFAULT_PATHS.sim, method: 'GET',
      timeout: pcfg.httpTimeoutMs,
    });
  };

  // 通用入口：把当前激活品牌的 driver call 出去；新品牌只需补 DRIVERS.xxx.callXxx 即可
  function activeDriver() {
    return DRIVERS[cfgRoot.brand] || DRIVERS.xinchuang;
  }
  async function callPush(payload) {
    const drv = activeDriver();
    if (typeof drv.callPush !== 'function') throw new Error(drv.name + ' 暂未实现 callPush');
    return drv.callPush(cfg, payload);
  }
  async function callResults(ids) {
    const drv = activeDriver();
    if (typeof drv.callResults !== 'function') throw new Error(drv.name + ' 暂未实现 callResults');
    return drv.callResults(cfg, ids);
  }
  async function callSimStatus() {
    const drv = activeDriver();
    if (!drv.capabilities || !drv.capabilities.sim) throw new Error(drv.name + ' 不支持 SIM 卡查询');
    if (typeof drv.callSimStatus !== 'function') throw new Error(drv.name + ' 暂未实现 callSimStatus');
    return drv.callSimStatus(cfg);
  }

  function parseJsonSafe(buf) {
    try { return JSON.parse(buf.toString('utf8')); } catch (_e) { return null; }
  }

  // 推送一条消息：{to[]?, recipientIds[]?, persons[]?, text, type, encoding} → 写入 history，返回 entry
  // 号码来源优先级：to（直接传入手机号） > recipientIds（按 person.id 查库） > persons（自动推送已解析好的列表）
  // input.persons 用于自动推送：listener 已经按 NotifyModeID → alarmnotifymode → person 解析过，
  //   直接把 [{id,name,phone,groupId}] 传进来，sendOne 取里面的 phone 当 to，并把整份 persons 写进 history。
  async function sendOne(input, source) {
    let to = sanitizeRecipients(input.to);
    let resolvedPersons = Array.isArray(input.persons) ? input.persons.slice() : [];
    if (!to.length) {
      if (input.recipientIds && input.recipientIds.length) {
        resolvedPersons = await resolveRecipientsByIds(input.recipientIds);
        to = resolvedPersons.map(function (p) { return p.phone; });
      } else if (resolvedPersons.length) {
        to = resolvedPersons
          .map(function (p) { return String(p && p.phone || '').trim(); })
          .filter(function (s) { return s.length > 0; });
        to = sanitizeRecipients(to);
      }
    }
    if (!to.length) throw new Error('收件人为空');
    const text = String(input.text == null ? '' : input.text).trim();
    if (!text) throw new Error('内容为空');
    const type = ['SMS', 'Call', 'All'].indexOf(input.type) >= 0 ? input.type : cfg.type;
    const encoding = ['UTF-8', 'ANSI'].indexOf(input.encoding) >= 0 ? input.encoding : cfg.encoding;
    // 协议要求：id 数组长度 == to 数组长度（每个号一个独立 id），否则网关报
    // "The number of phone numbers is not equal to the number of IDs."
    const ids = to.map(function () { return genId(); });
    const id = String(input.id || ids[0]);
    if (input.id) ids[0] = id;            // 调用方指定了 id 时让首个 id 与 entry.id 对齐
    const stime = isoZ();
    const payload = { stime: stime, id: ids, type: type, to: to, text: text, encoding: encoding };
    const entry = {
      id: id, ids: ids, stime: stime, type: type, to: to, text: text, encoding: encoding,
      status: '发送中', ackTime: '', error: '',
      source: source || 'manual',
      gateway: cfg.gatewayHost + ':' + cfg.gatewayPort,
      persons: resolvedPersons,
    };
    pushHistory(entry);
    try {
      const resp = await callPush(payload);
      const bodyText = resp.body.toString('utf8').trim();
      // 解析网关 reply：HTTP 200 不代表业务成功，还要看 body.reply 是不是 "OK"
      let replyText = '';
      try {
        const parsed = JSON.parse(bodyText);
        if (parsed && typeof parsed === 'object' && 'reply' in parsed) {
          replyText = String(parsed.reply || '').trim();
        }
      } catch (_e) { /* 非 JSON 时按 raw 处理 */ }
      const httpOk = resp.statusCode >= 200 && resp.statusCode < 300;
      const replyOk = httpOk && (replyText === 'OK' || replyText.toLowerCase() === 'ok' || (!replyText && bodyText.toLowerCase() === 'ok'));
      if (replyOk) {
        entry.status = '已下发';
        totalSent += 1;
        appendLog(`下发成功 id=${id} to=${to.join(',')} type=${type} resp=${bodyText.slice(0, 100)}`);
      } else if (httpOk) {
        // HTTP 200 但 reply 不是 OK：业务级失败（短信猫未初始化 / 号码与 id 不匹配 等）
        entry.status = '网关拒绝';
        entry.error = '网关 reply: ' + (replyText || bodyText.slice(0, 200));
        totalFailed += 1;
        appendLog(`网关拒绝 id=${id} to=${to.join(',')} reply=${replyText || bodyText.slice(0, 100)}`);
      } else {
        entry.status = '下发失败';
        entry.error = 'HTTP ' + resp.statusCode + ' ' + bodyText.slice(0, 200);
        totalFailed += 1;
        appendLog(`下发失败 id=${id} ${entry.error}`);
      }
    } catch (err) {
      entry.status = '下发失败';
      entry.error = err.message;
      totalFailed += 1;
      appendLog(`下发异常 id=${id} ${err.message}`);
      throw err;
    }
    return entry;
  }

  // 批量查询：取 history 里 status 为"发送中"或"已下发"且未拿到 ackTime 的最近 N 条
  async function refreshResults(ids) {
    let target = Array.isArray(ids) ? ids.slice(0) : null;
    if (!target) {
      target = history
        .filter(function (e) { return !e.ackTime && e.status !== '下发失败'; })
        .slice(-50)
        .map(function (e) { return e.id; });
    }
    if (!target.length) return { updated: 0, list: [] };
    const resp = await callResults(target);
    const list = parseJsonSafe(resp.body) || [];
    let updated = 0;
    for (const item of list) {
      if (!item || !item.id) continue;
      const e = findHistoryById(item.id);
      if (!e) continue;
      let changed = false;
      if (item.status && item.status !== e.status) { e.status = item.status; changed = true; }
      if (item.ackTime && item.ackTime !== e.ackTime) { e.ackTime = item.ackTime; changed = true; }
      if (item.stime && item.stime !== e.stime) { e.stime = item.stime; }
      if (changed) updated += 1;
    }
    return { updated: updated, list: list, queried: target };
  }

  function scheduleResultsTimer() {
    if (resultsTimer) { clearInterval(resultsTimer); resultsTimer = null; }
    if (!cfg.enabled) return;
    // 没有结果回执能力的品牌不开启轮询
    const drv = activeDriver();
    if (!drv.capabilities || !drv.capabilities.results) return;
    const ms = Math.max(5000, cfg.autoQueryResultIntervalSec * 1000);
    resultsTimer = setInterval(function () {
      refreshResults().catch(function (err) { lastError = err.message; });
    }, ms);
  }

  function publicState() {
    const drv = activeDriver();
    return {
      // 当前激活品牌
      brand: cfgRoot.brand,
      brandName: drv.name,
      capabilities: Object.assign({}, drv.capabilities),
      brands: listBrands(),    // [{key, name, capabilities}]
      // 当前激活品牌的所有参数
      enabled: cfg.enabled,
      autoPushOnAlarm: !!cfg.autoPushOnAlarm,
      autoPushOnCancel: !!cfg.autoPushOnCancel,
      gatewayHost: cfg.gatewayHost,
      gatewayPort: cfg.gatewayPort,
      pushPath: cfg.pushPath,
      resultsPath: cfg.resultsPath,
      simStatusPath: cfg.simStatusPath,
      type: cfg.type,
      encoding: cfg.encoding,
      httpTimeoutMs: cfg.httpTimeoutMs,
      autoQueryResultIntervalSec: cfg.autoQueryResultIntervalSec,
      // 全局
      historyCount: history.length,
      totalSent: totalSent,
      totalFailed: totalFailed,
      lastError: lastError,
      dbConnected: !!getDbPool(),
      recipientResolver: 'NotifyModeID -> dcim-alarmnotifymode -> dcim-person',
    };
  }

  // 订阅 monitor 模块的新告警事件，开关打开时按 NotifyModeID 自动解析收件人后推送
  if (typeof global.__smsMonitorAddAlarmListener === 'function') {
    global.__smsMonitorAddAlarmListener(function (row) {
      if (!cfg.enabled || !cfg.autoPushOnAlarm) return;
      const alarmId = row && row.id;
      const modeId = Number(row && row.NotifyModeID);
      if (!Number.isFinite(modeId) || modeId <= 0) {
        appendLog(`告警 #${alarmId} 跳过：NotifyModeID 为空`);
        return;
      }
      (async function () {
        try {
          const resolved = await resolveByNotifyMode(modeId);
          if (!resolved) {
            appendLog(`告警 #${alarmId} 跳过：alarmnotifymode 无 id=${modeId}`);
            return;
          }
          const phoneNotify = resolved.phoneNotify;
          const smsNotify = resolved.smsNotify;
          if (!phoneNotify && !smsNotify) {
            appendLog(`告警 #${alarmId} 跳过：mode=${modeId} PhoneNotify=0 SMSNotify=0`);
            return;
          }
          if (!resolved.persons.length) {
            appendLog(`告警 #${alarmId} 跳过：mode=${modeId} UserID=${resolved.mode.userId || '空'} 未匹配到任何 person`);
            return;
          }
          const text = (row && row.TextMessage && String(row.TextMessage).trim())
            || ('告警 #' + (alarmId != null ? alarmId : '-'));
          // 协议 type：电话+短信都开 → All；只开电话 → Call；只开短信 → SMS
          let type;
          if (phoneNotify && smsNotify) type = 'All';
          else if (phoneNotify) type = 'Call';
          else type = 'SMS';
          await sendOne({
            persons: resolved.persons,
            text: text,
            type: type,
            encoding: cfg.encoding,
          }, 'auto');
        } catch (err) {
          lastError = err.message;
          appendLog(`告警 #${alarmId} 自动推送失败：${err.message}`);
        }
      })();
    });
  }

  // 订阅 monitor 模块的告警解除事件，开关打开时按 NotifyModeID 自动推送"解除"消息
  if (typeof global.__smsMonitorAddCancelListener === 'function') {
    global.__smsMonitorAddCancelListener(function (row) {
      if (!cfg.enabled || !cfg.autoPushOnCancel) return;
      const alarmId = row && row.id;
      const modeId = Number(row && row.NotifyModeID);
      if (!Number.isFinite(modeId) || modeId <= 0) {
        appendLog(`解除 #${alarmId} 跳过：NotifyModeID 为空`);
        return;
      }
      (async function () {
        try {
          const resolved = await resolveByNotifyMode(modeId);
          if (!resolved) {
            appendLog(`解除 #${alarmId} 跳过：alarmnotifymode 无 id=${modeId}`);
            return;
          }
          const phoneNotify = resolved.phoneNotify;
          const smsNotify = resolved.smsNotify;
          if (!phoneNotify && !smsNotify) {
            appendLog(`解除 #${alarmId} 跳过：mode=${modeId} PhoneNotify=0 SMSNotify=0`);
            return;
          }
          if (!resolved.persons.length) {
            appendLog(`解除 #${alarmId} 跳过：mode=${modeId} UserID=${resolved.mode.userId || '空'} 未匹配到任何 person`);
            return;
          }
          const baseText = (row && row.TextMessage && String(row.TextMessage).trim())
            || ('告警 #' + (alarmId != null ? alarmId : '-'));
          const cancelTime = row && row.CancelTime
            ? new Date(row.CancelTime).toLocaleString('zh-CN', { hour12: false })
            : '';
          const text = '【告警解除】' + baseText + (cancelTime ? '（解除时间 ' + cancelTime + '）' : '');
          // 协议 type：电话+短信都开 → All；只开电话 → Call；只开短信 → SMS
          let type;
          if (phoneNotify && smsNotify) type = 'All';
          else if (phoneNotify) type = 'Call';
          else type = 'SMS';
          await sendOne({
            persons: resolved.persons,
            text: text,
            type: type,
            encoding: cfg.encoding,
          }, 'auto-cancel');
        } catch (err) {
          lastError = err.message;
          appendLog(`解除 #${alarmId} 自动推送失败：${err.message}`);
        }
      })();
    });
  }

  // ===== HTTP 接口 =====
  app.get('/api/sms/push/config', function (_req, res) {
    res.json(publicState());
  });

  app.put('/api/sms/push/config', function (req, res) {
    const body = req.body || {};
    // 允许 PUT 同时切换品牌：body.brand 指定要修改的品牌 key（默认改激活品牌）
    const targetKey = body.brand && DRIVERS[body.brand] ? body.brand : cfgRoot.brand;
    if (!cfgRoot.brands[targetKey]) cfgRoot.brands[targetKey] = normalizeBrandCfg(targetKey, {});
    const target = cfgRoot.brands[targetKey];
    const dft = (DRIVERS[targetKey].defaults) || defaults;

    if ('enabled' in body) target.enabled = !!body.enabled;
    if ('autoPushOnAlarm' in body) target.autoPushOnAlarm = !!body.autoPushOnAlarm;
    if ('autoPushOnCancel' in body) target.autoPushOnCancel = !!body.autoPushOnCancel;
    if ('gatewayHost' in body) target.gatewayHost = String(body.gatewayHost || '').trim() || target.gatewayHost;
    if ('gatewayPort' in body) target.gatewayPort = clamp(body.gatewayPort, 1, 65535, target.gatewayPort);
    if ('pushPath' in body) target.pushPath = String(body.pushPath || dft.pushPath || DEFAULT_PATHS.push).trim() || (dft.pushPath || DEFAULT_PATHS.push);
    if ('resultsPath' in body) target.resultsPath = String(body.resultsPath || dft.resultsPath || DEFAULT_PATHS.results).trim() || (dft.resultsPath || DEFAULT_PATHS.results);
    if ('simStatusPath' in body) target.simStatusPath = String(body.simStatusPath || dft.simStatusPath || DEFAULT_PATHS.sim).trim() || (dft.simStatusPath || DEFAULT_PATHS.sim);
    if ('type' in body && ['SMS', 'Call', 'All'].indexOf(body.type) >= 0) target.type = body.type;
    if ('encoding' in body && ['UTF-8', 'ANSI'].indexOf(body.encoding) >= 0) target.encoding = body.encoding;
    if ('httpTimeoutMs' in body) target.httpTimeoutMs = clamp(body.httpTimeoutMs, 1000, 60000, target.httpTimeoutMs);
    if ('autoQueryResultIntervalSec' in body) {
      target.autoQueryResultIntervalSec = clamp(body.autoQueryResultIntervalSec, 5, 600, target.autoQueryResultIntervalSec);
    }
    // 互斥：如果 PUT 把某个品牌 enabled 置 true，把其他品牌全部置 false
    if (target.enabled) enforceSingleEnabled(targetKey);

    writeCfg();
    scheduleResultsTimer();
    appendLog(`配置更新[${targetKey}] enabled=${target.enabled} autoPush=${target.autoPushOnAlarm} autoCancel=${target.autoPushOnCancel} gw=${target.gatewayHost}:${target.gatewayPort}`);
    res.json(publicState());
  });

  // 列出全部支持的品牌（含 capabilities，前端做能力开关）
  app.get('/api/sms/push/brands', function (_req, res) {
    res.json({ ok: true, brand: cfgRoot.brand, brands: listBrands() });
  });

  // 切换激活品牌：参数已并存，不强制关闭其他品牌的 enabled。
  // 互斥仍由 PUT 接口 + readCfg 启动时保证：任何时候真正发送的只可能是 cfgRoot.brand 这一个。
  app.post('/api/sms/push/brand', function (req, res) {
    const body = req.body || {};
    const want = String(body.brand || '');
    if (!DRIVERS[want]) return res.status(400).json({ ok: false, message: '未知品牌：' + want });
    activateBrand(want);
    writeCfg();
    scheduleResultsTimer();
    appendLog(`切换品牌 → ${want}（其他品牌参数保留）`);
    res.json({ ok: true, state: publicState() });
  });

  // 列出 dcim-person（前端"收件人"按钮的只读视图，仅供查看，不再用于推送配置）
  app.get('/api/sms/push/persons', async function (_req, res) {
    try {
      const list = await listPersons();
      res.json({
        ok: true,
        items: list.map(function (r) {
          return { id: r.id, name: r.PersonName, phone: r.PersonPhone, groupId: r.GroupId };
        }),
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // 调试接口：给一个 NotifyModeID，返回 alarmnotifymode 行 + 解析出的 person 列表，
  // 前端"收件人"弹窗里可以输入 modeId 直观验证联表是否正确
  app.get('/api/sms/push/resolve-mode', async function (req, res) {
    const id = Number(req.query && req.query.id);
    try {
      const resolved = await resolveByNotifyMode(id);
      if (!resolved) return res.status(404).json({ ok: false, message: 'alarmnotifymode 无 id=' + id });
      res.json({ ok: true, resolved: resolved });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.post('/api/sms/push/send', async function (req, res) {
    const body = req.body || {};
    try {
      const entry = await sendOne({
        to: body.to,
        recipientIds: body.recipientIds,
        text: body.text,
        type: body.type,
        encoding: body.encoding,
        id: body.id,
      }, 'manual');
      res.json({ ok: true, entry: entry, state: publicState() });
    } catch (err) {
      lastError = err.message;
      res.status(500).json({ ok: false, message: err.message, state: publicState() });
    }
  });

  app.get('/api/sms/push/history', function (req, res) {
    const limit = clamp(req.query.limit, 1, MAX_HISTORY, 100);
    res.json({
      state: publicState(),
      items: history.slice(-limit).reverse(),
    });
  });

  app.post('/api/sms/push/refresh-results', async function (req, res) {
    const body = req.body || {};
    try {
      const r = await refreshResults(Array.isArray(body.ids) ? body.ids : null);
      res.json({ ok: true, updated: r.updated, queried: r.queried, raw: r.list });
    } catch (err) {
      lastError = err.message;
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.get('/api/sms/push/sim-status', async function (_req, res) {
    try {
      const resp = await callSimStatus();
      const json = parseJsonSafe(resp.body);
      res.json({
        ok: resp.statusCode >= 200 && resp.statusCode < 300,
        statusCode: resp.statusCode,
        json: json,
        raw: resp.body.toString('utf8'),
      });
    } catch (err) {
      lastError = err.message;
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.post('/api/sms/push/clear-history', function (_req, res) {
    history = [];
    res.json(publicState());
  });

  readCfg();
  scheduleResultsTimer();
  appendLog(`服务启动：enabled=${cfg.enabled} autoPush=${cfg.autoPushOnAlarm} autoCancel=${cfg.autoPushOnCancel} gw=${cfg.gatewayHost}:${cfg.gatewayPort}`);

  // 暴露给「定时短信」等模块复用：直接走同一条 sendOne 链路（含历史落库 + 网关回执解析）
  global.__smsPushSendOne = sendOne;
  global.__smsPushIsEnabled = function () { return !!cfg.enabled; };
})();

// ===== 信创短信猫 - 定时短信（整点短信）=====
// 数据源：dcim 库 dcim-alarmparam 表（单例 id=1）
//   SmsOnhourAlarm    1=开启整点短信 0=关闭
//   SmsContent        1=告警数量 2=详细告警 3=定制内容 4=参数（本期仅实现 3）
//   SmsCustomContent  定制内容文本
//   SmsTargetPhone    收件人手机号（/ , ; 空格 任意分隔均可）
//   SmsTime           小时数列表 "16" 或 "15,16"
//   LastSmsAlarmTime  上次成功发送时间（防重写回此列）
//
// 调度：每 60s 跑一次。
//   命中条件 = SmsOnhourAlarm==1 且 当前小时 ∈ SmsTime 且 LastSmsAlarmTime 距今 > 50 分钟
//   防重写回：sendOne 成功后 UPDATE LastSmsAlarmTime = NOW()
(function setupScheduledSms() {
  const path = require('path');
  const TABLE = 'dcim-alarmparam';
  const LOG_PATH = process.env.SMS_SCHEDULED_LOG
    || path.join(__dirname, 'logs', 'sms-scheduled.log');
  const POLL_MS = 60 * 1000;
  // 防重策略：按"整点小时"比对，而不是按分钟数。
  // 触发条件：当前小时 ∈ SmsTime 且 LastSmsAlarmTime 的整点小时 ≠ 当前小时（或日期不同）
  // 好处：手动触发 / 改系统时间 等扰动 LastSmsAlarmTime 都不会污染下一个整点

  let timer = null;
  let lastError = '';
  let lastTickAt = '';
  let lastSendAt = '';
  let totalSent = 0;
  let totalFailed = 0;
  // 最近调度记录环形缓冲：每条 { at, kind, fired, checks, error, entryId }
  // kind: 'tick' | 'manual'，checks 数组逐项给出预检结果（详见 evaluateGuards）
  const RECENT_LIMIT = 50;
  let recent = [];

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
  function getDbPool() {
    return typeof global.__smsDbGetPool === 'function' ? global.__smsDbGetPool() : null;
  }
  function parseHours(raw) {
    return String(raw || '')
      .split(/[\s,，;；/]+/)
      .map(function (s) { return Number(String(s).trim()); })
      .filter(function (n) { return Number.isInteger(n) && n >= 0 && n <= 23; });
  }
  function parsePhones(raw) {
    return String(raw || '')
      .split(/[\s,，;；/]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  // 把"是否该发"的判定拆成多项明细，前端能逐项 ✓✗ 展示
  // SmsContent=2（详细告警）时多一项"区间内有新告警"预检
  // 返回 { allOk, checks: [{key, label, ok, detail}] }
  // 注意：可能查库（type=2 时），故为 async
  async function evaluateGuards(row, nowDate) {
    const now = nowDate || new Date();
    const nowH = now.getHours();
    const hourList = parseHours(row.SmsTime);
    const enabled = Number(row.SmsOnhourAlarm) === 1;
    const lastDate = row.LastSmsAlarmTime ? new Date(row.LastSmsAlarmTime) : null;
    let alreadySentThisHour = false;
    let lastHourLabel = '';
    if (lastDate && !isNaN(lastDate.getTime())) {
      lastHourLabel = lastDate.getFullYear() + '-' + String(lastDate.getMonth() + 1).padStart(2, '0')
        + '-' + String(lastDate.getDate()).padStart(2, '0') + ' ' + String(lastDate.getHours()).padStart(2, '0') + '时';
      alreadySentThisHour = lastDate.getFullYear() === now.getFullYear()
        && lastDate.getMonth() === now.getMonth()
        && lastDate.getDate() === now.getDate()
        && lastDate.getHours() === nowH;
    }
    const phones = parsePhones(row.SmsTargetPhone);
    const checks = [
      {
        key: 'enabled',
        label: '总开关 SmsOnhourAlarm=1',
        ok: enabled,
        detail: enabled ? '已开启' : '关闭中（数据库 SmsOnhourAlarm=' + row.SmsOnhourAlarm + '）',
      },
      {
        key: 'phones',
        label: 'SmsTargetPhone 至少 1 个号码',
        ok: phones.length > 0,
        detail: phones.length ? '解析出 ' + phones.length + ' 个：' + phones.join(' / ') : '原值="' + (row.SmsTargetPhone || '') + '"',
      },
      {
        key: 'hour',
        label: '当前小时 ∈ SmsTime',
        ok: hourList.length > 0 && hourList.indexOf(nowH) >= 0,
        detail: hourList.length
          ? '当前 ' + nowH + ' 时，SmsTime=[' + hourList.join(',') + ']'
          : 'SmsTime 解析为空（原值="' + (row.SmsTime || '') + '"）',
      },
      {
        key: 'hourDedup',
        label: '本整点尚未发送过',
        ok: !alreadySentThisHour,
        detail: lastDate
          ? (alreadySentThisHour ? '已在 ' + lastHourLabel + ' 发过' : '上次发送在 ' + lastHourLabel + '，与当前整点不同')
          : '尚未发送过',
      },
    ];

    // SmsContent=2 详细告警：还要看"上次发送以来 dcim-alarmlist 是否有新增"
    // 没有新增就不发，避免发"本时段无告警"这种废话
    if (Number(row.SmsContent) === 2) {
      let hasNew = false;
      let newDetail = '';
      try {
        const result = await fetchNewAlarmsSince(row.LastSmsAlarmTime, 1);
        hasNew = result.total > 0;
        newDetail = hasNew
          ? '区间内新增 ' + result.total + ' 条告警'
          : '区间内无新增告警，将跳过本次发送';
      } catch (err) {
        newDetail = '查询失败：' + err.message;
      }
      checks.push({
        key: 'hasNewAlarms',
        label: '区间内有新增告警（仅 SmsContent=2 需要）',
        ok: hasNew,
        detail: newDetail,
      });
    }

    const allOk = checks.every(function (c) { return c.ok; });
    return { allOk: allOk, checks: checks };
  }

  // 算下次预计触发时间：在所有未来 SmsTime 小时点里找到第一个未在该自然小时发过的整点
  function nextExpected(row) {
    const enabled = Number(row.SmsOnhourAlarm) === 1;
    const hourList = parseHours(row.SmsTime);
    if (!enabled) return { iso: null, label: '-', reason: '总开关关闭' };
    if (!hourList.length) return { iso: null, label: '-', reason: 'SmsTime 解析为空' };
    const lastDate = row.LastSmsAlarmTime ? new Date(row.LastSmsAlarmTime) : null;
    const sortedH = hourList.slice().sort(function (a, b) { return a - b; });
    const now = new Date();
    for (let d = 0; d < 8; d += 1) {
      for (const h of sortedH) {
        const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, h, 0, 0, 0);
        if (candidate.getTime() <= now.getTime()) continue;
        // 同自然小时去重：候选时间点与上次发送处于同一年月日时则跳过（实际不会出现，因为 candidate 是未来）
        if (lastDate
          && lastDate.getFullYear() === candidate.getFullYear()
          && lastDate.getMonth() === candidate.getMonth()
          && lastDate.getDate() === candidate.getDate()
          && lastDate.getHours() === candidate.getHours()) continue;
        return { iso: candidate.toISOString(), label: localStamp(candidate), reason: '' };
      }
    }
    return { iso: null, label: '-', reason: '7 天内无满足条件的时间点' };
  }

  function pushRecent(rec) {
    rec.at = localStamp();
    recent.push(rec);
    if (recent.length > RECENT_LIMIT) recent = recent.slice(-RECENT_LIMIT);
  }

  // 读 dcim-alarmparam 单例（id=1）
  async function readParam() {
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    const [rows] = await pool.query(
      'SELECT id, SmsOnhourAlarm, SmsContent, SmsCustomContent, SmsTargetPhone, SmsTime, SmsParamId, LastSmsAlarmTime '
      + 'FROM `' + TABLE + '` ORDER BY id ASC LIMIT 1'
    );
    if (!rows || !rows.length) throw new Error(TABLE + ' 表为空，无可用配置');
    return rows[0];
  }

  // 统计今日告警条数：返回 { total, unresolved, resolved }
  // 按 dcim-alarmlist.create_time 落在今天的所有 status=1 的行计数；CancelTime IS NULL 视为未解除
  async function countTodayAlarms() {
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    const sql = 'SELECT '
      + 'COUNT(*) AS total, '
      + 'SUM(CASE WHEN CancelTime IS NULL THEN 1 ELSE 0 END) AS unresolved, '
      + 'SUM(CASE WHEN CancelTime IS NOT NULL THEN 1 ELSE 0 END) AS resolved '
      + 'FROM `dcim-alarmlist` '
      + 'WHERE DATE(create_time) = CURDATE() AND status = 1';
    const [rows] = await pool.query(sql);
    const r = (rows && rows[0]) || {};
    return {
      total: Number(r.total) || 0,
      unresolved: Number(r.unresolved) || 0,
      resolved: Number(r.resolved) || 0,
    };
  }

  // SmsContent=2 用：拉"上次发送之后新增"的告警列表
  // 入参：lastSmsAlarmTime（可能是 Date / ISO 字符串 / null）
  // 出参：{ total, items: [{id, level, text, time}] }，items 取最早的 limit 条（按 id ASC）
  // lastSmsAlarmTime 为 null 时退化为今天 00:00 起，避免首次启用时全表扫
  async function fetchNewAlarmsSince(lastSmsAlarmTime, limit) {
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    let cursor;
    if (lastSmsAlarmTime) {
      cursor = new Date(lastSmsAlarmTime);
      if (isNaN(cursor.getTime())) cursor = null;
    }
    if (!cursor) {
      const today = new Date();
      cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
    }
    // 一条 SQL 拿 total + 列表，避免两次往返。先 COUNT，再 SELECT 顶 N 条。
    const [cntRows] = await pool.query(
      'SELECT COUNT(*) AS total FROM `dcim-alarmlist` WHERE create_time > ? AND status = 1',
      [cursor]
    );
    const total = Number(cntRows[0] && cntRows[0].total) || 0;
    if (total === 0) return { total: 0, items: [], cursor: cursor };
    const [rows] = await pool.query(
      'SELECT id, AlarmLevel, TextMessage, create_time '
      + 'FROM `dcim-alarmlist` WHERE create_time > ? AND status = 1 '
      + 'ORDER BY id ASC LIMIT ?',
      [cursor, Number(limit) || 5]
    );
    const items = (rows || []).map(function (r) {
      return {
        id: r.id,
        level: r.AlarmLevel,
        text: String(r.TextMessage == null ? '' : r.TextMessage).trim(),
        time: r.create_time,
      };
    });
    return { total: total, items: items, cursor: cursor };
  }

  // SmsContent=4 用：解析 SmsParamId（JSON 数组 [{id, paramKey}, ...]），
  // 按 dcim-paramcollectvalview 的 (DevId=id, AlarmKey=paramKey) 联合定位行，
  // 从 LastReceiveData（Python dict 字符串："{'温度': '333.3(℃)', '湿度': '0.0(%)'}"）里抠出对应 paramKey 的值。
  // 查不到的项静默跳过；返回 [{ devId, deviceName, paramKey, value }]
  async function fetchParamValues(smsParamIdRaw) {
    const pool = getDbPool();
    if (!pool) throw new Error('数据库未连接');
    let list;
    try {
      list = JSON.parse(String(smsParamIdRaw || '[]'));
    } catch (_e) {
      list = [];
    }
    if (!Array.isArray(list) || !list.length) return [];

    // 一次性把所有需要的 (DevId, AlarmKey) 行拉回来，避免逐条查
    const devIds = Array.from(new Set(list.map(function (it) { return Number(it && it.id); })
      .filter(function (n) { return Number.isInteger(n) && n > 0; })));
    if (!devIds.length) return [];
    const placeholders = devIds.map(function () { return '?'; }).join(',');
    const [rows] = await pool.query(
      'SELECT DevId, AlarmKey, DeviceName, LastReceiveData '
      + 'FROM `dcim-paramcollectvalview` '
      + 'WHERE DevId IN (' + placeholders + ') AND status = 1',
      devIds
    );
    // 按 (DevId, AlarmKey) 建索引：同一设备下不同 AlarmKey 的行其 LastReceiveData 通常一样，
    // 但严格按行匹配能避免歧义
    const idx = new Map();
    (rows || []).forEach(function (r) {
      const key = String(r.DevId) + '|' + String(r.AlarmKey || '');
      idx.set(key, r);
    });

    // Python dict 风格 → JS：单引号转双引号，再 JSON.parse
    function parsePyDict(raw) {
      if (raw == null) return null;
      const s = String(raw).trim();
      if (!s) return null;
      try { return JSON.parse(s.replace(/'/g, '"')); } catch (_e) { return null; }
    }

    const out = [];
    for (const it of list) {
      const devId = Number(it && it.id);
      const paramKey = String(it && it.paramKey || '').trim();
      if (!Number.isInteger(devId) || devId <= 0 || !paramKey) continue;
      // 先按 (devId, paramKey) 精确找；如果同设备多行但 AlarmKey 不一样，退化为该设备任一行
      let hit = idx.get(devId + '|' + paramKey);
      if (!hit) {
        for (const r of (rows || [])) {
          if (Number(r.DevId) === devId) { hit = r; break; }
        }
      }
      if (!hit) continue;       // 静默跳过：库里没有这个 DevId
      const dict = parsePyDict(hit.LastReceiveData);
      if (!dict || !(paramKey in dict)) continue;   // 静默跳过：dict 里没这个 paramKey
      out.push({
        devId: devId,
        deviceName: String(hit.DeviceName || '').trim() || ('设备#' + devId),
        paramKey: paramKey,
        value: String(dict[paramKey]),
      });
    }
    return out;
  }

  // 按 SmsContent 类型生成短信文本
  // 1 = 告警数量  2 = 详细告警  3 = 定制内容  4 = 参数
  async function buildContent(row) {
    const type = Number(row.SmsContent);
    const pad = function (n) { return String(n).padStart(2, '0'); };
    const now = new Date();
    const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
      + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());

    if (type === 1) {
      const cnt = await countTodayAlarms();
      return '《整点告警通报》截至' + stamp + ','
        + '今日告警' + cnt.total + '条，'
        + '未解除告警' + cnt.unresolved + '条，'
        + '已解除告警' + cnt.resolved + '条。';
    }

    if (type === 2) {
      const result = await fetchNewAlarmsSince(row.LastSmsAlarmTime, 5);
      if (result.total === 0) {
        // 实际上 evaluateGuards 已经在调度路径里把"无新告警"挡掉了，
        // 走到这里只可能是手动触发（skipGuard）或者 preview 接口
        return '《整点告警通报》截至' + stamp + '，本时段无新增告警。';
      }
      // 单条短信：抬头 + 最多 5 条 + 末尾折叠提示
      const head = '《整点告警通报》截至' + stamp + '，本时段新增告警 ' + result.total + ' 条：';
      const lines = result.items.map(function (it, idx) {
        // TextMessage 已含设备/区域/类型/等级/时间/当前值等关键字段，直接用
        const text = it.text || ('告警 #' + it.id);
        return (idx + 1) + '.' + text;
      });
      let body = lines.join('；');
      if (result.total > result.items.length) {
        body += '；…还有 ' + (result.total - result.items.length) + ' 条';
      }
      return head + body + '。';
    }

    if (type === 4) {
      const items = await fetchParamValues(row.SmsParamId);
      if (!items.length) {
        // SmsParamId 为空 / JSON 格式坏 / 全部查不到 → 兜底文案
        return '《整点参数报告》截至' + stamp + '，本时段参数查询为空。';
      }
      // 拼成「设备名-参数名=值」用「; 」分隔
      const body = items.map(function (it) {
        return it.deviceName + '-' + it.paramKey + '=' + it.value;
      }).join('; ');
      return '《整点参数报告》截至' + stamp + '：' + body + '。';
    }

    // 默认（含 type=3 / 未实现的类型）走定制内容
    const text = String(row.SmsCustomContent || '').trim();
    if (!text) {
      throw new Error(type === 3
        ? 'SmsCustomContent 为空（请先在 system-parameter-sms 页面填写定制内容）'
        : 'SmsContent=' + type + ' 暂未实现，且 SmsCustomContent 为空');
    }
    return text;
  }

  // 实际发送：复用 push 模块的 sendOne，写入 history，记 source=scheduled
  async function doSend(row, trigger) {
    const phones = parsePhones(row.SmsTargetPhone);
    if (!phones.length) throw new Error('SmsTargetPhone 为空');
    if (typeof global.__smsPushSendOne !== 'function') {
      throw new Error('短信推送模块未加载');
    }
    if (typeof global.__smsPushIsEnabled === 'function' && !global.__smsPushIsEnabled()) {
      throw new Error('推送总开关已关闭（请先在「推送设置」中开启）');
    }
    const text = await buildContent(row);
    return global.__smsPushSendOne({
      to: phones,
      text: text,
      type: 'SMS',
    }, 'scheduled-' + (trigger || 'tick'));
  }

  // 写回 LastSmsAlarmTime = NOW()
  async function writeBack() {
    const pool = getDbPool();
    if (!pool) return;
    try {
      await pool.query(
        'UPDATE `' + TABLE + '` SET LastSmsAlarmTime = NOW() WHERE id = 1'
      );
    } catch (err) {
      appendLog(`写回 LastSmsAlarmTime 失败：${err.message}`);
    }
  }

  // 一次调度评估：判定条件 + 必要时发送
  // skipGuard=true 表示手动触发，不看 SmsOnhourAlarm/SmsTime/防重，强行发一条
  async function evaluateAndMaybeSend(trigger, skipGuard) {
    lastTickAt = localStamp();
    let row;
    try {
      row = await readParam();
    } catch (err) {
      pushRecent({ kind: trigger, fired: false, error: '读参数失败：' + err.message, checks: [] });
      throw err;
    }
    const guards = await evaluateGuards(row);
    if (!skipGuard && !guards.allOk) {
      const failed = guards.checks.filter(function (c) { return !c.ok; });
      pushRecent({
        kind: trigger,
        fired: false,
        skipped: true,
        reason: failed.map(function (c) { return c.label; }).join(' / '),
        checks: guards.checks,
      });
      return { fired: false, checks: guards.checks };
    }

    let entry;
    try {
      entry = await doSend(row, trigger);
    } catch (err) {
      pushRecent({
        kind: trigger,
        fired: false,
        error: err.message,
        checks: guards.checks,
        skipGuard: !!skipGuard,
      });
      throw err;
    }
    await writeBack();
    totalSent += 1;
    lastSendAt = localStamp();
    pushRecent({
      kind: trigger,
      fired: true,
      skipGuard: !!skipGuard,
      entryId: entry && entry.id,
      to: (entry && entry.to) || [],
      checks: guards.checks,
    });
    appendLog(`${skipGuard ? '手动触发' : '整点触发'} 已下发 id=${entry && entry.id} to=${(entry && entry.to || []).join(',')}`);
    return { fired: true, entry: entry, checks: guards.checks };
  }

  function scheduleTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    timer = setInterval(function () {
      evaluateAndMaybeSend('tick', false).then(function () {
        lastError = '';
      }).catch(function (err) {
        lastError = err.message;
        appendLog(`tick 失败：${err.message}`);
      });
    }, POLL_MS);
  }

  function publicState() {
    return {
      pollMs: POLL_MS,
      dedupStrategy: 'same-hour',
      lastTickAt: lastTickAt,
      lastSendAt: lastSendAt,
      lastError: lastError,
      totalSent: totalSent,
      totalFailed: totalFailed,
    };
  }

  // ===== HTTP 接口 =====
  // GET：返回 dcim-alarmparam 当前快照 + 调度状态 + 4 项预检明细 + 下次预计触发时间
  app.get('/api/sms/scheduled/config', async function (_req, res) {
    try {
      const row = await readParam();
      const guards = await evaluateGuards(row);
      const next = nextExpected(row);
      // 预览文本：如果生成失败（比如 SmsContent=1 时 DB 查询失败），不让整个接口挂掉，
      // 把错误信息塞进 preview 字段让前端能展示
      let preview = '';
      let previewError = '';
      try {
        preview = await buildContent(row);
      } catch (err) {
        previewError = err.message;
      }
      res.json({
        ok: true,
        param: {
          id: row.id,
          SmsOnhourAlarm: row.SmsOnhourAlarm,
          SmsContent: row.SmsContent,
          SmsCustomContent: row.SmsCustomContent || '',
          SmsTargetPhone: row.SmsTargetPhone || '',
          SmsTime: row.SmsTime || '',
          LastSmsAlarmTime: row.LastSmsAlarmTime,
          parsedHours: parseHours(row.SmsTime),
          parsedPhones: parsePhones(row.SmsTargetPhone),
        },
        guards: guards,
        next: next,
        preview: preview,
        previewError: previewError,
        state: publicState(),
        currentHour: new Date().getHours(),
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // GET：最近 N 条调度记录（默认全量返回，按时间倒序）
  app.get('/api/sms/scheduled/recent', function (_req, res) {
    res.json({ ok: true, items: recent.slice().reverse() });
  });

  // POST：手动触发一次（不看开关、不看小时、不看防重间隔）
  app.post('/api/sms/scheduled/trigger', async function (_req, res) {
    try {
      const r = await evaluateAndMaybeSend('manual', true);
      res.json({ ok: true, fired: r.fired, entry: r.entry, state: publicState() });
    } catch (err) {
      totalFailed += 1;
      lastError = err.message;
      appendLog(`手动触发失败：${err.message}`);
      res.status(500).json({ ok: false, message: err.message, state: publicState() });
    }
  });

  scheduleTimer();
  appendLog(`定时短信调度启动：每 ${POLL_MS / 1000}s 评估一次，按整点小时去重`);
})();

const port = Number(process.env.PORT || 3000);
server.listen(port, function () {
  console.log('Web SSH running at http://0.0.0.0:' + port);
});
