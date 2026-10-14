'use strict';
const fs = require('fs');
const path = require('path');
const { Readable, Writable } = require('stream');
const worker = fs.readFileSync(path.join(__dirname, 'container-files-worker.py'), 'utf8');
const LIMIT = 32 * 1024 * 1024;
function quote(value) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
function validateContainer(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) throw new Error('容器名称无效');
  return name;
}
function terminalCommand(name) { return 'docker exec -it ' + quote(validateContainer(name)) + ' sh'; }
function createContainerFiles(ssh, name) {
  const command = 'docker exec -i ' + quote(validateContainer(name)) + ' python3 -c ' + quote(worker);
  let pending = 0;
  function request(req, cb) {
    if (pending >= 4) return process.nextTick(() => cb(new Error('容器文件操作繁忙，请稍后重试')));
    pending++;
    let channel, done = false, chunks = [], size = 0, stderr = '';
    const timer = setTimeout(() => finish(new Error('容器文件操作超时')), 60000);
    function finish(err, result) {
      if (done) return;
      done = true; clearTimeout(timer); pending--;
      if (err && channel) { try { channel.close(); } catch (_) {} }
      cb(err, result);
    }
    try {
      ssh.exec(command, (err, ch) => {
        if (err) return finish(err);
        channel = ch;
        if (done) { ch.close(); return; }
        ch.on('error', finish);
        ch.on('data', chunk => {
          size += chunk.length;
          if (size > LIMIT * 2) return finish(new Error('容器响应过大'));
          chunks.push(chunk);
        });
        ch.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(0, 4096); });
        ch.on('close', code => {
          if (done) return;
          let value;
          try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch (_) { return finish(new Error(stderr || '容器文件管理不可用：请检查容器运行状态及 python3')); }
          if (code !== 0 || value.error) return finish(new Error(value.error || stderr || '容器文件操作失败'));
          finish(null, value.result);
        });
        ch.end(JSON.stringify(req));
      });
    } catch (err) { finish(err); }
  }
  return {
    probe(cb) { request({op:'probe'}, cb); },
    readdir(p, cb) { request({op:'readdir', path:p}, cb); },
    mkdir(p, cb) { request({op:'mkdir', path:p}, cb); },
    unlink(p, cb) { request({op:'unlink', path:p}, cb); },
    rename(p, dest, cb) { request({op:'rename', path:p, dest}, cb); },
    createReadStream(p) {
      const out = new Readable({ read() {} });
      request({op:'read', path:p}, (err, data) => {
        if (err) return out.destroy(err);
        out.push(Buffer.from(data, 'base64')); out.push(null);
      });
      return out;
    },
    createWriteStream(p) {
      const chunks = []; let size = 0;
      return new Writable({
        autoDestroy: true,
        write(chunk, encoding, cb) {
          size += chunk.length;
          if (size > LIMIT) return cb(new Error('文件超过 32 MiB'));
          chunks.push(Buffer.from(chunk)); cb();
        },
        final(cb) { request({op:'write', path:p, data:Buffer.concat(chunks).toString('base64')}, cb); }
      });
    }
  };
}
module.exports = { createContainerFiles, terminalCommand, validateContainer };
