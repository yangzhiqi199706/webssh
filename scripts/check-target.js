#!/usr/bin/env node
// 一次性探测脚本：摸清 192.168.0.22 上的 Python 环境与既有安装状态
// 用法: WEBSSH_DEPLOY_PASS='REDACTED_DEPLOY_PASS' node scripts/check-target.js
'use strict';
const { Client } = require('ssh2');

const HOST = process.env.WEBSSH_HOST || '192.168.0.22';
const PORT = Number(process.env.WEBSSH_PORT || 22);
const USER = process.env.WEBSSH_USER || 'root';
const PASSWORD = process.env.WEBSSH_DEPLOY_PASS;

if (!PASSWORD) {
  console.error('错误：需要设置环境变量 WEBSSH_DEPLOY_PASS');
  process.exit(1);
}

function exec(conn, cmd) {
  return new Promise((resolve) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return resolve({ ok: false, err: String(err), stdout: '', stderr: '' });
      let stdout = '';
      let stderr = '';
      stream
        .on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }))
        .on('data', (d) => { stdout += d.toString(); })
        .stderr.on('data', (d) => { stderr += d.toString(); });
    });
  });
}

const conn = new Client();
conn.on('ready', async () => {
  console.log(`✓ 已连接 ${USER}@${HOST}:${PORT}\n`);
  const probes = [
    ['系统信息', 'uname -a; cat /etc/os-release | head -5'],
    ['glibc 版本', 'ldd --version | head -1'],
    ['python3', 'which python3; python3 --version 2>&1'],
    ['pip3', 'which pip3; pip3 --version 2>&1 || echo PIP3_MISSING'],
    ['python3-venv', 'dpkg -l python3-venv 2>/dev/null | tail -1 || rpm -q python3-venv 2>/dev/null || echo VENV_UNKNOWN'],
    ['/opt/webssh 状态', 'ls -la /opt/webssh 2>/dev/null | head; systemctl is-active webssh 2>&1'],
    ['webssh 服务', 'systemctl status webssh --no-pager 2>&1 | head -10'],
    ['3010 端口', 'ss -lntp | grep ":3010 " || echo 3010_NOT_LISTENING'],
    ['可用磁盘', 'df -h /opt 2>/dev/null | tail -1'],
    ['网络出网', 'curl -sS -o /dev/null -w "pypi: %{http_code} (%{time_total}s)\\n" --max-time 5 https://pypi.org/simple/ 2>&1'],
  ];
  for (const [label, cmd] of probes) {
    const r = await exec(conn, cmd);
    console.log(`──── ${label} ────`);
    console.log((r.stdout || r.stderr || '(no output)').trim());
    console.log('');
  }
  conn.end();
}).on('error', (e) => {
  console.error('连接失败:', e.message);
  process.exit(2);
}).connect({
  host: HOST, port: PORT, username: USER, password: PASSWORD,
  readyTimeout: 15000, keepaliveInterval: 10000,
});
