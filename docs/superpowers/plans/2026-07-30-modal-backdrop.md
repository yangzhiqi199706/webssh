# 弹窗遮罩点击保持打开 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 所有自定义弹窗在点击遮罩空白区域时保持打开，同时保留 `Esc`、关闭/取消按钮和业务流程的既有关闭行为。

**Architecture:** 不引入全局事件拦截。各子系统只移除自身“遮罩元素自身被点击时调用关闭函数”的监听代码，继续让显示、隐藏、键盘和业务事件由既有模块负责。新增一项源文件回归测试，禁止这些模块重新出现 `e.target === …` 或 `event.target === …` 的遮罩关闭模式。

**Tech Stack:** 原生 HTML/JavaScript、Node.js `assert` 测试。

---

## 文件结构

- 新增：`tests/modal-backdrop.test.js` — 扫描 17 个弹窗源码，拒绝遮罩点击关闭模式。
- 修改：`package.json` — 将新回归测试纳入 `npm test`。
- 修改：`index.html`、`ha/assets/js/*.js`、`sms/assets/js/*.js`、`proto-conv/assets/js/*.js`、`protocol_app/templates/module4.html`、`video/index.html`、`video/assets/js/video-config.js` — 删除 26 处遮罩点击关闭监听。

### Task 1: 先建立遮罩点击回归测试

**Files:**
- Create: `tests/modal-backdrop.test.js`

- [ ] **Step 1: 编写失败测试**

创建文件：

```js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourceFiles = [
  'index.html',
  'ha/assets/js/ha-config.js',
  'ha/assets/js/ha-failover.js',
  'ha/assets/js/ha-sync.js',
  'sms/assets/js/sms-db.js',
  'sms/assets/js/sms-monitor.js',
  'sms/assets/js/sms-push.js',
  'sms/assets/js/sms-scheduled.js',
  'proto-conv/assets/js/pc-config.js',
  'proto-conv/assets/js/pc-iec104.js',
  'proto-conv/assets/js/pc-modbus-control.js',
  'proto-conv/assets/js/pc-modbus.js',
  'proto-conv/assets/js/pc-runner.js',
  'proto-conv/assets/js/pc-snmp.js',
  'protocol_app/templates/module4.html',
  'video/index.html',
  'video/assets/js/video-config.js',
];

const backdropClosePattern = /\b(?:e|event)\.target\s*===/;

sourceFiles.forEach(function (relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  assert.strictEqual(
    backdropClosePattern.test(source),
    false,
    '遮罩点击不应关闭弹窗：' + relativePath,
  );
});

console.log('modal backdrop: OK');
```

- [ ] **Step 2: 运行测试并确认失败**

运行：`node tests/modal-backdrop.test.js`

预期：以 `遮罩点击不应关闭弹窗` 失败，首先指出 `index.html`，证明测试能捕获现有遮罩关闭逻辑。

### Task 2: 逐处删除遮罩关闭监听

**Files:**
- Modify: `index.html:4193,4210,4907,4981,5013`
- Modify: `ha/assets/js/ha-config.js:52-54`
- Modify: `ha/assets/js/ha-failover.js:284-286`
- Modify: `ha/assets/js/ha-sync.js:148-150,327-329`
- Modify: `sms/assets/js/sms-db.js:37-39`
- Modify: `sms/assets/js/sms-monitor.js:52-54,226-228`
- Modify: `sms/assets/js/sms-push.js:89-91,94-96,98-100,109-111`
- Modify: `sms/assets/js/sms-scheduled.js:36-38`
- Modify: `proto-conv/assets/js/pc-config.js:310-312`
- Modify: `proto-conv/assets/js/pc-iec104.js:213`
- Modify: `proto-conv/assets/js/pc-modbus-control.js:461`
- Modify: `proto-conv/assets/js/pc-modbus.js:446`
- Modify: `proto-conv/assets/js/pc-runner.js:344-346`
- Modify: `proto-conv/assets/js/pc-snmp.js:166`
- Modify: `protocol_app/templates/module4.html:623-625`
- Modify: `video/index.html:323`
- Modify: `video/assets/js/video-config.js:118`
- Test: `tests/modal-backdrop.test.js`

- [ ] **Step 1: 删除主壳与双机热备的监听**

删除以下仅在遮罩本身被点击时调用关闭函数的代码；保留相邻的关闭按钮和 `keydown` 监听：

```js
if (mask) mask.addEventListener('click', (e) => { if (e.target === mask) fwCloseModal(); });
if (helpMask) helpMask.addEventListener('click', (e) => { if (e.target === helpMask) closeHelp(); });
if (event.target === el.settingsMask) closeSettings();
if (event.target === el.modalMask) setModal(false);
if (event.target === el.editorMask) closeEditor();
if (e.target === el.modal) closeModal();
if (e.target === el.infoModal) closeInfo();
if (e.target === infoModal) closeInfo();
if (e.target === schEl.cronModal) closeCronInfo();
```

- [ ] **Step 2: 删除短信猫与协议转换的监听**

删除以下仅由遮罩点击触发的关闭语句或其整段 `click` 监听；保留 `btnClose*`、`btnCancel*` 与 `Escape` 监听：

```js
if (e.target === el.modal) closeModal();
if (e.target === el.monModal) closeMonModal();
if (e.target === detailModal) closeDetailModal();
if (e.target === el.pushModal) closeModal(el.pushModal);
if (e.target === el.sendModal) closeModal(el.sendModal);
if (e.target === el.historyDetailModal) closeModal(el.historyDetailModal);
if (e.target === el.recipientsModal) closeModal(el.recipientsModal);
if (e.target === el.paramModal) closeParamModal();
if (e.target === el.modal) close();
```

- [ ] **Step 3: 删除协议助手与视频模块的监听**

删除以下仅由遮罩点击触发的关闭语句或其整段 `click` 监听；保留确认、关闭和保存按钮：

```js
if (e.target === previewModal) closeParamPreview();
if (event.target === modal) closeModal();
if (e.target === el.modal) close();
```

- [ ] **Step 4: 验证实现已转绿**

运行：`node tests/modal-backdrop.test.js`

预期：输出 `modal backdrop: OK`。

### Task 3: 纳入完整测试并提交

**Files:**
- Modify: `package.json:9`
- Test: `tests/modal-backdrop.test.js`

- [ ] **Step 1: 纳入标准测试入口**

将 `package.json` 的 `test` 命令改为以新回归测试开头：

```json
"test": "node tests/modal-backdrop.test.js && node tests/settings-update-removal.test.js && node tests/proto-conv-area-utils.test.js && node tests/proto-conv-session.test.js && node tests/proto-conv-db-type.test.js && node tests/dcim-wvp-opengauss.test.js && node tests/access-control.test.js && node tests/ops-settings.test.js && node tests/log-rotation.test.js && node tests/ssh-idle-timer.test.js && node tests/ops-settings-ui.test.js && node tests/shell-script-eol.test.js"
```

- [ ] **Step 2: 运行完整验证**

运行：`npm test`

预期：退出码为 0，包含 `modal backdrop: OK`，并且所有已有测试继续通过。

- [ ] **Step 3: 检查差异并提交**

运行：`git diff --check`

预期：无输出。

运行：

```bash
git add index.html ha/assets/js sms/assets/js proto-conv/assets/js protocol_app/templates/module4.html video/index.html video/assets/js/video-config.js package.json tests/modal-backdrop.test.js
git commit -m "fix: 禁止遮罩点击关闭弹窗"
```

预期：创建一个只包含弹窗遮罩行为和测试的提交。

## 自检结果

- 设计说明中的“遮罩点击保持打开”由 Task 1-2 覆盖。
- “保留 Esc、按钮和业务自动关闭”由 Task 2 的定向删除约束覆盖，未触碰这些监听或调用点。
- Task 3 将新测试纳入标准入口并执行完整验证。
- 所有目标文件、匹配语句、测试内容和命令均已列出。
