const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
assert(fs.existsSync(path.join(__dirname, '../lib/container-files.js')), '容器文件适配器尚未实现');
const { createContainerFiles, terminalCommand } = require('../lib/container-files');
for (const name of ['', '-x', 'dcim;id', 'a\nb', '$(id)']) assert.throws(() => terminalCommand(name));
assert(terminalCommand('dcim').includes("'dcim'"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-container-'));
const ssh = { exec(command, callback) {
  assert(command.startsWith("docker exec -i 'dcim' python3 -c "));
  const child = spawn('python', [path.join(__dirname, '../lib/container-files-worker.py')]);
  const channel = new (require('events').EventEmitter)();
  channel.stderr = child.stderr;
  channel.end = data => child.stdin.end(data);
  channel.close = () => child.kill();
  child.stdout.on('data', data => channel.emit('data', data));
  child.on('error', err => channel.emit('error', err));
  child.on('close', code => channel.emit('close', code));
  callback(null, channel);
} };
const api = createContainerFiles(ssh, 'dcim');
const call = (method, ...args) => new Promise((resolve, reject) => api[method](...args, (e, v) => e ? reject(e) : resolve(v)));
const write = (p, data) => new Promise((resolve, reject) => { const s = api.createWriteStream(p); s.on('error', reject); s.on('close', resolve); s.end(data); });
const read = p => new Promise((resolve, reject) => { const chunks=[]; const s=api.createReadStream(p); s.on('data', b=>chunks.push(b)); s.on('error',reject); s.on('end',()=>resolve(Buffer.concat(chunks))); });
(async () => {
  try {
    await call('probe');
    const dir = root + '/中文 空格';
    await call('mkdir', dir);
    const file = dir + "/quote' $test.bin";
    const data = Buffer.from([0, 255, 10, 13, 128]);
    await write(file, data);
    assert.deepStrictEqual(await read(file), data);
    assert.strictEqual((await call('readdir', dir))[0].filename, "quote' $test.bin");
    await call('rename', file, dir + '/new.bin');
    await call('unlink', dir + '/new.bin');
    await assert.rejects(read(file));
    const failed = createContainerFiles({ exec(c, cb) { cb(new Error('container stopped')); } }, 'dcim');
    await assert.rejects(new Promise((resolve,reject)=>failed.readdir('/', e=>e?reject(e):resolve())), /stopped/);
    console.log('container file operations passed');
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
})().catch(e=>{ console.error(e); process.exitCode=1; });
