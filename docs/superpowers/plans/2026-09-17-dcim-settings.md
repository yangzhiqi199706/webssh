# DCIM 设置实施计划

## 范围

目标为新增主菜单“DCIM设置”，SSH 管理目标主机的 /dcim/python/src/collection/config。默认目标 192.168.50.61，连接凭据通过管理员配置，不写进源码。共用代码兼容 x86 Node12 / ARM Node16。

已确认：11 个 JSON 文件；feature_flags、services、http_services、crontab_tasks、logging、runtime_env、sms_gateways 含布尔与普通参数；i18n 为文本。architecture_boundaries、legacy_module_map、service_launchers 属程序结构映射，只读展示。用户确认同时编辑普通参数。

## 实现步骤

- [x] 先测后实现 Python 配置读写器：固定文件白名单、敏感值不返回、保持类型、字段校验、文件版本冲突检查、进程锁、备份和原子替换。测试使用临时目录，不改生产配置。
- [x] Node 独立模块注册 API，复用 SSH runner，管理员校验、同源写入、超时、连接设置密码不回显；独立重启操作需确认。
- [x] 原生 HTML/JS 子页面，配置文件导航、分组字段、搜索、开关、数字与文本编辑、保存/放弃、连接弹窗、服务重启确认与状态。
- [x] 主壳菜单/iframe 集成；x86 和 ARM 打包器纳入新目录。
- [x] 测试、浏览器桌面/移动端核查、只读现场读取验证、记录功能章节与双架构交付状态。

## 生效机制与边界

DCIM 容器挂载 /dcim/python 到 /www/python，dcim.service 执行 /www/python/src/collection/main.py。runner 在启动时加载 services 配置；不能承诺所有配置热更新。保存只写文件并返回待应用提示，重启按钮单独执行 docker exec dcim systemctl restart dcim，再查询运行状态。开发验证不修改生产配置、不重启 DCIM、不发送消息。

## 文件

lib/dcim-settings.js：API 和 SSH 编排；lib/dcim-settings-worker.py：远端 JSON 文件事务；dcim-settings/：子站 HTML/CSS/JS；tests/dcim-settings*：回归；index.html/server.js：集成；scripts/deploy-upgrade.js、scripts/build-fullstack-arm64.js：交付目录。
