#!/usr/bin/env node
// 一次性增量部署脚本：把串口调试新功能推送到目标服务器并重启服务
// 使用方式（bash）：
//   WEBSSH_DEPLOY_PASS='<password>' node scripts/deploy-upgrade.js
// 可选环境变量：
//   WEBSSH_HOST          目标主机，默认 192.168.50.10
//   WEBSSH_PORT          SSH 端口，默认 22
//   WEBSSH_USER          SSH 用户，默认 root
//   WEBSSH_INSTALL_DIR   远端安装目录，默认 /opt/webssh
//   WEBSSH_SERVICE       systemd 服务名，默认 webssh
//   WEBSSH_HTTP_PORT     /health 检查端口，默认 3010

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Client } = require('ssh2');

const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.WEBSSH_HOST || '192.168.50.10';
const PORT = Number(process.env.WEBSSH_PORT || 22);
const USER = process.env.WEBSSH_USER || 'root';
const INSTALL_DIR = process.env.WEBSSH_INSTALL_DIR || '/opt/webssh';
const SERVICE = process.env.WEBSSH_SERVICE || 'webssh';
const HTTP_PORT = Number(process.env.WEBSSH_HTTP_PORT || 3010);
const PASSWORD = process.env.WEBSSH_DEPLOY_PASS;

if (!PASSWORD) {
  console.error('错误：需要设置环境变量 WEBSSH_DEPLOY_PASS');
  process.exit(1);
}

// 需要同步到远端 /opt/webssh/app/ 的条目（相对项目根路径）
// 完整部署：包含 server.js、package*.json、完整 node_modules、index.html、serial/、sms/、ha/、proto-conv/
const PAYLOAD_ENTRIES = [
  'server.js',
  'index.html',
  'login.html',
  'package.json',
  'package-lock.json',
  'serial',
  'sms',
  'ha',
  'proto-conv',
  'node_modules',
];

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function buildTar() {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const tarName = `webssh-upgrade-${stamp}.tar.gz`;
  const tarPath = path.join(os.tmpdir(), tarName);
  log(`本地打包：${tarPath}`);
  for (const entry of PAYLOAD_ENTRIES) {
    if (!fs.existsSync(path.join(ROOT, entry))) {
      throw new Error(`缺少待上传内容：${entry}`);
    }
  }
  // 用系统自带的 tar（Git for Windows 自带 GNU tar）
  // Windows 下要 --force-local，否则 "C:\..." 会被当成远端主机
  const tarArgs = process.platform === 'win32'
    ? ['--force-local', '-czf', tarPath, '-C', ROOT, ...PAYLOAD_ENTRIES]
    : ['-czf', tarPath, '-C', ROOT, ...PAYLOAD_ENTRIES];
  execFileSync('tar', tarArgs, { stdio: 'inherit' });
  const sha = crypto.createHash('sha256').update(fs.readFileSync(tarPath)).digest('hex');
  log(`tar 大小：${(fs.statSync(tarPath).size / 1024).toFixed(1)} KB  sha256=${sha.slice(0, 16)}...`);
  return { tarPath, tarName, sha };
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
        readyTimeout: 15000,
        // 关闭 keepalive 打印噪音
        keepaliveInterval: 10000,
      });
  });
}

function exec(conn, cmd, { allowNonZero = false } = {}) {
  return new Promise((resolve, reject) => {
    log(`远端 $ ${cmd}`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream
        .on('close', (code) => {
          if (stdout.trim()) process.stdout.write(stdout);
          if (stderr.trim()) process.stderr.write(stderr);
          if (code !== 0 && !allowNonZero) {
            return reject(new Error(`命令失败（exit=${code}）: ${cmd}`));
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
      log(`上传 ${path.basename(localPath)} → ${remotePath}`);
      sftp.fastPut(localPath, remotePath, { step: (transferred, _chunk, total) => {
        if (total && transferred === total) {
          process.stdout.write(`  上传完成 ${(total / 1024).toFixed(1)} KB\n`);
        }
      } }, (putErr) => {
        if (putErr) return reject(putErr);
        resolve();
      });
    });
  });
}

async function main() {
  const { tarPath, tarName, sha } = buildTar();
  const remoteTar = `/root/${tarName}`;
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const backupDir = `${INSTALL_DIR}/app.bak-${stamp}`;

  log(`连接 ${USER}@${HOST}:${PORT} ...`);
  const conn = await connect();
  try {
    await exec(conn, `test -d ${INSTALL_DIR}/app && echo OK || (echo 目标目录缺失 ${INSTALL_DIR}/app && exit 1)`);
    await uploadFile(conn, tarPath, remoteTar);

    // 校验上传完整性
    const { stdout: remoteSha } = await exec(conn, `sha256sum ${remoteTar} | awk '{print $1}'`);
    if (remoteSha.trim() !== sha) {
      throw new Error(`sha256 不一致，本地=${sha} 远端=${remoteSha.trim()}`);
    }
    log('sha256 校验通过');

    await exec(conn, `cp -a ${INSTALL_DIR}/app ${backupDir}`);
    log(`已备份原 app 到 ${backupDir}`);

    await exec(conn, `tar -xzf ${remoteTar} -C ${INSTALL_DIR}/app`);
    await exec(conn, `chown -R root:root ${INSTALL_DIR}/app`);

    await exec(conn, `systemctl restart ${SERVICE}`);
    await new Promise((r) => setTimeout(r, 2000));
    const status = await exec(conn, `systemctl is-active ${SERVICE}`, { allowNonZero: true });
    if (status.stdout.trim() !== 'active') {
      log('服务未 active，开始回滚 ...');
      await exec(conn, `rm -rf ${INSTALL_DIR}/app && mv ${backupDir} ${INSTALL_DIR}/app`);
      await exec(conn, `systemctl restart ${SERVICE}`, { allowNonZero: true });
      throw new Error('新版启动失败，已回滚到备份目录');
    }

    const health = await exec(conn, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${HTTP_PORT}/health`, { allowNonZero: true });
    if (health.stdout.trim() !== '200') {
      log(`/health 返回 ${health.stdout.trim()}，回滚 ...`);
      await exec(conn, `rm -rf ${INSTALL_DIR}/app && mv ${backupDir} ${INSTALL_DIR}/app`);
      await exec(conn, `systemctl restart ${SERVICE}`, { allowNonZero: true });
      throw new Error('health 检查失败，已回滚');
    }

    await exec(conn, `rm -f ${remoteTar}`);

    // 备份轮换：仅保留最近 KEEP_BACKUPS 个 app.bak-*（按文件名/时间戳倒排），其余删除
    const KEEP_BACKUPS = Number(process.env.WEBSSH_KEEP_BACKUPS || 5);
    const pruneCmd = `ls -d ${INSTALL_DIR}/app.bak-* 2>/dev/null | sort -r | tail -n +${KEEP_BACKUPS + 1} | xargs -r rm -rf`;
    const before = await exec(conn, `ls -d ${INSTALL_DIR}/app.bak-* 2>/dev/null | wc -l`, { allowNonZero: true });
    await exec(conn, pruneCmd, { allowNonZero: true });
    const after = await exec(conn, `ls -d ${INSTALL_DIR}/app.bak-* 2>/dev/null | wc -l`, { allowNonZero: true });
    log(`备份轮换：${before.stdout.trim()} → ${after.stdout.trim()}（保留最近 ${KEEP_BACKUPS} 个，可用 WEBSSH_KEEP_BACKUPS 覆盖）`);

    log('✅ 升级完成，服务运行正常');
    log(`浏览器访问：http://${HOST}:${HTTP_PORT}`);
    log(`如需手动回滚：rm -rf ${INSTALL_DIR}/app && mv ${backupDir} ${INSTALL_DIR}/app && systemctl restart ${SERVICE}`);
  } finally {
    conn.end();
    try { fs.unlinkSync(tarPath); } catch (_e) {}
  }
}

main().catch((err) => {
  console.error('部署失败:', err.message);
  process.exit(1);
});
