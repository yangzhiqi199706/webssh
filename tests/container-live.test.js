// Optional integration check: only creates its own uniquely named /tmp file.
const assert = require('assert');
const { Client } = require('ssh2');
const { createContainerFiles, terminalCommand } = require('../lib/container-files');
if (!process.env.WEBSSH_TEST_HOST || !process.env.WEBSSH_TEST_PASS) {
  console.log('SKIP container live test: set WEBSSH_TEST_HOST and WEBSSH_TEST_PASS');
  process.exit(0);
}
const ssh = new Client();
const name = process.env.WEBSSH_TEST_CONTAINER || 'dcim';
const file = '/tmp/webssh-container-check-' + Date.now() + "-quote' space.bin";
let created = false;
const api = createContainerFiles(ssh, name);
const call = (method, ...args) => new Promise((resolve,reject)=>api[method](...args,(err,result)=>err?reject(err):resolve(result)));
const connected = new Promise((resolve,reject)=>{ssh.once('ready',resolve);ssh.on('error',reject);});
ssh.connect({host:process.env.WEBSSH_TEST_HOST, username:process.env.WEBSSH_TEST_USER || 'root',password:process.env.WEBSSH_TEST_PASS,readyTimeout:10000});
(async()=>{
  try {
    await connected;
    await call('probe');
    await new Promise((resolve,reject)=>ssh.exec(terminalCommand(name),{pty:{term:'xterm',rows:24,cols:80}},(err,ch)=>{
      if(err)return reject(err);
      let out=''; const timer=setTimeout(()=>{ch.close();reject(Error('terminal timeout'));},10000);
      ch.on('data',b=>{out+=b.toString();}); ch.on('error',reject);
      ch.on('close',code=>{clearTimeout(timer);try{assert.strictEqual(code,0);assert(out.includes('CONTAINER_OK'));resolve();}catch(e){reject(e);}});
      ch.write("test -f /.dockerenv && printf 'CONTAINER_%s\\n' OK\nexit\n");
    }));
    const data=Buffer.from([0,255,10,13,128,1,2,3]);
    created=true;
    await new Promise((resolve,reject)=>{const s=api.createWriteStream(file);s.on('error',reject);s.on('close',resolve);s.end(data);});
    const actual=await new Promise((resolve,reject)=>{const chunks=[];const s=api.createReadStream(file);s.on('data',b=>chunks.push(b));s.on('error',reject);s.on('end',()=>resolve(Buffer.concat(chunks)));});
    assert.deepStrictEqual(actual,data);
    assert((await call('readdir','/tmp')).some(item=>item.filename===file.slice(5)));
    console.log('LIVE container terminal, listing and binary upload/download passed');
  } finally {
    if(created) await call('unlink',file);
    ssh.end();
  }
})().catch(e=>{console.error(e.message);ssh.end();process.exitCode=1;});
