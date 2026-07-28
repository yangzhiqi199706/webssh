# 192.168.0.60 全栈离线包回归演练 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 192.168.0.60 从现有运行态组装全栈离线包，完成一次可验证的卸载和离线重装，并将校验通过的产物拉回本地。

**Architecture:** 使用 `scripts/build-fullstack-on-server.js` 从远端 `/opt/webssh` 运行目录采集主壳、Node 运行时、协议助手、Python 运行时、依赖和可选媒体服务。将生成的 tar.gz 与 SHA-256 文件下载到本地 `dist/`，再使用同一归档在远端执行卸载和重装，以证明归档可以独立恢复服务。

**Tech Stack:** Node.js 12、ssh2、Bash、systemd、curl、tar、sha256sum。

---

### Task 1: 远端运行态预检

**Files:**
- Read: `scripts/build-fullstack-on-server.js`
- Read: `scripts/install-all.sh`
- Read: `scripts/uninstall-all.sh`

- [ ] **Step 1: 验证 SSH 认证与核心运行目录**

Run: 使用 `ssh2` 连接 `root@192.168.0.60:22`，检查 `/opt/webssh/app/server.js`、Node 运行时、协议助手、Python 运行时及 site-packages。

Expected: SSH 连接成功，所有必需路径存在且运行时二进制可执行。

- [ ] **Step 2: 记录现有服务状态**

Run: `systemctl is-active webssh webssh-protocol webssh-mediaserver`（媒体服务允许不存在或 inactive）。

Expected: 当前状态被记录，后续由安装结果重新验证。

### Task 2: 生成并下载全栈离线包

**Files:**
- Read: `scripts/build-fullstack-on-server.js`
- Create: `dist/webssh-fullstack-offline-linux-x64-v1.0.0-<timestamp>.tar.gz`
- Create: `dist/webssh-fullstack-offline-linux-x64-v1.0.0-<timestamp>.tar.gz.sha256`

- [ ] **Step 1: 在目标机组装归档**

Run: `WEBSSH_HOST=192.168.0.60 WEBSSH_DEPLOY_PASS=<secret> node scripts/build-fullstack-on-server.js`。

Expected: 远端 tar.gz、SHA-256 文件生成，stage 结构检查通过，归档条目数输出。

- [ ] **Step 2: 下载归档和校验文件**

Run: 脚本内置 SFTP 下载至本地 `dist/`。

Expected: 本地具有同名 `.tar.gz` 与 `.sha256`。

### Task 3: 归档完整性验证

**Files:**
- Read: `dist/webssh-fullstack-offline-linux-x64-v1.0.0-<timestamp>.tar.gz`
- Read: `dist/webssh-fullstack-offline-linux-x64-v1.0.0-<timestamp>.tar.gz.sha256`

- [ ] **Step 1: 比对本地与远端 SHA-256**

Run: 本地 `Get-FileHash -Algorithm SHA256` 与远端 `sha256sum` 结果比较。

Expected: 两个摘要完全一致。

- [ ] **Step 2: 检查归档内容**

Run: `tar -tzf <archive>` 并检查 `app/server.js`、`app/node_modules`、`runtime/node/bin/node`、`protocol/app/app.py`、`protocol/runtime/python/bin/python3`、`protocol/runtime/site-packages`、双 systemd 模板、`install-all.sh` 和 `uninstall-all.sh`。

Expected: 每项均在归档中。

### Task 4: 卸载与同包重装

**Files:**
- Read: `scripts/uninstall-all.sh`
- Read: `scripts/install-all.sh`

- [ ] **Step 1: 将已校验归档暂存至远端 `/root`**

Run: 上传本地 tar.gz 与 sha256 文件，并在远端再次运行 `sha256sum -c`。

Expected: 远端校验通过，之后的安装仅依赖该归档。

- [ ] **Step 2: 执行默认卸载**

Run: 从已解压归档执行 `./uninstall-all.sh`。

Expected: 三个服务停止并注销，代码和运行时目录被删除；`config/`、`logs/` 保留。

- [ ] **Step 3: 执行离线安装**

Run: 从同一解压归档执行 `./install-all.sh`。

Expected: Python 关键依赖导入检查全部通过，webssh 与协议助手服务启动成功。

### Task 5: 最终验收与清理

**Files:**
- Read: `dist/webssh-fullstack-offline-linux-x64-v1.0.0-<timestamp>.tar.gz`

- [ ] **Step 1: 验收服务和 HTTP 接口**

Run: `systemctl is-active webssh webssh-protocol`、`curl http://127.0.0.1:3010/health`、直连及反代的 `/protocol/` HTTP 状态检查，并检查监听端口。

Expected: 服务均为 `active`，健康接口与两个协议助手入口均返回 HTTP 200。

- [ ] **Step 2: 清理远端临时解压目录**

Run: 仅删除 `/root` 下本次归档的解压目录，保留归档供后续部署使用。

Expected: 无残留构建 stage；本地 `dist/` 保留已验证的归档和 SHA-256 文件。
