#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("ssh2");

const HOST = process.env.WEBSSH_HOST || "192.168.50.221";
const PORT = Number(process.env.WEBSSH_PORT || 22);
const USER = process.env.WEBSSH_USER || "root";
const PASSWORD = process.env.WEBSSH_DEPLOY_PASS;
const INSTALL_DIR = process.env.WEBSSH_INSTALL_DIR || "/opt/webssh";
const HTTP_PORT = Number(process.env.WEBSSH_HTTP_PORT || 3010);
const PROTOCOL_PORT = Number(process.env.WEBSSH_PROTO_PORT || 5000);
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

function die(message) { throw new Error(message); }
function latestPackage() {
  const files = fs.readdirSync(DIST)
    .filter((name) => /^webssh-fullstack-offline-linux-arm64-v[^/]+\.tar\.gz$/.test(name))
    .map((name) => ({ name, full: path.join(DIST, name), mtime: fs.statSync(path.join(DIST, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) die("dist 中没有 ARM64 全功能 tar.gz");
  const item = files[0];
  const sha = `${item.full}.sha256`;
  if (!fs.existsSync(sha)) die(`缺少 SHA256 文件: ${sha}`);
  return { ...item, sha };
}
function connect() {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", reject);
    client.connect({ host: HOST, port: PORT, username: USER, password: PASSWORD, readyTimeout: 30000, keepaliveInterval: 10000 });
  });
}
function exec(client, command, allowNonZero = false) {
  return new Promise((resolve, reject) => {
    console.log(`远端 $ ${command}`);
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk) => { stdout += chunk.toString("utf8"); process.stdout.write(chunk); });
      stream.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); process.stderr.write(chunk); });
      stream.on("close", (code) => {
        if (code !== 0 && !allowNonZero) return reject(new Error(`远端命令失败 exit=${code}: ${command}\n${stderr}`));
        resolve({ code, stdout, stderr });
      });
    });
  });
}
function upload(client, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) return reject(error);
      const total = fs.statSync(localPath).size;
      let last = -1;
      console.log(`上传 ${path.basename(localPath)} (${(total / 1048576).toFixed(1)} MiB)`);
      sftp.fastPut(localPath, remotePath, {
        step(transferred) {
          const pct = Math.floor((transferred / total) * 100);
          if (pct % 10 === 0 && pct !== last) { last = pct; console.log(`  ${pct}%`); }
        }
      }, (putError) => putError ? reject(putError) : resolve());
    });
  });
}
async function main() {
  if (!PASSWORD) die("请设置 WEBSSH_DEPLOY_PASS");
  const pkg = latestPackage();
  const tarName = path.basename(pkg.full);
  const shaName = path.basename(pkg.sha);
  const release = tarName.replace(/\.tar\.gz$/, "");
  const remoteTar = `/root/${tarName}`;
  const remoteSha = `/root/${shaName}`;
  const remoteDir = `/root/${release}`;
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const preBackup = `/root/webssh-pre-arm64-${stamp}.tar.gz`;
  const client = await connect();
  try {
    await exec(client, "set -o pipefail; uname -m; cat /etc/os-release | head -5; systemctl is-active webssh 2>/dev/null || true; /opt/webssh/runtime/node/bin/node -p 'process.version + \"\:\" + process.arch' 2>/dev/null || true; ss -lntup | grep -E ':(3010|5000|5060|18080|18081)\\b' || true");
    await exec(client, `tar -czf ${preBackup} -C /opt webssh/config /etc/systemd/system/webssh.service /etc/systemd/system/webssh-protocol.service 2>/dev/null || true`, true);
    await exec(client, `rm -f ${remoteTar} ${remoteSha}`);
    await upload(client, pkg.full, remoteTar);
    await upload(client, pkg.sha, remoteSha);
    await exec(client, `cd /root && sha256sum -c ${shaName}`);
    await exec(client, `rm -rf ${remoteDir} && tar -xzf ${remoteTar} -C /root && test -f ${remoteDir}/install-all-arm64.sh && test -f ${remoteDir}/scripts/install-all-arm64.sh && echo PACKAGE_STRUCTURE_OK`);
    await exec(client, `cd ${remoteDir} && chmod +x install-all-arm64.sh scripts/install-all-arm64.sh && ./install-all-arm64.sh`);
    await exec(client, "set -o pipefail; echo '=== SERVICES ==='; systemctl is-active webssh webssh-protocol; echo '=== HEALTH ==='; curl -fsS http://127.0.0.1:3010/health; echo; echo '=== NODE ==='; /opt/webssh/runtime/node/bin/node -p 'process.version + \"\:\" + process.arch'; echo '=== PROTOCOL ==='; curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:5000/protocol/; curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3010/protocol/; echo '=== FEATURES ==='; cat /opt/webssh/app/runtime-features.js; echo '=== MODULES ==='; cd /opt/webssh/app && /opt/webssh/runtime/node/bin/node -e \"for (const m of ['express','ws','ssh2','http-proxy','net-snmp','mysql2','pg','dmdb']) require(m); console.log('MODULES_OK')\"; echo '=== STATIC ==='; for p in /serial/index.html /sms/index.html /ha/index.html /proto-conv/index.html /video/index.html /db/index.html; do printf \"%s \" \"$p\"; curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3010$p; done; echo '=== DCIM ==='; docker ps --format '{{.Names}} {{.Status}}' | grep '^dcim ' || true; docker exec dcim sh -lc \"ps -ef | grep -E 'ZLMediaKit|wvp|redis|mysqld' | grep -v grep || true\"; ss -lntup | grep -E ':(3010|5000|5060|18080|18081)\\b' || true");
    console.log(`部署验证通过，远端预安装备份: ${preBackup}`);
  } finally {
    client.end();
  }
}
main().catch((error) => { console.error(error.stack || error.message || error); process.exit(1); });
