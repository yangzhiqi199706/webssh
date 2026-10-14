const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync(require('path').join(__dirname, '../index.html'), 'utf8');
function source(name) {
  const start = html.indexOf('    function ' + name + '(');
  assert(start >= 0, name);
  const end = html.indexOf('\n    }', start) + 6;
  return html.slice(start, end);
}
const store = {};
const context = vm.createContext({ Date, localStorage: { getItem: key => store[key], setItem: (key, value) => { store[key] = value; } } });
vm.runInContext("const SAVED_HOSTS_KEY='hosts';" + ['savedHostKey','cloneConnection','loadSavedHosts','persistSavedHosts','upsertSavedHost','makeHostFromConnection'].map(source).join('\n'), context);
vm.runInContext(`
const host = {host:'example',port:'22',user:'root'};
const container = Object.assign({},host,{connectionType:'container',containerName:'DCIM'});
const lower = Object.assign({},container,{containerName:'dcim'});
if (savedHostKey(host) === savedHostKey(container)) throw Error('宿主和容器混淆');
if (savedHostKey(container) === savedHostKey(lower)) throw Error('容器名大小写被合并');
upsertSavedHost(host); upsertSavedHost(container); upsertSavedHost(lower);
if (loadSavedHosts().length !== 3) throw Error('保存覆盖了其他目标');
const restored=cloneConnection(loadSavedHosts()[1]);
if(restored.containerName!=='DCIM'||restored.connectionType!=='container') throw Error('恢复丢失目标');
if(!makeHostFromConnection(restored).name.includes('/ DCIM')) throw Error('目标名称不明确');
`, context);
for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
console.log('container connection persistence and frontend syntax passed');
