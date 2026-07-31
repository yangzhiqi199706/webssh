'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const access = require('../lib/access-control');

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

function request(port, method, pathname, body, cookie) {
  return new Promise(function (resolve, reject) {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request({ hostname: '127.0.0.1', port: port, path: pathname, method: method,
      headers: Object.assign({}, payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}, cookie ? { Cookie: cookie } : {}) }, function (res) {
      const chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_error) {}
        resolve({ statusCode: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const result = await request(port, 'GET', '/health');
      if (result.statusCode === 200) return;
    } catch (_error) {}
    await new Promise(function (resolve) { setTimeout(resolve, 100); });
  }
  throw new Error('server health timeout');
}

async function run() {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-local-accounts-'));
  const configPath = path.join(configDirectory, 'access-control.json');
  const password = access.createPasswordRecord('N3w-Secret!');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 2,
    passwordPolicy: { maxAgeDays: 90 },
    loginIpAllowlist: ['127.0.0.1/32'],
    users: [
      { id: 'u-admin', username: 'admin', role: 'admin', enabled: true, password: password,
        passwordChangedAt: '2026-07-01T00:00:00.000Z', sessionVersion: 1, loginIpAllowlist: ['127.0.0.1/32'] },
      { id: 'u-denied', username: 'denied', role: 'viewer', enabled: true, password: password,
        passwordChangedAt: '2026-07-01T00:00:00.000Z', sessionVersion: 1, loginIpAllowlist: ['192.168.0.0/24'] },
      { id: 'u-expired', username: 'expired', role: 'viewer', enabled: true, password: password,
        passwordChangedAt: '2020-01-01T00:00:00.000Z', sessionVersion: 1, loginIpAllowlist: ['127.0.0.1/32'] },
    ], temporaryGrants: [],
  }, null, 2), 'utf8');
  const port = await reservePort();
  const child = childProcess.spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(port), WEBSSH_ACCESS_CONTROL_CONFIG: configPath }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', function (chunk) { output += chunk.toString('utf8'); });
  child.stderr.on('data', function (chunk) { output += chunk.toString('utf8'); });
  try {
    await waitForHealth(port);
    const health = await request(port, 'GET', '/health');
    assert.strictEqual(health.statusCode, 200, 'health must remain available without login');
    const accepted = await request(port, 'POST', '/api/auth/login', { user: 'admin', password: 'N3w-Secret!', timeoutHours: 2 });
    assert.strictEqual(accepted.statusCode, 200, output);
    assert.strictEqual(accepted.body.ok, true);
    assert.strictEqual(accepted.body.username, 'admin');
    assert.strictEqual(accepted.body.role, 'admin');
    const cookie = String((accepted.headers['set-cookie'] || [])[0] || '').split(';')[0];
    const profile = await request(port, 'GET', '/api/local-accounts', null, cookie);
    assert.strictEqual(profile.statusCode, 200, output);
    assert.strictEqual(profile.body.canManage, true);
    assert.strictEqual(profile.body.config.users.length, 3);
    const invalidPolicy = await request(port, 'PUT', '/api/local-accounts/policy', {
      maxAgeDays: 90, loginIpAllowlist: ['198.51.100.0/33'],
    }, cookie);
    assert.strictEqual(invalidPolicy.statusCode, 400, output);
    const invalidUser = await request(port, 'POST', '/api/local-accounts/users', {
      username: 'invalid-ip', role: 'viewer', password: 'Another-Secret!', loginIpAllowlist: ['198.51.100.0/33'],
    }, cookie);
    assert.strictEqual(invalidUser.statusCode, 400, output);
    const invalidUserUpdate = await request(port, 'PUT', '/api/local-accounts/users/u-denied', {
      role: 'viewer', enabled: true, loginIpAllowlist: ['198.51.100.0/33'],
    }, cookie);
    assert.strictEqual(invalidUserUpdate.statusCode, 400, output);
    const legacyPasswordChange = await request(port, 'PUT', '/api/access-control/password', {
      currentPassword: 'N3w-Secret!', newPassword: 'Another-Secret!', confirmPassword: 'Another-Secret!',
    }, cookie);
    assert.strictEqual(legacyPasswordChange.statusCode, 409, output);
    const profileAfterLegacyAttempt = await request(port, 'GET', '/api/local-accounts', null, cookie);
    assert.strictEqual(profileAfterLegacyAttempt.statusCode, 200, output);
    assert.strictEqual(profileAfterLegacyAttempt.body.config.users.length, 3);
    const denied = await request(port, 'POST', '/api/auth/login', { user: 'denied', password: 'N3w-Secret!', timeoutHours: 2 });
    assert.strictEqual(denied.statusCode, 403);
    assert.strictEqual(denied.body.code, 'ip_not_allowed');
    const deniedExpiredReset = await request(port, 'POST', '/api/auth/password-expired', {
      user: 'denied', currentPassword: 'N3w-Secret!', newPassword: 'Another-Secret!', confirmPassword: 'Another-Secret!',
    });
    assert.strictEqual(deniedExpiredReset.statusCode, 403, output);
    assert.strictEqual(deniedExpiredReset.body.code, 'ip_not_allowed');
    const expired = await request(port, 'POST', '/api/auth/login', { user: 'expired', password: 'N3w-Secret!', timeoutHours: 2 });
    assert.strictEqual(expired.statusCode, 403);
    assert.strictEqual(expired.body.code, 'password_expired');
    const logout = await request(port, 'POST', '/api/auth/logout', {}, cookie);
    assert.strictEqual(logout.statusCode, 200, output);
    const profileAfterLogout = await request(port, 'GET', '/api/local-accounts', null, cookie);
    assert.strictEqual(profileAfterLogout.statusCode, 401, output);
  } finally {
    child.kill();
    if (typeof fs.rmSync === 'function') fs.rmSync(configDirectory, { recursive: true, force: true });
    else fs.rmdirSync(configDirectory, { recursive: true });
  }
}

run().then(function () {
  console.log('local account server: OK');
}).catch(function (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
});
