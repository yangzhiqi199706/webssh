# ARM64 全功能 WebSSH 适配实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 aarch64 目标机生成并安装一套可离线运行的 WebSSH 全功能 ARM64 包，保留 SSH/SFTP、串口/TCP、短信猫、双机热备、协议转换、数据库管理、协议助手和视频监控入口，并完成 192.168.50.221 的安装验收。

**Architecture:** 主壳使用已经在鲲鹏上验证过的 Node.js 16.20.2 ARM64；协议助手使用 ARM64 可执行的 Python 运行时和与 Python 3.11/ARM64 匹配的 wheels，不能复用 x86_64 runtime。视频监控优先接入 50.221 已存在的 ARM64 dcim/ZLMediaKit/WVP 栈，主壳仅负责页面、API 和配置，不替换现有媒体容器。

**Tech Stack:** Node.js 16.20.2 arm64、Express/WebSocket/ssh2/http-proxy、CPython 3.11 arm64、Flask 2.3.3、pandas 2.2.3、numpy 1.26.4、systemd、Docker、ZLMediaKit/WVP、GB/T 28181。

---

### Task 1: 远端 ARM 运行时与功能基线核对

**Files:**
- Read: `scripts/install-all.sh`
- Read: `scripts/build-fullstack-on-server.js`
- Read: `scripts/install-protocol.sh`
- Read: `server.js`
- Read: `index.html`
- Read: `video/index.html`

- [ ] **Step 1: 采集目标机架构、服务和已有运行时**

```powershell
& {
  $env:WEBSSH_DEPLOY_PASS = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('QWRtaW5AOTAwMDA='))
  node -e "const{Client}=require('ssh2');const c=new Client();c.on('ready',()=>c.exec('uname -m; cat /etc/os-release | head -5; systemctl is-active webssh 2>/dev/null || true; docker exec dcim python3 --version 2>/dev/null || true; docker exec dcim python3 -c \"import importlib; mods=[\\\"flask\\\",\\\"pandas\\\",\\\"numpy\\\",\\\"xlrd\\\",\\\"xlwt\\\",\\\"openpyxl\\\",\\\"docx\\\",\\\"lxml\\\"]; print(\\\";\\\".join(m+\\\"=OK\\\" if importlib.util.find_spec(m) else m+\\\"=MISS\\\" for m in mods))\" 2>/dev/null || true; systemctl is-active ZLMediaKit wvp-pro wvp-pro-assist redis 2>/dev/null || true; ss -lntup | grep -E \\\":(3010|5000|5060|18080|18081|8081|8082|8086)\\\\b\\\" || true',(_,s)=>{let o='';s.on('data',d=>o+=d).on('close',()=>{process.stdout.write(o);c.end()})})}).connect({host:'192.168.50.221',port:22,username:'root',password:process.env.WEBSSH_DEPLOY_PASS})"
}
```

Expected: `aarch64`，Node 主壳可访问；容器 Python 关键包逐项显示 `OK` 或明确缺失；已有媒体服务状态和端口可见。

- [ ] **Step 2: 确认本地代码已经包含全功能菜单和视频静态资源**

```powershell
rg -n "id: '(|serial|sms|ha|proto-conv|video|db|protocol)'|runtime-features|/api/video|/api/db|/api/ha|/api/proto-conv" index.html server.js
Test-Path video/vendor/flv.min.js
```

Expected: 8 个功能入口、视频 API、`video/vendor/flv.min.js` 都存在。

- [ ] **Step 3: 记录运行时决策**

若远端容器关键 Python 包齐全，则将其 Python 解释器和 site-packages 作为 ARM 包来源；若不齐全，则只补缺失的 ARM64 wheels，不把 x86_64 wheel 放入包。若已有 ZLMediaKit/WVP 只在 dcim 容器内运行，则安装器不创建第二套媒体服务，改为使用现有媒体 API/端口。

### Task 2: ARM64 打包与安装器

**Files:**
- Create: `scripts/build-fullstack-arm64-on-server.js`
- Create: `scripts/install-all-arm64.sh`
- Modify: `scripts/install-all.sh`
- Modify: `scripts/uninstall-all.sh`
- Modify: `systemd/webssh.service.template`
- Modify: `systemd/webssh-protocol.service.template`
- Modify: `systemd/webssh-mediaserver.service.template`
- Test: `tests/arm64-package.test.js`

- [ ] **Step 1: 先写包结构与架构校验测试**

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(root, 'scripts/install-all-arm64.sh'), 'utf8');
const builder = fs.readFileSync(path.join(root, 'scripts/build-fullstack-arm64-on-server.js'), 'utf8');

assert.match(installer, /aarch64|arm64/);
assert.match(installer, /process\.arch/);
assert.match(installer, /sha256sum/);
assert.match(builder, /node16|arm64/i);
assert.doesNotMatch(installer, /x86_64-unknown-linux-gnu/);
console.log('arm64 package tests passed');
```

- [ ] **Step 2: 运行测试确认新脚本尚不存在**

```powershell
node tests/arm64-package.test.js
```

Expected: FAIL，原因是 `scripts/install-all-arm64.sh` 尚未创建。

- [ ] **Step 3: 实现 ARM64 打包器**

`build-fullstack-arm64-on-server.js` 必须：

1. 连接 `WEBSSH_HOST`（本次为 `192.168.50.221`）。
2. 校验远端 `uname -m` 为 `aarch64`，Node 为 `arm64`，并拒绝 x86_64。
3. 复制 `/opt/webssh/app`、`/opt/webssh/runtime/node`、协议助手代码和 ARM Python/site-packages；复制 `video/`、`db/`、`ha/`、`proto-conv/`、`serial/`、`sms/`。
4. 把 `runtime-features.js` 写为：

```js
window.WEBSSH_FEATURES = {
  protocol: true,
  video: true,
  db: true,
  ha: true,
  protoConv: true
};
```

5. 把安装器、卸载器、systemd 模板和 `INSTALL.md` 放入 stage。
6. 生成 `tar.gz` 和同名 `.sha256`，并把两者拉回 `dist/`。

- [ ] **Step 4: 实现 ARM64 安装器**

安装器必须在复制前检查：

```bash
[[ "$(uname -m)" == "aarch64" ]] || die "此包仅支持 aarch64"
NODE_ARCH="$("$PACKAGE_ROOT/runtime/node/bin/node" -p 'process.arch')"
[[ "$NODE_ARCH" == "arm64" ]] || die "Node 架构不是 arm64: $NODE_ARCH"
chmod +x "$PACKAGE_ROOT/runtime/node/bin/node"
```

随后安装主壳、协议助手和所有静态子站，启用全部功能标志；协议助手探活 `/protocol/`；视频功能只在包内带有可执行 MediaServer 且目标机没有正在使用同端口的外部 ZLMediaKit 时安装 `webssh-mediaserver`，否则记录“复用现有 dcim 媒体栈”并保持现有服务不动。安装结束必须写 `.sha256` 校验文件到包目录并输出安装摘要。

- [ ] **Step 5: 运行测试确认脚本契约**

```powershell
node tests/arm64-package.test.js
```

Expected: PASS，输出 `arm64 package tests passed`。

### Task 3: 全功能入口与 ARM 兼容性回归

**Files:**
- Create: `tests/arm64-feature-gates.test.js`
- Modify: `server.js`（仅在测试发现架构相关硬编码时）
- Modify: `index.html`（仅在测试发现功能标志未覆盖时）

- [ ] **Step 1: 写功能门控回归测试**

测试加载 `index.html` 和 `server.js`，确认：

```js
const html = fs.readFileSync('index.html', 'utf8');
for (const id of ['serial', 'sms', 'ha', 'proto-conv', 'video', 'db', 'protocol']) {
  assert.match(html, new RegExp(`id: '${id}'`));
}
assert.match(html, /\/api\/video/);
assert.match(html, /\/api\/proto-conv/);
assert.match(html, /\/protocol\//);
```

- [ ] **Step 2: 运行回归测试确认当前基线**

```powershell
node tests/arm64-feature-gates.test.js
```

Expected: 当前全功能源码基线 PASS；如果失败，只修复对应功能门控或静态路径，不改业务协议字段。

- [ ] **Step 3: 对主壳和关键模块做语法/加载检查**

```powershell
node --check server.js
node --check proto-conv/assets/js/pc-runner.js
node --check video/assets/js/video-app.js
node --check ha/assets/js/ha-config.js
```

Expected: 4 条命令均退出码 0。

### Task 4: 50.221 安全安装测试

**Files:**
- Create: `docs/ARM64全功能安装验收记录-20260804.md`

- [ ] **Step 1: 上传 tar 和 sha256 到目标机临时目录**

```powershell
scp dist/<ARM64包名>.tar.gz root@192.168.50.221:/root/
scp dist/<ARM64包名>.tar.gz.sha256 root@192.168.50.221:/root/
```

- [ ] **Step 2: 在目标机先做校验和备份**

```bash
cd /root
sha256sum -c <ARM64包名>.tar.gz.sha256
tar -xzf <ARM64包名>.tar.gz
systemctl is-active webssh || true
cp -a /opt/webssh /opt/webssh.pre-arm64-$(date +%Y%m%d%H%M%S)
```

- [ ] **Step 3: 执行安装器并记录输出**

```bash
cd /root/<ARM64包目录>
chmod +x install-all-arm64.sh runtime/node/bin/node
./install-all-arm64.sh
```

Expected: 主壳、协议助手 active；若视频复用外部 dcim 栈，则安装器明确输出复用，不停止 dcim/ZLMediaKit/WVP。

- [ ] **Step 4: 做远端验收**

```bash
systemctl is-active webssh webssh-protocol
curl -fsS http://127.0.0.1:3010/health
curl -fsS -o /dev/null http://127.0.0.1:3010/protocol/
/opt/webssh/runtime/node/bin/node -p 'process.version + ":" + process.arch'
ss -lntp | grep -E '(\*:3010|127\.0\.0\.1:5000)'
grep -F 'protocol: true' /opt/webssh/app/runtime-features.js
grep -F 'video: true' /opt/webssh/app/runtime-features.js
```

Expected: `active`、`{"ok":true}`、协议助手 HTTP 200、`v16.20.2:arm64`、3010 由 Node 监听、协议和视频标志为 `true`。

- [ ] **Step 5: 验证全功能 HTTP/静态入口**

```bash
for p in / /serial/index.html /sms/index.html /ha/index.html /proto-conv/index.html /video/index.html /db/index.html /protocol/; do
  printf '%-24s ' "$p"
  curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:3010$p"
done
systemctl is-active ZLMediaKit wvp-pro wvp-pro-assist redis
```

Expected: 每个页面为 200；已有视频相关服务保持 active。

### Task 5: 文档、卸载和最终复核

**Files:**
- Create: `docs/ARM64全功能安装验收记录-20260804.md`
- Modify: `ARM64打包避坑总结.md`
- Modify: `安装与卸载手册.md`

- [ ] **Step 1: 记录包名、SHA256、远端服务和端口**

记录不得包含密码；包含 `uname -m`、Node/Python 架构、包 SHA256、systemd 状态、HTTP 状态和媒体栈复用结论。

- [ ] **Step 2: 验证卸载脚本不会删除外部 dcim 媒体容器**

```powershell
rg -n "docker rm|docker stop|dcim|ZLMediaKit|wvp" scripts/uninstall-all.sh
```

Expected: 卸载只删除 WebSSH 安装目录和自身 systemd unit，不执行 `docker rm dcim` 或停止外部媒体服务。

- [ ] **Step 3: 执行本地完整测试**

```powershell
npm test
node tests/arm64-package.test.js
node tests/arm64-feature-gates.test.js
```

Expected: 所有命令退出码 0；若已有用户测试因环境缺依赖失败，记录真实失败项，不宣称完成。
