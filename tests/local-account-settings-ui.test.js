'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
[
  'id="localAccountProfile"',
  'id="accessAdminPanel"',
  'id="accessPolicyDays"',
  'id="accessGlobalAllowlist"',
  'id="accessUserList"',
  'id="accessGrantList"',
  'id="accessGrantStart"',
  'id="accessGrantEnd"',
  '/api/local-accounts',
  '/api/local-accounts/self-password',
  '/api/local-accounts/policy',
  '/api/local-accounts/users',
  '/api/local-accounts/temporary-grants',
  'access-admin-only',
].forEach(function (needle) {
  assert.ok(html.includes(needle), '设置页缺少本地账号管理元素：' + needle);
});
assert.strictEqual(html.includes("settingsMask.addEventListener('click'"), false, '设置遮罩不得点击关闭');
console.log('local account settings UI: OK');
