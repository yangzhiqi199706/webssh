# WebSSH 项目说明（给 Claude 看的）

本文件是 Claude Code 进入本仓库时必须先读的项目须知。
项目根目录：`界面操作系统命令/`。

------------------------------------------------------------

## 一、项目概览

### 是什么
浏览器里的 SSH / 串口 / TCP 调试控制台，Node + Express + WebSocket
单进程服务，前端是原生 HTML+JS 单页（`index.html`），没有构建步骤。

### 主要能力
- **SSH 终端**：`/ws` 通道，基于 `ssh2` 开 pty
- **SFTP 文件管理**：复用同一条 SSH 连接，支持浏览/上传/下载/编辑/重命名/新建
- **串口调试**：`/ws/serial` 通道，服务端用原生串口；前端也支持浏览器 WebSerial
- **TCP 调试**：`/ws/tcp` 通道
- **docker 自动重启**：开机倒计时执行 `systemctl restart docker`，顶栏按钮+设置弹窗

### 技术栈
- 运行时：Node.js（离线包自带，路径 `/opt/webssh/runtime/node/bin/node`）
- 依赖：`express` / `ws` / `ssh2` / `codemirror`（编辑器）
- 前端：纯 HTML + 原生 JS，不用框架，不打包
- 部署：systemd 单服务 `webssh`，HTTP 端口 **3010**
- 健康检查：`GET /health` 返回 `{"ok":true}`

### 目录结构
```
index.html                    # 前端全部 UI，单文件
server.js                     # 后端 HTTP + WS 入口
serial/                       # 串口调试独立页面，iframe 嵌入主页
  index.html
  assets/{css,js}/
scripts/                      # 部署 / 安装 / 打包脚本
  deploy-fresh.js             # 首次部署（全量）
  deploy-upgrade.js           # 增量部署（日常用这个）
  install.sh / start.sh / stop.sh / status.sh / uninstall.sh
  build-offline-tar.sh        # 打离线包
  webssh.service.template     # systemd unit 模板
dist/                         # 已打好的离线包 tar.gz + sha256
config/                       # 安装时才创建，仓库里保持空
systemd/                      # 预留
node_modules/                 # 会被打进离线包一起上服务器
```

### 前端菜单扩展点
左侧功能菜单由 `index.html` 里的 `menuItems` 数组驱动，新增一个功能：
1. 在 `menuItems` 追加 `{ id, label, icon, title }`
2. 在 `showView(view)` 里加分支控制对应视图的显示/隐藏
3. 若是 iframe 嵌入的子页面，放到 `serial/` 平级目录下

------------------------------------------------------------

## 二、部署规范（核心）

### 目标机
| 项 | 值 |
| -- | -- |
| Host | 192.168.0.22 |
| SSH  | 22 |
| 账号 | root / `REDACTED_DEPLOY_PASS` |
| 安装目录 | /opt/webssh |
| 服务名 | webssh（systemd, 开机自启） |
| HTTP 端口 | 3010 |

**默认行为**：只要用户让"部署 / 推上去 / 更新服务器"，走增量部署走
`scripts/deploy-upgrade.js`，不用问目标机——除非用户明确指定别的 host。

### 增量部署（日常，代码改动后）
```
WEBSSH_HOST=192.168.0.22 \
WEBSSH_PORT=22 \
WEBSSH_USER=root \
WEBSSH_DEPLOY_PASS='REDACTED_DEPLOY_PASS' \
node scripts/deploy-upgrade.js
```
脚本做的事：
1. 本地把 `server.js / index.html / package*.json / serial/ / node_modules` 打 tar
2. scp 到 `/root/`，校验 sha256
3. `cp -a /opt/webssh/app /opt/webssh/app.bak-<时间戳>` 备份
4. 解压覆盖到 `/opt/webssh/app/`
5. `systemctl restart webssh`
6. `is-active` + `/health` 200 双验证，失败自动回滚到 `app.bak-*`

**脚本里 `WEBSSH_HOST` 默认值是旧值 192.168.50.10**，每次执行都要显式传
`WEBSSH_HOST=192.168.0.22` 覆盖（见项目 memory "部署目标主机"）。

### 全新机器首次部署
```
WEBSSH_HOST=192.168.0.22 \
WEBSSH_DEPLOY_PASS='REDACTED_DEPLOY_PASS' \
node scripts/deploy-fresh.js
```
会上传 `dist/` 下最新 tar、跑 `scripts/install.sh`、放通 3010 端口、探活。

### 部署后验证（在目标机上）
```
systemctl is-active webssh         # 期望 active
curl -s http://127.0.0.1:3010/health   # {"ok":true}
ss -lntp | grep 3010               # node 在监听
```
浏览器：http://192.168.0.22:3010

### 手动回滚
```
rm -rf /opt/webssh/app
mv /opt/webssh/app.bak-<时间戳> /opt/webssh/app
systemctl restart webssh
```

### 常用运维
```
systemctl restart webssh
journalctl -u webssh -n 200 --no-pager
tail -f /opt/webssh/logs/webssh.out.log
tail -f /opt/webssh/logs/docker-restart.log
```

### 常见坑
1. **Windows 侧打 tar 报 "C:\..." 未知主机**：已在脚本里处理，会自动加
   `--force-local`。如果换了路径还不行，检查 Git for Windows 的 `tar` 是否在 PATH。
2. **`tar: xxx 时间戳是未来的 N 秒之后`**：本机和服务器时间不同步的无害告警，
   不影响解压运行，可忽略。
3. **目标目录缺失 /opt/webssh/app**：目标机还没装过，要改用 `deploy-fresh.js`。
4. **health 不是 200 自动回滚**：先看 `journalctl -u webssh -n 100`，常见是
   `node_modules` 没跟着打包进去。
5. **docker 重启设置页的"立即执行"失败**：看返回里的 stderr，常见原因是目标机
   `docker.service` 不存在或异常。
6. **localhost_8088 目录**：只读，不要改、不要重命名，冲突走别的路解。
