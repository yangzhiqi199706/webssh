# WebSSH ARM64 主壳安装流程

适用对象：Kylin Linux ARM64/aarch64 服务器。当前包只部署 WebSSH 主壳；协议助手、视频监控不安装且菜单隐藏。

## 1. 安装包

本地包：

```text
webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436.tar.gz
SHA-256: f739a97d8c322a32f3122fec90eb7117e1bbfd1090444b2dd11f2c134852eb52
```

先在本机校验：

```powershell
Get-FileHash .\webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436.tar.gz -Algorithm SHA256
```

## 2. 上传并解压

```bash
scp webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436.tar.gz root@<目标IP>:/root/
ssh root@<目标IP>

cd /root
sha256sum webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436.tar.gz
tar -xzf webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436.tar.gz
cd webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436
```

确认运行时是 ARM64：

```bash
chmod +x runtime/node/bin/node
runtime/node/bin/node -p 'process.version + ":" + process.arch'
```

预期包含 `v16.20.2:arm64`。

## 3. 首次安装

> 以 root 执行。若机器已有 `/opt/webssh`，请先按“升级与回滚”备份。

PKG=/root/webssh-main-offline-linux-arm64-node16-v1.0.0-20260714070436
INSTALL=/opt/webssh

mkdir -p "$INSTALL"/{logs,run,config,runtime}
cp -a "$PKG/app" "$INSTALL/app"
cp -a "$PKG/runtime/node" "$INSTALL/runtime/node"

printf 'PORT=3010\n' > "$INSTALL/config/.env"
printf 'window.WEBSSH_FEATURES = { protocol: false, video: false };\n' > "$INSTALL/app/runtime-features.js"

sed \
  -e "s|__INSTALL_DIR__|$INSTALL|g" \
  -e 's|__RUN_USER__|root|g' \
  "$PKG/systemd/webssh.service.template" \
  > /etc/systemd/system/webssh.service

systemctl daemon-reload
systemctl enable webssh
systemctl restart webssh

若 firewalld 已启用，开放 3010：

```bash
if systemctl is-active --quiet firewalld; then
  firewall-cmd --add-port=3010/tcp
  firewall-cmd --permanent --add-port=3010/tcp
  firewall-cmd --reload
fi
```

## 4. 验收

```bash
systemctl is-active webssh
curl -sS http://127.0.0.1:3010/health
/opt/webssh/runtime/node/bin/node -p 'process.version + ":" + process.arch'
ss -lntp | grep ':3010'
```

预期：

- 服务：`active`
- 健康检查：`{"ok":true}`
- Node：`v16.20.2:arm64`
- 3010 由 node 监听

浏览器访问：`http://<目标IP>:3010/`。

## 5. 升级与回滚

升级前备份：

```bash
STAMP=$(date +%Y%m%d%H%M%S)
systemctl stop webssh
mv /opt/webssh/app "/opt/webssh/app.bak-$STAMP"
mv /opt/webssh/runtime/node "/opt/webssh/runtime/node.bak-$STAMP"
```

随后按“首次安装”重新复制 `app` 和 `runtime/node`，保留已有 `config/.env`，并重启服务。

如新版本无法启动，回滚：

```bash
systemctl stop webssh
rm -rf /opt/webssh/app /opt/webssh/runtime/node
mv /opt/webssh/app.bak-<时间戳> /opt/webssh/app
mv /opt/webssh/runtime/node.bak-<时间戳> /opt/webssh/runtime/node
systemctl restart webssh
```

## 6. 注意事项

- 本机验证表明官方 Node.js 12.22.12 ARM64 在该鲲鹏/Kylin 环境创建 V8 isolate 时会报 OOM；必须使用包内 Node.js 16.20.2 ARM64。
- 不要使用 x64 离线包的 Node、Python 或 MediaServer 二进制。
- 此包不包含协议助手和视频监控；页面会隐藏对应菜单。
