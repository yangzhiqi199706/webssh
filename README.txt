Web SSH 本地运行说明

1. 安装依赖
   npm install

2. 启动服务
   npm start

3. 打开浏览器
   http://localhost:3000

环境变量可选：
- PORT=3000
- SSH_HOST=你的Linux主机IP
- SSH_PORT=22
- SSH_USER=用户名
- SSH_PASSWORD=密码
- SSH_PRIVATE_KEY=私钥文件路径

说明：
- 前端页面与后端通过 WebSocket 连接
- 后端通过 ssh2 连接 Linux
- 当前页面已接入后端，输入命令会透传到 SSH Shell
- 当前页面已接入 SFTP 文件管理
- 当前页面已支持本地 CodeMirror 高亮编辑器

离线构建说明：
1. 该项目的离线包必须在 Linux 构建机生成。
2. 先准备好 Linux Node 运行时目录，并确保其中存在 bin/node。
3. 构建前请确认以下文件已存在：
   - scripts/build-offline-tar.sh
   - scripts/install.sh
   - scripts/start.sh
   - scripts/stop.sh
   - scripts/status.sh
   - scripts/uninstall.sh
   - systemd/webssh.service.template
   - config/.env.example
4. 在 Linux 构建机执行：
   NODE_RUNTIME_DIR=/opt/node-v12.22.12-linux-x64 ./scripts/build-offline-tar.sh
5. 构建完成后会在 dist 目录生成 tar.gz 离线包；若系统支持 sha256sum，还会额外生成 .sha256 校验文件。

离线安装说明：
1. 把 dist 目录中的 tar.gz 上传到目标 Linux 机器。
2. 在目标机器解压：
   tar -xzf webssh-offline-linux-x64-v1.0.0.tar.gz
3. 进入解压目录后执行安装：
   sudo ./scripts/install.sh --install-dir /opt/webssh --service-name webssh --port 3010
4. 安装脚本会：
   - 复制 app、runtime、scripts、systemd 到安装目录
   - 初始化 config/.env
   - 生成 systemd 服务
   - 启动服务
5. 常用管理命令：
   - 启动：/opt/webssh/scripts/start.sh
   - 停止：/opt/webssh/scripts/stop.sh
   - 状态：/opt/webssh/scripts/status.sh
   - 卸载：sudo /opt/webssh/scripts/uninstall.sh
6. 安装完成后默认访问：
   http://目标机器IP:3010

文件管理当前支持：
- 切换到“文件管理”面板
- 初始化 SFTP 通道
- 加载目录列表
- 点击目录进入子目录
- 点击“上一级”返回父目录
- 点击“刷新”重新拉取当前目录
- 选择本地文件上传到当前目录
- 拖拽文件到文件列表区域上传
- 选择远端文件并下载到本地
- 删除普通文件
- 重命名文件或目录
- 新建文件
- 新建文件夹
- 在线编辑文本文件并保存

在线编辑当前支持的文本类型：
- .txt
- .log
- .md
- .json
- .js
- .ts
- .html
- .css
- .xml
- .yml
- .yaml
- .sh
- .env
- .ini
- .conf
- .py

当前暂不支持：
- 删除目录
- 编辑二进制文件
- 超过 1MB 的文本文件在线编辑
- 拖拽上传目录
- 大文件分片上传与进度条

验证步骤：
1. 启动服务后打开页面
2. 通过“新建连接”填写 SSH 信息
3. 连接成功后，右侧切换到“文件管理”
4. 确认目录列表可以加载
5. 点击“新建文件夹”并创建目录
6. 点击“新建文件”并创建文件
7. 点击“上传”选择多个本地文件，确认目录刷新后可看到新文件
8. 将本地文件拖到文件列表区域，确认拖拽上传正常
9. 点击一个文件，再点“下载”，确认浏览器开始下载
10. 选中一个普通文件，点击“删除”并确认，确认列表刷新后文件消失
11. 选中文件或目录，点击“重命名”，输入新名称，确认列表刷新后名称更新
12. 选中一个文本文件，点击“编辑”，确认出现本地高亮编辑器，修改内容并保存，再次打开确认内容已更新
13. 切换主机后确认连接信息、目录、文件列表和编辑器状态都会变化
