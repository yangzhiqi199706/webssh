// 仅回环监听的 UI 验证服务，操作临时配置，不连接真实 SSH。
const express=require('express'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'../..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dcim-ui-'));
const config=path.join(temp,'config');fs.mkdirSync(config);
fs.writeFileSync(path.join(temp,'dcim-settings.json'),JSON.stringify({host:'192.168.50.61',password:'fixture',directory:config.replace(/\\/g,'/')}));
fs.writeFileSync(path.join(config,'feature_flags.json'),JSON.stringify({acquisition:{modbus:true,snmp:true,snmptrap:false,mqtt:true},publish:{http_publish:true,iec104_publish:true},alarm:{alarm_trigger:true,alarm_push:true}}));
fs.writeFileSync(path.join(config,'runtime_env.json'),JSON.stringify({redis_buffer_params:{DCIM_REDIS_HOST:'127.0.0.1',DCIM_REDIS_PORT:6379,DATA_BATCH_SIZE:500},snmp_collector_params:{SNMP_BULK_ENABLED:true,SNMP_TIMEOUT_SEC:2},tcp_collector_params:{MODBUS_FRAME_READ_WHITELIST:[]}}));
// 连接配置保持Linux目录格式；仅在测试执行器内部替换为临时目录。
fs.writeFileSync(path.join(temp,'dcim-settings.json'),JSON.stringify({host:'192.168.50.61',password:'fixture',directory:'/fixture/config'}));
const app=express();app.use(express.json());
require('../../lib/dcim-settings').register(app,{configDir:temp,requireAccount:()=>({role:'admin'}),runSsh:(cfg,command,cb)=>{
 if(command.startsWith('docker'))return cb(null,{code:0,stdout:'active'});
 const payload=JSON.parse(Buffer.from(command.match(/python3 - '([^']+)'/)[1],'base64'));
 payload.directory=config;
 cp.execFile('python',[path.join(root,'lib/dcim-settings-worker.py'),Buffer.from(JSON.stringify(payload)).toString('base64')],{encoding:'utf8',env:Object.assign({},process.env,{PYTHONIOENCODING:'utf-8'})},(err,stdout)=>cb(err,{code:err?1:0,stdout}));
}});
app.use(express.static(path.join(root,'dcim-settings')));
app.listen(3199,'127.0.0.1',()=>console.log('DCIM UI fixture http://127.0.0.1:3199'));
