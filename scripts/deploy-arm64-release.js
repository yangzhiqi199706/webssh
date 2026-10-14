'use strict';
// Deploy one explicit ARM package, verify existing settings, then pull the same archive back.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), http = require('http');
const { Client } = require('ssh2');
const host = process.env.WEBSSH_HOST;
const password = process.env.WEBSSH_DEPLOY_PASS;
const archive = path.resolve(process.env.WEBSSH_PACKAGE || '');
const name = path.basename(archive), release = name.replace(/\.tar\.gz$/, '');
const remoteArchive = '/root/' + name, remoteDirectory = '/root/' + release;
const remoteSha = remoteArchive + '.sha256', shaFile = archive + '.sha256';
const stamp = new Date().toISOString().replace(/\D/g,'').slice(0,14);
const controlBackup = '/root/webssh-arm-control-' + stamp + '.tar.gz';
const root = path.resolve(__dirname,'..');
const conn = new Client();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const quote = value => "'" + String(value).replace(/'/g,"'\\''") + "'";
function exec(command) {
  return new Promise((resolve,reject)=>conn.exec(command,(error,stream)=>{
    if(error)return reject(error); const out=[];
    stream.on('data',b=>{out.push(b);process.stdout.write(b);});
    stream.stderr.on('data',b=>process.stderr.write(b));
    stream.on('close',code=>code===0?resolve(Buffer.concat(out).toString('utf8')):reject(new Error('ARM command failed: '+code)));
    stream.end();
  }));
}
const get = url => new Promise((resolve,reject)=>{
  const req=http.get(url,res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks)}));});
  req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('HTTP timeout')));
});
const configCommand = "find /opt/webssh/config /opt/webssh/app/config -type f -name '*.json' -exec sha256sum {} + 2>/dev/null | sort -k2";
async function main() {
  if(!host || !password || !process.env.WEBSSH_PACKAGE)throw new Error('Set WEBSSH_HOST, WEBSSH_DEPLOY_PASS and WEBSSH_PACKAGE');
  if(!/^webssh-fullstack-offline-linux-arm64-v[A-Za-z0-9._-]+\.tar\.gz$/.test(name))throw new Error('Invalid ARM package name');
  const digest = hash(fs.readFileSync(archive));
  if(fs.readFileSync(shaFile,'utf8').trim().split(/\s+/)[0]!==digest)throw new Error('Local archive checksum failed');
  await new Promise((resolve,reject)=>conn.once('ready',resolve).once('error',reject).connect({host,port:22,username:'root',password,readyTimeout:30000,keepaliveInterval:10000}));
  try {
    await exec('test "$(uname -m)" = aarch64 || test "$(uname -m)" = arm64');
    const before = await exec(configCommand);
    const dcimBefore = await exec("docker inspect --format '{{.Id}} {{.State.StartedAt}}' dcim");
    const sftp = await new Promise((resolve,reject)=>conn.sftp((e,s)=>e?reject(e):resolve(s)));
    const put = (local,remote)=>new Promise((resolve,reject)=>sftp.fastPut(local,remote,e=>e?reject(e):resolve()));
    const read = remote=>new Promise((resolve,reject)=>sftp.readFile(remote,(e,b)=>e?reject(e):resolve(b)));
    const pull = (remote,local)=>new Promise((resolve,reject)=>sftp.fastGet(remote,local,e=>e?reject(e):resolve()));
    const opsFile = '/opt/webssh/config/ops-settings.json';
    const stableOps = content => {const data=JSON.parse(content.toString('utf8'));if(data.logRotation){delete data.logRotation.lastRotationDate;delete data.logRotation.lastResult;}return JSON.stringify(data);};
    const beforeOps=stableOps(await read(opsFile));
    await exec('tar -czf ' + quote(controlBackup) + ' /opt/webssh/config /opt/webssh/app/config /etc/systemd/system/webssh.service /etc/systemd/system/webssh-protocol.service');
    console.log('Uploading ARM package ' + name);
    await put(archive,remoteArchive);await put(shaFile,remoteSha);
    await exec('cd /root && sha256sum -c ' + quote(path.basename(remoteSha)));
    await exec('test ! -e ' + quote(remoteDirectory) + ' && tar -xzf ' + quote(remoteArchive) + ' -C /root');
    await exec('cd ' + quote(remoteDirectory) + ' && chmod +x install-all-arm64.sh scripts/install-all-arm64.sh && ./install-all-arm64.sh');
    const verificationSource = [
      "const fs=require('fs'),crypto=require('crypto');",
      "process.chdir('/opt/webssh/app'); const req=name=>require('/opt/webssh/app/node_modules/'+name);",
      "for(const name of ['express','ws','ssh2','http-proxy','net-snmp','mysql2','pg','dmdb','sax'])req(name);",
      "const protocol=require('/opt/webssh/app/proto-conv/b-interface-protocol');const defaults=require('/opt/webssh/app/proto-conv/b-interface-forwarder').defaults;",
      "const cfg=Object.assign({},defaults,{suId:'001122AABBCC',suRId:'test',suIp:'127.0.0.1'});const xml=protocol.mockLoginAck(cfg);if(!protocol.ack(protocol.unwrap(xml,cfg.soap,true),'LOGIN',101,cfg.suId))throw Error('B protocol failed');",
      "const manifest=JSON.parse(fs.readFileSync(" + JSON.stringify(remoteDirectory+'/source-manifest.json') + ",'utf8'));let checked=0;",
      "for(const [key,digest]of Object.entries(manifest)){if(key.startsWith('protocol/app/module4_config/'))continue;const file='/opt/webssh/'+key;if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==digest)throw Error('Source mismatch '+key);checked++;}",
      "console.log(JSON.stringify({arch:process.arch,node:process.version,sourceFilesChecked:checked,modules:true,bInterfaceProtocol:true}));"
    ].join('\n');
    await new Promise((resolve,reject)=>conn.exec('/opt/webssh/runtime/node/bin/node',(e,stream)=>{
      if(e)return reject(e);const chunks=[];stream.on('data',b=>chunks.push(b));stream.stderr.on('data',b=>process.stderr.write(b));stream.on('close',code=>code===0?resolve(console.log(Buffer.concat(chunks).toString('utf8'))):reject(new Error('ARM source/runtime verification failed')));stream.end(verificationSource);
    }));
    const services = await exec('systemctl is-active webssh webssh-protocol');
    await exec('PYTHONPATH=/opt/webssh/protocol/runtime/site-packages /opt/webssh/protocol/runtime/python/bin/python3 -c ' + quote('import flask,pandas,numpy,xlrd,xlwt,openpyxl,docx,lxml; print("PYTHON_MODULES_OK")'));
    await exec('curl -fsS -o /dev/null http://127.0.0.1:5000/protocol/');
    const httpChecks = {};
    for(const endpoint of ['/health','/protocol/','/proto-conv/index.html','/proto-conv/assets/js/pc-b-interface.js','/proto-conv/assets/js/pc-b-mapping-view.js','/serial/index.html','/sms/index.html','/ha/index.html','/video/index.html','/db/index.html','/overview/index.html','/dcim-settings/index.html']) {
      const response=await get('http://'+host+':3010'+endpoint);httpChecks[endpoint]=response.status;
      if(response.status!==200)throw new Error('External HTTP failed '+endpoint+' '+response.status);
    }
    const authentication = await get('http://'+host+':3010/api/proto-conv/b-interface/config');
    if(authentication.status!==401)throw new Error('B interface authentication failed');
    const after = await exec(configCommand), afterLines = new Set(after.trim().split(/\r?\n/));
    const stableLines=before.trim().split(/\r?\n/).filter(line=>!line.endsWith('/ops-settings.json') && !line.endsWith('/service-overview-history.json'));
    if(!stableLines.every(line=>afterLines.has(line)) || beforeOps!==stableOps(await read(opsFile)))throw new Error('Existing business settings changed');
    const dcimAfter = await exec("docker inspect --format '{{.Id}} {{.State.StartedAt}}' dcim");
    if(dcimBefore.trim()!==dcimAfter.trim())throw new Error('DCIM container unexpectedly restarted');
    const backups=await exec("find /opt/webssh -maxdepth 1 -type d -name '*bak-arm64-*' -printf '%f\\n' | sort");
    console.log('Pulling deployed installer back to local dist...');
    const pulling = archive + '.pulling';await pull(remoteArchive,pulling);
    if(hash(fs.readFileSync(pulling))!==digest)throw new Error('Pulled archive checksum failed');
    fs.renameSync(pulling,archive);await pull(remoteSha,shaFile);
    const report={at:new Date().toISOString(),host,architecture:'arm64',package:name,sha256:digest,remoteArchive,remoteDirectory,controlBackup,backups:backups.trim().split(/\r?\n/),services:services.trim().split(/\s+/),httpChecks,authenticationStatus:authentication.status,configPreserved:true,dcimUnchanged:true,pulledFromServer:true};
    fs.writeFileSync(archive+'.verification.json',JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
  } finally {conn.end();}
}
main().catch(e=>{console.error(e.message);conn.end();process.exitCode=1;});
