'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

function reservePort() {
  return new Promise(function (resolve, reject) {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      server.close(function () { resolve(port); });
    });
  });
}

function request(port, pathname) {
  return new Promise(function (resolve, reject) {
    const req = http.request({ hostname: '127.0.0.1', port: port, path: pathname, method: 'GET' }, function (res) {
      const chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.once('error', reject);
    req.end();
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if ((await request(port, '/health')).statusCode === 200) return;
    } catch (_error) {}
    await new Promise(function (resolve) { setTimeout(resolve, 100); });
  }
  throw new Error('server health timeout');
}

async function run() {
  const port = await reservePort();
  const child = childProcess.spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', function (chunk) { output += chunk.toString('utf8'); });
  child.stderr.on('data', function (chunk) { output += chunk.toString('utf8'); });
  try {
    await waitForHealth(port);
    const response = await request(port, '/api/serial/bridge/config');
    assert.strictEqual(response.statusCode, 401, output + response.body);
  } finally {
    child.kill();
  }
}

run().then(function () {
  console.log('serial bridge auth: passed');
}).catch(function (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
});
