# Docker 定时重启 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在运维板块新增独立的 Docker 定时重启功能，按分钟循环倒计时，重启成功后自动进入下一轮。

**Architecture:** 保留已有“开机后自动重启 docker”一次性功能不变，新增 `lib/docker-scheduled-restart.js` 管理独立配置、倒计时、执行锁、结果和日志。主服务通过 `/api/docker-scheduled-restart/*` 暴露状态与控制接口，运维页面新增同风格卡片并每秒刷新倒计时。

**Tech Stack:** Node.js 12 CommonJS、Express、`child_process.spawn`、原生 HTML/CSS/JavaScript、Node 内置 `assert` 测试。

---

### Task 1: 建立循环调度器的失败测试

**Files:**
- Create: `tests/docker-scheduled-restart.test.js`
- Create: `lib/docker-scheduled-restart.js`

- [ ] **Step 1: 写出失败测试**

测试覆盖：分钟到秒的换算、启用后开始倒计时、成功执行后自动排下一轮、失败后暂停、取消清理计时器、并发执行防重入。

- [ ] **Step 2: 运行红测**

Run: `node tests/docker-scheduled-restart.test.js`

Expected: 因 `lib/docker-scheduled-restart.js` 尚不存在而失败。

- [ ] **Step 3: 实现最小调度器**

实现 `createDockerScheduledRestart({ spawn, setTimeout, clearTimeout, now, loadConfig, saveConfig, appendLog })`，公开 `getState`、`updateConfig`、`cancel`、`restartCountdown`、`trigger`、`load`。配置字段为 `enabled`、`intervalMinutes`、`lastResult`，间隔限制 1-1440 分钟。

- [ ] **Step 4: 运行绿测**

Run: `node tests/docker-scheduled-restart.test.js`

Expected: 所有调度器行为通过。

### Task 2: 接入主服务 API

**Files:**
- Modify: `server.js`
- Create: `tests/docker-scheduled-restart-api.test.js`

- [ ] **Step 1: 写出 API 契约测试**

检查 `server.js` 包含配置、状态、取消、重新倒计时和手动执行路由，并调用调度器的公开方法；验证配置路径和日志路径均位于运行时 `config/`、`logs/`。

- [ ] **Step 2: 运行红测**

Run: `node tests/docker-scheduled-restart-api.test.js`

Expected: 因主服务尚未接入新路由而失败。

- [ ] **Step 3: 接入 IIFE**

在现有 Docker 自动重启模块之后挂载新调度器。定时执行复用 `systemctl restart docker`，执行前后调用已有短信数据库暂停/恢复钩子；成功后由调度器自动排下一轮，失败不自动重试。

- [ ] **Step 4: 运行 API 契约测试**

Run: `node tests/docker-scheduled-restart-api.test.js`

Expected: 路由、字段和循环语义检查通过。

### Task 3: 增加运维页面卡片

**Files:**
- Modify: `index.html`
- Create: `tests/docker-scheduled-restart-ui.test.js`

- [ ] **Step 1: 写出 UI 契约测试**

检查运维面板包含“Docker 定时重启”、分钟输入、启用开关、当前状态、上次结果、取消/重新倒计时/立即执行/保存控件，并调用新 API；倒计时显示单位为分钟/秒，不再把新功能标成开机一次性重启。

- [ ] **Step 2: 运行红测**

Run: `node tests/docker-scheduled-restart-ui.test.js`

Expected: 因页面尚未增加新卡片和 API 调用而失败。

- [ ] **Step 3: 实现 UI**

沿用现有运维卡片样式，新增独立 DOM ID、渲染函数、保存/取消/重新倒计时/立即执行事件和 1 秒轮询；危险的立即执行保留确认提示。失败状态显示错误并暂停循环。

- [ ] **Step 4: 运行 UI 契约测试**

Run: `node tests/docker-scheduled-restart-ui.test.js`

Expected: UI 契约检查通过。

### Task 4: 章节归档、全量验证与交付

**Files:**
- Create: `docs/development-chapters/第17章-2026-08-28-Docker定时重启.md`
- Modify: `docs/development-chapters/README.md`
- Modify: `package.json`

- [ ] **Step 1: 将新测试加入 `npm test`**

按现有串联式测试脚本追加三个新测试。

- [ ] **Step 2: 补充第 17 章**

记录功能目标、循环成功/失败语义、配置/API/UI 关联文件、自动化验证和部署后的手工验证命令；不写入真实凭据。

- [ ] **Step 3: 全量验证**

Run: `npm test; git diff --check`

Expected: 全量测试通过，空白检查无输出。

- [ ] **Step 4: 部署前检查**

确认 `scripts/deploy-upgrade.js` 的主壳打包清单已包含新库文件、测试和章节记录，然后再按用户指示部署目标服务器。
