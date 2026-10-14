const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const source = fs.readFileSync(require('path').join(__dirname, '../server.js'), 'utf8');
const start = source.indexOf("wss.on('connection', function (ws)");
const end = source.indexOf('// ===================== 远程串口', start);
const instances = [];
class Client extends EventEmitter {
  constructor() { super(); instances.push(this); this.commands=[]; }
  connect() { this.emit('ready'); }
  end() {}
  shell(options, cb) { this.hostShell=true; this.open(cb); }
  sftp() { throw Error('容器不得打开宿主机 SFTP'); }
  open(cb) { this.channel = new PassThrough(); this.channel.stderr=new PassThrough(); cb(null,this.channel); }
  exec(command, options, cb) {
    this.commands.push(command);
    assert(options.pty);
    this.open(cb);
  }
}
const wss = new EventEmitter();
let adapters=0;
const context = {
  wss, Client, WebSocket:{OPEN:1}, console, Buffer,
  setTimeout,clearTimeout,setInterval,clearInterval,
  sshIdleSessionReconfigurers:new Set(), currentOpsSettings:{idleDisconnect:{enabled:false}},
  demoConfig:{}, fs,
  containerFiles:Object.assign({},require('../lib/container-files'),{createContainerFiles(ssh,name){
    assert.strictEqual(name,'dcim'); adapters++; return {probe(cb){cb(null);}};
  }})
};
vm.runInNewContext(source.slice(start,end),context);
function session(type,name) {
  const ws = new EventEmitter(); ws.readyState=1; ws.bufferedAmount=0; ws.messages=[];
  ws.send=raw=>ws.messages.push(JSON.parse(raw)); ws.close=()=>{ws.readyState=3;ws.emit('close');};
  wss.emit('connection',ws);
  ws.emit('message',Buffer.from(JSON.stringify({type:'connect',payload:{connectionType:type,containerName:name,auth:'Password',host:'test'}})));
  return ws;
}
const ws = session('container','dcim');
const ssh = instances[0];
assert.strictEqual(ssh.hostShell,undefined);
assert.strictEqual(ssh.commands[0], "docker exec -it 'dcim' sh");
ws.emit('message',Buffer.from(JSON.stringify({type:'sftp:init',payload:{requestId:'files'}})));
assert.strictEqual(adapters,1);
assert.strictEqual(ws.messages.find(m=>m.type==='sftp:ready').payload.cwd,'/');
ws.emit('message',Buffer.from(JSON.stringify({type:'connect',payload:{connectionType:'ssh'}})));
assert.strictEqual(ssh.hostShell,undefined);
ws.emit('message',Buffer.from(JSON.stringify({type:'snmp:deploy',payload:{requestId:'snmp'}})));
assert.strictEqual(ws.messages.find(m=>m.type==='snmp:done').payload.ok,false);
ssh.channel.emit('close',1);
assert.strictEqual(ws.readyState,3);
const invalid=session('container','dcim;id');
assert(invalid.messages.some(m=>m.type==='error')); invalid.close();
const host=session('ssh'); assert.strictEqual(instances[2].hostShell,true); host.close();
console.log('container session target isolation, exit, validation and SSH compatibility passed');
