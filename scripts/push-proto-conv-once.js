// 一次性脚本：把本地 proto-conv/ 全量推到 192.168.0.22:/opt/webssh/app/proto-conv/
// 起因：scripts/deploy-protocol.js 的 main-sync 没包含 proto-conv 目录
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name === '.DS_Store') continue;
    const abs = path.join(dir, entry.name);
    const rel = (base ? base + '/' : '') + entry.name;
    if (entry.isDirectory()) walk(abs, rel, out);
    else out.push({ abs, rel });
  }
  return out;
}

const localRoot = path.join(__dirname, '..', 'proto-conv');
const files = walk(localRoot, '', []);
console.log('proto-conv 本地文件数:', files.length);

const c = new Client();
c.on('ready', () => {
  console.log('SSH 已连接');
  c.sftp((err, sftp) => {
    if (err) { console.error(err); c.end(); return; }
    (async () => {
      const exec = (cmd) => new Promise((resolve, reject) => {
        c.exec(cmd, (e, s) => {
          if (e) return reject(e);
          let out = '', errOut = '';
          s.on('data', d => { out += d; });
          s.stderr.on('data', d => { errOut += d; });
          s.on('close', () => resolve({ out, errOut }));
        });
      });
      const putFile = (local, remote) => new Promise((resolve, reject) => {
        sftp.fastPut(local, remote, (e) => e ? reject(e) : resolve());
      });
      const mkdir = (p) => new Promise((resolve) => {
        sftp.mkdir(p, () => resolve());
      });

      const remoteRoot = '/opt/webssh/app/proto-conv';
      console.log('备份旧 proto-conv（如有）');
      const ts = String(Date.now());
      await exec('if [ -d ' + remoteRoot + ' ]; then mv ' + remoteRoot + ' ' + remoteRoot + '.bak-' + ts + '; fi');
      await mkdir(remoteRoot);

      const dirs = new Set();
      files.forEach(f => {
        const parts = f.rel.split('/');
        parts.pop();
        let acc = '';
        parts.forEach(p => { acc = acc ? acc + '/' + p : p; dirs.add(acc); });
      });
      const sortedDirs = Array.from(dirs).sort();
      for (const d of sortedDirs) {
        await mkdir(remoteRoot + '/' + d);
      }
      console.log('已创建', sortedDirs.length, '个子目录');

      let i = 0;
      for (const f of files) {
        await putFile(f.abs, remoteRoot + '/' + f.rel);
        i++;
        if (i % 20 === 0) console.log('已上传', i, '/', files.length);
      }
      console.log('全部上传完成', i, '个文件');

      const r1 = await exec('grep -c btnOpenIec104 /opt/webssh/app/proto-conv/index.html');
      console.log('远端 index.html btnOpenIec104 命中:', r1.out.trim());
      const r2 = await exec('ls -la /opt/webssh/app/proto-conv/assets/js/pc-iec104.js');
      console.log(r2.out.trim());

      console.log('重启 webssh');
      await exec('systemctl restart webssh');
      await new Promise(r => setTimeout(r, 2500));
      const r3 = await exec('systemctl is-active webssh');
      console.log('webssh:', r3.out.trim());
      const r4 = await exec('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3010/protocol/');
      console.log('GET /protocol/ ->', r4.out.trim());
      const r5 = await exec('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3010/proto-conv/index.html');
      console.log('GET /proto-conv/index.html ->', r5.out.trim());

      c.end();
    })().catch(e => { console.error('ERR:', e); c.end(); });
  });
}).connect({ host: '192.168.0.22', username: 'root', password: 'smt@2023' });
