# 信创短信猫告警监测加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复信创短信猫数据库监测区的未授权 API、解除告警漏报风险和 TextMessage 待处理队列无界增长问题。

**Architecture:** 将告警解除游标与增量 SQL 生成抽到无副作用的 Node 工具，使用 `(CancelTime, id)` 复合顺序保证同秒记录不会被跳过。监测 IIFE 分批查询 pending ID，并在达到上限时按最早入队顺序兜底放行。所有短信猫数据库、监测、推送和定时短信 HTTP API 统一复用主壳登录门禁。

**Tech Stack:** Node.js 12 CommonJS、Express、mysql2、Node 内置 `assert`。

---

### Task 1: 复合游标与 pending 队列红测

**Files:**
- Create: `tests/sms-monitor-hardening.test.js`
- Create: `lib/sms-monitor-state.js`

- [ ] **Step 1: 写出失败测试**

覆盖同一秒多个 `CancelTime` 按 id 递增、跨秒游标推进、增量 SQL 同时比较时间和 id、pending 队列达到上限时最早项兜底放行、pending 查询分批上限。

- [ ] **Step 2: 运行红测**

Run: `node tests/sms-monitor-hardening.test.js`

Expected: 因 `lib/sms-monitor-state.js` 尚不存在而失败。

- [ ] **Step 3: 实现无副作用状态工具**

公开 `createCancelCursor`、`buildCancelQuery`、`acceptCancelRow`、`pushPendingWithLimit` 和 `chunk`；不连接数据库、不读写文件。

- [ ] **Step 4: 运行绿测**

Run: `node tests/sms-monitor-hardening.test.js`

Expected: 复合游标、队列上限和分批行为通过。

### Task 2: 监测服务接入加固

**Files:**
- Modify: `server.js`
- Create: `tests/sms-monitor-api-auth.test.js`

- [ ] **Step 1: 写出 API 安全红测**

检查所有 `/api/sms/db/*`、`/api/sms/monitor/*`、`/api/sms/push/*`、`/api/sms/scheduled/*` 路由都调用 `requireSettingsAuth`，并检查服务端使用复合游标和 pending 分批工具。

- [ ] **Step 2: 运行红测**

Run: `node tests/sms-monitor-api-auth.test.js`

Expected: 因现有短信猫路由没有登录门禁和复合游标接入而失败。

- [ ] **Step 3: 实现最小服务改动**

为短信猫 HTTP 路由增加 401 门禁；将解除查询改为 `(CancelTime > ? OR (CancelTime = ? AND id > ?)) ORDER BY CancelTime ASC, id ASC LIMIT 200`；pending ID 按 200 条一批查询，并在达到固定上限时最早项兜底放入告警缓冲。

- [ ] **Step 4: 运行 API 绿测**

Run: `node tests/sms-monitor-api-auth.test.js`

Expected: 路由门禁和服务接入检查通过。

### Task 3: 前端错误可见性与章节归档

**Files:**
- Modify: `sms/assets/js/sms-monitor.js`
- Modify: `package.json`
- Create: `docs/development-chapters/第19章-2026-08-28-信创短信猫告警监测加固.md`
- Modify: `docs/development-chapters/README.md`

- [ ] **Step 1: 增加前端轮询错误状态**

轮询失败时更新监测元信息为“轮询失败：…”，下一次成功后由服务端状态覆盖；保存失败继续显示现有提示。

- [ ] **Step 2: 将专项测试加入 `npm test`**

追加 `sms-monitor-hardening.test.js` 和 `sms-monitor-api-auth.test.js`。

- [ ] **Step 3: 记录第 19 章**

记录安全门禁、复合游标、pending 上限、数据库现状、未自动建索引的部署前置项和验证命令；不写入账号密码。

- [ ] **Step 4: 全量验证**

Run: `npm test; node --check server.js; node --check lib/sms-monitor-state.js; git diff --check`

Expected: 所有回归、专项测试、语法检查和空白检查通过。
