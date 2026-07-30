# Remove Settings Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely remove the WebSSH settings-based 8081 src update feature while retaining generic SSH and SFTP file management.

**Architecture:** The feature is isolated to a settings tab and support code in `index.html`, one `update:apply` WebSocket branch in `server.js`, and a Windows-only packaging script. A source-level regression test will prevent all three parts from returning independently.

**Tech Stack:** Node.js 12, browser-native JavaScript, Node `assert` tests, batch script removal.

---

### Task 1: Add the removal regression test

**Files:**
- Create: `tests/settings-update-removal.test.js`
- Test: `tests/settings-update-removal.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert.doesNotMatch(indexSource, /data-pane="update"/,
  '设置中不得保留更新分页');
assert.doesNotMatch(indexSource, /id: 'update', label: '更新'/,
  '设置侧栏不得保留更新标签');
assert.doesNotMatch(indexSource, /update:apply/,
  '前端不得发送更新 WebSocket 消息');
assert.doesNotMatch(serverSource, /msg\.type === 'update:apply'/,
  '后端不得处理更新 WebSocket 消息');
assert.strictEqual(fs.existsSync(path.join(root, 'scripts', 'pack-8081-src.bat')), false,
  '不得保留 8081 src 更新打包脚本');

console.log('settings update feature removal: OK');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/settings-update-removal.test.js`

Expected: assertion failure because `index.html` still contains `data-pane="update"`.

### Task 2: Remove the frontend update panel and client behavior

**Files:**
- Modify: `index.html:1613-1655`
- Modify: `index.html:2178-2184`
- Modify: `index.html:2970-3000`
- Modify: `index.html:3017`
- Modify: `index.html:4019-4172`
- Modify: `index.html:4618-4633`
- Modify: `index.html:4677`, `index.html:4687`, `index.html:4804`, `index.html:4842`, `index.html:4861`
- Modify: `index.html:4883-4888`

- [ ] **Step 1: Delete the settings UI and navigation entry**

Delete the complete `<section class="settings-section" data-pane="update">` block and this tab entry:

```js
{ id: 'update', label: '更新' },
```

- [ ] **Step 2: Delete update-only DOM references and lifecycle calls**

Remove the seven `update*` properties from `el`, the `id === 'update'` block in `switchSettingsTab`, and every `refreshUpdatePane();` invocation. Retain `initSftp(state.fileCwd)` inside the successful SSH connection handler so regular file management continues to initialize SFTP.

- [ ] **Step 3: Delete the complete update-only implementation and event bindings**

Remove the code from the `// ===== 8081src 更新` marker through the closing brace of `applyUpdatePackage`, including `UPDATE_MAX_BYTES`, `UPDATE_TARGET_DIR`, update state variables, validation helpers, status/log helpers, and the `FileReader`/`update:*` handler. Remove these bindings:

```js
el.updateFileInput?.addEventListener('change', onUpdateFilePicked);
el.updateResetBtn?.addEventListener('click', () => {
  resetUpdateFile();
});
el.updateApplyBtn?.addEventListener('click', applyUpdatePackage);
```

### Task 3: Remove the server update endpoint and packaging script

**Files:**
- Modify: `server.js:1913-2007`
- Delete: `scripts/pack-8081-src.bat`

- [ ] **Step 1: Delete the complete `update:apply` branch**

Remove the block beginning with:

```js
// 8081src 覆盖更新：上传 tar.gz → 备份 → 解压 → 失败回滚
if (msg.type === 'update:apply') {
```

and ending at its `return;` plus matching closing brace. Leave the preceding generic `sftp:upload` branch intact; it is used by the regular file manager.

- [ ] **Step 2: Delete the obsolete packaging script**

Delete `scripts/pack-8081-src.bat` from the repository.

### Task 4: Verify regression coverage and unaffected behavior

**Files:**
- Test: `tests/settings-update-removal.test.js`
- Test: `tests/dcim-wvp-opengauss.test.js`

- [ ] **Step 1: Run the removal regression test**

Run: `node tests/settings-update-removal.test.js`

Expected: `settings update feature removal: OK` and exit code 0.

- [ ] **Step 2: Run the existing primary test suite**

Run: `npm test`

Expected: exit code 0 and the existing `dcim-wvp-opengauss` assertions remain green.

- [ ] **Step 3: Search for stale specialized identifiers**

Run: `rg -n -i "update:apply|pack-8081-src|8081src 更新|data-pane=\"update\"" index.html server.js scripts tests`

Expected: exit code 1 with no matches.

- [ ] **Step 4: Commit the implementation**

```bash
git add index.html server.js scripts/pack-8081-src.bat tests/settings-update-removal.test.js
git commit -m "refactor: remove settings update feature"
```
