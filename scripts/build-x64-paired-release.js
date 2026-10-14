'use strict';
// Pair an x64 offline package with one exact deployed ARM application snapshot.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFileSync}=require('child_process');
const root=path.resolve(__dirname,'..');
const archive=path.resolve(process.env.WEBSSH_ARM_PACKAGE || '');
const runtimeRoot=path.resolve(process.env.WEBSSH_X64_RUNTIME_ROOT || '');
const armName=path.basename(archive).replace(/\.tar\.gz$/,'');
if(!/^webssh-fullstack-offline-linux-arm64-v[A-Za-z0-9._-]+$/.test(armName))throw Error('Explicit ARM package required');
const name=armName.replace('linux-arm64','linux-x64'),out=path.join(root,'dist',name+'.tar.gz');
const base=path.join(root,'output','arm-release-20261014');fs.mkdirSync(base,{recursive:true});
const temp=fs.mkdtempSync(path.join(base,'pair-'));
const stage=path.join(temp,name);
const hash=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
function machine(file) {const b=fs.readFileSync(file);return b[0]===127&&b.toString('ascii',1,4)==='ELF' ? b.readUInt16LE(18) : -1;}
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);}
function copy(source,destination) {
  if(process.platform==='win32') {
    try {execFileSync('robocopy',[source,destination,'/E','/COPY:DAT','/DCOPY:DAT','/R:0','/W:0','/NFL','/NDL','/NJH','/NJS','/NP'],{stdio:'pipe'});}
    catch(error){if(!Number.isInteger(error.status)||error.status<0||error.status>7)throw error;}
  } else fs.cpSync(source,destination,{recursive:true});
}
try {
  execFileSync('tar',['-xzf',archive,'-C',temp]);
  const snapshot=path.join(temp,armName);
  fs.mkdirSync(stage,{recursive:true});
  for(const dir of ['app','systemd'])copy(path.join(snapshot,dir),path.join(stage,dir));
  copy(path.join(snapshot,'protocol','app'),path.join(stage,'protocol','app'));
  const native=[];
  function check(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())check(file);else if(/\.(node|so|dll|exe)$/i.test(entry.name)){if(machine(file)!==62)throw Error('Not x64 native dependency: '+file);native.push(file);}}}
  check(path.join(stage,'app','node_modules'));
  const nodeDir=path.join(runtimeRoot,'runtime','node');if(machine(path.join(nodeDir,'bin','node'))!==62)throw Error('x64 Node runtime architecture failed');
  const nodeName='node-v12.22.12-linux-x64.tar.xz';
  fs.mkdirSync(path.join(stage,'runtime'),{recursive:true});
  execFileSync('tar',['-cJf',path.join(stage,'runtime',nodeName),'-C',path.join(runtimeRoot,'runtime'),'node']);
  const pyName='cpython-3.11.10+20241016-x86_64-unknown-linux-gnu-install_only.tar.gz';
  fs.mkdirSync(path.join(stage,'protocol','runtime'),{recursive:true});fs.copyFileSync(path.join(root,'.offline-downloads',pyName),path.join(stage,'protocol','runtime',pyName));
  const py=execFileSync('tar',['-xOf',path.join(root,'.offline-downloads',pyName),'python/bin/python3.11'],{maxBuffer:128*1024*1024});
  if(py[0]!==127 || py.readUInt16LE(18)!==62)throw Error('x64 Python runtime architecture failed');
  const wheels=path.join(root,'.offline-downloads','wheels');
  for(const wheel of fs.readdirSync(wheels).filter(n=>n.endsWith('.whl'))){if(!/-(?:any|[^/]*x86_64)\.whl$/.test(wheel))throw Error('Non-x64 wheel '+wheel);}
  copy(wheels,path.join(stage,'protocol','wheels'));
  const installer=fs.readFileSync(path.join(snapshot,'scripts','install-all-arm64.sh'),'utf8').replace(/ARM64/g,'x86_64').replace(/aarch64/g,'x86_64').replace(/arm64/g,'x64');
  write(path.join(stage,'scripts','install-all-x64.sh'),installer);
  write(path.join(stage,'install-all.sh'),'#!/usr/bin/env bash\nset -euo pipefail\nexec bash "$(dirname "$0")/scripts/install-all-x64.sh" "$@"\n');
  fs.copyFileSync(path.join(snapshot,'uninstall-all.sh'),path.join(stage,'uninstall-all.sh'));
  const manifest=JSON.parse(fs.readFileSync(path.join(snapshot,'release-manifest.json')));Object.assign(manifest,{name,architecture:'x64',nodeVersion:'12.22.12',pairedFrom:armName});write(path.join(stage,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  fs.copyFileSync(path.join(snapshot,'source-manifest.json'),path.join(stage,'source-manifest.json'));
  const sources=JSON.parse(fs.readFileSync(path.join(stage,'source-manifest.json')));
  for(const [key,digest] of Object.entries(sources)){if(hash(fs.readFileSync(path.join(stage,key)))!==digest)throw Error('Application snapshot mismatch '+key);}
  write(path.join(stage,'INSTALL.md'),'# x86_64全栈离线包\n\n解包后执行 bash install-all.sh。Node12 x64、Python3.11 x86_64与离线wheels；视频复用目标机DCIM。应用源码与同时间戳ARM包一致，升级保留配置和协议助手运行文件。\n');
  execFileSync('tar',['-czf',out,'-C',temp,name]);
  const digest=hash(fs.readFileSync(out));write(out+'.sha256',digest+'  '+path.basename(out)+'\n');
  write(out+'.verification.json',JSON.stringify({at:new Date().toISOString(),architecture:'x64',package:path.basename(out),sha256:digest,pairedArmPackage:path.basename(archive),sourceFilesChecked:Object.keys(sources).length,nativeDependencies:native.length,runtimeELFMachine:62,deployed:false},null,2)+'\n');
  console.log(JSON.stringify({archive:out,sha256:digest,sourceFilesChecked:Object.keys(sources).length,nativeDependencies:native.length}));
} finally {
  if(path.dirname(fs.realpathSync(temp))!==fs.realpathSync(base))throw Error('Unsafe build cleanup');
  fs.rmSync(temp,{recursive:true,force:true});
}
