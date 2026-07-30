'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'login.html'), 'utf8');
[
  'id="newPassword"',
  'id="confirmPassword"',
  'id="passwordExpiredPanel"',
  'role="alert"',
  '/api/auth/password-expired',
  "data.code === 'password_expired'",
  "credentials: 'same-origin'",
].forEach(function (needle) {
  assert.ok(html.includes(needle), '登录页缺少密码到期交互：' + needle);
});
assert.ok(html.includes('/api/auth/login'), '常规登录接口必须保留');
assert.ok(html.includes('id="timeoutHours"'), '常规登录会话时长必须保留');
console.log('local account login UI: OK');
