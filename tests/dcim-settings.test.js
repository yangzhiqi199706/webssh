'use strict';
const assert = require('assert');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { register, normalize } = require('../lib/dcim-settings');
const project=path.resolve(__dirname,'..');
const shell=fs.readFileSync(path.join(project,'index.html'),'utf8');
assert(shell.includes("id: 'dcim-settings'"));
assert(shell.includes("el.dcimSettingsFrame.src = './dcim-settings/index.html'"));
for(const script of ['deploy-upgrade.js','deploy-protocol.js','build-fullstack-arm64.js','build-fullstack-on-server.js']) {
  assert(fs.readFileSync(path.join(project,'scripts',script),'utf8').includes('dcim-settings'),script+' must ship DCIM settings');
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcim-settings-test-'));
const app = express(); app.use(express.json());
let commands = [];
register(app, { configDir: temp, requireAccount: (req,res) => {
  if (!req.get('x-role')) { res.status(401).json({ok:false}); return null; }
  return {role:req.get('x-role')};
}, runSsh: (cfg,cmd,cb) => {
  commands.push(cmd);
  assert(cfg.commandTimeoutMs > 0);
  setTimeout(() => cb(null,{code:0,stdout:cmd.startsWith('docker')?'active':JSON.stringify({ok:true,data:{files:[]}})}),20);
} });
const server = app.listen(0,'127.0.0.1',async () => {
  const port=server.address().port;
  function request(url,method,body,role,extra) {
    return new Promise((resolve,reject)=>{
      const headers=Object.assign({'Content-Type':'application/json'},role?{'x-role':role}:{},extra);
      const req=http.request({host:'127.0.0.1',port,path:'/api/dcim-settings'+url,method:method||'GET',headers},res=>{
        let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));
      });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
    });
  }
  try {
    assert.strictEqual((await request('/connection')).status,401);
    assert.strictEqual((await request('/connection','GET',null,'viewer')).status,403);
    assert.strictEqual((await request('/connection','PUT',{password:'secret'},'admin',{Origin:'https://evil.test'})).status,403);
    const saved=await request('/connection','PUT',{password:'private-test'},'admin');
    assert.strictEqual(saved.status,200);assert(!JSON.stringify(saved).includes('private-test'));
    assert.strictEqual((await request('/connection','PUT',{port:0},'admin')).status,400);
    assert.throws(()=>normalize({container:'dcim;id'}));
    assert.throws(()=>normalize({directory:'/dcim/../etc'}));
    assert.strictEqual((await request('/files','GET',null,'admin')).status,200);
    assert.strictEqual((await request('/snapshot','GET',null,'admin')).status,200);
    assert.strictEqual((await request('/snapshot','GET',null,'viewer')).status,403);
    const before=commands.length;
    assert.strictEqual((await request('/restart','POST',{},'admin')).status,400);assert.strictEqual(commands.length,before);
    assert.strictEqual((await request('/restart','POST',{confirm:true},'admin')).status,200);
    assert(commands[commands.length-1].includes('systemctl restart dcim'));
    // 路径和脚本内容作为Base64数据传递，不拼接执行用户配置。
    await request('/file','PUT',{name:'feature_flags.json',revision:'x',changes:[{path:['flag'],value:"'$(touch bad)'"}]},'admin');
    assert(!commands[commands.length-1].includes('touch bad'));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(temp,'dcim-settings.json'))).password,'private-test');
    console.log('DCIM settings: auth, same-origin, SSH command and config tests passed');
  } catch(e) {console.error(e);process.exitCode=1;}
  finally {
    server.close();
    if (fs.rmSync) fs.rmSync(temp,{recursive:true,force:true});
    else fs.rmdirSync(temp,{recursive:true});
  }
});
