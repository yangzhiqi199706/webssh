'use strict';
const fs = require('fs'), { Client } = require('ssh2');
const conn = new Client();
(async () => {
  const root = '/tmp/webssh-arm-installer-test-' + Date.now();
  await new Promise((resolve,reject) => conn.once('ready',resolve).once('error',reject).connect({host:process.env.WEBSSH_HOST || '192.168.50.221',username:'root',password:process.env.WEBSSH_DEPLOY_PASS,readyTimeout:30000}));
  const run = command => new Promise((resolve,reject) => conn.exec(command,(error,stream) => {
    if(error)return reject(error);const out=[];stream.on('data',b=>out.push(b));stream.stderr.on('data',b=>out.push(b));stream.on('close',code=>code===0?resolve(Buffer.concat(out).toString('utf8')):reject(new Error(Buffer.concat(out).toString('utf8'))));stream.end();
  }));
  try {
    await run('mkdir -p ' + root);
    const sftp = await new Promise((resolve,reject)=>conn.sftp((e,s)=>e?reject(e):resolve(s)));
    for(const [local,name] of [['scripts/install-all-arm64.sh','installer.sh'],['tests/helpers/arm64-installer-fixture.py','fixture.py']]) await new Promise((resolve,reject)=>sftp.fastPut(local,root+'/'+name,e=>e?reject(e):resolve()));
    const result = await run('ARM_INSTALLER_SOURCE=' + root + '/installer.sh /opt/webssh/protocol/runtime/python/bin/python3 ' + root + '/fixture.py');
    fs.mkdirSync('output/arm-release-20261014',{recursive:true}); fs.writeFileSync('output/arm-release-20261014/installer-fixture.json',result); console.log(result);
  } finally { await run('rm -rf '+root); conn.end(); }
})().catch(e=>{console.error(e.message);process.exitCode=1;conn.end();});
