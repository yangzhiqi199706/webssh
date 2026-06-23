# WebSSH + 协议助手 项目说明（给 Claude 看的）

本文件是 Claude Code 进入本仓库时必须先读的项目须知。
项目根目录：`界面操作系统命令/`。

最近一次大改：2026-05-21，把"协议助手"作为子站集成进 webssh 主壳并做了完整 UI 重构，
现在仓库是 **双子系统**（webssh 主壳 + 协议助手 Flask 子站），通过反向代理在同一端口下提供。

------------------------------------------------------------

## 一、项目概览

### 1.1 是什么
- **webssh 主壳**：浏览器里的 SSH / 串口 / TCP 调试控制台 + 信创短信猫管理面板，
  Node + Express + WebSocket，单进程服务。前端是原生 HTML+JS 单页（`index.html`），
  没有构建步骤。
- **协议助手子站**：5 个 Excel/PDF 处理模块（XLS 清洗、故障编码填充、PDF 对照、
  MBP 生成、协议批处理），Flask + 原生 HTML+JS。挂载在主壳的 `/protocol/*` 路径下，
  iframe 嵌入。

### 1.2 主要能力
**webssh 主壳**：
- SSH 终端：`/ws` 通道，基于 `ssh2` 开 pty
- SFTP 文件管理：复用同一条 SSH 连接，浏览/上传/下载/编辑/重命名/新建
- 串口调试：`/ws/serial`，服务端原生串口 + 浏览器 WebSerial 双支持
- TCP 调试：`/ws/tcp`
- 信创短信猫：MySQL 监测告警 + 短信推送（`sms/` 子站）
- docker 自动重启：开机倒计时执行 `systemctl restart docker`
- **协议助手反代**：`/protocol/*` → `127.0.0.1:5000`（用 `http-proxy@1.18.1`）

**协议助手 5 个模块**（全部走 `/protocol` 子路径）：
| 编号 | 路径 | 功能 |
| -- | -- | -- |
| M1 | `/protocol/module1` | XLS 清洗：B/D/G/I/J/M/R/S~V 列规则处理，故障标记 |
| M2 | `/protocol/module2` | 故障编码断续填充：10/16 进制转换 + 缺失补全 |
| M3 | `/protocol/module3` | PDF 与 Excel 对照编辑器：左 PDF 右编辑器，三相多功能表点码表生成 |
| M4 | `/protocol/module4` | MBP 文件生成：遍历 D 列自动匹配 J/K 列 J2K2 规则 |
| M5 | `/protocol/module5` | 协议文件批量处理：xls/xlsx/docx，统一格式 + 清洗 NaN |

### 1.3 技术栈
| 子系统 | 运行时 | 框架 | 端口 |
| -- | -- | -- | -- |
| webssh 主壳 | Node.js（离线包自带 `/opt/webssh/runtime/node/bin/node`） | express / ws / ssh2 / http-proxy / codemirror | **3010**（对外）|
| 协议助手 | CPython 3.11.10（离线包自带 `/opt/webssh/protocol/runtime/python/bin/python3`） | flask 2.3.3 / pandas 2.2.3 / numpy 1.26.4 / xlrd 1.2.0 / openpyxl / lxml / python-docx | **5000**（仅 127.0.0.1）|

- 前端：纯 HTML + 原生 JS，**不用框架，不打包**
- 部署：systemd 双服务 `webssh` + `webssh-protocol`（后者 `PartOf=webssh.service`）
- 健康检查：`GET /health`、`GET /protocol/`

### 1.4 目录结构（仓库根 = 项目根）
```
index.html                    # webssh 主壳前端（含协议助手菜单和 iframe）
server.js                     # webssh 主壳后端，含 /protocol/* 反代路由
package.json / package-lock.json

serial/                       # 串口调试子站，iframe 嵌入
sms/                          # 信创短信猫子站，iframe 嵌入

protocol_app/                 # 协议助手 Flask 子站（2026-05-21 新增）
  app.py                      # Flask 入口，DispatcherMiddleware 挂 /protocol 前缀
  requirements.txt            # 21 个锁定版本依赖
  modules/                    # 业务逻辑：module1_xls / module2 / module3 / module4_mbp_generator / module5
  templates/                  # 7 个 Jinja 模板（index + module1~5 + xls_module）
  static/
    webssh-theme.css          # ★ 全局主题 CSS（webssh 设计语言沉淀，540 行）
    common.css                # 旧版样式（已废弃，仅保留兼容）
    common.js                 # showMsg / 表格渲染等共享函数
    vendor/                   # 离线静态资源（jquery / bootstrap / fontawesome / xlsx）
  module4_config/             # j2k2_format_config.json（必须保留）
  uploads/ outputs/ downloads/ module4_uploads/ module4_downloads/  # 运行时产物，部署时不打包

proto-conv/                   # ★ 协议转换子站（2026-06-04 新增，8082 接口可视化调用）
  index.html                  # 子站入口（左右双列布局，复用 ha 主题样式）
  assets/js/
    pc-bus.js                 # 极简事件总线
    pc-monitor.js             # 右列实时消息（环形 200 条 + 暂停滚动）
    pc-config.js              # 「连接信息」弹窗：baseUrl/账号/UserLsh/timeoutMs/pathMap
    pc-endpoints.js           # 91 条接口元数据（10 业务分组，含 24 危险写入类）
    pc-runner.js              # 按钮渲染 / 参数弹窗 / 调用代理 / 危险接口二次确认

scripts/                      # 部署 / 安装 / 打包脚本
  install.sh                  # webssh 主壳一次性安装（被 deploy-fresh.js 调用）
  install-protocol.sh         # 协议助手一次性安装（被 deploy-protocol.js 调用）
  install-all.sh              # ★ 全栈一键安装（主壳 + 协议助手 + 双 runtime，被全栈离线包使用）
  uninstall-all.sh            # ★ 全栈一键卸载（双服务联动停止 + 清目录，支持 --purge / --keep-backups）
  start.sh / stop.sh / status.sh / uninstall.sh

  deploy-fresh.js             # 全新机器首次部署 webssh 主壳（默认 host: 192.168.0.22）
  deploy-upgrade.js           # 增量部署 webssh 主壳（★ 默认 host 是 192.168.50.10，用时必须显式覆盖！）
  deploy-protocol.js          # ★ 协议助手一键部署：本地打包 → SSH 推送 → install → 同步主壳代码 → 双服务探活
  build-fullstack-on-server.js # ★ 在服务器上组装全栈离线包并拉回本地 dist/（推荐打包方式）

  pack-8081-src.bat           # Windows 辅助：打包 8081 src 配合主壳"在线更新"使用

systemd/                      # systemd unit 模板
  webssh.service.template
  webssh-protocol.service.template  # ★ 协议助手 unit（含 PartOf=webssh.service 联动）

dist/                         # 已打好的离线包 tar.gz + sha256
  webssh-fullstack-offline-linux-x64-v*.tar.gz  # ★ 全栈包（主壳 + 协议助手 + 双 runtime，~95 MB）

.offline-downloads/           # 协议助手离线素材（66 MB，不进 git，但部署脚本依赖它）
  cpython-3.11.10+20241016-x86_64-unknown-linux-gnu-install_only.tar.gz   # 29 MB
  wheels/*.whl                # 21 个直接 + 1 个传递（共 22 个 manylinux2014 wheels，38 MB）

config/                       # 安装时才创建，仓库里保持空
node_modules/                 # 会被打进离线包一起上服务器
.test-fixtures/               # ★ 本地手测/回归用的样本文件（不进 git，不部署）
  NetCol8000-A013(1).xls      #   module1/module4 回归测试用的 103KB .xls
  read_excel.py               #   独立的 .xls 读取小脚本（开发参考）
  docs/模块1规则报告.md       #   M1 业务规则文档
  protocol-samples/三相多功能表协议/   # M3 PDF/Excel 对照样本
  protocol-samples/HMU-UPS/   #   .docx 协议样本（M5 测试用）
```

> 历史遗留：原开发期的 `协议助手/xls_process_web/` 项目（174 MB，含 Python 3.14 venv）
> 已于 2026-05-21 删除。所有需要的代码已迁到 `protocol_app/`，
> 开发期常用样本和文档已迁到 `.test-fixtures/`。

### 1.5 前端菜单扩展点
左侧功能菜单由 `index.html` 里的 `menuItems` 数组驱动。新增功能：
1. 在 `menuItems` 追加 `{ id, label, icon, title }`
2. 在 `showView(view)` 里加分支控制对应视图的显示/隐藏
3. iframe 子页面：放到 `serial/`、`sms/` 平级（如果是 Flask 后端就走反代）

当前菜单项：SSH 终端 / 串口调试 / 信创短信猫 / 双机热备 / 协议转换 / 协议助手（6 项）。

------------------------------------------------------------

## 二、协议助手设计要点

### 2.1 子路径机制
协议助手必须能在 **两种模式** 下工作：
- 直连 Flask 调试：`http://127.0.0.1:5000/protocol/...`
- 经主壳反代：`http://<host>:3010/protocol/...`

实现方式（关键约定，改的时候不要破坏）：
1. **后端**：`app.py` 用 `werkzeug.middleware.dispatcher.DispatcherMiddleware`
   把 Flask app 挂在 `os.environ['PROTOCOL_PREFIX']`（默认 `/protocol`）下。
2. **模板**：所有 URL 都用 `url_for(...)` 生成（不要写死 `/static/xxx`）。
3. **JS**：通过 `<meta name="protocol-prefix" content="{{ config.PROTOCOL_PREFIX }}">`
   注入到 `window.PROTOCOL_PREFIX`，再被 `common.js` 读出来组装 `BACKEND_CONFIG`。
   **不要** 在 `<script>` 里直接写 `{{ ... }}`——IDE 会误报 JS 语法错误。

### 2.2 反代规则的坑（已修复）
`http-proxy` 的常见用法是 `app.use('/protocol', proxy)`，会把 `/protocol`
前缀剥掉再转发。但 Flask 的 DispatcherMiddleware 看到 `/` 会兜底 404。
所以 `server.js` 里写的是：
```js
app.all(/^\/protocol(\/.*)?$/, (req, res) => proxy.web(req, res, {
  target: 'http://127.0.0.1:5000', changeOrigin: true,
}));
```
保留完整路径转给 Flask。改 server.js 的时候不要把这条规则换成 `app.use`。

### 2.3 主题系统（webssh 设计语言）
所有协议助手页面引 `protocol_app/static/webssh-theme.css`，与 sms 子站、
webssh 主壳保持一致：
- 配色：bg `#020617` / panel `#0f172a` / cyan `#22d3ee`（强调）
- 字体：Inter 系，13px 默认 / 14px 标题
- 组件：`.app-shell` `.top-bar` `.column` `.card` `.btn` `.field`
  `.tag` `.dot` `.status-box` `.modal-mask` `.module-card` 等

改样式优先动 `webssh-theme.css` 里的 CSS 变量（`:root` 下定义），不要在
模板里写大段 `<style>`（除非是该模板独有的特殊布局，比如 module3 的左右分屏、
module4 的预览弹窗）。

### 2.4 业务零侵入约定
重构 UI 时严格保留：
- 所有 `fetch()` URL（在 `common.js` 的 `BACKEND_CONFIG` 里集中定义）
- 所有 DOM ID（业务代码靠 `document.getElementById` 寻址）
- 所有事件监听器和函数名
- JSON 字段名（前后端协议契约）

如果要改这些，必须前后端同步改。

------------------------------------------------------------

## 三、部署规范（核心）

### 3.1 目标机
| 项 | 值 |
| -- | -- |
| Host | 192.168.0.22 |
| OS | Kylin Linux V10 (Halberd), glibc 2.28, x86_64 |
| SSH | 22 |
| 账号 | root / `smt@2023` |
| 安装目录 | /opt/webssh |
| HTTP 端口 | 3010（对外）|
| 服务 | systemd 双服务 `webssh` + `webssh-protocol`（开机自启） |
| 网络 | **公网不通**，DNS 都解不到 pypi/github——所有依赖必须离线包 |

**默认行为**：用户说"部署 / 推上去 / 更新服务器"时：
- 改了 webssh 主壳代码 → 走 `scripts/deploy-upgrade.js`
- 改了协议助手代码或主题 → 走 `scripts/deploy-protocol.js`
- 不知道改了哪边 → 走 `deploy-protocol.js`（它会同步主壳 + 协议助手）

### 3.2 webssh 主壳：增量部署（日常）
```
WEBSSH_HOST=192.168.0.22 \
WEBSSH_PORT=22 \
WEBSSH_USER=root \
WEBSSH_DEPLOY_PASS='smt@2023' \
node scripts/deploy-upgrade.js
```
脚本做的事：
1. 本地把 `server.js / index.html / package*.json / serial/ / sms/ / node_modules` 打 tar
2. scp 到 `/root/`，校验 sha256
3. `cp -a /opt/webssh/app /opt/webssh/app.bak-<时间戳>` 备份
4. 解压覆盖到 `/opt/webssh/app/`
5. `systemctl restart webssh`
6. `is-active` + `/health` 200 双验证，失败自动回滚到 `app.bak-*`

⚠️ **`deploy-upgrade.js` 默认 `WEBSSH_HOST` 是旧值 192.168.50.10**，每次执行
都要显式传 `WEBSSH_HOST=192.168.0.22` 覆盖。`deploy-fresh.js` 和
`deploy-protocol.js` 的默认值已经是 `192.168.0.22`。

### 3.3 协议助手：一键部署（推荐）
```powershell
# PowerShell
$env:WEBSSH_DEPLOY_PASS = 'smt@2023'
node scripts/deploy-protocol.js

# Bash
WEBSSH_DEPLOY_PASS='smt@2023' node scripts/deploy-protocol.js
```
脚本做的事（`scripts/deploy-protocol.js`）：
1. 本地打 `webssh-protocol-<stamp>.tar.gz`：
   - `.offline-downloads/cpython-*.tar.gz` → `runtime/`（29 MB）
   - `.offline-downloads/wheels/*.whl` → `wheels/`（38 MB）
   - `protocol_app/` 全量（剔除 uploads/outputs/downloads/__pycache__）
   - `systemd/webssh-protocol.service.template` → `systemd/`
   - `scripts/install-protocol.sh` → 包根
   - `server.js` `index.html` `package.json` `package-lock.json` +
     `node_modules/{http-proxy,follow-redirects,requires-port,eventemitter3}` → `main-sync/`
2. SSH 上传 tar 到 `/root/`，sha256 校验
3. 解压到 `/root/webssh-protocol-<stamp>/`
4. 跑 `install-protocol.sh`：
   - 备份旧 `/opt/webssh/protocol/` 为 `protocol.bak-<时间戳>`
   - 解压 Python tar 到 `/opt/webssh/protocol/runtime/python/`
   - 离线 pip 安装 wheels 到 `/opt/webssh/protocol/runtime/site-packages/`
   - import 自检 8 个关键包（flask/pandas/numpy/xlrd/xlwt/openpyxl/docx/lxml）
   - 拷贝 Flask 代码 + 渲染 systemd unit + 启动 + 探活
5. 同步主壳代码（覆盖 `/opt/webssh/app/`）+ 重启 webssh
6. 双服务最终探活：
   - `systemctl is-active webssh / webssh-protocol`
   - `GET /health` → 200
   - `GET /protocol/` → 200（直连 + 反代两种）
7. 清理 `/root/` 临时文件

复用模式（不重打 Python/wheels，加快速度）：
```bash
SKIP_BUILD=1 WEBSSH_DEPLOY_PASS='smt@2023' node scripts/deploy-protocol.js
```
仅推协议助手，不动主壳：
```bash
SKIP_MAIN_SYNC=1 WEBSSH_DEPLOY_PASS='smt@2023' node scripts/deploy-protocol.js
```

### 3.4 部署后验证
**远端**（在目标机上）：
```bash
systemctl is-active webssh webssh-protocol         # 都期望 active
curl -s http://127.0.0.1:3010/health               # {"ok":true}
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5000/protocol/    # 200（直连）
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3010/protocol/    # 200（反代）
ss -lntp | grep -E ':(3010|5000)'                  # node 监听 3010，python 监听 5000
```

**本机**（外部访问）：
```
http://192.168.0.22:3010/                  # 主壳
http://192.168.0.22:3010/protocol/         # 协议助手主页
```

### 3.5 服务器侧最终目录
```
/opt/webssh/
├── app/                              # webssh 主壳代码
│   ├── server.js                     # 含 /protocol 反代规则
│   ├── server.js.bak-<时间戳>        # deploy-protocol 自动备份
│   ├── index.html                    # 含「协议助手」菜单 + iframe
│   ├── index.html.bak-<时间戳>
│   ├── package.json / package-lock.json
│   └── node_modules/                 # 含 http-proxy 及其依赖
├── runtime/node/                     # webssh Node runtime
├── protocol/                         # 协议助手（新增）
│   ├── app/                          # Flask 应用代码
│   │   ├── app.py / modules/ / templates/ / static/
│   │   ├── module4_config/j2k2_format_config.json
│   │   ├── uploads/ outputs/ ...     # 运行时数据
│   │   └── requirements.txt
│   └── runtime/
│       ├── python/bin/python3        # CPython 3.11.10
│       └── site-packages/            # flask/pandas/numpy/...
├── protocol.bak-<时间戳>             # 旧协议助手备份（自动留最近几次）
└── logs/
    ├── webssh.{out,err}.log
    └── protocol.{out,err}.log

/etc/systemd/system/
├── webssh.service                    # 主服务
└── webssh-protocol.service           # 协议助手（PartOf=webssh.service）
```

### 3.6 手动回滚
**主壳**：
```bash
rm -rf /opt/webssh/app
mv /opt/webssh/app.bak-<时间戳> /opt/webssh/app
systemctl restart webssh
```
或单个文件回滚：
```bash
cp /opt/webssh/app/server.js.bak-<时间戳> /opt/webssh/app/server.js
systemctl restart webssh
```

**协议助手**：
```bash
systemctl stop webssh-protocol
rm -rf /opt/webssh/protocol
mv /opt/webssh/protocol.bak-<时间戳> /opt/webssh/protocol
systemctl start webssh-protocol
```

### 3.7 常用运维
```bash
systemctl restart webssh webssh-protocol
journalctl -u webssh -n 200 --no-pager
journalctl -u webssh-protocol -n 200 --no-pager
tail -f /opt/webssh/logs/webssh.out.log
tail -f /opt/webssh/logs/protocol.out.log
tail -f /opt/webssh/logs/docker-restart.log
```

------------------------------------------------------------

## 四、关键依赖版本与选型理由

### 4.1 Python 3.11.10 standalone
- 来源：`astral-sh/python-build-standalone` 20241016 release
- 文件：`cpython-3.11.10+20241016-x86_64-unknown-linux-gnu-install_only.tar.gz`
- 选 3.11 而不是 3.12+：pandas/numpy 在 3.11 上更稳，wheels 覆盖最完整
- 选 3.11 而不是 3.7（系统自带）：pandas 2.x 要求 3.9+

### 4.2 协议助手 Python 依赖（21 包）
锁定版本写在 `protocol_app/requirements.txt`，关键选型：
- `flask==2.3.3` + `werkzeug==2.3.8`：避开 flask 3.x 不兼容
- `pandas==2.2.3` + `numpy==1.26.4`：稳定兼容，原项目用的是 3.0 预发布
- **`xlrd==1.2.0`**：⚠️ 关键！这是支持 `.xls` 的最后版本，>=2.0 移除了 .xls 读支持
- `openpyxl==3.1.5` + `et-xmlfile==1.1.0`：处理 .xlsx
- `python-docx==1.1.2` + `lxml==5.3.0`：处理 .docx

下载方式（本地 Windows 跑，给 Linux 用）：
```bash
pip download -r protocol_app/requirements.txt \
  --platform manylinux2014_x86_64 --python-version 3.11 \
  --implementation cp --abi cp311 --only-binary=:all: \
  -i https://pypi.tuna.tsinghua.edu.cn/simple/ \
  -d .offline-downloads/wheels/
```

### 4.3 Node.js 12.22.12
webssh 主壳用的旧版 Node（系统遗留），不要升。`http-proxy@1.18.1` 是兼容 Node 12 的最高版本。

------------------------------------------------------------

## 五、常见坑

1. **Windows 侧打 tar 报 "C:\..." 未知主机**：脚本里已自动加 `--force-local`。
   如果换路径还不行，检查 Git for Windows 的 `tar` 是否在 PATH。

2. **`tar: xxx 时间戳是未来的 N 秒之后`**：本机和服务器时间不同步的无害告警，
   不影响解压运行，可忽略。

3. **目标目录缺失 `/opt/webssh/app`**：目标机还没装过主壳，先跑 `deploy-fresh.js`。

4. **deploy-protocol 失败说"webssh 主服务未就位"**：先确保主壳已部署，再跑协议助手部署。

5. **health 不是 200 自动回滚（主壳）**：先看 `journalctl -u webssh -n 100`，
   常见原因：`node_modules` 没跟着打包进去 / `http-proxy` 模块缺失。

6. **`webssh-protocol` 启动失败**：
   - `journalctl -u webssh-protocol -n 50` 看 traceback
   - 常见：`PYTHONPATH` 找不到 site-packages、Python 二进制无 +x 权限
   - import 自检在 `install-protocol.sh` 步骤 6 已经做了，跑过这步还失败基本是配置问题

7. **协议助手页面打开是白屏 / 静态资源 404**：
   - 看 server.js 是否含 `/protocol/*` 反代规则（被覆盖过吗？）
   - `curl http://127.0.0.1:5000/protocol/` 直连是否正常
   - `webssh-theme.css` 路径是否被替换成绝对路径（应该用 `url_for`）

8. **docker 重启设置页的"立即执行"失败**：看返回里的 stderr，
   常见原因是目标机 `docker.service` 不存在或异常。

9. **`localhost_8088` 目录**：只读，不要改、不要重命名，冲突走别的路解。

10. **修改协议助手模板时 IDE 报 JS 语法错误**：
    Jinja `{{ ... }}` 不要直接放 `<script>` 内，用 meta 标签注入：
    ```html
    <meta name="protocol-prefix" content="{{ config.PROTOCOL_PREFIX }}">
    <script>window.PROTOCOL_PREFIX = (document.querySelector('meta[name="protocol-prefix"]')||{}).content||'';</script>
    ```

11. **`deploy-upgrade.js` 默认 host 是旧值 192.168.50.10**：每次执行都要显式传
    `WEBSSH_HOST=192.168.0.22`。`deploy-fresh.js` 和 `deploy-protocol.js` 的
    默认值已经是 `192.168.0.22`。

12. **GitHub 直连慢（python-build-standalone 下载）**：用户在本地手动下载放进
    `.offline-downloads/` 即可，文件名要保持 `cpython-*-x86_64-unknown-linux-gnu-install_only.tar.gz`
    格式（部署脚本按通配符找）。

13. **跨版本 mysqldump 灌库报 `ERROR 3105 The value specified for generated column ... is not allowed`**：
    宿主机自带的 `mysqldump` 可能是 MariaDB（如 0.22 上是 MariaDB 10.3.39），跟主库 MySQL 5.7
    不兼容——MariaDB mysqldump 不会自动跳过 STORED 生成列的 INSERT，导入到 MySQL 5.7 时报错。
    **铁律**：操作 dcim 容器里的 mysqld 时，所有客户端工具（mysqldump / mysql / mysqladmin 等）
    一律走 `docker exec dcim <tool>`，跟主库版本对齐。
    HA 同步功能里 `spawnLocalDump` 已经按这个原则改造，新增类似功能时照搬。

14. **MySQL `Host '...' is blocked because of many connection errors`**：
    `max_connect_errors` 默认 100，HA 模块旧版本固定 5s 重试 = 8 分 20 秒就拉黑。
    现已两层防护：① HA DB 重试改成渐进退避（5s ×3 → 15s ×5 → 60s 封顶）；
    ② dcim 容器内 `/etc/my.cnf` 已调到 `max_connect_errors = 100000`。
    **新部署到其他机器时**：要么手动在容器内调 my.cnf 后重启 mysqld，要么去 webssh 的
    「双机热备 → 连接信息 → MySQL 调优」一键调（按钮已实现）。
    解锁命令（拉黑后救急）：`docker exec dcim systemctl restart mysqld`，会清空 host_cache。

------------------------------------------------------------

## 六、本仓库的开发节奏

### 6.1 改了 webssh 主壳（server.js / index.html / serial / sms）
```bash
WEBSSH_HOST=192.168.0.22 WEBSSH_DEPLOY_PASS='smt@2023' \
  node scripts/deploy-upgrade.js
```

### 6.2 改了协议助手（protocol_app/）
```powershell
$env:WEBSSH_DEPLOY_PASS = 'smt@2023'
node scripts/deploy-protocol.js
```

### 6.3 改了协议助手主题（webssh-theme.css）
跟 6.2 一样，主题文件在 `protocol_app/static/`，会一起打包。

### 6.4 同时改了主壳 + 协议助手
直接走 `deploy-protocol.js`（默认会同步主壳代码 + 重启主服务）：
```powershell
$env:WEBSSH_DEPLOY_PASS = 'smt@2023'
node scripts/deploy-protocol.js
```

### 6.5 想本地起来手测
**主壳**：
```bash
PORT=3010 node server.js
```

**协议助手**（PowerShell）：

> ⚠️ 原 `协议助手/xls_process_web/xls_env/` 虚拟环境已于 2026-05-21 删除。
> 本地调试如需 Python 环境，先建一个 venv（任意 Python 3.9~3.12 都可以）：
> ```powershell
> python -m venv .venv-local
> .venv-local\Scripts\pip install -r protocol_app\requirements.txt
> ```
> 注：`requirements.txt` 里 numpy/pandas/lxml 在 Windows 上装会从 PyPI 拉
> Windows wheels（不是用 `.offline-downloads/` 里的 manylinux 包）。
> 通常直接走 `deploy-protocol.js` 推到 192.168.0.22 测更快。

```powershell
cd protocol_app
$env:PROTOCOL_PREFIX = "/protocol"
$env:PROTOCOL_PORT   = "5050"   # 避免占用 5000
$env:PROTOCOL_HOST   = "127.0.0.1"
..\.venv-local\Scripts\python.exe app.py
```

**两边一起**：先启 Flask，再启 Node，浏览器开 `http://127.0.0.1:3010`。
注意主壳 `server.js` 里反代 target 写死了 `127.0.0.1:5000`，本地用 5050 测时
临时改一下，或起 Flask 时 `PROTOCOL_PORT=5000`。

------------------------------------------------------------

## 七、最近一次大改记录（2026-05-21）

### 协议助手集成
- 把 `协议助手/xls_process_web/` 项目改造成可子路径运行的 `protocol_app/`
- 用 `werkzeug.middleware.dispatcher.DispatcherMiddleware` 接管 `/protocol` 前缀
- CDN 资源（jquery / bootstrap / fontawesome / xlsx）全部下载到 `protocol_app/static/vendor/`
- `server.js` 加 `http-proxy@1.18.1`，`/protocol/*` 反代到 Flask
- `index.html` 加菜单项 + iframe DOM + `showView` 分支
- 写离线打包脚本 `deploy-protocol.js` + `install-protocol.sh`
- 部署到 192.168.0.22 验证通过

### UI 重构（webssh 风格统一）
- 提取 sms 子站设计 token 到 `protocol_app/static/webssh-theme.css`（540 行）
- 7 个模板（index + module1~5 + xls_module）全部按新主题重写
- 业务逻辑零侵入：所有 fetch URL / DOM ID / 事件 / JSON 字段都没改
- `common.js` 微调适配新主题（showMsg 不再注入 inner div，直接改 #msgArea 自身 class）

### 离线素材
- Python 运行时：用户手动下载 `cpython-3.11.10+20241016-x86_64-unknown-linux-gnu-install_only.tar.gz`（29 MB）
- 22 个 manylinux2014 wheels（38 MB），来自清华 PyPI 镜像

### 关键产出（已部署到 192.168.0.22）
```
新增文件：
  protocol_app/                                 # 整个 Flask 子站
  systemd/webssh-protocol.service.template
  scripts/install-protocol.sh
  scripts/deploy-protocol.js
  .offline-downloads/cpython-3.11.10+*.tar.gz   # 不进 git
  .offline-downloads/wheels/*.whl               # 22 个，不进 git

修改文件：
  server.js               # + /protocol/* 反代
  index.html              # + 协议助手菜单/iframe/showView 分支
  package.json / package-lock.json   # + http-proxy@1.18.1
  node_modules/http-proxy/ + 依赖    # 新增
```

### 收尾清理（同日）
- 删除原 `协议助手/xls_process_web/` 项目目录（174 MB，含 Python 3.14 venv）
- 保留的资料迁到 `.test-fixtures/`（641 KB）：
  - `NetCol8000-A013(1).xls` — module1/module4 回归测试用的 103KB .xls
  - `docs/模块1规则报告.md` — M1 业务规则文档
  - `read_excel.py` — 独立的 .xls 读取小脚本
  - `protocol-samples/三相多功能表协议/` — M3 PDF+Excel 对照样本
  - `protocol-samples/HMU-UPS/` — .docx 协议样本
- 清理空的 `.offline-build/` 临时目录

------------------------------------------------------------

## 八、2026-05-22 全栈打包与清理

### 8.1 新增「全栈一键离线包」
原来主壳和协议助手分两包部署（webssh-offline + webssh-protocol），现在出一个
自包含 95 MB tar.gz，目标机一条命令装好双服务：

```bash
tar -xzf webssh-fullstack-offline-linux-x64-v*.tar.gz
cd webssh-fullstack-offline-linux-x64-v*/
./install-all.sh
```

包内结构：
```
app/                       # webssh 主壳 + node_modules
runtime/node/              # Node 12.22.12
protocol/app/              # Flask 子站（含 module4_config）
protocol/runtime/python/   # CPython 3.11.10
protocol/runtime/site-packages/  # flask/pandas/numpy/...
systemd/*.template         # 双 service unit 模板
install-all.sh             # 一键安装（双服务联装 + 三重探活）
uninstall-all.sh           # 一键卸载（双服务停止 + 清目录，--purge / --keep-backups）
INSTALL.md
```

打包流程（一行命令）：
```powershell
$env:WEBSSH_DEPLOY_PASS = 'smt@2023'
node scripts/build-fullstack-on-server.js
```
脚本做的事：在 192.168.0.22 服务器上 stage `/opt/webssh/{app,protocol,runtime}/`
现成的运行态目录 + 上传本地最新的 install-all.sh / uninstall-all.sh / systemd 模板，
打 tar + sha256，scp 拉回 `dist/`。整个过程约 90 秒，产物 95 MB。

### 8.2 脚本/文档清理
删除的过时素材：
- `scripts/build-offline-tar.sh`（被 build-fullstack-on-server.js 取代）
- `scripts/build-offline-on-server.js`（只打主壳，被全栈版取代）
- `scripts/check-target.js`（一次性环境探测工具，使命已完成）
- `scripts/打包命令.txt`（对应被删的 build-offline-tar.sh）
- `服务器手动打包流程.txt`（手动流程已脚本化）
- `目标服务器安装命令清单.txt`（默认 host 还是旧的 192.168.50.10）
- `部署与卸载步骤.txt`（指向 5/10 旧 tar，已被「安装与卸载手册.md」取代）
- `dist/webssh-offline-linux-x64-*-20260510*.tar.gz`（5/10 旧主壳包 ×2）
- `dist/webssh-offline-linux-x64-*-20260522035440.tar.gz`（被全栈包取代）
- `dist/webssh-protocol-2026052114*.tar.gz`（5/21 协议助手中间产物 ×2）
- `dist/webssh-fullstack-*-20260522040459.tar.gz`（早期全栈包，缺 uninstall-all.sh，已被新版替换）

新增的素材：
- `scripts/uninstall-all.sh`（双服务联动卸载，安装时会被自动复制到 `/opt/webssh/uninstall-all.sh` 方便日后调用）
- `安装与卸载手册.md`（部署运维同事看的独立手册，10 章覆盖安装/升级/卸载/排障）

保留的 dist 产物：
- `webssh-fullstack-offline-linux-x64-v1.0.0-20260522042433.tar.gz` 95 MB
- `.sha256: 65301995f0ef5bcef0033c3631f55b5d1a826bfb13a6dfb421a7c474cab4ae27`

### 8.3 部署方式取舍
现有三条部署路径，按场景选：

| 场景 | 用什么 |
| -- | -- |
| 新机器初装 / 完整迁移 | 全栈包 + `install-all.sh`（推荐，自包含）|
| 完整卸载 / 重装前清场 | `/opt/webssh/uninstall-all.sh`（安装后自动放在那里）|
| 已部署机日常增量主壳代码 | `deploy-upgrade.js`（增量 scp + 重启） |
| 已部署机日常更新协议助手 | `deploy-protocol.js`（含主壳代码同步） |
| 需要本地组装全新全栈包 | `build-fullstack-on-server.js`（从服务器现态打包）|

> 给运维同事的完整手册见仓库根的 [`安装与卸载手册.md`](安装与卸载手册.md)，
> 包含端口冲突 / SELinux / 防火墙 / 历史备份管理等实操要点。

------------------------------------------------------------

## 九、协议转换板块（2026-06-04 新增）

### 9.1 是什么
左侧菜单第 5 项「协议转换」，把 dcim 后端 `https://192.168.0.50:8082`
暴露的 91 条接口做成可视化调用面板。子站走 iframe 嵌入主壳，
左操作（按业务分组的接口按钮卡片）+ 右实时消息（method/url/req/resp/状态码/耗时）。

### 9.2 接口范围
覆盖 `协议文档/8082接口完整测试报告_含接口业务.docx` 全部 91 条：
10 业务分组（登录会话 / 告警 / 知识库图片 / 资产盘点 / 巡检维护维修 /
区域设备控制 / IT 机房容量能效 / 工单值班 / 自定义参数 / 资管 GET R80–R91）。
其中 24 条写入/控制类（CheckAlarmKey、SendControlCommandKey、CreateWorkOrderKey、
ChangePwdKey 等）按钮加红 + ⚠ 图标，点击会弹 confirm 二次确认。

### 9.3 配置文件
`config/proto-conv.json`，由后端在「连接信息」弹窗保存时写入，权限 0600，
**不入 git**（已加到 `.gitignore`）。schema：
```json
{
  "baseUrl": "https://192.168.0.50:8082",
  "userName": "admin",
  "passWord": "admin",
  "userLsh": "1",
  "timeoutMs": 8000,
  "pathMap": {}
}
```
- `userName/passWord` 明文存盘，调 LoginKey 时 Node 后端自动 Base64 编码（与 dcim 约定一致）
- `userLsh` 全局兜底；登录成功如果返回 UserLsh，会自动覆盖；接口调用时空字段也会自动用它兜底
- `pathMap`：默认 URL 是 `/${Key}`，若实际路由不同，在这里以 JSON 覆盖，
  比如 `{"LoginKey":"/api/Login"}`

### 9.4 调用通道
浏览器 → `/api/proto-conv/invoke` → Node `https` 模块 → 8082。
- 自签名证书：`new https.Agent({ rejectUnauthorized: false })`
- Cookie 维持：内存 `cookieJar` 按 baseUrl 维度合并 set-cookie（按 key 去重）
- 401 自动续登：非 LoginKey 接口收到 401 时，后端自动调 LoginKey 一次再重试
- 协议自适应：按 `URL.protocol` 选 `https/http` 模块（baseUrl 为 http 也能用）

### 9.5 后端路由清单（`server.js` 末尾 `setupProtoConv()` IIFE）
| 路由 | 用途 |
| -- | -- |
| `GET  /api/proto-conv/config` | 读配置（password 字段返 `***` + `hasPassword` 标志）|
| `PUT  /api/proto-conv/config` | 保存；password=`***` 或空时不更新；写盘 chmod 0600，cookieJar 清空 |
| `POST /api/proto-conv/login`  | 调 LoginKey；userName/passWord Base64；返回 set-cookie 写 jar；尝试解析 UserLsh 写回配置 |
| `POST /api/proto-conv/test-connection` | TCP 探活 baseUrl |
| `POST /api/proto-conv/invoke` | 核心代理；body `{key, method, body, query?, pathOverride?}`；返回 `{ok, status, data, message?}` |

### 9.6 危险接口约定
- 元数据 `pc-endpoints.js` 里 `danger:true` 共 24 条
- 前端按钮：`.btn.danger` 红底 + `⚠` 前缀
- 弹窗：顶部一条 `.danger-banner` 红色警示
- 提交时：`window.confirm()` 拦一道，取消则不发

### 9.7 验证
```bash
PORT=3010 node server.js
# 浏览器 http://127.0.0.1:3010/ → 左侧第 5 项「协议转换」
# 步骤：连接信息 → 登录 → 点 GetRealAlarmsKey 测一下 → 看右栏消息
```
日志：`logs/proto-conv.log`（每行一条 `[时间戳] method key status=xxx bodyLen=xxx`）。

### 9.8 Modbus TCP 转发（2026-06-04 新增）

把 `GetDeviceByGroupKey` 返回的设备实时数据转成 Modbus TCP holding registers，
对外提供给第三方 SCADA / Modbus master 直接读取。

**配置文件**：`config/proto-conv-modbus.json`，UI 写入，chmod 0600，**不入 git**。schema：
```json
{
  "enabled": false,
  "port": 5020,
  "pollIntervalSec": 5,
  "selectedDevices": [
    { "deviceId": "1", "deviceName": "CIM1机房1#温湿度",
      "groupId": "1", "groupName": "温湿度组",
      "zonesubno": "2", "zonesubname": "CIM1机房",
      "params": [ {"paraName":"温度","unit":"℃"}, ... ] }
  ]
}
```

**寄存器布局（紧凑排列，每设备 1 + 2N reg）**：
- `Reg[base+0]`：DeviceStatus（INT16，"1"→1 在线 / "0"→0 离线 / 其它→-1）
- 后续每参数 2 reg：`CurValue` FLOAT32 BE（占 2 reg）
- 设备按 selectedDevices 数组顺序紧密排开，第一个设备从 Reg[0] 开始
- 不再推送参数级 Status 字段（2026-06-04 调整）

**轮询**：默认 5s，UI 可改 1-60s。按 groupId 去重批拉（同分组多设备一次接口拿全），降低 dcim QPS。
失败时保留上一轮值，但 DeviceStatus 改 -1。dcim 没返回的已选设备：DeviceStatus -1 + 所有 CurValue NaN + Status -1。

**复用**：`setupModbusBridge` 通过 `global.__protoConv.callUpstream` 复用 setupProtoConv 的 cookieJar 和登录态；不再单独维护 dcim session。

**路由清单（server.js setupModbusBridge IIFE）**：
| 路由 | 用途 |
| -- | -- |
| `GET  /api/proto-conv/modbus/config`  | 读配置 + 运行状态 |
| `PUT  /api/proto-conv/modbus/config`  | 保存（含 selectedDevices）；改了自动重启 server |
| `POST /api/proto-conv/modbus/start`   | 显式启动（写 enabled=true 并启动） |
| `POST /api/proto-conv/modbus/stop`    | 显式停止（写 enabled=false 并停） |
| `GET  /api/proto-conv/modbus/status`  | 实时状态（running / port / 设备数 / 寄存器数 / lastPollAt / lastError / missingDevices） |
| `GET  /api/proto-conv/modbus/map.csv` | 映射表 CSV（带 UTF-8 BOM，Excel 可直接打开） |

**UI 入口**：协议转换顶栏「Modbus 转发」按钮（紫色），LED 灯指示状态：灰未启用 / 绿运行中 / 红错误。
弹窗里能扫描区域→分组→设备树，多选勾设备，实时显示总寄存器数（>60000 拒绝保存），下载映射 CSV。

**端口**：默认 5020。改成 502 需 root 启动（webssh.service 已是 root，OK）。Linux 防火墙：
```bash
firewall-cmd --add-port=5020/tcp --permanent && firewall-cmd --reload
```

**日志**：`logs/proto-conv-modbus.log`。

**验证**（用 mbpoll 或任意 Modbus master）：
```bash
mbpoll -m tcp -p 5020 -a 1 -t 4 -r 0 -c 20 127.0.0.1
# 或 ModScan / Modbus Poll，FC=03，地址按映射 CSV
```

### 9.9 Modbus TCP 控制转换（2026-06-04 新增）

把 dcim 8082 的 `SendControlCommandKey` 反向暴露成 Modbus TCP 写寄存器接口：
master 用 FC=06 写 `value=1` 到映射地址 → 后端触发对应 controlId 下发到 dcim。

**端口**：与「Modbus 转发」**共用 5020**（不再独立监听 5021）。上位机一个 TCP 连接同时读数据 + 写控制。

**配置文件**：`config/proto-conv-modbus-control.json`，UI 写入，chmod 0600，**不入 git**。schema：
```json
{
  "enabled": false,
  "debounceSec": 2,
  "selectedCommands": [
    { "deviceId": "1", "deviceName": "CIM1机房1#温湿度",
      "controlId": "2182", "commandName": "CIM1机房1#温湿度温度控制",
      "groupId": "1", "groupName": "温湿度组",
      "zonesubno": "2", "zonesubname": "CIM1机房" }
  ]
}
```

**寄存器布局（控制段固定起始地址 60000）**：
- 数据段从 `Reg[0]` 起紧凑排列（数据模块所有已选设备的总寄存器数 ≤ 59000）
- 控制段固定从 `Reg[60000]` 起：`selectedCommands[i]` → `Reg[60000+i]`
- 数据段与控制段地址完全解耦：master 端的控制地址不受数据段大小变化影响
- 中间未用区域（`Reg[N..59999]`）在 holding buffer 里全 0，master 读到 0
- master 写 `value=1` 触发；写其他值忽略；触发后 server 立即清回 0（边沿触发）
- 同一 controlId 在 `debounceSec` 秒内重复触发被忽略

**地址空间预算**：
- 数据段上限 59000 寄存器
- 控制段从 60000 起，到 65535，最多 5500 个控制命令

**两个模块协同（同一进程内）**：
- `setupModbusBridge`（数据）持有唯一的 jsmodbus server + holding buffer，listen 5020
- `setupModbusControlBridge`（控制）暴露 `global.__modbusControl`：`isEnabled / getCommands / handleWrite`
- 数据模块 `buildMapping()` 把控制段 append 进 holding；启动后注册 `postWriteSingleRegister` 监听器
- master 写控制段地址时，数据模块 dispatch 到 `global.__modbusControl.handleWrite(ctrlIdx, val, fullAddr, holding)`
- 控制模块 PUT 配置后调 `global.__modbus.rebuild()` 重启 server，让 holding 大小匹配新映射
- 任一模块 enabled=true 即启动 5020 server；都 disabled 时 server 关闭

**复用**：通过 `global.__protoConv.callUpstream` 共用 setupProtoConv 的 cookieJar 和登录态。

**路由清单（server.js setupModbusControlBridge IIFE）**：
| 路由 | 用途 |
| -- | -- |
| `GET  /api/proto-conv/modbus-control/config`  | 读配置 + 聚合状态（含 controlBaseAddr）+ 最近 20 条触发记录 |
| `PUT  /api/proto-conv/modbus-control/config`  | 保存（含 selectedCommands）；自动调 `__modbus.rebuild()` |
| `POST /api/proto-conv/modbus-control/start`   | 显式启用，rebuild server |
| `POST /api/proto-conv/modbus-control/stop`    | 显式停用，rebuild server |
| `GET  /api/proto-conv/modbus-control/status`  | 实时状态（enabled / running / port / controlBaseAddr / commandCount / totalFires / debouncedCount / lastFireAt / lastError）+ recentFires |
| `GET  /api/proto-conv/modbus-control/map.csv` | 映射表 CSV，地址 = controlBaseAddr + i |

**字段名注意**：dcim 后端 `SendControlCommandKey` 字段是 `controlId`（小写 c）。

**日志**：`logs/proto-conv-modbus-control.log`。

**验证**（用 jsmodbus client，先 GET status 拿到 controlBaseAddr）：
```js
const r = await client.writeSingleRegister(controlBaseAddr, 1);  // 触发第 1 个控制命令
```

### 9.10 SNMP v2c 转发（2026-06-05 新增）

把 dcim 8082 设备数据 + 控制项暴露成 SNMP v2c OID 树：master 用 GET 周期查温湿度等参数，用 SET 触发控制下发。

- **库**：`net-snmp@3.9.7`（**注意：不能用 3.10+/4.x，它们用了 ES2020 `?.` `??` 语法，Node 12.22.12 SyntaxError**）
- **协议**：仅 v2c；不做 v1/v3/trap
- **端口**：默认 udp/16162（UI 可改；161 需 root）
- **配置**：`config/proto-conv-snmp.json`（chmod 0600，不入 git）
- **数据来源**：复用 `setupModbusBridge.cfg.selectedDevices`（不重复维护）
- **控制 SET**：复用 `setupModbusControlBridge.handleWrite`（共享 2 秒去重 + 触发记录，addr 字段填 -1 表示来自 SNMP）

**OID 树**（前缀 `1.3.6.1.4.1.99999`）：
```
.1.<deviceIdx>.0.0          INTEGER       DeviceStatus (1=在线 / 0=离线 / -1=未知)
.1.<deviceIdx>.1.0          OCTET STRING  设备名（调试用）
.1.<deviceIdx>.2.<paraIdx>.0  INTEGER     CurValue × 10（master 除 10 还原；NaN→-1）
.1.<deviceIdx>.3.<paraIdx>.0  OCTET STRING 参数名（调试用）
.2.<cmdIdx>.0               INTEGER       ControlTrigger（写 1 触发 controlId）
```

**数据更新流**：`setupModbusBridge.pollOnce` 末尾调 `global.__snmp.syncFromHolding()` → SNMP 模块从 modbus 的 holding buffer 读 INT16/FLOAT32 转 INTEGER×10 → `mib.setScalarValue()` 写入 OID 树。

**鉴权关键点（坑过一次）**：net-snmp 3.9.7 的 `Authorizer.addCommunity(name)` **永远初始化 ReadOnly**，不接 accessLevel 参数。要给 community 写权限必须**显式覆盖**：
```js
auth.addCommunity('private');  // 先注册（ReadOnly）
auth.getAccessControlModel().setCommunityAccess('private', snmp.AccessLevel.ReadWrite);  // ★ 覆盖为 RW
```
provider 注册必须显式给 `maxAccess`，否则默认 not-accessible 连 GET 都失败。

**IP 白名单**：UI 配置数组，空 = 不限制。后端在 createAgent 的 callback 中读 `data.rinfo.address` 校验，不在白名单不回包（应用层兜底，正式靠 firewalld）。

**路由清单（server.js setupSnmpAgent IIFE）**：
| 路由 | 用途 |
| -- | -- |
| `GET  /api/proto-conv/snmp/config`  | 读配置 + 状态 |
| `PUT  /api/proto-conv/snmp/config`  | 保存（含 enabled/port/community/whitelist）；自动重启 agent |
| `POST /api/proto-conv/snmp/start`   | 显式启用 |
| `POST /api/proto-conv/snmp/stop`    | 显式停用 |
| `GET  /api/proto-conv/snmp/status`  | enabled / running / port / oidCount / setCount / lastSyncAt / lastSetAt / lastError |
| `GET  /api/proto-conv/snmp/map.csv` | OID 映射 CSV：OID / 类型 / 字段 / 设备 / 参数 / 单位 / controlId |

**日志**：`logs/proto-conv-snmp.log`。

**验证**（snmpwalk / snmpset）：
```bash
# 读所有数据
snmpwalk -v2c -c public 127.0.0.1:16162 .1.3.6.1.4.1.99999.1

# 读单个 OID
snmpget -v2c -c public 127.0.0.1:16162 .1.3.6.1.4.1.99999.1.1.0.0

# SET 触发控制
snmpset -v2c -c private 127.0.0.1:16162 .1.3.6.1.4.1.99999.2.1.0 i 1
```
或用 net-snmp client：
```js
const session = snmp.createSession('127.0.0.1', 'public', { port: 16162, version: snmp.Version2c });
session.subtree('1.3.6.1.4.1.99999', vbs => console.log(vbs), () => session.close());
```

------------------------------------------------------------

## 十、防火墙管理面板（2026-06-08 新增）

### 10.1 是什么
设置弹窗里的「防火墙」分页，参考 1panel 风格，对服务器 firewalld 做可视化管理：
- 顶部状态栏：firewalld 服务 active 状态、版本、默认 zone、开启/关闭/重启入口、禁 ping 开关
- 三个子 tab：
  - **端口规则**：协议 / 端口 / 策略（允许/拒绝）/ 指定源 IP，搜索 + 创建 + 删除
  - **端口转发**：本机端口 → 本机或远端端口（含目标 IP）
  - **IP 规则**：IPv4/IPv6 黑名单/白名单（单 IP 或 CIDR）

仅支持 Linux + firewalld（Kylin V10 默认）；非 Linux 平台 `available:false`，UI 显示原因不报错。

### 10.2 实现要点
- 后端：`server.js` 末尾 `setupFirewall()` IIFE，所有命令 `--permanent` + `--reload`
- 不走 shell：`spawn('firewall-cmd', [...args])`，参数当 argv，避免命令注入
- 端口规则映射：
  - 简单放行（accept + 无源 IP）→ `--add-port=80/tcp`
  - 拒绝 / 带源 IP → `--add-rich-rule='rule family="ipv4" [source address="x"] port port="80" protocol="tcp" accept|drop'`
- 端口转发：`--add-forward-port=port=80:proto=tcp:toport=8080[:toaddr=...]`
- IP 规则：`--add-rich-rule='rule family="ipv4" source address="x" accept|drop'`
- 输入校验：端口 `\d{1,5}(-\d{1,5})?` 1-65535、协议 tcp/udp、IP 仅允许十六进制 + `.:/`，长度 ≤ 64
- 删除时按 `id` 前缀路由：`port:` / `fwd:` / `rich:`，rich-rule 删除前用对应正则二次校验类型，防止串改

### 10.3 路由清单
| 路由 | 用途 |
| -- | -- |
| `GET  /api/firewall/status` | available / running / version / defaultZone / icmpBlocked |
| `POST /api/firewall/service` | body `{action: start\|stop\|restart\|enable\|disable}` |
| `POST /api/firewall/icmp` | body `{block: true\|false}`，禁 ping 开关 |
| `GET  /api/firewall/ports` | 列端口规则（合并 `--list-ports` + 端口型 rich-rule）|
| `POST /api/firewall/ports` | body `{port, protocol, strategy, address?}` |
| `DELETE /api/firewall/ports` | body `{id}` |
| `GET  /api/firewall/forwards` | 列端口转发（`--list-forward-ports` + 转发型 rich-rule）|
| `POST /api/firewall/forwards` | body `{srcPort, dstPort, protocol, dstAddr?}` |
| `DELETE /api/firewall/forwards` | body `{id}` |
| `GET  /api/firewall/addresses` | 列地址型 rich-rule |
| `POST /api/firewall/addresses` | body `{address, strategy}` |
| `DELETE /api/firewall/addresses` | body `{id}` |

**zone**：默认操作 `public`，可通过环境变量 `FIREWALL_ZONE` 覆盖。
**日志**：`logs/firewall.log`，每条改动追加一行。

### 10.4 验证
本机（Windows）：
```bash
PORT=3010 node server.js
# 浏览器开 http://127.0.0.1:3010 → 设置 → 防火墙 → 看到「firewalld 不可用 only firewalld on Linux is supported」即正常
```

服务器（192.168.0.22）部署后：
```bash
curl -s http://127.0.0.1:3010/api/firewall/status | jq
# 预期：{ "available": true, "running": true/false, "version": "x.y.z", ... }
firewall-cmd --list-ports
firewall-cmd --list-rich-rules
firewall-cmd --list-forward-ports
```
UI 操作后用上面 3 条 firewall-cmd 复核，规则应已生效且 `--permanent` 写入。

### 10.5 部署
属于主壳改动，走 `deploy-upgrade.js`：
```bash
WEBSSH_HOST=192.168.0.22 WEBSSH_DEPLOY_PASS='smt@2023' \
  node scripts/deploy-upgrade.js
```
或者用 `deploy-protocol.js`（会顺带同步主壳代码）。

------------------------------------------------------------

## 十之一、IP 管理分页（大框架设置，2026-06-23 新增）

### 11.1 是什么
设置弹窗里的「IP 管理」分页，和「运维 / 防火墙 / 更新」同属于 webssh 主壳的大框架设置。
它不是左侧一级菜单，也不是独立子站；入口在 [index.html](index.html) 的 settings modal：

- `settingsTabs` 增加 `{ id: 'ip', label: 'IP 管理' }`
- 页面 DOM 是 `<section class="settings-section" data-pane="ip">...`
- 切到该分页时只做表单状态同步，不加载 iframe

### 11.2 功能范围
- 用户填写 SSH 主机、端口、用户名、密码
- 后端用 `ssh2` 登录目标机，读取全部非 lo 网口、当前 IPv4、子网掩码、默认网关、NetworkManager 连接名称、配置方式、autoconnect
- 「网络接口」是真实设备名（如 `ens33` / `p3p1`），用下拉选择；下拉项要显示链路状态：已插入 / 未插入 / 已插入未配置 / 已插入自动
- 切换「网络接口」时，必须自动同步 IP、子网掩码、网关、配置方式、DNS、网卡名称、开机自动连接到下面输入栏
- 「网卡名称」是 NetworkManager 连接名称，保存时可通过 `nmcli connection modify <old> connection.id <new>` 重命名；编辑后要同步刷新下拉项显示，方便查看
- 支持手动配置 IP / 子网掩码 / 网关
- 支持自动模式（NetworkManager `ipv4.method auto`）
- 支持 DNS 选择填写/不填写；填写时设置 `ipv4.ignore-auto-dns yes ipv4.dns <value>`，不填写时恢复自动 DNS
- 支持设置 `connection.autoconnect`
- 支持「网络类型」：普通网络 / 主网络 / 备用网络；后端写 `ipv4.route-metric`，主网络 100、普通网络 300、备用网络 500，用于多网口主备切换并减少同网段默认路由互相干扰
- 支持「重启网卡」：优先 `nmcli connection down/up`，无连接时退回 `ip link down/up`
- 未插网线的接口也必须能持久化配置：有 NetworkManager 时按 `connection.interface-name=<iface>` 查找连接，找不到就创建绑定该接口的 ethernet connection，不能只用 `ip addr` 临时改

### 11.3 后端路由
后端在 [server.js](server.js) 的「大框架设置：IP 管理」块里实现：

| Method | Path | 用途 |
|---|---|---|
| POST | `/api/ip/info` | SSH 验证并读取目标机网卡/IP/网关信息 |
| POST | `/api/ip/set` | 应用目标机网络配置 |
| POST | `/api/ip/restart` | 重启选中的真实网口 / NetworkManager 连接 |

实现约定：
- 远程命令必须通过 `shellEscape()` 拼接用户输入，避免命令注入
- 子网掩码支持点分十进制（如 `255.255.255.0`）和前缀长度（如 `24`）
- `nmcli` 存在时优先读取/修改 NetworkManager 连接；不存在时手动模式仅用 `ip` 命令做运行时修改
- 未插线接口读取不到 `GENERAL.CONNECTION` 时，要从 `nmcli connection show` 按 `connection.interface-name` 反查配置，并读取 `ipv4.addresses/gateway/dns/route-metric`
- 保存 NetworkManager 连接时必须写入 `connection.interface-name` 和 `ipv4.route-metric`；主备切换只靠路由 metric，不另起守护进程
- 网口列表不能只取“已有 IPv4 地址”的接口，必须从 `ip -o link` 或 `/sys/class/net` 枚举，否则未配置 IP 的网口不会显示
- 改 IP 可能导致当前 SSH 连接断开，前端只显示后端返回结果，不做自动重连假设

### 11.4 部署
属于 webssh 主壳改动，走 `deploy-upgrade.js`：
```bash
WEBSSH_HOST=192.168.0.22 WEBSSH_DEPLOY_PASS='smt@2023' \
  node scripts/deploy-upgrade.js
```
或者用 `deploy-protocol.js`（会顺带同步主壳代码）。

------------------------------------------------------------

## 十之二、时间分页（大框架设置，2026-06-23 新增）

设置弹窗左边栏增加「时间」分页，和「运维 / IP 管理 / 防火墙 / 更新」同属于 webssh 主壳的大框架设置。

### 12.1 前端约定

- `settingsTabs` 增加 `{ id: 'time', label: '时间' }`
- 页面 DOM 是 `<section class="settings-section" data-pane="time">...`
- 通过 SSH 凭据读取目标服务器系统时间、时区、NTP 状态和 BIOS 硬件时钟
- 显示当前浏览器主机时间，包含年月日、星期几、时分秒，并计算服务器时间与主机时间差值
- 支持「一键同步当前主机时间」：把浏览器当前时间传给后端设置服务器系统时间
- 支持「手动修改时间」：`datetime-local` 精确到秒，显示对应星期，提交后写入服务器系统时间和 BIOS 硬件时钟
- 支持配置 NTP 时间服务器：输入一个或多个服务器地址，保存后写入目标机 NTP 服务配置并立即尝试同步

### 12.2 后端路由

后端在 [server.js](server.js) 的「大框架设置：时间」块里实现：

| Method | Path | 用途 |
|---|---|---|
| POST | `/api/time/info` | SSH 验证并读取目标机系统时间 / 时区 / NTP / BIOS 时钟 |
| POST | `/api/time/set` | 设置目标机系统时间，并执行 `hwclock --systohc` 写入 BIOS 硬件时钟 |
| POST | `/api/time/ntp` | 保存目标机 NTP 时间服务器，优先 chrony，退回 systemd-timesyncd / ntpd |

实现约定：

- 远程命令必须通过 `shellEscape()` 拼接用户输入
- 写入时间前优先 `timedatectl set-ntp false`，避免 NTP 立刻把手动时间改回去
- 设置系统时间用 `date -s "YYYY-MM-DD HH:mm:ss"`，写 BIOS 用 `hwclock --systohc`
- 如果缺少 `hwclock`，必须返回错误，不能只改系统时间，否则重启后可能回退
- NTP 服务器输入必须用 `parseNtpServers()` 校验，只允许主机名 / IPv4 / IPv6 类字符，最多 8 个；不能把原始输入直接拼到远程 shell
- 保存 NTP 优先改 `/etc/chrony.conf` 并重启 `chronyd/chrony`；无 chrony 时改 `/etc/systemd/timesyncd.conf`；再退到 `/etc/ntp.conf`

------------------------------------------------------------




## 十一、视频监控板块（GB/T 28181，2026-06-09 新增）

### 11.1 是什么
左侧菜单第 7 项「视频监控」。GB/T 28181 接入实际**走 wvp-pro + ZLMediaKit + Redis** 的标准栈，
webssh 主壳只负责 UI 入口（iframe 嵌入 wvp 原生 UI）。下级 NVR/IPC 主动注册到 wvp，
浏览器走 wvp 自带的「分屏监控」做实时预览 + 历史回放。

### 11.2 架构（实际部署）
```
浏览器  http://<host>:3010/  →  webssh 主壳菜单「视频监控」
  └─ iframe → http://<host>:18082/  (wvp-pro 原生 UI，跨端口同主机)
                  ↓
           wvp-pro 2.6.9 (webssh-wvp.service, Java 8)
              ├─ SIP 5070/udp+tcp     接收 NVR 注册 / 心跳 / catalog
              ├─ HTTP API 18082       wvp UI + 内部调度
              ├─ Redis 127.0.0.1:6380 缓存设备/会话/在线状态
              └─ MySQL 127.0.0.1:3333 → dcim 容器内 MySQL，独立库 wvp_webssh
                  ↓
           ZLMediaKit (webssh-mediaserver.service)
              ├─ HTTP API+FLV 18180   仅本机
              ├─ RTP 30600-30700/udp  收 PS 流
              └─ webhook → wvp:18082  wvp 启动时自动 setServerConfig 配置 hook
```

**4 个 systemd 服务**（启动顺序）：webssh-redis → webssh-mediaserver → webssh-wvp → webssh

### 11.3 关键文件分布

```
/opt/webssh/
├── app/                                  webssh 主壳（含 video/ 子站，目前未使用，留作备用）
├── redis/
│   ├── bin/{redis-server,redis-cli}      从 dcim 容器拷出
│   ├── conf/redis.conf                   port 6380, bind 127.0.0.1
│   └── data/                             RDB 数据（默认禁用持久化）
├── mediaserver/                          ZLMediaKit 二进制+依赖（从 dcim 容器拷）
│   ├── MediaServer                       ELF 二进制（90MB，git d818cad / 2023-03-12）
│   ├── lib/{libssl.so.10,libcrypto.so.10}  从 dcim overlay 拷的旧 OpenSSL（CentOS 7 ABI）
│   │                                       systemd 用 LD_LIBRARY_PATH 加载
│   ├── config.ini                        secret + http.port=18180 + rtp_proxy.port_range=30600-30700
│   └── default.pem
├── wvp/
│   ├── wvp.jar                           wvp-pro 2.6.9-06021439（111 MB，从 dcim 拷）
│   └── conf/application-webssh.yml       见 11.4
└── config/
    └── video-28181.json                  webssh 主壳预留扩展点（当前未读写）
```

dcim 容器对 webssh 的两个外部依赖（**仅读，不修改 dcim 自身**）：
- 容器内 MySQL 5.7.39 → 通过 docker port-map `host:3333 → container:3306` 访问
- 容器卷里的 ZLMediaKit 二进制和 OpenSSL 库 → 复制出来用，不依赖 dcim 进程

### 11.4 wvp 配置 `/opt/webssh/wvp/conf/application-webssh.yml`

关键字段（chmod 600，**不入 git**）：

```yaml
spring:
  redis:
    host: 127.0.0.1
    port: 6380             # 独立 redis，避开 dcim 容器内的 6379
    database: 6
  datasource:
    url: jdbc:mysql://127.0.0.1:3333/wvp_webssh?...    # 复用 dcim MySQL，独立库
    username: root
    password: e1145c17c66ca8ac
server:
  port: 18082              # wvp HTTP / UI
  ssl:
    enabled: false
sip:
  ip: 0.0.0.0
  port: 5070               # SIP 信令端口（避开 dcim 占用的 5060）
  domain: 4401020049
  id: 44010200492000000001
  password: ""             # 留空 = 跳过密码摘要校验。海康/大华密码 hash 各家有差异，
                           # 留空最稳；内网部署不需要 SIP 鉴权
media:
  id: webssh_zlm           # 必须和 ZLM config.ini 的 general.mediaServerId 一致
  ip: 127.0.0.1
  stream-ip: 192.168.0.22
  hook-ip: 127.0.0.1
  http-port: 18180
  secret: <16字节hex>      # 必须和 ZLM config.ini 的 api.secret 一致
  rtp:
    enable: true
    port-range: 30600,30700
```

**两套 ID 规则**（注意区别）：
- 平台 ID（webssh-wvp 自己的 SIP ID）：`44010200492000000001`，第 11-13 位 `200` 表示平台
- 设备 ID（NVR/IPC 厂商烧录）：`44010200491320000001`，第 11-12 位 `13` 表示 IP 摄像机

下级设备配 SIP 服务器 ID = 平台 ID `34020000002000000001`，下级设备 SIP 用户名 = 设备自己 ID。

### 11.5 数据库初始化

`wvp_webssh` 库 schema 直接从 dcim 的 `wvp` 库 dump 过来（同版本 wvp 2.6.9）：

```bash
docker exec dcim mysqldump -uroot -p<pwd> --no-data --routines --triggers wvp \
  | mysql -h127.0.0.1 -P3333 -uroot -p<pwd> wvp_webssh
```

需要手动灌两条 seed 数据（schema dump 不带数据）：

```sql
INSERT INTO wvp_user_role (id, name, authority, create_time, update_time)
VALUES (1, 'admin', '0', NOW(), NOW());

INSERT INTO wvp_user (id, username, password, role_id, create_time, update_time, push_key)
VALUES (1, 'admin', '551c76780e34e1c1fab9ff85dfc79947', 1, NOW(), NOW(), 'webssh_admin_key');
```

wvp 登录：浏览器输入 `admin / admin`，前端会自动 md5 转 hash 提交。
后端 API 直接调用时 `password` 字段填 `551c76780e34e1c1fab9ff85dfc79947`（dcim 库里的 hash）。

### 11.6 webssh 主壳「视频监控」入口（自研 UI · 实时预览 · dcim/webssh 双栈）

webssh 视频监控菜单是**真接通了实时预览的自研 UI**，同时反代两套独立的 wvp（dcim
原生 + webssh 自建）让用户切换查看：

```
[index.html]                       showView("video") → iframe src=./video/index.html
[video/index.html]                 webssh 设计语言（深色 #020617 / cyan #22d3ee）
  顶栏：标题 + 1/4/9/16 分屏切换 + 关闭全部 + 全屏
        + 状态灯「dcim 视频监控」+「📡 加载 dcim 视频监控」按钮
        + 状态灯「webssh 视频监控」+「📡 加载 webssh 视频监控」按钮
        + 「🔗 打开 8086」次按钮
  左栏：设备列表（双击设备名 → 起播到当前激活分屏）+「⚙ 8086 修复指南」details
  中央上：1/4/9/16 video 分屏（flv.js 实例 + active tile 选择）
  中央下：折叠卡片（带数据源标签 dcim/webssh）
        - 🛰 国标 28181 服务器配置
        - 📺 监控设备
[video/vendor/flv.min.js]          flv.js v1.6.2（144 KB）
[video/assets/css/style.css]       占位样式 + dcim 面板 + 数据源标签 + 修复指南
```

**双栈反代（两套对称）**：
| 套 | apiBase | 协议 | ZLM | 摄像头 SIP 端口 |
|---|---|---|---|---|
| `dcim`   | `https://127.0.0.1:18080` (dcim wvp，自签证书) | HTTPS | dcim ZLM `127.0.0.1:80`     | **5060** |
| `webssh` | `http://127.0.0.1:18082`  (webssh-wvp)         | HTTP  | webssh ZLM `127.0.0.1:18180` | **5070** |

两边都自动用 `admin / 551c76780e34e1c1fab9ff85dfc79947` 登录拿 token，401 自动续登。

**路由清单**（两套对称，把 `<src>` 替换为 `dcim` 或 `webssh`）：
| Method | Path | 用途 |
|---|---|---|
| GET  | `/api/<src>-video/status`                    | 探活：reachable/version/hasToken |
| GET  | `/api/<src>-video/config`                    | wvp `/api/server/system/configInfo`（SIP 配置） |
| GET  | `/api/<src>-video/devices?page=&count=`      | wvp `/api/device/query/devices` |
| GET  | `/api/<src>-video/channels?deviceId=&page=&count=` | wvp `/api/device/query/devices/{id}/channels` |
| POST | `/api/<src>-video/play/:dev/:ch`             | wvp `/api/play/start` → 改写 flv URL 为 `/media-<src>/...` |
| POST | `/api/<src>-video/play/stop/:dev/:ch`        | wvp `/api/play/stop` |
| POST | `/api/<src>-video/playback/start/:dev/:ch`   | wvp `/api/playback/start?startTime=&endTime=` |
| POST | `/api/<src>-video/playback/stop/:streamId`   | wvp `/api/playback/stop` |
| POST | `/api/<src>-video/playback/control/:streamId/:cmd` | wvp `/api/playback/control` (pause/play/scale/seek) |
| ALL  | `/media-<src>/*`                             | 反代到对应 ZLM HTTP-FLV，剥前缀转发 |

**前端起播流程**（双击设备名）：
1. `currentSource` 由最后一次点击的「📡 加载 dcim/webssh 视频监控」决定
2. 双击 `<dev-head data-dev=... data-name=...>` → fetch `/api/<src>-video/channels?deviceId=...`
3. 取第一个在线通道 → POST `/api/<src>-video/play/<dev>/<ch>` → 拿到 `flvUrl`（已改写为 `/media-<src>/rtp/<streamKey>.live.flv`）
4. `tiles[activeIdx].play({ flvUrl, ... })` → flv.js attachMediaElement → 出图
5. 点 tile 右上 ✕ 或顶栏「关闭全部」触发 `tile.stop()` → flv.js destroy + POST stop API

**Tile 类**（`video/index.html` 内联）管理 flv.js 实例：
- `play(params)` 创建 player + attach video + 自动播放
- `stop()` destroy player + 调 wvp stop + 还原占位
- `_destroyPlayer()` pause/unload/detach/destroy 完整清理

**保留代码**：[server.js](server.js) 的 `setupVideo28181` IIFE（API 路由 + `/media/*` 反代，
最早的设想里 webssh 直接当 SIP 服务器用 ZLM 28181）+ [video/assets/js/](video/assets/js/)
下 7 个 JS 模块仍在仓库里，当前 `video/index.html` 不引用（用 inline 简化版），预留备用。

### 11.7 端口分配（最终）

| 端口 | 协议 | 用途 | 暴露范围 |
|---|---|---|---|
| 3010 | TCP | webssh 主壳 | LAN |
| 5070 | UDP+TCP | wvp SIP 信令 | LAN（NVR/IPC 注册）|
| 6380 | TCP | webssh-redis | 仅本机 |
| 18082 | TCP | wvp HTTP+UI | LAN（浏览器 iframe）|
| 18180 | TCP | ZLM HTTP API + HTTP-FLV | 仅本机 |
| 30600-30700 | UDP | ZLM RTP 收流 | LAN（NVR 推流）|

dcim 容器原有的 5060 SIP / 18080 ZLM / 30000-30500 RTP **不动**，两套环境完全并存。

### 11.8 NVR/IPC 接入步骤

下级设备（海康/大华等）配置上级平台：

| 字段 | 值 |
|---|---|
| 平台接入方式 | 28181 |
| 协议版本 | GB/T28181-2016 |
| SIP 服务器 ID | `34020000002000000001`（webssh-wvp 的 sip.id）|
| SIP 服务器域 | `3402000000`（webssh-wvp 的 sip.domain）|
| SIP 服务器地址 | `192.168.0.22`（webssh 部署主机）|
| SIP 服务器端口 | **5070**（注意不是默认的 5060）|
| SIP 用户名 / 用户认证 ID | 设备自己的 28181 编码（如海康默认 `44010200491320000001`）|
| 密码 | 任意（wvp 端 password 留空跳过校验）|
| 注册有效期 | 3600 |
| 心跳周期 | 60 |

保存后 1-2 个心跳周期内（约 60s），wvp UI「国标设备」页应能看到设备上线。

### 11.9 验证

通路探活：
```bash
# 4 个服务
systemctl is-active webssh-redis webssh-mediaserver webssh-wvp webssh

# wvp 登录测试
curl "http://127.0.0.1:18082/api/user/login?username=admin&password=551c76780e34e1c1fab9ff85dfc79947"

# ZLM API 自检
SECRET=$(grep '^secret=' /opt/webssh/mediaserver/config.ini | head -1 | cut -d= -f2)
curl "http://127.0.0.1:18180/index/api/getServerConfig?secret=$SECRET"

# 看 wvp 是否认到 ZLM
mysql -h127.0.0.1 -P3333 -uroot -p<pwd> wvp_webssh \
  -e "SELECT id,ip,http_port,default_server FROM wvp_media_server"
/opt/webssh/redis/bin/redis-cli -p 6380 -n 6 ZRANGE VMP_MEDIA_ONLINE_SERVERS_webssh_<id> 0 -1
```

SIP 注册抓包（设备注册不上时用）：
```bash
timeout 60 tcpdump -i any -nn -A 'udp and (port 5060 or port 5070)'
journalctl -u webssh-wvp -f       # wvp 日志，grep "注册请求" 看 401/403/200
```

端到端：
1. 浏览器开 `http://192.168.0.22:3010/` → 左栏「视频监控」 → iframe 加载 wvp UI
2. wvp 登录页输 `admin / admin` → 进顶部菜单「分屏监控」
3. 左侧设备树选通道拖到右边格子 → 1-3s 出图（HTTP-FLV via ZLM）
4. 切换 1/4/9 分屏布局 / 试回放（菜单 → 云端录像）

### 11.10 已知坑

1. **wvp 启动慢**：Spring Boot 冷启动 30-40s，systemd 探活时要给足时间
2. **ZLM 端口冲突**：dcim 容器默认 ZLM 在 18080/30000-30500，webssh 这套必须用 18180/30600-30700
3. **wvp `media_server/list` API 偶发返回空**：DB+Redis 数据齐全但 API 返回 `[]`。重启 wvp 一次能恢复，
   原因不明，疑似 wvp 2.6.9 启动期 race condition
4. **wvp 注册 race condition 报错**：日志看到 `Duplicate entry ... for key 'uk_device_device'` 是
   正常的（同时收到多次 REGISTER 重传），最终一次能成功入库即可
5. **SIP 密码摘要兼容性差**：留空 `sip.password=""` 是最稳的做法。海康/大华等设备的
   `Authorization: Digest` 计算细节和 wvp 默认实现不完全一致，开校验后大量设备会 403
6. **跨端口 iframe 没问题但 cookie/storage 不共享**：用户首次打开「视频监控」会看到 wvp 登录页，
   登录一次即可，token 存在 wvp 域的 sessionStorage 里
7. **浏览器拦截 mixed content**：webssh 如果配 HTTPS，iframe 拉 wvp HTTP 资源会被拦
   要么 webssh 也走 HTTP，要么 wvp 也开 HTTPS（在 application.yml 改 ssl.enabled=true）
8. **dcim 8086 原生页面 ajax 失败问题**（**2026-06-09 已修复**）：
   dcim 自己 8086 HTTPS 站点 (donghuan-camera-list.html / donghuan-camera-setting.html)
   子页面进去后「配置信息」「监控设备」表格全空。
   - **真实根因（最终定位）**：dcim wvp 的 `application-dev.yml` 里 `user-settings.allowed-origins`
     只有 `http://ip:8088` 和 `http://ip:8081`，**没包含 `https://192.168.0.22:8086`**。
     浏览器从 `https://...:8086` 跨端口调 `https://...:18080/api/*` 走 CORS 预检，
     wvp 拒绝该 origin → 浏览器拦截响应 → 前端模板渲染不出数据。
   - **错误判断（已订正）**：之前以为是 Apache 8086 vhost 没有 `/api/*` 反代规则，
     加了 ProxyPass → 但前端 `videoUrl = window.location.protocol + '//' + hostname + ":18080/"`
     根本不走 `/api/*`，是直连 18080。ProxyPass 实际未起作用（保留备份不删）。
   - **修复方式 A（webssh 自研 UI）**：server.js 末尾 `setupDcimVideo` IIFE 做反代
     （HTTPS + 自动登录），前端 [video/index.html](video/index.html) 通过
     `/api/dcim-video/*` 拿到 dcim 那套数据。**不改 dcim 内部任何东西**。
   - **修复方式 B（dcim 8086 原生页面，最终生效）**：用户在 dcim 容器内改：
     - `/dcim/media/wvp-GB28181-pro/target/classes/application-dev.yml`
     - `/dcim/media/wvp-pro-assist/target/classes/application-dev.yml`
     ```yaml
     media:
       stream-ip: 192.168.0.22       # 之前是 192.168.2.141（旧网段，已不可达）
       sdp-ip: 192.168.0.22
     user-settings:
       allowed-origins:
         - http://192.168.0.22:8088
         - https://192.168.0.22:8081
         - https://192.168.0.22:8086  # ← 新增，关键
     ```
     然后容器内 `systemctl restart ZLMediaKit.service && systemctl restart wvp-pro.service`，
     8086 那两个原生页面立刻恢复显示。
   - **遗留产物**：`127.0.0.6.conf.bak-20260531103846`（容器内 8086 vhost 备份）+
     vhost 里追加的 ProxyPass `/api → 18080` 块。不影响功能，保留作为冗余反代。
     如要回滚：`docker exec dcim sh -c "cp -a /www/server/panel/vhost/apache/127.0.0.6.conf.bak-20260531103846 /www/server/panel/vhost/apache/127.0.0.6.conf && /www/server/apache/bin/httpd -k graceful"`
9. **dcim wvp_device 表本身是空的**：海康摄像头默认 SIP 服务器端口配的是 5070（webssh-wvp），
   不是 5060（dcim wvp）。要看 dcim 那套有数据，得把摄像头 SIP 端口切回 5060 重新注册。

### 11.11 不做 / 暂搁置（明确收口）

- ⚠️ webssh 风格自研视频 UI **架子已搭**（[video/index.html](video/index.html) 占位 +
  分屏切换演示 + dcim 反代修复面板），实际播放/分屏拖动/回放等功能待对接
- ⚠️ webssh 主壳 `/api/video/*` 路由 + `/media/*` 反代代码已就绪
  （[server.js](server.js) `setupVideo28181` IIFE），但前端当前不调用
- ❌ ZLM 自带 SIP 服务器（v8 master 分支已拆掉，必须 wvp+ZLM 双进程）
- ❌ webssh 本地录像（用 NVR 自带）
- ❌ WebRTC / HLS（wvp 默认 FLV 已够用）
- ❌ 装独立 MySQL（直接复用 dcim 的，仅独立库 `wvp_webssh`）
