# 服务总览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 webssh 主壳提供只读服务总览，按分钟采集本机、HA 对端和 `dcim` 容器状态，保留 7 天趋势并支持手动刷新。

**Architecture:** 新建独立的 `lib/service-overview.js`，负责无凭据泄露的采样、单飞并发控制、原子历史写入和 7 天裁剪；`server.js` 只注入依赖、注册 API 并启动采样。前端以一个懒加载 iframe 子站呈现运维指挥台，使用原生 Canvas 绘制趋势，不引入外部依赖。

**Tech Stack:** Node.js 12、Express、ssh2、原生 HTML/CSS/JavaScript、Node `assert` 测试。

---

## 文件结构

- 新增：`lib/service-overview.js` — 指标解析、采样、历史存储、7 天清理和单飞刷新。
- 新增：`overview/index.html`、`overview/assets/css/style.css`、`overview/assets/js/overview.js` — 指挥台 iframe 页面与 Canvas 趋势。
- 修改：`server.js` — 初始化采集器，注册只读查询与手动刷新 API，并在服务启动时开启定时采样。
- 修改：`index.html` — 菜单、懒加载 iframe 和视图切换。
- 修改：`package.json` — 将 3 个服务总览测试纳入 `npm test`。
- 修改：`scripts/deploy-upgrade.js`、`scripts/deploy-protocol.js`、`scripts/build-fullstack-on-server.js` — 使 `overview/` 随增量部署、协议部署和全栈包同步。
- 新增：`tests/service-overview.test.js`、`tests/service-overview-ui.test.js`、`tests/service-overview-deploy.test.js`。

### Task 1: 建立采集与历史模块

**Files:**
- Create: `tests/service-overview.test.js`
- Create: `lib/service-overview.js`

- [ ] **Step 1: 编写失败测试**

创建 `tests/service-overview.test.js`：

```js
'use strict';

const assert = require('assert');
const overview = require('../lib/service-overview');

const probe = [
  'cpu.user=100', 'cpu.nice=0', 'cpu.system=50', 'cpu.idle=850',
  'mem.totalKb=1000', 'mem.availableKb=250', 'disk.usedKb=400', 'disk.totalKb=1000',
  'load.1m=1.25', 'uptime.seconds=7200',
  'service.webssh=active', 'service.protocol=active', 'service.docker=active',
  'dcim.container=true', 'dcim.service=active',
].join('\n');

const parsed = overview.parseProbeOutput(probe);
assert.deepStrictEqual(parsed.cpu, { user: 100, nice: 0, system: 50, idle: 850 });
assert.strictEqual(parsed.memory.percent, 75);
assert.strictEqual(parsed.disk.percent, 40);
assert.strictEqual(parsed.services.dcim.healthy, true);
assert.strictEqual(overview.cpuPercent(parsed.cpu, { user: 130, nice: 0, system: 70, idle: 900 }), 50);

const now = Date.UTC(2026, 6, 30, 0, 0, 0);
assert.strictEqual(overview.pruneHistory([
  { sampledAt: new Date(now - 8 * 86400000).toISOString() },
  { sampledAt: new Date(now - 6 * 86400000).toISOString() },
], now, 7 * 86400000).length, 1);

const safe = overview.toPublicSnapshot({ peer: { password: 'secret' }, error: 'password=secret' });
assert.strictEqual(JSON.stringify(safe).includes('secret'), false);

let calls = 0;
const collector = overview.createCollector({
  collectOnce: async function () { calls += 1; return { sampledAt: '2026-07-30T00:00:00.000Z' }; },
});
Promise.all([collector.refresh(), collector.refresh()]).then(function () {
  assert.strictEqual(calls, 1);
  console.log('service overview core: OK');
});
```

- [ ] **Step 2: 确认测试失败**

运行：`node tests/service-overview.test.js`

预期：因 `Cannot find module '../lib/service-overview'` 失败。

- [ ] **Step 3: 实现最小模块**

创建 `lib/service-overview.js` 并导出：

```js
module.exports = {
  createProbeCommand,
  parseProbeOutput,
  cpuPercent,
  pruneHistory,
  toPublicSnapshot,
  createCollector,
  createServiceOverview,
};
```

`createProbeCommand()` 只能读取 `/proc/stat`、`/proc/meminfo`、`/proc/loadavg`、`/proc/uptime`，并调用 `df -Pk /`、`systemctl is-active`、`docker inspect`、`docker exec dcim systemctl is-active dcim`。输出必须含下列键：

```text
cpu.user cpu.nice cpu.system cpu.idle
mem.totalKb mem.availableKb
disk.usedKb disk.totalKb
load.1m uptime.seconds
service.webssh service.protocol service.docker
dcim.container dcim.service
```

服务和容器命令均以 `|| true` 收尾，局部失败不得中断同次采样。解析函数把数值转换为 Number，以 `availableKb / totalKb` 和 `usedKb / totalKb` 计算使用率；`cpuPercent(previous, current)` 用总差值和 idle 差值计算百分比，首次采样返回 `null`。

`createServiceOverview(options)` 接收 `fs`、`path`、`Client`、`spawn`、`historyPath`、`haConfigPath`、`now`、`intervalMs`、`retentionMs`。它从 HA 配置按照 `selfRole` 选择对端 SSH，只在服务端读取密码，分别采集本机和对端；对端失败记录 `unknown` 和脱敏错误，不影响本机。历史文件以临时文件写入并 `renameSync` 原子替换，写入前后用 `pruneHistory` 裁剪 7 天。

`createCollector` 用一个 `inFlight` Promise 实现单飞：刷新进行时返回同一 Promise，完成或失败后清空。

- [ ] **Step 4: 验证模块**

运行：`node tests/service-overview.test.js`

预期：输出 `service overview core: OK`。

### Task 2: 接入 Express API 与分钟采样

**Files:**
- Modify: `server.js:顶部依赖、CONFIG_DIR 附近、API 路由区、server.listen 回调`
- Modify: `tests/service-overview.test.js`

- [ ] **Step 1: 增加失败的服务器接入断言**

在核心测试追加：

```js
const fs = require('fs');
const path = require('path');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
[
  "require('./lib/service-overview')",
  "app.get('/api/service-overview'",
  "app.post('/api/service-overview/refresh'",
  'serviceOverview.start();',
  'serviceOverview.stop();',
].forEach(function (needle) {
  assert.ok(server.includes(needle), '缺少服务总览服务端接入：' + needle);
});
```

- [ ] **Step 2: 确认接入断言失败**

运行：`node tests/service-overview.test.js`

预期：以 `缺少服务总览服务端接入` 失败。

- [ ] **Step 3: 注册只读 API**

在 `server.js` 顶部加入：

```js
const { createServiceOverview } = require('./lib/service-overview');
```

在 `CONFIG_DIR` 附近建立运行时路径和实例：

```js
const SERVICE_OVERVIEW_HISTORY_PATH = process.env.WEBSSH_SERVICE_OVERVIEW_HISTORY
  || path.join(CONFIG_DIR, 'service-overview-history.json');
const SERVICE_OVERVIEW_HA_CONFIG_PATH = process.env.HA_CONFIG || path.join(CONFIG_DIR, 'ha.json');
const serviceOverview = createServiceOverview({
  fs: fs, path: path, Client: Client, spawn: spawn,
  historyPath: SERVICE_OVERVIEW_HISTORY_PATH,
  haConfigPath: SERVICE_OVERVIEW_HA_CONFIG_PATH,
  intervalMs: 60 * 1000, retentionMs: 7 * 24 * 60 * 60 * 1000,
});
```

注册 API：

```js
app.get('/api/service-overview', function (_req, res) {
  res.json({ ok: true, snapshot: serviceOverview.getSnapshot(), history: serviceOverview.getHistory() });
});

app.post('/api/service-overview/refresh', async function (_req, res) {
  try {
    const snapshot = await serviceOverview.refresh();
    res.json({ ok: true, snapshot: snapshot, history: serviceOverview.getHistory() });
  } catch (err) {
    res.status(502).json({ ok: false, message: String(err && err.message || err) });
  }
});
```

在 `server.listen` 回调调用 `serviceOverview.start();`，并以 `SIGINT` 和 `SIGTERM` 的 `process.once` 处理器调用 `serviceOverview.stop();`。响应体必须经过 `toPublicSnapshot` 清理，绝不返回 SSH 密码。

- [ ] **Step 4: 验证 API 接入**

运行：`node tests/service-overview.test.js`

预期：输出 `service overview core: OK`。

### Task 3: 构建运维指挥台页面

**Files:**
- Create: `overview/index.html`
- Create: `overview/assets/css/style.css`
- Create: `overview/assets/js/overview.js`
- Create: `tests/service-overview-ui.test.js`
- Modify: `index.html:menuItems、iframe 视图区、el 对象、showView()`

- [ ] **Step 1: 编写失败 UI 测试**

创建 `tests/service-overview-ui.test.js`：

```js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const shell = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const page = fs.readFileSync(path.join(root, 'overview', 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'overview', 'assets', 'js', 'overview.js'), 'utf8');

[
  "id: 'overview'", 'id="overviewView"', 'id="overviewFrame"', './overview/index.html',
].forEach(function (needle) { assert.ok(shell.includes(needle), '主壳缺少总览接入：' + needle); });
[
  'overviewRefresh', 'overviewUpdatedAt', 'overviewAlerts', 'overviewServices', 'overviewTrend',
].forEach(function (id) { assert.ok(page.includes('id="' + id + '"'), '总览页面缺少：' + id); });
[
  '/api/service-overview', '/api/service-overview/refresh', "getContext('2d')", 'drawTrend',
].forEach(function (needle) { assert.ok(script.includes(needle), '总览脚本缺少：' + needle); });
assert.doesNotMatch(script, /restart|failover|switch|PUT\s|DELETE\s/, '总览不得出现控制操作');
console.log('service overview UI: OK');
```

- [ ] **Step 2: 确认 UI 测试失败**

运行：`node tests/service-overview-ui.test.js`

预期：因缺少 `overview/index.html` 失败。

- [ ] **Step 3: 实现懒加载指挥台**

在主壳菜单加入：

```js
{ id: 'overview', label: '服务总览', icon: 'OPS', title: '本机、双机热备与 dcim 的只读运行总览' },
```

添加：

```html
<div class="serial-view" id="overviewView">
  <iframe id="overviewFrame" title="服务总览" loading="lazy" src="about:blank"></iframe>
</div>
```

在 `el` 与 `showView()` 加 `overviewView`、`overviewFrame`，选中时只执行一次：

```js
el.overviewFrame.src = './overview/index.html';
el.overviewFrame.dataset.loaded = '1';
```

`overview/index.html` 必须有最后采样时间、手动刷新按钮、两台主机资源卡片、服务矩阵、异常列表和趋势区。脚本只可调用 `GET /api/service-overview` 与 `POST /api/service-overview/refresh`。用 `drawTrend(canvas, records, metric, color)` 在 Canvas 绘制本机与对端的 CPU、内存、磁盘 7 天曲线；无数据时显示“暂无数据”，不得伪造曲线。CSS 复用深色背景、青色强调、`.ok/.warn/.bad/.unknown` 状态色，不引入 CDN。

- [ ] **Step 4: 验证 UI**

运行：`node tests/service-overview-ui.test.js`

预期：输出 `service overview UI: OK`。

### Task 4: 纳入所有部署产物

**Files:**
- Modify: `scripts/deploy-upgrade.js:upgradePayloadEntries()`
- Modify: `scripts/deploy-protocol.js:protocolMainSyncEntries(),createMainSyncReleasePlan(),本地 main-sync 复制、远端目录同步`
- Modify: `scripts/build-fullstack-on-server.js:主壳 stage copy`
- Create: `tests/service-overview-deploy.test.js`

- [ ] **Step 1: 编写失败部署测试**

创建 `tests/service-overview-deploy.test.js`：

```js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const upgrade = fs.readFileSync(path.join(root, 'scripts', 'deploy-upgrade.js'), 'utf8');
const protocol = fs.readFileSync(path.join(root, 'scripts', 'deploy-protocol.js'), 'utf8');
const fullstack = fs.readFileSync(path.join(root, 'scripts', 'build-fullstack-on-server.js'), 'utf8');

assert.match(upgrade, /'overview'/, '增量部署必须包含 overview');
assert.match(protocol, /'overview'/, '协议部署主壳同步必须包含 overview');
assert.match(protocol, /main-sync\/overview/, '协议部署必须复制 overview 子站');
assert.match(fullstack, /\/opt\/webssh\/app\/overview/, '全栈包必须包含 overview 子站');
console.log('service overview deploy: OK');
```

- [ ] **Step 2: 确认部署测试失败**

运行：`node tests/service-overview-deploy.test.js`

预期：以 `增量部署必须包含 overview` 失败。

- [ ] **Step 3: 更新部署脚本**

在 `scripts/deploy-upgrade.js` 的 `upgradePayloadEntries()` 中添加 `'overview'`。在 `scripts/deploy-protocol.js` 的 `protocolMainSyncEntries()` 和 `createMainSyncReleasePlan()` 条目数组加入 `'overview'`，按现有 `proto-conv` 目录同步模式复制本地 `overview/` 到 `main-sync/overview/`，在远端先备份 `/opt/webssh/app/overview` 后复制并验证 `overview/index.html`。失败时必须复用 `releasePlan` 的回滚路径恢复旧目录。在 `scripts/build-fullstack-on-server.js` 的主壳 stage 区加入：

```js
await exec(conn, \`cp -a /opt/webssh/app/overview \${STAGE_DIR}/app/ 2>/dev/null || true\`);
```

- [ ] **Step 4: 验证部署脚本**

运行：`node tests/service-overview-deploy.test.js`

预期：输出 `service overview deploy: OK`。

### Task 5: 完整验证并提交

**Files:**
- Modify: `package.json:9`
- Test: `tests/service-overview.test.js`
- Test: `tests/service-overview-ui.test.js`
- Test: `tests/service-overview-deploy.test.js`

- [ ] **Step 1: 纳入 npm test**

在 `package.json` 的 `test` 字符串中，于 `node tests/modal-backdrop.test.js &&` 后加入：

```text
node tests/service-overview.test.js && node tests/service-overview-ui.test.js && node tests/service-overview-deploy.test.js &&
```

- [ ] **Step 2: 执行验证**

运行：`npm test`

预期：退出码为 0，包含：

```text
service overview core: OK
service overview UI: OK
service overview deploy: OK
```

运行：`git diff --check`

预期：无输出。

- [ ] **Step 3: 提交实现**

```bash
git add lib/service-overview.js overview index.html server.js package.json scripts/deploy-upgrade.js scripts/deploy-protocol.js scripts/build-fullstack-on-server.js tests/service-overview.test.js tests/service-overview-ui.test.js tests/service-overview-deploy.test.js
git commit -m "feat: 新增服务总览"
```

预期：提交只包含服务总览、覆盖测试和必要的部署同步修改。

## 自检结果

- Task 1-2 覆盖本机/对端/DCIM 采集、敏感信息保护、对端降级、单飞刷新和 7 天历史。
- Task 3 覆盖指挥台、手动刷新、趋势和只读边界。
- Task 4 覆盖三条部署路径。
- Task 5 将测试纳入 `npm test` 并执行完整验证。
