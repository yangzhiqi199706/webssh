'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const helperPath = path.resolve(__dirname, '..', 'proto-conv', 'proto-conv-session.js');
const serverPath = path.resolve(__dirname, '..', 'server.js');
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

assert.ok(fs.existsSync(helperPath), '协议转换会话工具必须存在');
assert.ok(
  packageJson.scripts.test.includes('node tests/proto-conv-session.test.js'),
  'npm test 必须执行协议转换会话回归测试',
);

const session = require(helperPath);

assert.deepStrictEqual(
  session.extractLoginSession({
    code: 100,
    data: { token: 'token-from-8086', userId: '1' },
  }),
  { token: 'token-from-8086', userLsh: '1' },
  '8086 的嵌套登录响应应提取 token 和 userId',
);

assert.deepStrictEqual(
  session.extractLoginSession({ UserLsh: 12, Token: 'legacy-token' }),
  { token: 'legacy-token', userLsh: '12' },
  '旧版顶层 Token 和 UserLsh 响应仍应兼容',
);

assert.deepStrictEqual(
  session.buildSessionHeaders('token-from-8086'),
  { token: 'token-from-8086' },
  '已登录请求必须通过 8086 可透传的 token 请求头携带会话',
);

assert.deepStrictEqual(
  session.buildSessionHeaders(''),
  {},
  '没有 token 时不得注入空鉴权请求头',
);

assert.strictEqual(
  session.isSessionExpired({ code: 300, msg: '请登录' }),
  true,
  '8086 业务码 300 应识别为会话失效',
);

assert.strictEqual(
  session.isSessionExpired({ code: 100, msg: '请求成功' }),
  false,
  '成功响应不得误判为会话失效',
);

assert.strictEqual(
  session.shouldRetryLoginWithPlain({ code: 400, msg: '用户不存在' }),
  true,
  'Base64 登录被 8086 拒绝时应改用明文重试',
);

assert.strictEqual(
  session.shouldRetryLoginWithPlain({ code: 100, msg: '请求成功' }),
  false,
  '成功登录不得重复提交明文密码',
);

const serverSource = fs.readFileSync(serverPath, 'utf8');
assert.ok(
  serverSource.includes("require('./proto-conv/proto-conv-session')"),
  '协议转换代理必须使用会话工具',
);
assert.ok(
  serverSource.includes('sessionUtils.buildSessionHeaders(session.token)'),
  '非登录请求必须从内存会话生成鉴权请求头',
);
assert.ok(
  serverSource.includes('sessionUtils.isSessionExpired(data)'),
  '协议转换代理必须识别 8086 的业务会话失效码',
);
assert.ok(
  serverSource.includes('sessionUtils.shouldRetryLoginWithPlain(r.data)'),
  'Base64 登录失败时必须按 8086 约定使用明文重试',
);

console.log('proto-conv session: OK');
