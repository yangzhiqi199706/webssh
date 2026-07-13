// 一次性脚本：把本地 server.js 推到 192.168.0.22:/opt/webssh/app/server.js 并重启 webssh
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const localFile = path.join(__dirname, '..', 'server.js');
const remoteFile = '/opt/webssh/app/server.js';
console.log('本地大小:', (fs.statSync(localFile).size / 1024).toFixed(1), 'KB');

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

      const ts = String(Date.now());
      console.log('备份旧 server.js');
      await exec('cp -a ' + remoteFile + ' ' + remoteFile + '.bak-' + ts);
      console.log('上传新 server.js');
      await putFile(localFile, remoteFile);

      console.log('重启 webssh');
      await exec('systemctl restart webssh');
      await new Promise(r => setTimeout(r, 2500));

      const r1 = await exec('systemctl is-active webssh');
      console.log('webssh:', r1.out.trim());
      const r2 = await exec('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3010/health');
      console.log('GET /health ->', r2.out.trim());
      const r3 = await exec('curl -s http://127.0.0.1:3010/api/proto-conv/iec104/status');
      console.log('IEC104 status:', r3.out.trim().slice(0, 200));

      c.end();
    })().catch(e => { console.error('ERR:', e); c.end(); });
  });
}).connect({ host: '192.168.0.22', username: 'root', password: 'smt@2023' });
