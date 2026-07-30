# 运维设置完善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 实现服务端日志轮转与保留、固定页面访问密码、仅 SSH 会话的闲置自动断开。

**Architecture:** 在 lib 中实现四个可独立测试的模块；server.js 负责配置加载、认证路由、轮转调度和 SSH 生命周期接入；index.html 只负责设置表单与现有提示样式。密码与运维设置分别以 0600 JSON 文件写入 /opt/webssh/config。

**Tech Stack:** Node.js 12、Express、ws、crypto、zlib、stream、原生 HTML/JavaScript、Node assert。

---

## 文件结构

- Create: lib/access-control.js — scrypt 密码记录、日期密码迁移和脱敏状态。
- Create: lib/ops-settings.js — 默认配置、数值归一化、原子 JSON 写入。
- Create: lib/log-rotation.js — .log gzip copy-truncate 和归档保留期清理。
- Create: lib/ssh-idle-timer.js — 可重置与取消的闲置计时器。
- Modify: server.js — 认证、五个配置 API、自动轮转、SSH 计时器。
- Modify: index.html — 三张运维设置卡片和 API 调用。
- Create: tests/access-control.test.js, tests/ops-settings.test.js, tests/log-rotation.test.js, tests/ssh-idle-timer.test.js, tests/ops-settings-ui.test.js。
- Modify: package.json — 所有新增测试纳入 npm test。

### Task 1: 先实现访问密码模块

**Files:**
- Create: tests/access-control.test.js
- Create: lib/access-control.js

- [ ] **Step 1: 写入失败测试**

~~~js
'use strict';
const assert = require('assert');
const access = require('../lib/access-control');
const fixedRandom = function (size) { return Buffer.alloc(size, 0xab); };
const legacy = '20260730';

assert.strictEqual(access.authenticate(null, 'admin', legacy, legacy), true);
assert.strictEqual(access.authenticate(null, 'root', legacy, legacy), false);
const record = access.createPasswordRecord('N3w-Secret!', fixedRandom);
assert.strictEqual(record.algorithm, 'scrypt');
assert.strictEqual(record.salt, 'ab'.repeat(16));
assert.notStrictEqual(record.hash, 'N3w-Secret!');
assert.strictEqual(access.verifyPassword('N3w-Secret!', record), true);
assert.strictEqual(access.verifyPassword('wrong', record), false);
assert.strictEqual(access.authenticate({ username: 'admin', password: record }, 'admin', legacy, legacy), false);
assert.deepStrictEqual(access.publicConfig({ username: 'admin', password: record }), { username: 'admin', hasPassword: true });
console.log('access control: OK');
~~~

- [ ] **Step 2: 运行并确认失败**

Run: node tests/access-control.test.js

Expected: Cannot find module '../lib/access-control'。

- [ ] **Step 3: 编写最小实现**

使用 Node crypto 实现并导出 hasPassword、createPasswordRecord、verifyPassword、authenticate、publicConfig。createPasswordRecord 必须使用 16 字节随机 salt 与 crypto.scryptSync(password, salt, 64)；verifyPassword 用 crypto.timingSafeEqual 比较 64 字节摘要且所有无效数据返回 false。authenticate 在无摘要配置时仅接受 admin 加 legacyPassword，摘要存在后只接受摘要匹配。

- [ ] **Step 4: 验证通过**

Run: node tests/access-control.test.js

Expected: access control: OK。

- [ ] **Step 5: 提交**

~~~bash
git add lib/access-control.js tests/access-control.test.js
git commit -m "feat: add persistent access password support"
~~~

### Task 2: 实现运维设置配置模块

**Files:**
- Create: tests/ops-settings.test.js
- Create: lib/ops-settings.js

- [ ] **Step 1: 写入失败测试**

~~~js
'use strict';
const assert = require('assert');
const ops = require('../lib/ops-settings');

assert.deepStrictEqual(ops.normalize(null), {
  logRotation: { enabled: true, retentionDays: 30, lastRotationDate: '', lastResult: null },
  idleDisconnect: { enabled: false, timeoutMinutes: 30 },
});
assert.deepStrictEqual(ops.normalize({
  logRotation: { enabled: 0, retentionDays: 99999 },
  idleDisconnect: { enabled: true, timeoutMinutes: 0 },
}), {
  logRotation: { enabled: false, retentionDays: 3650, lastRotationDate: '', lastResult: null },
  idleDisconnect: { enabled: true, timeoutMinutes: 1 },
});
assert.strictEqual(ops.localDateKey(new Date(2026, 6, 30)), '2026-07-30');
console.log('ops settings: OK');
~~~

- [ ] **Step 2: 运行并确认失败**

Run: node tests/ops-settings.test.js

Expected: Cannot find module '../lib/ops-settings'。

- [ ] **Step 3: 编写最小实现**

导出 DEFAULTS、normalize、localDateKey、writeJsonAtomic。normalize 固定日志保留天数为 1–3650、闲置分钟为 1–1440；缺省值分别为每日自动轮转/30 天、闲置关闭/30 分钟。writeJsonAtomic 在同目录 0600 临时文件中写 JSON、chmod 后 rename，再 chmod 最终文件。

- [ ] **Step 4: 验证通过**

Run: node tests/ops-settings.test.js

Expected: ops settings: OK。

- [ ] **Step 5: 提交**

~~~bash
git add lib/ops-settings.js tests/ops-settings.test.js
git commit -m "feat: add operations settings persistence helpers"
~~~

### Task 3: 实现日志轮转和保留期清理

**Files:**
- Create: tests/log-rotation.test.js
- Create: lib/log-rotation.js

- [ ] **Step 1: 写入失败测试**

测试使用 fs.mkdtempSync 创建目录，写入 webssh.out.log、webssh.err.log.20260101.gz 与 ha-sync-bak.sql.gz。调用 rotateLogs({ logDir, now: new Date(2026, 6, 30, 12), retentionDays: 30 }) 后断言：

~~~js
assert.deepStrictEqual(result.rotated, ['webssh.out.log']);
assert.strictEqual(fs.readFileSync(active, 'utf8'), '');
assert.strictEqual(zlib.gunzipSync(fs.readFileSync(archive)).toString(), 'first line\n');
assert.strictEqual(fs.existsSync(expiredArchive), false);
assert.strictEqual(fs.readFileSync(backup, 'utf8'), 'keep');
~~~

finally 中删除临时目录，并打印 log rotation: OK。

- [ ] **Step 2: 运行并确认失败**

Run: node tests/log-rotation.test.js

Expected: Cannot find module '../lib/log-rotation'。

- [ ] **Step 3: 编写最小实现**

rotateLogs 仅处理文件名匹配 /\.log$/ 的非空活动日志。每个文件通过 promisify(stream.pipeline)(readStream, zlib.createGzip(), createWriteStream) 生成归档，管道成功后才 fs.truncateSync 活动文件。常规归档使用 .YYYYMMDD.gz；force 为 true 且已存在当天归档时使用 .YYYYMMDD-HHmmss.gz。仅删除匹配 /\.log\.\d{8}(?:-\d{6})?\.gz$/ 且 mtime 早于 now - retentionDays * 86400000 的文件。返回 rotated、deleted、finishedAt。

- [ ] **Step 4: 验证通过**

Run: node tests/log-rotation.test.js

Expected: log rotation: OK。

- [ ] **Step 5: 提交**

~~~bash
git add lib/log-rotation.js tests/log-rotation.test.js
git commit -m "feat: add built-in service log rotation"
~~~

### Task 4: 实现 SSH 闲置计时器

**Files:**
- Create: tests/ssh-idle-timer.test.js
- Create: lib/ssh-idle-timer.js

- [ ] **Step 1: 写入失败测试**

使用 fakeSetTimeout 和 fakeClearTimeout 注入 createIdleTimer。调用 touch 两次后断言第一次 handle 被清除、第二次等待 60000ms；手工触发第二个回调后断言 onIdle 只调用一次；再次 touch 后调用 cancel，断言无 pending timer。

- [ ] **Step 2: 运行并确认失败**

Run: node tests/ssh-idle-timer.test.js

Expected: Cannot find module '../lib/ssh-idle-timer'。

- [ ] **Step 3: 编写最小实现**

createIdleTimer(options) 返回 touch 和 cancel。touch 在非取消状态下清理旧 handle 后设置一个新超时；超时后清空 handle 并调用一次 onIdle；cancel 标记取消且清理 handle。缺省使用全局 setTimeout 和 clearTimeout。

- [ ] **Step 4: 验证通过**

Run: node tests/ssh-idle-timer.test.js

Expected: ssh idle timer: OK。

- [ ] **Step 5: 提交**

~~~bash
git add lib/ssh-idle-timer.js tests/ssh-idle-timer.test.js
git commit -m "feat: add resettable SSH idle timer"
~~~

### Task 5: 接入服务端认证、设置 API、轮转调度和 SSH 生命周期

**Files:**
- Create: tests/ops-settings-ui.test.js
- Modify: server.js:1-10
- Modify: server.js:597-699
- Modify: server.js:1680-1806

- [ ] **Step 1: 写入失败的接入点测试**

~~~js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
[
  './lib/access-control', './lib/ops-settings', './lib/log-rotation', './lib/ssh-idle-timer',
  "app.get('/api/ops-settings'", "app.put('/api/ops-settings'",
  "app.post('/api/ops-settings/rotate-logs'", "app.get('/api/access-control'",
  "app.put('/api/access-control/password'", "code: 'idle_timeout'",
].forEach(function (needle) { assert.ok(server.includes(needle), '缺少服务端接入：' + needle); });
console.log('ops server integration: OK');
~~~

- [ ] **Step 2: 运行并确认失败**

Run: node tests/ops-settings-ui.test.js

Expected: 首个“缺少服务端接入”断言失败。

- [ ] **Step 3: 替换登录门禁密码校验**

在 server.js 顶部加载四个 lib。为 WEBSSH_ACCESS_CONTROL_CONFIG 和 WEBSSH_OPS_SETTINGS_CONFIG 建立默认的 /opt/webssh/config 文件路径；读取失败时用各自默认配置。将原 admin 加 todayPassword 直接比较替换为 accessControl.authenticate(accessConfig, user, pwd, todayPassword())，保留 token、cookie、登录时长、/login 与主页重定向。

- [ ] **Step 4: 注册五个受认证保护的 API**

实现 GET/PUT /api/ops-settings、POST /api/ops-settings/rotate-logs、GET /api/access-control、PUT /api/access-control/password。每个路由未通过 isAuthed(req) 时返回 401 和 { ok:false, message:'登录已失效' }。密码更新要求 currentPassword、newPassword、confirmPassword，长度至少 8、两次一致，并以当前摘要或日期密码验证后保存新 scrypt 记录。GET 密码接口只返回 publicConfig。

- [ ] **Step 5: 接入自动轮转**

实现 runScheduledRotation：日志开关开启且 lastRotationDate 不等于 localDateKey 时调用 rotateLogs；成功后更新 lastRotationDate 与 lastResult，失败只记录失败结果。服务启动时调用一次；以 setInterval(runScheduledRotation, 60 * 60 * 1000).unref() 每小时检查。手动轮转 API 传 force:true 并返回最新结果。

- [ ] **Step 6: 接入 SSH 闲置断开**

在 wss.on('connection') 中维护 idleTimer。SSH ready 后若配置开启，创建 timeoutMinutes * 60000 的计时器；超时发送：

~~~js
send('error', { message: 'SSH 会话闲置超时，已自动断开', code: 'idle_timeout' });
try { ssh.end(); } catch (_e) {}
try { ws.close(); } catch (_e) {}
~~~

每个已就绪的 WebSocket 请求、shell data、每个 SFTP 请求入口调用 idleTimer.touch()；ws close、SSH error、shell close 和已有 lifetime timer 到期前调用 idleTimer.cancel()。连接时长上限逻辑保持独立。

- [ ] **Step 7: 验证**

Run: node tests/ops-settings-ui.test.js && npm test

Expected: ops server integration: OK，npm test 通过。

- [ ] **Step 8: 提交**

~~~bash
git add server.js tests/ops-settings-ui.test.js
git commit -m "feat: expose operations settings and enforce SSH idle timeout"
~~~

### Task 6: 实现运维页和测试命令

**Files:**
- Modify: index.html:1270-1311
- Modify: index.html:2126-2135
- Modify: index.html:2953-3085
- Modify: index.html:3511-3587
- Modify: index.html:4650-4665
- Modify: tests/ops-settings-ui.test.js
- Modify: package.json:6-10

- [ ] **Step 1: 扩展 UI 失败断言**

在 tests/ops-settings-ui.test.js 读取 index.html 并断言存在下列字符串：

~~~js
[
  'opsLogRotateEnabled', 'opsLogRetentionDays', 'opsRotateNow',
  'opsIdleEnabled', 'opsIdleMinutes',
  'accessCurrentPassword', 'accessNewPassword', 'accessConfirmPassword',
  '/api/ops-settings', '/api/access-control/password',
]
~~~

- [ ] **Step 2: 运行并确认失败**

Run: node tests/ops-settings-ui.test.js

Expected: 缺少运维 UI 或 API 调用：opsLogRotateEnabled。

- [ ] **Step 3: 替换“规划中”卡片**

新增三张 settings-card：

1. 日志自动轮转：opsLogRotateEnabled、opsLogRetentionDays（1–3650）、opsLogRotateStatus、opsLogRotateResult、opsRotateNow、opsSaveSettings。
2. SSH 闲置自动断开：opsIdleEnabled、opsIdleMinutes（1–1440），明确“仅断开 SSH 会话，不退出页面”。
3. 页面访问密码：accessCurrentPassword、accessNewPassword、accessConfirmPassword、accessPasswordStatus、accessPasswordSave；所有密码输入为 type=password，禁止回填旧值。

- [ ] **Step 4: 接入前端行为**

增加 refreshOpsSettings、renderOpsSettings、saveOpsSettings、rotateLogsNow、refreshAccessControl、saveAccessPassword。所有 fetch 添加 credentials:'same-origin'。设置打开时刷新 Docker、运维设置和访问密码状态；设置关闭时保留现有 Docker 刷新定时器清理。前端保存密码先检查 8 字符最小长度和两次一致，但后端为最终权威。

- [ ] **Step 5: 纳入全量测试**

将以下测试追加到 package.json test 脚本：

~~~text
&& node tests/access-control.test.js && node tests/ops-settings.test.js && node tests/log-rotation.test.js && node tests/ssh-idle-timer.test.js && node tests/ops-settings-ui.test.js
~~~

Run: npm test

Expected: 所有既有与新增测试通过，退出码 0。

- [ ] **Step 6: 本机接口冒烟**

Run: PORT=3011 node server.js

第二终端执行：

~~~powershell
$login = Invoke-WebRequest -SessionVariable session -Method Post -Uri http://127.0.0.1:3011/api/auth/login -ContentType application/json -Body ('{"user":"admin","password":"' + (Get-Date -Format yyyyMMdd) + '","timeoutHours":1}')
$login.StatusCode
(Invoke-WebRequest -WebSession $session -Uri http://127.0.0.1:3011/api/ops-settings).StatusCode
~~~

Expected: 两次输出 200。停止服务后，仅删除本次冒烟生成的 config/ops-settings.json 和 config/access-control.json。

- [ ] **Step 7: 提交**

~~~bash
git add index.html package.json tests/ops-settings-ui.test.js
git commit -m "feat: add operations settings controls"
~~~

### Task 7: 完成前验证和部署

**Files:**
- Modify: none expected

- [ ] **Step 1: 验证部署包覆盖新增 lib**

Run: node tests/deploy-upgrade-tar-compat.test.js && node tests/build-fullstack-app-lib.test.js

Expected: 两项通过；现有部署脚本已整目录同步 lib，无需修改。

- [ ] **Step 2: 完整回归**

Run: npm test

Expected: 退出码 0，无失败。

- [ ] **Step 3: 部署与探活**

Run: $env:WEBSSH_DEPLOY_PASS = 'REDACTED_DEPLOY_PASS'; node scripts/deploy-protocol.js

Expected: webssh 和 webssh-protocol 均为 active，/health 和 /protocol/ 返回 HTTP 200。

- [ ] **Step 4: 目标机验收**

设置固定密码并重新登录；执行立即轮转并验证仅 logs/*.log 被归档；启用短阈值 SSH 闲置断开，确认 SSH 关闭但页面保持已登录。

- [ ] **Step 5: 提交全部功能文件**

~~~bash
git status --short
git add lib/access-control.js lib/ops-settings.js lib/log-rotation.js lib/ssh-idle-timer.js server.js index.html package.json tests/access-control.test.js tests/ops-settings.test.js tests/log-rotation.test.js tests/ssh-idle-timer.test.js tests/ops-settings-ui.test.js
git commit -m "feat: complete operations settings"
~~~
