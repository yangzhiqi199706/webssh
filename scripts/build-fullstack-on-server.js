#!/usr/bin/env node
// build-fullstack-on-server.js —— 在服务器上组装"全栈离线包"
//
// 内容：
//   webssh 主壳 (含 node_modules) + Node runtime
//   协议助手 Flask (含 module4_config) + Python runtime + site-packages
//   systemd unit 模板（双服务）
//   install-all.sh（一键安装双服务）
//   .env.example
//
// 用法：
//   WEBSSH_DEPLOY_PASS='<密码>' node scripts/build-fullstack-on-server.js
//
// 环境变量：
//   WEBSSH_HOST           默认 192.168.0.22
//   WEBSSH_PORT           默认 22
//   WEBSSH_USER           默认 root
//   APP_VERSION           默认取 package.json 的 version
//   WEBSSH_RELEASE_DIR    远端打包根目录，默认 /opt/webssh/release
//   WEBSSH_STAGE_ROOT     远端打包缓存目录，默认 /root

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.WEBSSH_HOST || '192.168.0.22';
const PORT = Number(process.env.WEBSSH_PORT || 22);
const USER = process.env.WEBSSH_USER || 'root';
const PASSWORD = process.env.WEBSSH_DEPLOY_PASS;
const RELEASE_DIR = process.env.WEBSSH_RELEASE_DIR || '/opt/webssh/release';
const STAGE_ROOT = process.env.WEBSSH_STAGE_ROOT || '/root';

if (!PASSWORD) {
  console.error('错误：需要设置环境变量 WEBSSH_DEPLOY_PASS');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const APP_VERSION = process.env.APP_VERSION || pkg.version || '1.0.0';
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const RELEASE_NAME = `webssh-fullstack-offline-linux-x64-v${APP_VERSION}-${STAMP}`;
const STAGE_DIR = `${STAGE_ROOT}/${RELEASE_NAME}`;
const ARCHIVE_PATH = `${RELEASE_DIR}/${RELEASE_NAME}.tar.gz`;
const ARCHIVE_SHA = `${ARCHIVE_PATH}.sha256`;

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn))
      .on('error', reject)
      .connect({ host: HOST, port: PORT, username: USER, password: PASSWORD,
                 readyTimeout: 20000, keepaliveInterval: 10000 });
  });
}

function exec(conn, cmd, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    if (!opts.silent) log(`远端 $ ${cmd}`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let so = '', se = '';
      stream.on('close', (code) => {
        if (!opts.silent) {
          if (so.trim()) process.stdout.write(so);
          if (se.trim()) process.stderr.write(se);
        }
        if (code !== 0 && !opts.allowNonZero) {
          return reject(new Error(`exit=${code}: ${cmd}\n${se}`));
        }
        resolve({ code, stdout: so, stderr: se });
      })
      .on('data', (d) => { so += d.toString('utf8'); })
      .stderr.on('data', (d) => { se += d.toString('utf8'); });
    });
  });
}

function uploadFile(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const size = fs.statSync(localPath).size;
      log(`上传 ${path.basename(localPath)} (${(size/1024).toFixed(1)} KB) -> ${remotePath}`);
      sftp.fastPut(localPath, remotePath, (e) => e ? reject(e) : resolve());
    });
  });
}

function downloadFile(conn, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      log(`下载 ${remotePath} -> ${localPath}`);
      let lastPct = -1;
      sftp.fastGet(remotePath, localPath, {
        step: (transferred, _chunk, total) => {
          if (!total) return;
          const pct = Math.floor(transferred / total * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            lastPct = pct;
            process.stdout.write(`  下载进度 ${pct}%\n`);
          }
        }
      }, (e) => e ? reject(e) : resolve());
    });
  });
}

async function main() {
  log(`版本：${APP_VERSION}    构建时间：${STAMP}`);
  log(`目标：${USER}@${HOST}:${PORT}`);
  log(`release：${RELEASE_NAME}`);

  const conn = await connect();
  try {
    // ---------- 1. 前置检查 ----------
    await exec(conn, 'test -f /opt/webssh/app/server.js && test -d /opt/webssh/app/node_modules && test -x /opt/webssh/runtime/node/bin/node && test -f /opt/webssh/protocol/app/app.py && test -x /opt/webssh/protocol/runtime/python/bin/python3 && test -d /opt/webssh/protocol/runtime/site-packages && test -f /opt/webssh/protocol/app/module4_config/j2k2_format_config.json && echo 前置检查通过');

    // ---------- 2. 准备 stage ----------
    await exec(conn, `rm -rf ${STAGE_DIR}`);
    await exec(conn, `mkdir -p ${STAGE_DIR}/app ${STAGE_DIR}/runtime ${STAGE_DIR}/protocol/runtime ${STAGE_DIR}/systemd ${STAGE_DIR}/scripts ${STAGE_DIR}/config ${STAGE_DIR}/mediaserver ${RELEASE_DIR}`);

    // ---------- 3. 主壳 ----------
    await exec(conn, `cp -a /opt/webssh/app/server.js /opt/webssh/app/index.html /opt/webssh/app/package.json /opt/webssh/app/package-lock.json ${STAGE_DIR}/app/`);
    await exec(conn, `cp -a /opt/webssh/app/lib ${STAGE_DIR}/app/`);
    await exec(conn, `cp -a /opt/webssh/app/login.html ${STAGE_DIR}/app/ 2>/dev/null || true`);
    await exec(conn, `cp -a /opt/webssh/app/serial ${STAGE_DIR}/app/ 2>/dev/null || true`);
    await exec(conn, `cp -a /opt/webssh/app/sms ${STAGE_DIR}/app/ 2>/dev/null || true`);
    await exec(conn, `cp -a /opt/webssh/app/ha ${STAGE_DIR}/app/ 2>/dev/null || true`);
    await exec(conn, `cp -a /opt/webssh/app/proto-conv ${STAGE_DIR}/app/ 2>/dev/null || true`);
    await exec(conn, `cp -a /opt/webssh/app/video ${STAGE_DIR}/app/ 2>/dev/null || true`);
    await exec(conn, `cp -a /opt/webssh/app/db ${STAGE_DIR}/app/ 2>/dev/null || true`);
    await exec(conn, `cp -a /opt/webssh/app/snmp-bundle ${STAGE_DIR}/app/ 2>/dev/null || true`);
    await exec(conn, `cp -a /opt/webssh/app/node_modules ${STAGE_DIR}/app/`);
    await exec(conn, `cp -a /opt/webssh/app/README.txt ${STAGE_DIR}/app/ 2>/dev/null || true`);
    await exec(conn, `cp -a /opt/webssh/runtime/node ${STAGE_DIR}/runtime/node`);
    // 清理可能的 glibc 污染
    await exec(conn, `find ${STAGE_DIR}/runtime/node \\( -name 'libc.so.6' -o -name 'ld-linux-x86-64.so.2' \\) -delete || true`);

    // ---------- 4. 协议助手 ----------
    // app（剔除运行时数据 + __pycache__）
    await exec(conn, `rsync -a --exclude=uploads --exclude=outputs --exclude=downloads --exclude=module4_uploads --exclude=module4_downloads --exclude=__pycache__ --exclude='*.pyc' /opt/webssh/protocol/app/ ${STAGE_DIR}/protocol/app/`);
    // python runtime
    await exec(conn, `cp -a /opt/webssh/protocol/runtime/python ${STAGE_DIR}/protocol/runtime/python`);
    // site-packages（剔除 __pycache__）
    await exec(conn, `rsync -a --exclude=__pycache__ --exclude='*.pyc' /opt/webssh/protocol/runtime/site-packages/ ${STAGE_DIR}/protocol/runtime/site-packages/`);

    // ---------- 5. 服务器侧已有的 systemd 模板 / scripts / config ----------
    await exec(conn, `cp -a /opt/webssh/systemd/. ${STAGE_DIR}/systemd/ 2>/dev/null || true`);
    await exec(conn, `cp -a /opt/webssh/scripts/. ${STAGE_DIR}/scripts/ 2>/dev/null || true`);
    await exec(conn, `cp -a /opt/webssh/config/.env.example ${STAGE_DIR}/config/.env.example 2>/dev/null || true`);

    // ---------- 5.5 视频媒体服务（ZLMediaKit）----------
    // 优先使用服务器现有的 mediaserver/ 目录（含编译好的 MediaServer 二进制 + config.ini.example）
    // 若服务器没有，再从 .offline-downloads/ZLMediaKit/ 拉一份原包（开发期）
    const localZlmDir = path.join(ROOT, '.offline-downloads', 'ZLMediaKit');
    let zlmTarLocal = '';
    if (fs.existsSync(localZlmDir)) {
      const tars = fs.readdirSync(localZlmDir).filter(function (n) {
        return /^MediaServer.*\.tar\.gz$/i.test(n);
      });
      if (tars.length) zlmTarLocal = path.join(localZlmDir, tars.sort().pop());
    }
    // 服务器侧若有现成 mediaserver/，整目录拷过来
    const hasServerZlm = await exec(conn, `test -x /opt/webssh/mediaserver/MediaServer && echo yes || echo no`, { silent: true });
    if (hasServerZlm.stdout.trim() === 'yes') {
      log('使用服务器已编译的 MediaServer');
      await exec(conn, `rsync -a --exclude=www --exclude=record /opt/webssh/mediaserver/ ${STAGE_DIR}/mediaserver/`);
    } else if (zlmTarLocal) {
      log('上传本地 ZLMediaKit tar 进打包目录：' + path.basename(zlmTarLocal));
      await uploadFile(conn, zlmTarLocal, `${STAGE_DIR}/mediaserver/${path.basename(zlmTarLocal)}`);
    } else {
      log('⚠ 未找到 ZLMediaKit 二进制（服务器和本地 .offline-downloads/ZLMediaKit/ 都没有），打出来的全栈包将不含视频监控的媒体服务');
    }

    // 视频前端 vendor：flv.js
    const localFlvDir = path.join(ROOT, '.offline-downloads', 'flvjs');
    if (fs.existsSync(localFlvDir)) {
      const flv = path.join(localFlvDir, 'flv.min.js');
      if (fs.existsSync(flv)) {
        await exec(conn, `mkdir -p ${STAGE_DIR}/app/video/vendor`);
        await uploadFile(conn, flv, `${STAGE_DIR}/app/video/vendor/flv.min.js`);
      }
    }

    // ---------- 6. 上传缺失的本地素材 ----------
    // 用本地版本覆盖（保证模板/脚本是最新的）
    const localInstallAll    = path.join(ROOT, 'scripts', 'install-all.sh');
    const localUninstallAll  = path.join(ROOT, 'scripts', 'uninstall-all.sh');
    const localProtoUnit     = path.join(ROOT, 'systemd', 'webssh-protocol.service.template');
    const localMainUnit      = path.join(ROOT, 'systemd', 'webssh.service.template');
    const localMediaUnit     = path.join(ROOT, 'systemd', 'webssh-mediaserver.service.template');
    const localInstallProto  = path.join(ROOT, 'scripts', 'install-protocol.sh');

    await uploadFile(conn, localInstallAll,    `${STAGE_DIR}/install-all.sh`);
    await uploadFile(conn, localUninstallAll,  `${STAGE_DIR}/uninstall-all.sh`);
    await uploadFile(conn, localMainUnit,      `${STAGE_DIR}/systemd/webssh.service.template`);
    await uploadFile(conn, localProtoUnit,     `${STAGE_DIR}/systemd/webssh-protocol.service.template`);
    if (fs.existsSync(localMediaUnit)) {
      await uploadFile(conn, localMediaUnit,   `${STAGE_DIR}/systemd/webssh-mediaserver.service.template`);
    }
    await uploadFile(conn, localInstallProto,  `${STAGE_DIR}/scripts/install-protocol.sh`);

    // ---------- 7. 生成 INSTALL.md ----------
    const installMdPath = path.join(__dirname, '..', '.tmp-install.md');
    fs.writeFileSync(installMdPath, [
      '# webssh 全栈离线包安装说明',
      '',
      '## 一键安装',
      '',
      '```bash',
      'tar -xzf ' + RELEASE_NAME + '.tar.gz',
      'cd ' + RELEASE_NAME,
      'chmod +x install-all.sh',
      './install-all.sh',
      '```',
      '',
      '## 自定义端口',
      '',
      '```bash',
      'INSTALL_DIR=/opt/webssh HTTP_PORT=3010 PROTOCOL_PORT=5000 ./install-all.sh',
      '```',
      '',
      '## 验证',
      '',
      '- 主壳     `curl http://127.0.0.1:3010/health`',
      '- 协议助手 `curl http://127.0.0.1:3010/protocol/`',
      '- 浏览器   `http://<host>:3010/`  → 左栏「协议助手」',
      '',
      '## 卸载',
      '',
      '```bash',
      'systemctl stop  webssh-protocol webssh',
      'systemctl disable webssh-protocol webssh',
      'rm -f /etc/systemd/system/webssh.service /etc/systemd/system/webssh-protocol.service',
      'systemctl daemon-reload',
      'rm -rf /opt/webssh',
      '```',
      ''
    ].join('\n'));
    await uploadFile(conn, installMdPath, `${STAGE_DIR}/INSTALL.md`);
    fs.unlinkSync(installMdPath);

    // ---------- 8. 权限 ----------
    await exec(conn, `chmod +x ${STAGE_DIR}/install-all.sh ${STAGE_DIR}/uninstall-all.sh && chmod +x ${STAGE_DIR}/scripts/*.sh 2>/dev/null || true`);

    // ---------- 9. 结构验证 ----------
    await exec(conn, `test -x ${STAGE_DIR}/runtime/node/bin/node && test -x ${STAGE_DIR}/protocol/runtime/python/bin/python3 && test -d ${STAGE_DIR}/app/node_modules && test -d ${STAGE_DIR}/app/lib && test -d ${STAGE_DIR}/protocol/runtime/site-packages && test -x ${STAGE_DIR}/install-all.sh && test -x ${STAGE_DIR}/uninstall-all.sh && test -f ${STAGE_DIR}/systemd/webssh.service.template && test -f ${STAGE_DIR}/systemd/webssh-protocol.service.template && test -f ${STAGE_DIR}/protocol/app/module4_config/j2k2_format_config.json && echo 结构验证通过`);

    // ---------- 10. 大小盘点 ----------
    log('--- stage 大小盘点 ---');
    await exec(conn, `du -sh ${STAGE_DIR} ${STAGE_DIR}/app ${STAGE_DIR}/app/node_modules ${STAGE_DIR}/runtime/node ${STAGE_DIR}/protocol ${STAGE_DIR}/protocol/app ${STAGE_DIR}/protocol/runtime/python ${STAGE_DIR}/protocol/runtime/site-packages 2>/dev/null || true`);

    // ---------- 11. 打 tar.gz + sha256 ----------
    log('打 tar.gz...');
    await exec(conn, `tar -czf ${ARCHIVE_PATH} -C ${STAGE_ROOT} ${RELEASE_NAME}`);
    await exec(conn, `cd ${RELEASE_DIR} && sha256sum ${RELEASE_NAME}.tar.gz > ${RELEASE_NAME}.tar.gz.sha256`);
    await exec(conn, `ls -lh ${ARCHIVE_PATH} ${ARCHIVE_SHA}`);
    const cnt = await exec(conn, `tar -tzf ${ARCHIVE_PATH} | wc -l`, { silent: true });
    log(`tar 内条目数：${cnt.stdout.trim()}`);

    // ---------- 12. 清理 stage ----------
    await exec(conn, `rm -rf ${STAGE_DIR}`);

    // ---------- 13. 拉回本地 dist/ ----------
    const localDist = path.join(ROOT, 'dist');
    if (!fs.existsSync(localDist)) fs.mkdirSync(localDist, { recursive: true });
    const localTar = path.join(localDist, `${RELEASE_NAME}.tar.gz`);
    const localShaP = path.join(localDist, `${RELEASE_NAME}.tar.gz.sha256`);
    await downloadFile(conn, ARCHIVE_PATH, localTar);
    await downloadFile(conn, ARCHIVE_SHA,  localShaP);

    log('✅ 全栈离线包打包完成');
    console.log('');
    console.log(`远端：${ARCHIVE_PATH}`);
    console.log(`本地：${localTar}`);
    console.log('');
    console.log('目标机离线安装（一条命令）：');
    console.log(`  scp dist/${RELEASE_NAME}.tar.gz root@<host>:/root/`);
    console.log(`  ssh root@<host>`);
    console.log(`  cd /root && tar -xzf ${RELEASE_NAME}.tar.gz && cd ${RELEASE_NAME} && ./install-all.sh`);
  } finally {
    conn.end();
  }
}

main().catch((err) => {
  console.error('打包失败:', err.message);
  process.exit(1);
});
