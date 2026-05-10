#!/usr/bin/env node
// 在目标服务器（192.168.50.10）上就地打离线 tar 包
// 产物路径：
//   - 远端：/opt/webssh/release/webssh-offline-linux-x64-v<APP_VERSION>-<stamp>.tar.gz
//   - 本地：dist/webssh-offline-linux-x64-v<APP_VERSION>-<stamp>.tar.gz（scp 拉回）
//
// 用法：
//   WEBSSH_DEPLOY_PASS='<密码>' node scripts/build-offline-on-server.js
// 环境变量：
//   WEBSSH_HOST          默认 192.168.50.10
//   WEBSSH_PORT          默认 22
//   WEBSSH_USER          默认 root
//   APP_VERSION          版本号后缀，默认取 package.json 的 version
//   WEBSSH_RELEASE_DIR   远端打包根目录，默认 /opt/webssh/release
//   WEBSSH_STAGE_ROOT    远端打包缓存目录，默认 /root/webssh-build

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.WEBSSH_HOST || '192.168.50.10';
const PORT = Number(process.env.WEBSSH_PORT || 22);
const USER = process.env.WEBSSH_USER || 'root';
const PASSWORD = process.env.WEBSSH_DEPLOY_PASS;
const RELEASE_DIR = process.env.WEBSSH_RELEASE_DIR || '/opt/webssh/release';
const STAGE_ROOT = process.env.WEBSSH_STAGE_ROOT || '/root/webssh-build';

if (!PASSWORD) {
  console.error('错误：需要设置环境变量 WEBSSH_DEPLOY_PASS');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const APP_VERSION = process.env.APP_VERSION || pkg.version || '1.0.0';
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const RELEASE_NAME = `webssh-offline-linux-x64-v${APP_VERSION}-${STAMP}`;
const STAGE_DIR = `${STAGE_ROOT}/${RELEASE_NAME}`;
const ARCHIVE_PATH = `${RELEASE_DIR}/${RELEASE_NAME}.tar.gz`;
const ARCHIVE_SHA = `${ARCHIVE_PATH}.sha256`;

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', reject)
      .connect({ host: HOST, port: PORT, username: USER, password: PASSWORD, readyTimeout: 15000, keepaliveInterval: 10000 });
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

function downloadFile(conn, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      log(`下载 ${remotePath} → ${localPath}`);
      sftp.fastGet(remotePath, localPath, (getErr) => {
        if (getErr) return reject(getErr);
        resolve();
      });
    });
  });
}

async function main() {
  log(`版本：${APP_VERSION}    构建时间：${STAMP}`);
  log(`连接 ${USER}@${HOST}:${PORT} ...`);
  const conn = await connect();

  try {
    // 前置检查：app/node_modules / runtime / /opt/webssh 下的 scripts systemd 都要就位
    await exec(conn, `test -d /opt/webssh/app && test -d /opt/webssh/app/node_modules && test -x /opt/webssh/runtime/node/bin/node && test -f /opt/webssh/scripts/install.sh && test -f /opt/webssh/systemd/webssh.service.template && echo 前置检查通过`);

    // 准备打包目录
    await exec(conn, `mkdir -p ${STAGE_ROOT} ${RELEASE_DIR}`);
    await exec(conn, `rm -rf ${STAGE_DIR}`);
    await exec(conn, `mkdir -p ${STAGE_DIR}/app ${STAGE_DIR}/runtime ${STAGE_DIR}/scripts ${STAGE_DIR}/systemd ${STAGE_DIR}/config ${STAGE_DIR}/logs ${STAGE_DIR}/run`);

    // app 内容（当前正在运行的版本）
    await exec(conn, `cp -a /opt/webssh/app/server.js /opt/webssh/app/index.html /opt/webssh/app/package.json /opt/webssh/app/package-lock.json ${STAGE_DIR}/app/`);
    await exec(conn, `cp -a /opt/webssh/app/serial ${STAGE_DIR}/app/ 2>/dev/null || true`);
    await exec(conn, `cp -a /opt/webssh/app/node_modules ${STAGE_DIR}/app/`);
    // README.txt 可选
    await exec(conn, `cp -a /opt/webssh/app/README.txt ${STAGE_DIR}/app/ 2>/dev/null || true`);

    // scripts / systemd 直接从 /opt/webssh 下拷（install.sh 已经把它们铺到这里）
    await exec(conn, `cp -a /opt/webssh/scripts/. ${STAGE_DIR}/scripts/`);
    await exec(conn, `cp -a /opt/webssh/systemd/. ${STAGE_DIR}/systemd/`);
    // config 需要的是 .env.example 模板；如果 /opt/webssh/config 里没有，就从 install.sh 留下的运行态 .env 里不要，而是用仓库里的 .env.example
    await exec(conn, `if [ -f /opt/webssh/config/.env.example ]; then cp -a /opt/webssh/config/.env.example ${STAGE_DIR}/config/; else echo 缺 .env.example 模板，需先放到 /opt/webssh/config/; exit 1; fi`);

    // Node runtime（官方目录整包）
    await exec(conn, `cp -a /opt/webssh/runtime/node ${STAGE_DIR}/runtime/node`);

    // 清除可能被打进来的 glibc 污染（防 GLIBC_PRIVATE 问题）
    await exec(conn, `find ${STAGE_DIR}/runtime/node \\( -name 'libc.so.6' -o -name 'ld-linux-x86-64.so.2' \\) -print -delete || true`);

    // 关键结构检查
    await exec(conn, `test -f ${STAGE_DIR}/app/server.js && test -d ${STAGE_DIR}/app/node_modules && test -x ${STAGE_DIR}/runtime/node/bin/node && test -f ${STAGE_DIR}/scripts/install.sh && test -f ${STAGE_DIR}/systemd/webssh.service.template && echo "结构检查通过"`);

    // 打 tar.gz 和 sha256（sha256 里只写文件名，便于在目标机同目录下直接 sha256sum -c 校验）
    await exec(conn, `tar -czf ${ARCHIVE_PATH} -C ${STAGE_ROOT} ${RELEASE_NAME}`);
    await exec(conn, `cd ${RELEASE_DIR} && sha256sum ${RELEASE_NAME}.tar.gz > ${RELEASE_NAME}.tar.gz.sha256`);

    // 列一下产物
    await exec(conn, `ls -lh ${ARCHIVE_PATH} ${ARCHIVE_SHA}`);
    const stat = await exec(conn, `du -sh ${STAGE_DIR}; tar -tzf ${ARCHIVE_PATH} | wc -l`, { silent: true });
    process.stdout.write('  stage 大小 / 条目数：\n    ' + stat.stdout.trim().replace(/\n/g, '\n    ') + '\n');

    // 清理 stage
    await exec(conn, `rm -rf ${STAGE_DIR}`);

    // 下载到本地 dist/
    const localDist = path.join(ROOT, 'dist');
    if (!fs.existsSync(localDist)) fs.mkdirSync(localDist, { recursive: true });
    const localTar = path.join(localDist, `${RELEASE_NAME}.tar.gz`);
    const localSha = path.join(localDist, `${RELEASE_NAME}.tar.gz.sha256`);
    await downloadFile(conn, ARCHIVE_PATH, localTar);
    await downloadFile(conn, ARCHIVE_SHA, localSha);

    log('✅ 打包完成');
    log(`远端产物：${ARCHIVE_PATH}`);
    log(`本地产物：${localTar}`);
    log('');
    log('目标机离线安装步骤：');
    log(`  scp ${path.basename(localTar)} root@<host>:/root/`);
    log(`  scp ${path.basename(localSha)} root@<host>:/root/`);
    log(`  ssh root@<host>`);
    log(`  cd /root && sha256sum -c ${path.basename(localSha)}`);
    log(`  tar -xzf ${path.basename(localTar)}`);
    log(`  cd ${RELEASE_NAME} && chmod +x scripts/*.sh`);
    log(`  ./scripts/install.sh --install-dir /opt/webssh --service-name webssh --port 3010`);
  } finally {
    conn.end();
  }
}

main().catch((err) => {
  console.error('打包失败:', err.message);
  process.exit(1);
});
