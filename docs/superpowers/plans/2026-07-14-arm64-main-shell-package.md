# ARM64 主壳离线包 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Kylin V10 ARM64/aarch64 服务器构建并部署 WebSSH 主壳离线包，运行 SSH、串口、短信猫、热备、协议转换和数据库管理，隐藏协议助手和视频监控。

**Architecture:** 新增与现有 x64 全栈包并存的 ARM64 主壳链路。构建器仅收集主壳资源、现有纯 JavaScript Node 依赖和经过 SHA-256/ELF 校验的 Node 12.22.12 linux-arm64 运行时；安装器只管理 `webssh.service` 并写入 ARM 菜单配置。

**Tech Stack:** Node.js 24（本机构建与测试）、Node.js 12.22.12 linux-arm64（目标运行时）、Node `assert` 和 `vm`、tar、ssh2、Bash、systemd、firewalld。

---

## File Map

| File | Responsibility |
| --- | --- |
| `runtime-features.js` | 浏览器菜单默认特性。 |
| `index.html` | 加载特性并过滤禁用菜单。 |
| `tests/runtime-features.test.js` | 默认菜单特性回归。 |
| `tests/arm64-runtime.test.js` | ARM64 ELF 判定回归。 |
| `tests/install-main-arm64-contract.test.js` | 安装器关键约束回归。 |
| `scripts/build-main-arm64.js` | ARM64 Node 校验和离线包构建。 |
| `scripts/install-main-arm64.sh` | ARM64 主壳安装、探活和回滚。 |
| `scripts/uninstall-main.sh` | 只卸载主壳服务。 |
| `install-main-arm64.sh` | 包根安装入口。 |
| `uninstall-main.sh` | 包根卸载入口。 |
| `scripts/deploy-main-arm64.js` | SSH 上传、安装和远端验证。 |
| `INSTALL-ARM64.md` | 构建、部署、回滚运维说明。 |

### Task 1: 为菜单特性写失败测试

**Files:**
- Create: `tests/runtime-features.test.js`
- Test: `tests/runtime-features.test.js`

- [ ] **Step 1: 写入测试**

```js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const profile = path.join(root, 'runtime-features.js');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(profile, 'utf8'), sandbox);
assert.strictEqual(sandbox.window.WEBSSH_FEATURES.protocol, true);
assert.strictEqual(sandbox.window.WEBSSH_FEATURES.video, true);
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const featureScript = index.indexOf('<script src="./runtime-features.js"></script>');
assert(featureScript >= 0);
assert(featureScript < index.indexOf('const menuItems ='));
assert.match(index, /const enabledMenuItems = menuItems\.filter\(\(item\) => window\.WEBSSH_FEATURES\[item\.id\] !== false\);/);
assert.match(index, /enabledMenuItems\.map\(\(item\) =>/);
console.log('runtime features: OK');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/runtime-features.test.js`

Expected: `ENOENT`，因为 `runtime-features.js` 还不存在。

- [ ] **Step 3: 提交测试**

```bash
git add tests/runtime-features.test.js
git commit -m "test: define runtime menu feature contract"
```

### Task 2: 实现菜单特性配置

**Files:**
- Create: `runtime-features.js`
- Modify: `index.html:6-23`
- Modify: `index.html:2263-2272`
- Modify: `index.html:5103-5110`
- Test: `tests/runtime-features.test.js`

- [ ] **Step 1: 创建默认配置**

```js
(function (root) {
  var defaults = { protocol: true, video: true };
  root.WEBSSH_FEATURES = Object.assign({}, defaults, root.WEBSSH_FEATURES || {});
})(window);
```

- [ ] **Step 2: 在主脚本之前引入配置**

Insert after the existing theme bootstrap script in the `<head>`:

```html
<script src="./runtime-features.js"></script>
```

- [ ] **Step 3: 只过滤渲染结果**

Append directly after the existing `menuItems` array:

```js
const enabledMenuItems = menuItems.filter((item) => window.WEBSSH_FEATURES[item.id] !== false);
```

Replace `menuItems.map((item) =>` in `renderMenu()` with
`enabledMenuItems.map((item) =>`. Do not modify `showView`, DOM IDs, iframe
paths, API paths, or the original `menuItems` array.

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/runtime-features.test.js`

Expected: `runtime features: OK`.

- [ ] **Step 5: 提交实现**

```bash
git add runtime-features.js index.html tests/runtime-features.test.js
git commit -m "feat: add deployable menu feature profile"
```

### Task 3: 为 ARM64 运行时校验写失败测试

**Files:**
- Create: `tests/arm64-runtime.test.js`
- Test: `tests/arm64-runtime.test.js`

- [ ] **Step 1: 写入测试**

```js
'use strict';
const assert = require('assert');
const { getElfMachine, assertArm64Elf } = require('../scripts/build-main-arm64.js');
function elf(machine) {
  const data = Buffer.alloc(64);
  data.writeUInt32BE(0x7f454c46, 0);
  data.writeUInt16LE(machine, 18);
  return data;
}
assert.strictEqual(getElfMachine(elf(0xb7)), 0xb7);
assert.doesNotThrow(() => assertArm64Elf(elf(0xb7), 'node'));
assert.throws(() => assertArm64Elf(elf(0x3e), 'node'), /aarch64/);
assert.throws(() => assertArm64Elf(Buffer.alloc(64), 'node'), /ELF/);
console.log('arm64 ELF validation: OK');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/arm64-runtime.test.js`

Expected: `MODULE_NOT_FOUND`，因为构建器还不存在。

- [ ] **Step 3: 提交测试**

```bash
git add tests/arm64-runtime.test.js
git commit -m "test: define ARM64 runtime validation"
```

### Task 4: 实现 ARM64 离线包构建器

**Files:**
- Create: `scripts/build-main-arm64.js`
- Test: `tests/arm64-runtime.test.js`
- Test: `tests/runtime-features.test.js`

- [ ] **Step 1: 定义构建常量和 ELF 函数**

```js
'use strict';
const NODE_VERSION = '12.22.12';
const NODE_PLATFORM = 'linux-arm64';
const NODE_ROOT = `node-v${NODE_VERSION}-${NODE_PLATFORM}`;
const ARM64_MACHINE = 0xb7;
const PAYLOAD_ENTRIES = [
  'server.js', 'index.html', 'login.html', 'runtime-features.js',
  'package.json', 'package-lock.json', 'serial', 'sms', 'ha',
  'proto-conv', 'db', 'snmp-bundle', 'node_modules',
];
function getElfMachine(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20 || buffer.toString('ascii', 0, 4) !== '\\x7fELF') throw new Error('不是 ELF 可执行文件');
  return buffer.readUInt16LE(18);
}
function assertArm64Elf(buffer, label) {
  if (getElfMachine(buffer) !== ARM64_MACHINE) throw new Error(`${label} 必须是 aarch64/arm64 ELF 二进制`);
}
module.exports = { getElfMachine, assertArm64Elf };
```

- [ ] **Step 2: 实现下载和运行时校验**

Implement `ensureNodeTarball(cacheDir)` with `https.get`, `crypto` SHA-256, a
temporary `*.part` file, and atomic rename. It accepts `WEBSSH_NODE_ARM64_TAR`
or downloads exactly these official files:

```text
https://nodejs.org/dist/v12.22.12/node-v12.22.12-linux-arm64.tar.xz
https://nodejs.org/dist/v12.22.12/SHASUMS256.txt
```

Require the archive filename's full SHA-256 entry in `SHASUMS256.txt`. Run
`tar -xOf <archive> node-v12.22.12-linux-arm64/bin/node`, pass output to
`assertArm64Elf`, and fail before staging on a corrupt or x86_64 archive.

- [ ] **Step 3: Stage payload and manifest**

Recursively reject any `*.node` under a staged payload. Copy every
`PAYLOAD_ENTRIES` member to `<stage>/app`, extract Node to
`<stage>/runtime/node`, and copy these source artifacts:

```text
scripts/install-main-arm64.sh -> scripts/install-main-arm64.sh
scripts/uninstall-main.sh     -> scripts/uninstall-main.sh
systemd/webssh.service.template -> systemd/webssh.service.template
INSTALL-ARM64.md              -> INSTALL-ARM64.md
```

Create root shims that use `BASH_SOURCE[0]` and `exec` their scripts. Write
`release-manifest.json` from `package.json` with architecture `arm64`, node
version `12.22.12`, and features `{ "protocol": false, "video": false }`.

- [ ] **Step 4: Archive reproducibly**

Write `dist/webssh-main-offline-linux-arm64-v<package-version>-<timestamp>.tar.gz`
plus an adjacent `.sha256`. Support `--output <directory>` and
`--node-tar <path>`; add `--force-local` to tar arguments on Windows; clean the
temporary stage in `finally`. Print archive path and complete SHA-256. Invoke
`main().catch(...)` only when `require.main === module` so the ELF functions
remain importable by `tests/arm64-runtime.test.js`.

- [ ] **Step 5: 运行构建器单元测试**

Run: `node tests/arm64-runtime.test.js`

Expected: `arm64 ELF validation: OK`.

Run: `node tests/runtime-features.test.js`

Expected: `runtime features: OK`.

Do not invoke the builder yet: the installer and `INSTALL-ARM64.md` staged by
the builder are created in Tasks 5 and 7. The first real archive build is the
ordered integration step in Task 7.

- [ ] **Step 6: 提交构建器**

```bash
git add scripts/build-main-arm64.js tests/arm64-runtime.test.js runtime-features.js index.html
git commit -m "feat: build ARM64 main shell offline package"
```

### Task 5: 为安装器写合同测试并实现安全部署

**Files:**
- Create: `tests/install-main-arm64-contract.test.js`
- Create: `scripts/install-main-arm64.sh`
- Create: `scripts/uninstall-main.sh`
- Create: `install-main-arm64.sh`
- Create: `uninstall-main.sh`
- Test: `tests/install-main-arm64-contract.test.js`

- [ ] **Step 1: 写入合同测试**

```js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'install-main-arm64.sh'), 'utf8');
assert.match(source, /uname -m/);
assert.match(source, /aarch64/);
assert.match(source, /process\.arch/);
assert.match(source, /runtime-features\.js/);
assert.match(source, /protocol: false/);
assert.match(source, /video: false/);
assert.match(source, /systemctl restart/);
assert.match(source, /127\.0\.0\.1:\$\{HTTP_PORT\}\/health/);
assert.doesNotMatch(source, /webssh-protocol/);
assert.doesNotMatch(source, /webssh-mediaserver/);
console.log('ARM64 installer contract: OK');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/install-main-arm64-contract.test.js`

Expected: `ENOENT`，因为安装器尚不存在。

- [ ] **Step 3: 实现安装器**

Use Bash `set -euo pipefail` and these defaults:

```bash
INSTALL_DIR="${INSTALL_DIR:-/opt/webssh}"
RUN_USER="${RUN_USER:-root}"
HTTP_PORT="${HTTP_PORT:-3010}"
SERVICE_MAIN="${SERVICE_MAIN:-webssh}"
PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
```

Before stopping anything, require root, `systemctl`, `tar`, valid package files,
`uname -m` equal to `aarch64` or `arm64`, manifest architecture `arm64`, and
`"$PACKAGE_ROOT/runtime/node/bin/node" -p 'process.arch'` equal to `arm64`.
Create only `$INSTALL_DIR/{logs,run,config,runtime}` and an empty `.env` when
absent. Stop only an existing `$SERVICE_MAIN`; move existing `app` and
`runtime/node` to timestamped sibling backups; then copy new files.

Overwrite installed `app/runtime-features.js` with:

```js
window.WEBSSH_FEATURES = { protocol: false, video: false };
```

Render only `/etc/systemd/system/${SERVICE_MAIN}.service` from
`systemd/webssh.service.template`, run daemon-reload/enable/restart, open only
`${HTTP_PORT}/tcp` when firewalld is active, wait four seconds, require active
service, and require health `200` from:

```bash
curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HTTP_PORT}/health"
```

Use an error trap after backup creation to stop the failed service, restore each
available app/runtime backup, reload systemd, restart a prior installation, and
exit nonzero. Never create, stop, start, remove, or reference protocol/media
services or directories.

- [ ] **Step 4: 实现卸载和包根入口**

Root `install-main-arm64.sh` must contain:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/scripts/install-main-arm64.sh" "$@"
```

`scripts/uninstall-main.sh` stops/disables only `$SERVICE_MAIN`, removes only
its unit, reloads systemd, and deletes `app` plus `runtime/node` only with
explicit `--purge`. It preserves `config`, logs, protocol/media directories,
and timestamped backups. The root `uninstall-main.sh` uses the same shim form.

- [ ] **Step 5: 运行测试和 shell 校验**

Run: `node tests/install-main-arm64-contract.test.js`

Expected: `ARM64 installer contract: OK`.

Run: `bash -n scripts/install-main-arm64.sh`

Expected: exit code `0`.

Run: `bash -n scripts/uninstall-main.sh`

Expected: exit code `0`.

- [ ] **Step 6: 提交安装器**

```bash
git add scripts/install-main-arm64.sh scripts/uninstall-main.sh install-main-arm64.sh uninstall-main.sh tests/install-main-arm64-contract.test.js
git commit -m "feat: install ARM64 main shell safely"
```

### Task 6: 实现 ARM64 SSH 部署器

**Files:**
- Create: `scripts/deploy-main-arm64.js`
- Test: `tests/arm64-runtime.test.js`
- Test: `tests/install-main-arm64-contract.test.js`

- [ ] **Step 1: 定义无凭据默认配置**

```js
const HOST = process.env.WEBSSH_HOST || '192.168.50.13';
const PORT = Number(process.env.WEBSSH_PORT || 22);
const USER = process.env.WEBSSH_USER || 'root';
const INSTALL_DIR = process.env.WEBSSH_INSTALL_DIR || '/opt/webssh';
const SERVICE = process.env.WEBSSH_SERVICE || 'webssh';
const HTTP_PORT = Number(process.env.WEBSSH_HTTP_PORT || 3010);
const PASSWORD = process.env.WEBSSH_DEPLOY_PASS;
```

Fail when `PASSWORD` is absent. Use existing `deploy-fresh.js` patterns for
`ssh2` connection, `exec`, SFTP upload, SHA-256, and Windows tar behavior. If
`WEBSSH_TAR` is unset, invoke the new builder and select the newest matching
ARM64 archive; otherwise resolve and validate the supplied archive.

- [ ] **Step 2: Perform remote preflight and install**

Require remote `uname -m` to be `aarch64` or `arm64`, upload to `/root`, compare
the entire remote `sha256sum`, extract to a unique `/root/<release-name>`, and
require `install-main-arm64.sh`, `release-manifest.json`, `app/server.js`, and
`runtime/node/bin/node`. Execute only the new installer with explicitly quoted
`INSTALL_DIR`, `SERVICE_MAIN`, and `HTTP_PORT`. Do not call x64 or protocol
deployment scripts.

- [ ] **Step 3: Verify and retain diagnostics on failure**

Before cleanup require:

```bash
systemctl is-active webssh
curl -s http://127.0.0.1:3010/health
test "$(/opt/webssh/runtime/node/bin/node -p 'process.arch')" = arm64
cd /opt/webssh/app && /opt/webssh/runtime/node/bin/node -e "require('express'); require('ws'); require('ssh2'); require('http-proxy'); require('net-snmp'); require('mysql2'); require('pg'); require('dmdb'); console.log('modules OK')"
```

On a failed command, retain the remote release directory and print
`journalctl -u webssh -n 80 --no-pager`; otherwise remove only the uploaded tar
and extracted release.

- [ ] **Step 4: 运行本地测试并提交**

Run: `node tests/runtime-features.test.js`

Expected: `runtime features: OK`.

Run: `node tests/arm64-runtime.test.js`

Expected: `arm64 ELF validation: OK`.

Run: `node tests/install-main-arm64-contract.test.js`

Expected: all three `OK` markers.

```bash
git add scripts/deploy-main-arm64.js tests
git commit -m "feat: deploy ARM64 main shell package"
```

### Task 7: 文档、构建和目标机验收

**Files:**
- Create: `INSTALL-ARM64.md`
- Modify: `docs/superpowers/specs/2026-07-14-arm64-main-shell-design.md`
- Create: `dist/webssh-main-offline-linux-arm64-v1.0.0-<timestamp>.tar.gz` (ignored artifact)
- Create: `dist/webssh-main-offline-linux-arm64-v1.0.0-<timestamp>.tar.gz.sha256` (ignored artifact)

- [ ] **Step 1: 写运维说明**

Document these commands without actual passwords:

```powershell
$env:WEBSSH_DEPLOY_PASS = '<目标机 root 密码>'
node scripts/deploy-main-arm64.js
```

```bash
tar -xzf webssh-main-offline-linux-arm64-v*.tar.gz
cd webssh-main-offline-linux-arm64-v*/
chmod +x install-main-arm64.sh
./install-main-arm64.sh
```

Include health, systemd, `process.arch`, rollback, and port-3010 checks. State
that protocol assistant and video monitoring are intentionally absent/hidden.
Append an “Implementation artifacts” section to the design doc listing the
builder, installer, deployer, package prefix, and this guide without changing
the approved scope.

- [ ] **Step 2: Run complete local verification**

Run separately:

```bash
node tests/runtime-features.test.js
node tests/arm64-runtime.test.js
node tests/install-main-arm64-contract.test.js
node scripts/build-main-arm64.js
tar -tzf dist/webssh-main-offline-linux-arm64-v1.0.0-*.tar.gz
```

Expected: every test prints `OK`; archive contains only the declared main-shell
assets and no protocol, Python, or MediaServer path.

- [ ] **Step 3: Deploy to 192.168.50.13 and verify service boundary**

Run: `WEBSSH_DEPLOY_PASS='<provided password>' node scripts/deploy-main-arm64.js`

Expected: aarch64 preflight, matching SHA-256, active webssh, HTTP 200 health,
ARM64 Node, and successful module loads.

Run on target:

```bash
cat /opt/webssh/app/runtime-features.js
systemctl is-active webssh
systemctl is-active webssh-protocol || true
systemctl is-active webssh-mediaserver || true
curl -s http://127.0.0.1:3010/health
```

Expected: profile contains `protocol: false` and `video: false`; webssh is
active; this deployment creates neither excluded service; health returns
`{"ok":true}`.

- [ ] **Step 4: Perform browser acceptance**

Open `http://192.168.50.13:3010/`. Visible menus must be SSH terminal, serial
debugging, SMS modem, high availability, protocol conversion, and database
management. Protocol assistant and video monitoring must be absent. Open each
visible iframe once, then use SSH terminal to connect to `192.168.50.13` and
use SFTP to list `/opt/webssh`.

- [ ] **Step 5: Commit source-only final state**

```bash
git add runtime-features.js index.html scripts tests INSTALL-ARM64.md docs/superpowers
git commit -m "feat: support ARM64 main shell offline deployment"
```

Do not stage `dist/`, `.offline-downloads/`, target credentials, or remote
runtime output.

## Plan Self-Review

- Scope coverage: Tasks 1-2 hide only protocol/video; Tasks 3-4 supply and
  verify ARM64 Node; Task 5 installs only one service; Task 6 transports it;
  Task 7 validates the approved target and menus.
- Placeholder scan: every change has a concrete file, command, expected result,
  and error condition.
- Type consistency: Node and manifest use `arm64`; `uname -m` accepts only
  `aarch64` or `arm64`; browser feature keys match current menu IDs `protocol`
  and `video`.
