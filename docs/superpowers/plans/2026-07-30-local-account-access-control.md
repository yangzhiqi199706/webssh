# 本地账号与登录访问控制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不影响现有程序、健康检查和外部业务接口运行的前提下，实现本地多账号登录、角色分级、临时授权、密码有效期和登录 IP 白名单。

**Architecture:** `lib/access-control.js` 升级为纯函数的账号策略核心，兼容旧版单 `admin` 配置并把密码、角色和授权记录安全持久化。`server.js` 只在登录、登录会话和账户管理 API 使用该核心；不增加全局 API/WS 认证中间件，故已有服务与外部调用持续可用。设置页提供管理员账户策略面板，登录页在密码过期时进入独立的改密流程。

**Tech Stack:** Node.js 12、Express 4、原生 HTML/CSS/JavaScript、`crypto.scryptSync`、Node `assert` 测试。

---

### Task 1: 定义可测试的本地账号策略核心

**Files:**
- Modify: `lib/access-control.js`
- Modify: `tests/access-control.test.js`

- [ ] **Step 1: 写出失败的账号策略单元测试**

在 `tests/access-control.test.js` 增加一个 v2 配置。测试 `normalizeConfig` 输出一个启用的 `admin` 用户；测试用户名大小写精确匹配、`admin > operator > viewer` 的角色级别、有效临时授权提升有效角色、过期授权不提升角色；测试 `evaluateLogin` 分别返回 `ok`、`ip_not_allowed`、`password_expired`。

```js
const config = access.normalizeConfig({
  version: 2,
  passwordPolicy: { maxAgeDays: 90 },
  loginIpAllowlist: ['192.168.0.0/24'],
  users: [{ id: 'u-admin', username: 'admin', role: 'viewer', enabled: true,
    password: record, passwordChangedAt: '2026-07-01T00:00:00.000Z', sessionVersion: 1,
    loginIpAllowlist: ['192.168.0.8/32'] }],
  temporaryGrants: [{ id: 'g1', userId: 'u-admin', role: 'admin',
    startsAt: '2026-07-29T00:00:00.000Z', endsAt: '2026-07-31T00:00:00.000Z' }],
});
assert.strictEqual(access.effectiveRole(config, config.users[0], new Date('2026-07-30T12:00:00Z')), 'admin');
assert.strictEqual(access.evaluateLogin(config, 'admin', 'N3w-Secret!', '192.168.0.8', new Date('2026-07-30T12:00:00Z')).ok, true);
```

- [ ] **Step 2: 运行测试并确认失败原因是 API 尚不存在**

Run: `node tests/access-control.test.js`

Expected: FAIL，提示 `normalizeConfig` 或 `evaluateLogin` 未定义。

- [ ] **Step 3: 实现最小策略核心**

在 `lib/access-control.js` 保留 `createPasswordRecord` 与定时比较，新增如下稳定接口：

```js
const ROLE_LEVELS = { viewer: 1, operator: 2, admin: 3 };
function normalizeConfig(input) { /* 返回 version:2、policy、users、temporaryGrants */ }
function effectiveRole(config, user, now) { /* 基础角色与当前有效 grant 的最高级 */ }
function evaluateLogin(config, username, password, sourceIp, now, legacyPassword) {
  // 先检查用户、enabled、全局和账号 CIDR；再验证密码；最后检查 passwordChangedAt + maxAgeDays。
  // 仅返回公共 user/session 所需字段，绝不返回 password/hash。
}
```

CIDR 只接受 IPv4 与 IPv4-mapped IPv6，并把 `::ffff:192.168.0.8` 标准化为 IPv4。全局和账号白名单只要均非空，必须同时匹配。旧配置或配置文件缺失均映射为一个兼容的 `admin` 账号；旧固定密码没有可信修改时间，首次改密前不追溯判定过期。

- [ ] **Step 4: 运行核心测试并确认通过**

Run: `node tests/access-control.test.js`

Expected: PASS，输出 `access control: OK`。

- [ ] **Step 5: 提交本任务**

```powershell
git add lib/access-control.js tests/access-control.test.js
git commit -m "feat: add local account policy core"
```

### Task 2: 接入仅登录边界的会话和账户管理 API

**Files:**
- Modify: `server.js`
- Create: `tests/local-account-server.test.js`
- Modify: `package.json`

- [ ] **Step 1: 写出失败的 HTTP 集成测试**

创建临时 v2 配置并以随机端口启动 `server.js`。测试登录成功返回 `username` 与 `role`；不匹配白名单的登录返回 `403` 和 `ip_not_allowed`；过期密码登录返回 `403` 和 `password_expired`；`GET /health` 无 Cookie 仍返回 `200`。

```js
const denied = await request(port, 'POST', '/api/auth/login', {
  user: 'operator', password: 'N3w-Secret!', timeoutHours: 12,
});
assert.strictEqual(denied.statusCode, 403);
assert.strictEqual(denied.body.code, 'ip_not_allowed');
const health = await request(port, 'GET', '/health');
assert.strictEqual(health.statusCode, 200);
```

- [ ] **Step 2: 运行测试并确认它因 v2 登录未接入失败**

Run: `node tests/local-account-server.test.js`

Expected: FAIL，v2 配置被旧加载逻辑拒绝或登录响应没有角色/错误代码。

- [ ] **Step 3: 实现会话与 API 边界**

把 `authTokens` 的值改为 `{ userId, username, expiresAt, sessionVersion }`，新增 `getAuthSession(req)`，每次登录页会话检查时验证账号启用状态和 `sessionVersion`。`/api/auth/login` 使用 `evaluateLogin` 和 `req.socket.remoteAddress`，成功响应返回不含敏感信息的当前用户；失败区分白名单、禁用和密码过期。新增未认证的 `/api/auth/password-expired`，只允许凭当前有效密码设置新密码。

新增管理员受控接口：

```text
GET    /api/access-control
PUT    /api/access-control/password
PUT    /api/access-control/policy
POST   /api/access-control/users
PUT    /api/access-control/users/:id
PUT    /api/access-control/users/:id/password
POST   /api/access-control/temporary-grants
DELETE /api/access-control/temporary-grants/:id
```

账户管理接口通过 `requireAccessAdmin` 检查有效角色。修改密码、禁用账号时递增该账号 `sessionVersion` 并清理其会话；撤销临时授权即时重算有效角色。禁止禁用或降级最后一个启用的基础 `admin`。所有保存沿用 `opsSettings.writeJsonThenCommit` 的原子写入和 `0600` 权限。

明确不增加全局 `app.use('/api', ...)` 或 WebSocket upgrade 鉴权，不改 `/health`、短信/协议/HA 自动任务、外部 webhook 和已存在业务 API 的可用性。

- [ ] **Step 4: 运行服务端集成测试和原有认证测试**

Run: `node tests/local-account-server.test.js`

Expected: PASS，且临时 child process 被结束。

Run: `node tests/access-control.test.js`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```powershell
git add server.js package.json tests/local-account-server.test.js
git commit -m "feat: add local account login management APIs"
```

### Task 3: 实现安全的登录及密码过期交互

**Files:**
- Modify: `login.html`
- Create: `tests/local-account-login-ui.test.js`
- Modify: `package.json`

- [ ] **Step 1: 写出失败的登录页静态交互测试**

验证 `login.html` 包含密码过期重置所需的 `newPassword`、`confirmPassword`、状态 `role="alert"`，并调用 `/api/auth/password-expired`。验证常规登录仍调用 `/api/auth/login`、仍使用可选会话时长和 `credentials: 'same-origin'`。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node tests/local-account-login-ui.test.js`

Expected: FAIL，缺少过期密码流程元素与接口调用。

- [ ] **Step 3: 实现最小登录 UI**

常规登录失败为 `password_expired` 时，保留用户名与当前密码，切换到“更新过期密码”表单；显示新密码与确认字段，并在当前密码验证成功后调用 `/api/auth/password-expired`。重置成功后清空敏感输入并恢复常规登录；所有失败显示在相邻 `role="alert"` 区域。保留现有深浅主题、可见 focus ring、语义 label、按钮 loading/disabled 状态和移动端不溢出布局。

- [ ] **Step 4: 运行 UI 测试**

Run: `node tests/local-account-login-ui.test.js`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```powershell
git add login.html tests/local-account-login-ui.test.js package.json
git commit -m "feat: support expired password reset at login"
```

### Task 4: 实现管理员账户与授权设置界面

**Files:**
- Modify: `index.html`
- Create: `tests/local-account-settings-ui.test.js`
- Modify: `package.json`

- [ ] **Step 1: 写出失败的设置页 UI 测试**

断言设置页具备账户、密码策略、全局 IP 白名单、账号级白名单和临时授权区域；有无障碍 label/aria-live；引用所有账户管理 API；含 `access-admin-only` 容器用于非管理员的只读个人密码区域；不注册任何 `settingsMask` 点击关闭监听。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node tests/local-account-settings-ui.test.js`

Expected: FAIL，缺少账号、白名单和临时授权管理 UI。

- [ ] **Step 3: 实现管理界面和事件处理**

在现有“设置 → 运维”中把访问控制区域扩展为紧凑的三段布局：个人登录信息及改密、管理员密码策略与全局白名单、账号/临时授权列表和新增表单。管理员加载完整公共配置；非管理员只显示自身角色、密码有效期和个人改密。所有危险操作使用显式按钮与确认框；异步请求期间禁用触发按钮，成功和错误写入现有 `aria-live` 状态区。复用现有 `settings-card`、`grid2`、`.btn` 和 CSS 变量，不新增遮罩外关闭行为。

- [ ] **Step 4: 运行 UI 测试**

Run: `node tests/local-account-settings-ui.test.js`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```powershell
git add index.html tests/local-account-settings-ui.test.js package.json
git commit -m "feat: add local account administration UI"
```

### Task 5: 全量验证、双重审查与交付

**Files:**
- Verify: `lib/access-control.js`
- Verify: `server.js`
- Verify: `login.html`
- Verify: `index.html`
- Verify: `tests/*.test.js`

- [ ] **Step 1: 运行所有测试与静态差异检查**

Run: `npm test`

Expected: 所有测试 PASS。

Run: `git diff --check`

Expected: 无输出，退出码 0。

- [ ] **Step 2: 执行规格符合性审查**

审查本计划的目标逐项对应实现：本地账号、三档角色、临时授权、密码有效期、全局和账号 IP 白名单、旧配置兼容、登录限制范围和不影响程序运行。

- [ ] **Step 3: 执行代码质量与安全审查**

检查密码/哈希/令牌不出现在公共响应，使用时序安全比较，配置原子写入权限为 `0600`，账号变更会话失效，未引入 Node 12 不支持语法，且没有对全局业务 API/WS 增加门禁。

- [ ] **Step 4: 提交最终验证变更（如有）**

```powershell
git add lib/access-control.js server.js login.html index.html tests package.json
git commit -m "test: verify local account access controls"
```
