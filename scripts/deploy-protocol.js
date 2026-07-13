#!/usr/bin/env node
// deploy-protocol.js —— 一键部署"协议助手"到目标机
//
// 做的事情：
//   1. 本地把以下素材打包成 webssh-protocol-<stamp>.tar.gz：
//      - .offline-downloads/cpython-*.tar.gz       -> runtime/
//      - .offline-downloads/wheels/*.whl           -> wheels/
//      - protocol_app/                             -> protocol_app/
//      - systemd/webssh-protocol.service.template  -> systemd/
//      - scripts/install-protocol.sh               -> install-protocol.sh
//   2. 同步主壳改动到目标机 /opt/webssh/app/：
//      - server.js, index.html, package.json, package-lock.json
//      - node_modules/http-proxy/ 以及它在 package-lock 里牵扯的子模块
//   3. SSH 推送 tar 包到 /root/，sha256 校验
//   4. 解压到 /root/webssh-protocol-<stamp>/，运行 install-protocol.sh
//   5. 重启 webssh 主服务，分别探活 /health 和 /protocol/
//
// 用法（PowerShell / Git Bash）：
//   $env:WEBSSH_DEPLOY_PASS = 'REDACTED_DEPLOY_PASS'        # PowerShell
//   export WEBSSH_DEPLOY_PASS='REDACTED_DEPLOY_PASS'        # Bash
//   node scripts/deploy-protocol.js
//
// 环境变量（一般不动）：
//   WEBSSH_HOST          默认 192.168.0.22
//   WEBSSH_USER          默认 root
//   WEBSSH_PORT          默认 22
//   WEBSSH_INSTALL_DIR   默认 /opt/webssh
//   WEBSSH_SERVICE       默认 webssh
//   WEBSSH_HTTP_PORT     默认 3010
//   WEBSSH_PROTO_SERVICE 默认 webssh-protocol
//   WEBSSH_PROTO_PORT    默认 5000
//   PROTOCOL_PREFIX      默认 /protocol
//   SKIP_BUILD           1=跳过本地打包，直接用 dist/ 下最新的 protocol tar
//   SKIP_MAIN_SYNC       1=跳过主壳代码同步（仅推协议助手）

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Client } = require('ssh2');

const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.WEBSSH_HOST || '192.168.0.22';
const PORT = Number(process.env.WEBSSH_PORT || 22);
const USER = process.env.WEBSSH_USER || 'root';
const INSTALL_DIR = process.env.WEBSSH_INSTALL_DIR || '/opt/webssh';
const SERVICE = process.env.WEBSSH_SERVICE || 'webssh';
const HTTP_PORT = Number(process.env.WEBSSH_HTTP_PORT || 3010);
const PROTO_SERVICE = process.env.WEBSSH_PROTO_SERVICE || 'webssh-protocol';
const PROTO_PORT = Number(process.env.WEBSSH_PROTO_PORT || 5000);
const PROTOCOL_PREFIX = process.env.PROTOCOL_PREFIX || '/protocol';
const SKIP_BUILD = process.env.SKIP_BUILD === '1';
const SKIP_MAIN_SYNC = process.env.SKIP_MAIN_SYNC === '1';
const PASSWORD = process.env.WEBSSH_DEPLOY_PASS;

if (!PASSWORD) {
  console.error('错误：需要设置环境变量 WEBSSH_DEPLOY_PASS');
  process.exit(1);
}

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }
function die(m) { console.error('[失败] ' + m); process.exit(1); }

function protocolMainSyncEntries() {
  return [
    'server.js',
    'index.html',
    'login.html',
    'package.json',
    'package-lock.json',
    'lib',
    'video',
  ];
}

const MAIN_SYNC_ENTRIES = protocolMainSyncEntries();

function createMainSyncDirectorySwap(mainSync, appDir, entry, stamp) {
  const requiredFiles = entry === 'lib'
    ? ['dcim-wvp.js', 'dcim-wvp-runtime.js']
    : entry === 'video'
      ? ['index.html', 'assets/js/video-runtime.js', 'assets/css/style.css']
      : null;
  if (!requiredFiles) throw new Error('不支持的主壳目录切换: ' + entry);
  const source = `${mainSync}/${entry}`;
  const target = `${appDir}/${entry}`;
  const staged = `${appDir}/.${entry}.stage-${stamp}`;
  const backup = `${appDir}/.${entry}.backup-${stamp}`;
  const checks = requiredFiles.map((file) => `test -f ${staged}/${file}`).join(' && ');
  return {
    entry: entry,
    staged: staged,
    backup: backup,
    stage: `rm -rf ${staged}; if ! test -d ${source} || ! cp -a ${source} ${staged} || ! (${checks}); then rm -rf ${staged}; exit 1; fi`,
    switch: `if [ -e ${backup} ]; then rm -rf ${backup}; fi; if [ -e ${target} ]; then mv ${target} ${backup}; fi; if mv ${staged} ${target} && test -d ${target}; then true; else if [ -e ${backup} ]; then rm -rf ${target}; mv ${backup} ${target}; else rm -rf ${target}; fi; rm -rf ${staged}; exit 1; fi`,
    rollback: `if [ -e ${backup} ]; then rm -rf ${target} && mv ${backup} ${target}; else rm -rf ${target}; fi; rm -rf ${staged}`,
    cleanup: `rm -rf ${backup} ${staged}`,
  };
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function requireFile(p, label) {
  if (!fs.existsSync(p)) die(`缺少 ${label || p}`);
}

// -------------------- 本地打包 --------------------
function buildPackage() {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const releaseName = `webssh-protocol-${stamp}`;
  const stageRoot = path.join(ROOT, '.offline-build');
  const releaseDir = path.join(stageRoot, releaseName);
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
  if (!fs.existsSync(stageRoot)) fs.mkdirSync(stageRoot, { recursive: true });
  if (fs.existsSync(releaseDir)) {
    log('清理旧 stage 目录...');
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
  fs.mkdirSync(releaseDir, { recursive: true });

  // 1) Python tarball
  const dlDir = path.join(ROOT, '.offline-downloads');
  const pyTars = fs.readdirSync(dlDir).filter(n => /^cpython-.*-x86_64-unknown-linux-gnu-install_only\.tar\.gz$/.test(n));
  if (!pyTars.length) die('未找到 .offline-downloads/cpython-*.tar.gz');
  const pyTar = pyTars.sort().pop();
  log(`Python 运行时: ${pyTar}`);
  fs.mkdirSync(path.join(releaseDir, 'runtime'));
  fs.copyFileSync(path.join(dlDir, pyTar), path.join(releaseDir, 'runtime', pyTar));

  // 2) wheels
  const wheelsSrc = path.join(dlDir, 'wheels');
  requireFile(wheelsSrc, '.offline-downloads/wheels/');
  const wheels = fs.readdirSync(wheelsSrc).filter(n => n.endsWith('.whl'));
  if (!wheels.length) die('wheels/ 为空');
  log(`Python 依赖 wheels: ${wheels.length} 个`);
  fs.mkdirSync(path.join(releaseDir, 'wheels'));
  for (const w of wheels) {
    fs.copyFileSync(path.join(wheelsSrc, w), path.join(releaseDir, 'wheels', w));
  }

  // 3) protocol_app 源码（排除运行时数据 / __pycache__）
  log('打包 protocol_app/ 源码（排除运行时数据）...');
  copyDirFiltered(path.join(ROOT, 'protocol_app'), path.join(releaseDir, 'protocol_app'), (rel) => {
    // rel 是相对 protocol_app 的路径
    if (rel.split(/[\\/]/)[0] === 'uploads') return false;
    if (rel.split(/[\\/]/)[0] === 'outputs') return false;
    if (rel.split(/[\\/]/)[0] === 'downloads') return false;
    if (rel.split(/[\\/]/)[0] === 'module4_uploads') return false;
    if (rel.split(/[\\/]/)[0] === 'module4_downloads') return false;
    if (rel.endsWith('__pycache__') || rel.includes('__pycache__' + path.sep) || rel.includes('__pycache__/')) return false;
    if (rel.endsWith('.pyc')) return false;
    return true;
  });

  // 4) systemd unit 模板
  fs.mkdirSync(path.join(releaseDir, 'systemd'));
  fs.copyFileSync(
    path.join(ROOT, 'systemd', 'webssh-protocol.service.template'),
    path.join(releaseDir, 'systemd', 'webssh-protocol.service.template')
  );

  // 5) install-protocol.sh
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'install-protocol.sh'),
    path.join(releaseDir, 'install-protocol.sh')
  );

  // 6) 主壳同步素材（让 install-protocol.sh 之后由 deploy-protocol.js 走 SFTP 推送）
  if (!SKIP_MAIN_SYNC) {
    fs.mkdirSync(path.join(releaseDir, 'main-sync'));
    MAIN_SYNC_ENTRIES.forEach((entry) => {
      const source = path.join(ROOT, entry);
      const target = path.join(releaseDir, 'main-sync', entry);
      if (fs.statSync(source).isDirectory()) copyDirFiltered(source, target, () => true);
      else fs.copyFileSync(source, target);
    });
    // http-proxy 整个模块（连同它的依赖）
    fs.mkdirSync(path.join(releaseDir, 'main-sync', 'node_modules'));
    copyDirFiltered(
      path.join(ROOT, 'node_modules', 'http-proxy'),
      path.join(releaseDir, 'main-sync', 'node_modules', 'http-proxy'),
      () => true,
    );
    // http-proxy 依赖 follow-redirects, requires-port, eventemitter3
    for (const dep of ['follow-redirects', 'requires-port', 'eventemitter3']) {
      const src = path.join(ROOT, 'node_modules', dep);
      const dst = path.join(releaseDir, 'main-sync', 'node_modules', dep);
      if (fs.existsSync(src)) {
        copyDirFiltered(src, dst, () => true);
      }
    }
    // snmp-bundle：跟着主壳一起推到 /opt/webssh/app/snmp-bundle/，
    // 后端「snmp 服务」按钮需要从这里读取 rpm 文件
    const snmpBundleSrc = path.join(ROOT, 'snmp-bundle');
    if (fs.existsSync(snmpBundleSrc)) {
      copyDirFiltered(
        snmpBundleSrc,
        path.join(releaseDir, 'main-sync', 'snmp-bundle'),
        () => true,
      );
    }
    // proto-conv/：协议转换板块前端（iframe 子站资源），跟主壳一起部署到 /opt/webssh/app/proto-conv/
    const protoConvSrc = path.join(ROOT, 'proto-conv');
    if (fs.existsSync(protoConvSrc)) {
      copyDirFiltered(
        protoConvSrc,
        path.join(releaseDir, 'main-sync', 'proto-conv'),
        (rel) => {
          // 排除一些临时/缓存文件
          if (rel.endsWith('.DS_Store')) return false;
          if (rel.endsWith('__pycache__') || rel.includes('__pycache__/')) return false;
          return true;
        },
      );
    }
    // db/：数据库管理板块前端（iframe 子站，2026-07-08 新增）
    const dbSrc = path.join(ROOT, 'db');
    if (fs.existsSync(dbSrc)) {
      copyDirFiltered(
        dbSrc,
        path.join(releaseDir, 'main-sync', 'db'),
        (rel) => !rel.endsWith('.DS_Store'),
      );
    }
    // 数据库管理板块新装的 npm 驱动，必须一起打包
    ['pg', 'pg-cloudflare', 'pg-connection-string', 'pg-int8', 'pg-pool', 'pg-protocol', 'pg-types', 'pgpass', 'postgres-array', 'postgres-bytea', 'postgres-date', 'postgres-interval', 'split2', 'xtend', 'dmdb'].forEach((dep) => {
      const s = path.join(ROOT, 'node_modules', dep);
      const d = path.join(releaseDir, 'main-sync', 'node_modules', dep);
      if (fs.existsSync(s)) copyDirFiltered(s, d, () => true);
    });
  }

  // 7) 打 tar.gz
  const tarPath = path.join(distDir, `${releaseName}.tar.gz`);
  log(`打 tar.gz: ${tarPath}`);
  const tarArgs = process.platform === 'win32'
    ? ['--force-local', '-czf', tarPath, '-C', stageRoot, releaseName]
    : ['-czf', tarPath, '-C', stageRoot, releaseName];
  execFileSync('tar', tarArgs, { stdio: 'inherit' });
  log(`tar 大小: ${(fs.statSync(tarPath).size / 1024 / 1024).toFixed(1)} MB`);
  // 顺手清理 stage
  fs.rmSync(releaseDir, { recursive: true, force: true });
  return tarPath;
}

function copyDirFiltered(src, dst, filter) {
  function walk(rel) {
    const abs = path.join(src, rel);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      if (rel && !filter(rel)) return;
      fs.mkdirSync(path.join(dst, rel), { recursive: true });
      for (const name of fs.readdirSync(abs)) {
        walk(path.join(rel, name));
      }
    } else if (stat.isFile()) {
      if (!filter(rel)) return;
      fs.mkdirSync(path.dirname(path.join(dst, rel)), { recursive: true });
      fs.copyFileSync(abs, path.join(dst, rel));
    }
  }
  walk('');
}

function pickLatestProtocolTar() {
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) die('dist/ 目录不存在');
  const files = fs.readdirSync(distDir)
    .filter(n => /^webssh-protocol-\d+\.tar\.gz$/.test(n))
    .map(n => ({ name: n, full: path.join(distDir, n), mtime: fs.statSync(path.join(distDir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) die('dist/ 下未找到 webssh-protocol-*.tar.gz');
  return files[0].full;
}

// -------------------- SSH --------------------
function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn))
      .on('error', reject)
      .connect({
        host: HOST, port: PORT, username: USER, password: PASSWORD,
        readyTimeout: 20000, keepaliveInterval: 10000,
      });
  });
}

function exec(conn, cmd, { allowNonZero = false, silent = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!silent) log(`远端 $ ${cmd}`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('close', (code) => {
        if (!silent) {
          if (stdout.trim()) process.stdout.write(stdout);
          if (stderr.trim()) process.stderr.write(stderr);
        }
        if (code !== 0 && !allowNonZero) {
          return reject(new Error(`命令失败（exit=${code}）: ${cmd}\n${stderr}`));
        }
        resolve({ code, stdout, stderr });
      }).on('data', (d) => { stdout += d.toString('utf8'); })
        .stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    });
  });
}

function uploadFile(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const size = fs.statSync(localPath).size;
      log(`上传 ${path.basename(localPath)} (${(size / 1024 / 1024).toFixed(1)} MB) -> ${remotePath}`);
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
      }, (e) => e ? reject(e) : resolve());
    });
  });
}

// 递归 SFTP 上传目录
async function uploadDir(conn, localDir, remoteDir) {
  await exec(conn, `mkdir -p ${remoteDir}`, { silent: true });
  const entries = fs.readdirSync(localDir, { withFileTypes: true });
  for (const e of entries) {
    const lp = path.join(localDir, e.name);
    const rp = `${remoteDir}/${e.name}`;
    if (e.isDirectory()) {
      await uploadDir(conn, lp, rp);
    } else if (e.isFile()) {
      await uploadFile(conn, lp, rp);
    }
  }
}

// -------------------- 主流程 --------------------
async function main() {
  // 1. 准备 tar 包
  let localTar;
  if (SKIP_BUILD) {
    localTar = pickLatestProtocolTar();
    log(`SKIP_BUILD=1，复用 ${localTar}`);
  } else {
    log('打离线协议助手包...');
    localTar = buildPackage();
  }
  const tarName = path.basename(localTar);
  const releaseName = tarName.replace(/\.tar\.gz$/, '');
  const localSha = sha256File(localTar);
  log(`本地 sha256: ${localSha}`);

  const remoteTar = `/root/${tarName}`;
  const remoteWork = `/root/${releaseName}`;

  // 2. 连接
  log(`连接 ${USER}@${HOST}:${PORT}...`);
  const conn = await connect();
  const directorySwaps = [];
  let mainRestartAttempted = false;
  try {
    // 前置检查
    await exec(conn, `test -d ${INSTALL_DIR} && test -d ${INSTALL_DIR}/app && test -x ${INSTALL_DIR}/runtime/node/bin/node && echo webssh 主服务已就位`);

    // 3. 上传 tar 并校验
    await exec(conn, `rm -f ${remoteTar}`);
    await uploadFile(conn, localTar, remoteTar);
    const remoteSha = await exec(conn, `sha256sum ${remoteTar} | awk '{print $1}'`);
    if (remoteSha.stdout.trim() !== localSha) {
      throw new Error(`sha256 不一致: 本地=${localSha} 远端=${remoteSha.stdout.trim()}`);
    }
    log('sha256 校验通过');

    // 4. 解压
    await exec(conn, `rm -rf ${remoteWork}`);
    await exec(conn, `tar -xzf ${remoteTar} -C /root`);
    await exec(conn, `test -d ${remoteWork} && test -f ${remoteWork}/install-protocol.sh && test -d ${remoteWork}/wheels && test -d ${remoteWork}/protocol_app && echo 包结构 OK`);

    // 5. 跑安装脚本（含 Python 解压 / pip / systemd unit / 启动 / 探活）
    await exec(conn, `chmod +x ${remoteWork}/install-protocol.sh`);
    await exec(conn, `${remoteWork}/install-protocol.sh`, { allowNonZero: false });

    // 6. 主壳代码同步（在协议助手装好之后再做，避免 Node 还没起来反代就被引）
    if (!SKIP_MAIN_SYNC) {
      const mainSync = `${remoteWork}/main-sync`;
      log('同步主壳代码（server.js / lib / video / http-proxy 模块）...');
      await exec(conn, `test -d ${mainSync} && echo main-sync OK`);
      // 备份原 app/server.js index.html，覆盖
      const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      await exec(conn, `cp -a ${INSTALL_DIR}/app/server.js ${INSTALL_DIR}/app/server.js.bak-${stamp}`);
      await exec(conn, `cp -a ${INSTALL_DIR}/app/index.html ${INSTALL_DIR}/app/index.html.bak-${stamp}`);

      for (const entry of ['lib', 'video']) {
        const swap = createMainSyncDirectorySwap(mainSync, `${INSTALL_DIR}/app`, entry, stamp);
        await exec(conn, swap.stage);
        await exec(conn, swap.switch);
        directorySwaps.push(swap);
      }
      for (const entry of MAIN_SYNC_ENTRIES) {
        const source = `${mainSync}/${entry}`;
        const target = `${INSTALL_DIR}/app/${entry}`;
        if (entry !== 'lib' && entry !== 'video') await exec(conn, `cp -f ${source} ${target}`);
      }
      // 拷 http-proxy + 它的依赖到 app/node_modules
      await exec(conn, `cp -a ${mainSync}/node_modules/. ${INSTALL_DIR}/app/node_modules/`);
      await exec(conn, `ls ${INSTALL_DIR}/app/node_modules/http-proxy/package.json && ${INSTALL_DIR}/runtime/node/bin/node -e "console.log('http-proxy', require('/opt/webssh/app/node_modules/http-proxy/package.json').version)"`);

      // snmp-bundle：覆盖到 /opt/webssh/app/snmp-bundle/（不存在则跳过）
      await exec(conn, `if [ -d ${mainSync}/snmp-bundle ]; then rm -rf ${INSTALL_DIR}/app/snmp-bundle && cp -a ${mainSync}/snmp-bundle ${INSTALL_DIR}/app/snmp-bundle && ls -la ${INSTALL_DIR}/app/snmp-bundle | head -20; else echo "main-sync 内无 snmp-bundle，跳过"; fi`, { allowNonZero: true });

      // proto-conv/：覆盖到 /opt/webssh/app/proto-conv/（协议转换板块前端 iframe 子站）
      await exec(conn, `if [ -d ${mainSync}/proto-conv ]; then if [ -d ${INSTALL_DIR}/app/proto-conv ]; then mv ${INSTALL_DIR}/app/proto-conv ${INSTALL_DIR}/app/proto-conv.bak-${stamp}; fi && cp -a ${mainSync}/proto-conv ${INSTALL_DIR}/app/proto-conv && ls ${INSTALL_DIR}/app/proto-conv/index.html >/dev/null && echo "proto-conv 已同步"; else echo "main-sync 内无 proto-conv，跳过"; fi`, { allowNonZero: true });

      // db/：覆盖到 /opt/webssh/app/db/（数据库管理板块前端 iframe 子站，2026-07-08 新增）
      await exec(conn, `if [ -d ${mainSync}/db ]; then if [ -d ${INSTALL_DIR}/app/db ]; then mv ${INSTALL_DIR}/app/db ${INSTALL_DIR}/app/db.bak-${stamp}; fi && cp -a ${mainSync}/db ${INSTALL_DIR}/app/db && ls ${INSTALL_DIR}/app/db/index.html >/dev/null && echo "db 已同步"; else echo "main-sync 内无 db，跳过"; fi`, { allowNonZero: true });

      // 重启主服务
      log(`重启 ${SERVICE} ...`);
      mainRestartAttempted = true;
      await exec(conn, `systemctl restart ${SERVICE}`);
    }

    // 7. 等服务起来再探活
    await new Promise((r) => setTimeout(r, 3000));

    log('==== 双服务最终探活 ====');
    const mainActive = await exec(conn, `systemctl is-active ${SERVICE}`, { allowNonZero: true });
    const protoActive = await exec(conn, `systemctl is-active ${PROTO_SERVICE}`, { allowNonZero: true });
    log(`${SERVICE} = ${mainActive.stdout.trim()}`);
    log(`${PROTO_SERVICE} = ${protoActive.stdout.trim()}`);

    if (mainActive.stdout.trim() !== 'active') {
      await exec(conn, `journalctl -u ${SERVICE} -n 80 --no-pager`, { allowNonZero: true });
      throw new Error(`${SERVICE} 未 active`);
    }
    if (protoActive.stdout.trim() !== 'active') {
      await exec(conn, `journalctl -u ${PROTO_SERVICE} -n 80 --no-pager`, { allowNonZero: true });
      throw new Error(`${PROTO_SERVICE} 未 active`);
    }

    const h1 = await exec(conn, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${HTTP_PORT}/health`, { allowNonZero: true });
    log(`GET http://127.0.0.1:${HTTP_PORT}/health -> ${h1.stdout.trim()}`);
    if (h1.stdout.trim() !== '200') throw new Error('webssh /health 失败');

    const h2 = await exec(conn, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PROTO_PORT}${PROTOCOL_PREFIX}/`, { allowNonZero: true });
    log(`GET http://127.0.0.1:${PROTO_PORT}${PROTOCOL_PREFIX}/ -> ${h2.stdout.trim()}`);
    if (h2.stdout.trim() !== '200') throw new Error('协议助手直连失败');

    const h3 = await exec(conn, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${HTTP_PORT}${PROTOCOL_PREFIX}/`, { allowNonZero: true });
    log(`GET http://127.0.0.1:${HTTP_PORT}${PROTOCOL_PREFIX}/ -> ${h3.stdout.trim()} (经反代)`);
    if (h3.stdout.trim() !== '200') throw new Error('协议助手反代失败');

    // 抽测一个静态资源
    const h4 = await exec(conn, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${HTTP_PORT}${PROTOCOL_PREFIX}/static/common.css`, { allowNonZero: true });
    log(`GET http://127.0.0.1:${HTTP_PORT}${PROTOCOL_PREFIX}/static/common.css -> ${h4.stdout.trim()}`);

    // 主服务和探活都已成功，才删除保留的旧 lib/video 目录。
    for (const swap of directorySwaps) {
      await exec(conn, swap.cleanup, { allowNonZero: true });
    }
    directorySwaps.length = 0;

    // 8. 清理
    await exec(conn, `rm -f ${remoteTar}`);
    await exec(conn, `rm -rf ${remoteWork}`);

    log('');
    log('✅ 部署完成');
    log(`浏览器访问: http://${HOST}:${HTTP_PORT}/ -> 左栏「协议助手」`);
  } catch (error) {
    if (directorySwaps.length) {
      log('主壳目录同步失败，恢复保留的 lib/video ...');
      for (let index = directorySwaps.length - 1; index >= 0; index--) {
        await exec(conn, directorySwaps[index].rollback, { allowNonZero: true });
      }
      if (mainRestartAttempted) {
        await exec(conn, `systemctl restart ${SERVICE}`, { allowNonZero: true });
      }
    }
    throw error;
  } finally {
    conn.end();
  }
}

main().catch(err => {
  console.error('部署失败:', err.message);
  process.exit(1);
});
