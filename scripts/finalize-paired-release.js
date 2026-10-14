'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{Client}=require('ssh2');
const host=process.env.WEBSSH_HOST,password=process.env.WEBSSH_DEPLOY_PASS;
const arm=path.resolve(process.env.WEBSSH_ARM_PACKAGE||''),x64=path.resolve(process.env.WEBSSH_X64_PACKAGE||'');
const names=[arm,x64].map(file=>path.basename(file));
if(!host||!password||!names.every(name=>/^webssh-fullstack-offline-linux-(arm64|x64)-v[A-Za-z0-9._-]+\.tar\.gz$/.test(name)))throw Error('Explicit host and two release archives required');
const conn=new Client();const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
const run=cmd=>new Promise((resolve,reject)=>conn.exec(cmd,(e,s)=>{if(e)return reject(e);const chunks=[];s.on('data',b=>chunks.push(b));s.stderr.on('data',b=>process.stderr.write(b));s.on('close',code=>code===0?resolve(Buffer.concat(chunks).toString('utf8')):reject(Error('Finalize command failed '+code)));s.end();}));
(async()=>{
  await new Promise((resolve,reject)=>conn.once('ready',resolve).once('error',reject).connect({host,username:'root',password,readyTimeout:30000}));
  try {
    const sftp=await new Promise((resolve,reject)=>conn.sftp((e,s)=>e?reject(e):resolve(s)));
    const put=(local,remote)=>new Promise((resolve,reject)=>sftp.fastPut(local,remote,e=>e?reject(e):resolve()));
    const write=(remote,value)=>new Promise((resolve,reject)=>sftp.writeFile(remote,value,e=>e?reject(e):resolve()));
    const pull=(remote,local)=>new Promise((resolve,reject)=>sftp.fastGet(remote,local,e=>e?reject(e):resolve()));
    const installer=fs.readFileSync('scripts/install-all-arm64.sh','utf8');
    await write('/opt/webssh/scripts/install-all-arm64.sh',installer);
    await run('bash -n /opt/webssh/scripts/install-all-arm64.sh');
    for(const [file,name] of [[arm,names[0]],[x64,names[1]]]){
      const release=name.replace(/\.tar\.gz$/,''),dir='/root/'+release,remote='/root/'+name;
      if(file===x64){await put(file,remote);const digest=hash(fs.readFileSync(file));await run('printf '+quote(digest+'  '+remote+'\n')+' | sha256sum -c -');await run('test ! -e '+quote(dir)+' && tar -xzf '+quote(remote)+' -C /root');}
      const script=file===arm?'install-all-arm64.sh':'install-all-x64.sh';
      await write(dir+'/scripts/'+script,file===arm?installer:installer.replace(/ARM64/g,'x86_64').replace(/aarch64/g,'x86_64').replace(/arm64/g,'x64'));
      await run('bash -n '+quote(dir+'/scripts/'+script)+' && chmod +x '+quote(dir+'/scripts/'+script)+' '+quote(dir+(file===arm?'/install-all-arm64.sh':'/install-all.sh')));
      await run('tar -czf '+quote(remote)+' -C /root '+quote(release)+' && cd /root && sha256sum '+quote(name)+' > '+quote(name+'.sha256'));
      const pending=file+'.final-pulling';await pull(remote,pending);await pull(remote+'.sha256',file+'.sha256');
      const digest=hash(fs.readFileSync(pending));if(digest!==fs.readFileSync(file+'.sha256','utf8').split(/\s+/)[0])throw Error('Final pull checksum failed');
      fs.renameSync(pending,file);
      const report=JSON.parse(fs.readFileSync(file+'.verification.json','utf8'));
      Object.assign(report,{sha256:digest,finalizedAt:new Date().toISOString(),finalInstaller:true,pulledFromServer:true,remoteArchive:remote});
      fs.writeFileSync(file+'.verification.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({file,digest,bytes:fs.statSync(file).size}));
    }
    const armManifest=await run('cat '+quote('/root/'+names[0].replace(/\.tar\.gz$/,'')+'/source-manifest.json'));
    const x64Manifest=await run('cat '+quote('/root/'+names[1].replace(/\.tar\.gz$/,'')+'/source-manifest.json'));
    if(armManifest!==x64Manifest)throw Error('Paired source manifests differ');
    console.log(await run('systemctl is-active webssh webssh-protocol; curl -fsS http://127.0.0.1:3010/health; /opt/webssh/runtime/node/bin/node -p "process.arch"'));
    console.log('PAIRED_FINAL_CHECKSUM_AND_SOURCE_OK');
  }finally{conn.end();}
})().catch(e=>{console.error(e.message);conn.end();process.exitCode=1;});
