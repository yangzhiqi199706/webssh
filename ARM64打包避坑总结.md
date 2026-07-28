# WebSSH ARM64 主壳打包避坑总结

适用对象：Kylin V10 / aarch64 / ARM64 服务器上的 WebSSH 主壳离线包。

当前已验证可用包：

```text
dist/webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436.tar.gz
SHA-256: f739a97d8c322a32f3122fec90eb7117e1bbfd1090444b2dd11f2c134852eb52
```

当前包只包含 WebSSH 主壳，协议助手和视频监控不实现、不部署，菜单隐藏。

## 一、最重要结论

1. ARM64 包必须使用 Node.js 16.20.2 linux-arm64。
2. 不要使用官方 Node.js 12.22.12 linux-arm64 作为这台鲲鹏/Kylin 的最终运行时。
3. 打包完成后必须带 `.sha256` 文件，且内容必须和 tar 包当前文件一致。
4. 解包安装前必须检查 `runtime/node/bin/node` 存在并可执行。
5. 安装成功不能只看 `systemctl`，必须同时验证 `/health`、Node 架构、3010 监听和关键模块加载。

## 二、Node 版本避坑

已在 `192.168.50.13` 验证：

```bash
node-v12.22.12-linux-arm64/bin/node --version
```

可以输出版本号，但只要执行 JavaScript，例如：

```bash
node -p 'process.arch'
```

就会报：

```text
Fatal process OOM in insufficient memory to create an Isolate
```

所以 ARM64 主壳包必须使用 Node.js 16.20.2：

```bash
/opt/webssh/runtime/node/bin/node -p 'process.version + ":" + process.arch'
```

预期：

```text
v16.20.2:arm64
```

## 三、推荐打包方式

最稳妥方式是基于已验证运行态打包，也就是从 ARM64 服务器上已经跑通的目录取：

```text
/opt/webssh/app
/opt/webssh/runtime/node
/etc/systemd/system/webssh.service 对应模板
安装脚本或安装说明
```

包根目录建议保持：

```text
webssh-main-offline-linux-arm64-node16-v<版本>-<时间戳>/
├── app/
├── runtime/
│   └── node/
├── systemd/
│   └── webssh.service.template
├── scripts/
│   ├── install-main-arm64.sh
│   └── uninstall-main.sh
├── install-main-arm64.sh
├── uninstall-main.sh
└── release-manifest.json
```

打包命名建议：

```text
webssh-main-offline-linux-arm64-node16-v1.0.0-YYYYMMDDHHMMSS.tar.gz
webssh-main-offline-linux-arm64-node16-v1.0.0-YYYYMMDDHHMMSS.tar.gz.sha256
```

## 四、打包后必须做的本地检查

在 Windows 本地检查：

```powershell
Get-FileHash .\dist\webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436.tar.gz -Algorithm SHA256
Get-Content .\dist\webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436.tar.gz.sha256
```

确认两边 hash 一致。

检查包内关键文件：

```powershell
tar -tzf .\dist\webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436.tar.gz | Select-String 'app/server.js|app/index.html|runtime/node/bin/node|systemd/webssh.service.template|release-manifest.json'
```

必须看到：

```text
app/server.js
app/index.html
runtime/node/bin/node
systemd/webssh.service.template
release-manifest.json
```

如果是在 Windows 重新打 tar，重点注意可执行位可能丢失。安装时务必执行：

```bash
chmod +x runtime/node/bin/node
chmod +x install-main-arm64.sh scripts/install-main-arm64.sh scripts/uninstall-main.sh
```

## 五、远端安装前检查

上传到目标服务器后先做：

```bash
cd /root
sha256sum webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436.tar.gz
tar -xzf webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436.tar.gz
cd webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436

uname -m
chmod +x runtime/node/bin/node
runtime/node/bin/node -p 'process.version + ":" + process.arch'
```

预期：

```text
aarch64
v16.20.2:arm64
```

如果这里不是 `arm64`，不要继续安装。

## 六、安装后验收清单

安装后必须逐条验证：

```bash
systemctl is-active webssh
curl -sS http://127.0.0.1:3010/health
/opt/webssh/runtime/node/bin/node -p 'process.version + ":" + process.arch'
cd /opt/webssh/app && /opt/webssh/runtime/node/bin/node -e "require('express'); require('ws'); require('ssh2'); require('http-proxy'); require('net-snmp'); require('mysql2'); require('pg'); require('dmdb'); console.log('MODULES_OK')"
cat /opt/webssh/app/runtime-features.js
ss -lntp | grep ':3010'
```

预期：

```text
active
{"ok":true}
v16.20.2:arm64
MODULES_OK
window.WEBSSH_FEATURES = { protocol: false, video: false };
*:3010 users:(("node",...))
```

注意：`ss -lntp | grep ':3010'` 会同时匹配 `30100` 到 `30109` 这类 Docker 端口。
真正的 WebSSH 主壳监听必须是 `*:3010` 或 `0.0.0.0:3010`，进程名是 `node`。

## 七、这次踩过的坑

### 1. 误用 Node12 ARM64

症状：

```text
Fatal process OOM in insufficient memory to create an Isolate
```

原因：Node12 在该鲲鹏/Kylin 环境上创建 V8 isolate 失败。

规避：最终包固定使用 Node16 ARM64，安装前必须跑：

```bash
runtime/node/bin/node -p 'process.version + ":" + process.arch'
```

### 2. Windows tar 丢可执行位

症状：

```bash
test -x runtime/node/bin/node
```

失败，或者安装器提示 `runtime/node/bin/node` 不可执行。

规避：安装前统一执行：

```bash
chmod +x runtime/node/bin/node
chmod +x install-main-arm64.sh scripts/install-main-arm64.sh scripts/uninstall-main.sh
```

### 3. 只看 systemctl 不够

`systemctl is-active webssh` 为 `active` 只能说明服务进程起来了，还必须检查：

```bash
curl -sS http://127.0.0.1:3010/health
/opt/webssh/runtime/node/bin/node -p 'process.version + ":" + process.arch'
```

### 4. 缺少 .sha256

每次交付 tar 包旁边都必须有同名 `.sha256`：

```bash
sha256sum webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436.tar.gz \
  > webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436.tar.gz.sha256
```

Windows 可用：

```powershell
$name = 'webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436.tar.gz'
$hash = (Get-FileHash ".\dist\$name" -Algorithm SHA256).Hash.ToLower()
"$hash  $name" | Set-Content ".\dist\$name.sha256" -Encoding ASCII
```

### 5. 误判端口

`30100`、`30101`、`30102` 不是 `3010`。
验收时必须看这一类行：

```text
LISTEN ... *:3010 ... users:(("node",pid=...,fd=...))
```

## 八、最终交付前清单

交付前逐项打钩：

- [ ] 包名带 `linux-arm64-node16`
- [ ] tar 包旁边有 `.sha256`
- [ ] 本地 `Get-FileHash` 与 `.sha256` 内容一致
- [ ] 包内存在 `app/server.js`
- [ ] 包内存在 `app/index.html`
- [ ] 包内存在 `runtime/node/bin/node`
- [ ] 包内存在 `systemd/webssh.service.template`
- [ ] 目标机 `uname -m` 是 `aarch64` 或 `arm64`
- [ ] 目标机包内 Node 输出 `v16.20.2:arm64`
- [ ] 安装后 `webssh` 是 `active`
- [ ] `/health` 返回 `{"ok":true}`
- [ ] 关键 Node 模块加载输出 `MODULES_OK`
- [ ] `runtime-features.js` 里 `protocol` 和 `video` 都是 `false`
- [ ] `ss` 显示 `node` 监听 `3010`

只要其中任一项不满足，就不要把包标记为可交付。
