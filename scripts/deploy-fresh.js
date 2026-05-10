#!/usr/bin/env node
// 一键全新部署：把本地 dist/ 下的离线 tar 包推送到全新目标机并安装启动服务
//
// 使用方式（bash）：
//   WEBSSH_DEPLOY_PASS='<password>' node scripts/deploy-fresh.js
//
// 环境变量：
//   WEBSSH_HOST          目标主机，默认 192.168.0.22
//   WEBSSH_PORT          SSH 端口，默认 22
//   WEBSSH_USER          SSH 用户，默认 root
//   WEBSSH_INSTALL_DIR   远端安装目录，默认 /opt/webssh
//   WEBSSH_SERVICE       systemd 服务名，默认 webssh
//   WEBSSH_HTTP_PORT     应用监听端口，默认 3010
//   WEBSSH_TAR           指定本地 tar 包（绝对或相对路径），默认取 dist/ 下最新的
//   WEBSSH_OPEN_FIREWALL 1=自动开放 HTTP_PORT，0=不动，默认 1
//   WEBSSH_FORCE         1=若已有安装目录则备份后覆盖安装，默认 1

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');

const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.WEBSSH_HOST || '192.168.0.22';
const PORT = Number(process.env.WEBSSH_PORT || 22);
const USER = process.env.WEBSSH_USER || 'root';
const INSTALL_DIR = process.env.WEBSSH_INSTALL_DIR || '/opt/webssh';
const SERVICE = process.env.WEBSSH_SERVICE || 'webssh';
const HTTP_PORT = Number(process.env.WEBSSH_HTTP_PORT || 3010);
const OPEN_FIREWALL = process.env.WEBSSH_OPEN_FIREWALL !== '0';
const FORCE = process.env.WEBSSH_FORCE !== '0';
const PASSWORD = process.env.WEBSSH_DEPLOY_PASS;

if (!PASSWORD) {
  console.error('错误：需要设置环境变量 WEBSSH_DEPLOY_PASS');
  process.exit(1);
}

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

function pickLocalTar() {
  if (process.env.WEBSSH_TAR) {
    const p = path.isAbsolute(process.env.WEBSSH_TAR)
      ? process.env.WEBSSH_TAR
      : path.join(ROOT, process.env.WEBSSH_TAR);
    if (!fs.existsSync(p)) throw new Error(`WEBSSH_TAR 指定的文件不存在：${p}`);
    return p;
  }
  const distDir = path.join(ROOT, 'dist');
  const files = fs.readdirSync(distDir)
    .filter((n) => /^webssh-offline-linux-x64-.*\.tar\.gz$/.test(n) && !n.endsWith('.sha256'))
    .map((n) => ({ name: n, full: path.join(distDir, n), mtime: fs.statSync(path.join(distDir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) throw new Error(`dist/ 下未找到离线 tar 包`);
  return files[0].full;
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', reject)
      .connect({
        host: HOST,
        port: PORT,
        username: USER,
        password: PASSWORD,
        readyTimeout: 20000,
        keepaliveInterval: 10000,
      });
  });
}

function exec(conn, cmd, { allowNonZero = false, silent = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!silent) log(`远端 $ ${cmd}`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream
        .on('close', (code) => {
          if (!silent) {
            if (stdout.trim()) process.stdout.write(stdout);
            if (stderr.trim()) process.stderr.write(stderr);
          }
          if (code !== 0 && !allowNonZero) {
            return reject(new Error(`命令失败（exit=${code}）: ${cmd}\n${stderr}`));
          }
          resolve({ code, stdout, stderr });
        })
        .on('data', (chunk) => { stdout += chunk.toString('utf8'); })
        .stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    });
  });
}

function uploadFile(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const size = fs.statSync(localPath).size;
      log(`上传 ${path.basename(localPath)} (${(size / 1024 / 1024).toFixed(1)} MB) → ${remotePath}`);
      let lastPct = -1;
      sftp.fastPut(localPath, remotePath, {
        step: (transferred, _chunk, total) => {
          if (!total) return;
          const pct = Math.floor((transferred / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            lastPct = pct;
            process.stdout.write(`  进度 ${pct}%\n`);
          }
        },
      }, (putErr) => {
        if (putErr) return reject(putErr);
        resolve();
      });
    });
  });
}

async function main() {
  const localTar = pickLocalTar();
  const tarName = path.basename(localTar);
  const releaseName = tarName.replace(/\.tar\.gz$/, '');
  const localSha256 = sha256File(localTar);
  log(`目标：${USER}@${HOST}:${PORT}`);
  log(`本地 tar：${localTar}`);
  log(`本地 sha256：${localSha256}`);

  const remoteTar = `/root/${tarName}`;
  const remoteWork = `/root/${releaseName}`;

  const conn = await connect();
  try {
    // 前置环境检查
    const uname = await exec(conn, 'uname -a');
    const hasSystemctl = await exec(conn, 'command -v systemctl >/dev/null 2>&1 && echo yes || echo no');
    if (hasSystemctl.stdout.trim() !== 'yes') {
      throw new Error('目标机缺少 systemctl，无法安装 systemd 服务');
    }
    void uname;

    // 如果已有旧装，按 FORCE 策略处理
    const existing = await exec(conn, `test -d ${INSTALL_DIR} && echo exists || echo none`);
    if (existing.stdout.trim() === 'exists') {
      if (!FORCE) {
        throw new Error(`远端已存在 ${INSTALL_DIR}，设 WEBSSH_FORCE=1 才允许覆盖`);
      }
      const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      await exec(conn, `systemctl stop ${SERVICE} 2>/dev/null || true`);
      await exec(conn, `mv ${INSTALL_DIR} ${INSTALL_DIR}.bak-${stamp}`);
      log(`已将旧安装目录备份为 ${INSTALL_DIR}.bak-${stamp}`);
    }

    // 上传 tar 并校验
    await exec(conn, `rm -f ${remoteTar}`);
    await uploadFile(conn, localTar, remoteTar);
    const remoteSha = await exec(conn, `sha256sum ${remoteTar} | awk '{print $1}'`);
    if (remoteSha.stdout.trim() !== localSha256) {
      throw new Error(`sha256 不一致：本地=${localSha256} 远端=${remoteSha.stdout.trim()}`);
    }
    log('sha256 校验通过');

    // 解压到 /root 下
    await exec(conn, `rm -rf ${remoteWork}`);
    await exec(conn, `tar -xzf ${remoteTar} -C /root`);
    await exec(conn, `test -d ${remoteWork} && test -x ${remoteWork}/runtime/node/bin/node && test -d ${remoteWork}/app/node_modules && echo 包结构 OK`);

    // 执行安装
    await exec(conn, `chmod +x ${remoteWork}/scripts/*.sh`);
    await exec(conn, `${remoteWork}/scripts/install.sh --install-dir ${INSTALL_DIR} --service-name ${SERVICE} --port ${HTTP_PORT}`);

    // 防火墙
    if (OPEN_FIREWALL) {
      const fwActive = await exec(conn, `systemctl is-active firewalld 2>/dev/null || echo inactive`, { allowNonZero: true });
      if (fwActive.stdout.trim() === 'active') {
        await exec(conn, `firewall-cmd --permanent --add-port=${HTTP_PORT}/tcp && firewall-cmd --reload`);
        await exec(conn, `firewall-cmd --list-ports`);
      } else {
        log('firewalld 未启用，跳过防火墙配置');
      }
    }

    // 等待服务起来再探活
    await new Promise((r) => setTimeout(r, 2500));
    const active = await exec(conn, `systemctl is-active ${SERVICE}`, { allowNonZero: true });
    if (active.stdout.trim() !== 'active') {
      await exec(conn, `journalctl -u ${SERVICE} -n 80 --no-pager`, { allowNonZero: true });
      throw new Error(`服务未 active，实际：${active.stdout.trim()}`);
    }
    const health = await exec(conn, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${HTTP_PORT}/health`, { allowNonZero: true });
    if (health.stdout.trim() !== '200') {
      await exec(conn, `journalctl -u ${SERVICE} -n 80 --no-pager`, { allowNonZero: true });
      throw new Error(`/health 返回 ${health.stdout.trim()}`);
    }

    // 清理上传的 tar 和解压目录
    await exec(conn, `rm -f ${remoteTar}`);
    await exec(conn, `rm -rf ${remoteWork}`);

    log('✅ 部署完成');
    log(`   浏览器访问：http://${HOST}:${HTTP_PORT}`);
    log(`   运维命令：`);
    log(`     systemctl status ${SERVICE} --no-pager`);
    log(`     journalctl -u ${SERVICE} -n 100 --no-pager`);
    log(`     ${INSTALL_DIR}/scripts/status.sh`);
  } finally {
    conn.end();
  }
}

main().catch((err) => {
  console.error('部署失败:', err.message);
  process.exit(1);
});
