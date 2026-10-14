# B 接口告警定义读取热更新

此包适用于已经安装 B 接口功能的 WebSSH。架构：__ARCH__；包名：__RELEASE__。

## 修复内容

仅替换 `/opt/webssh/app/proto-conv/b-interface-alarm-db.js`。数据库配置按顺序读取：

1. `/www/dbconfig.json`（保持已有 x86 行为）；
2. `/www/python/src/collection/dbconfig.json`（本次 ARM 现场已验证可用）；
3. `/www/wwwroot/localhost_8086/wwwroot/dbconfig.json`。

只有文件不存在才尝试下一个位置；配置损坏、权限不足、非 MySQL 或不符合本机查询要求时停止并明确提示，避免误读另一数据源。兼容 UTF-8 BOM。Docker 和常见 MySQL 错误返回具体分类，不暴露密码或原始 SQL/数据。

## 安装

将 `.tar.gz` 和同名 `.tar.gz.sha256` 上传到目标 ARM/x86 宿主机的同一目录。在宿主机 Bash 中执行，不能在 DCIM 容器内执行：

```bash
sha256sum -c __RELEASE__.tar.gz.sha256
tar -xzf __RELEASE__.tar.gz
cd __RELEASE__
bash install.sh
```

默认安装位置 `/opt/webssh/app`，Node `/opt/webssh/runtime/node/bin/node`，健康检查 `http://127.0.0.1:3010/health`。自定义安装时，可显式设置 `WEBSSH_APP_DIR`、`WEBSSH_NODE_BIN`、`WEBSSH_HEALTH_URL`。使用自定义参数后，回滚也必须设置相同参数。

安装器先验证架构、内部校验和、原有服务健康、模块依赖及新文件语法，然后备份并原子替换文件。它会重启 `webssh`，终端/转发连接可能短暂中断；根据 systemd 的联动配置，协议助手可能一起重启。无需重启 Docker、DCIM 容器或 MySQL。安装器不覆盖连接配置、设备/测点映射、数据库、Node/Python 运行时或其他源码。

## 验证和回滚

安装器验证服务状态和 `/health`；失败则自动恢复原文件并尝试恢复服务。健康检查通过并不代表数据库读取已在现场验证。安装完成后，在 B 接口界面重新点击“批量读取告警定义”，核对实际所选设备的预览结果；读取阶段不会自动保存或导入映射。

原文件位于 `/opt/webssh/app/.hotfix-backups/<备份编号>/original.js`。安装器会输出真实备份编号和回滚命令：

```bash
bash install.sh --rollback <安装时输出的备份编号>
```

回滚前校验备份及当前程序，程序如已发生后续更新会拒绝覆盖。保留解压后的更新包以便回滚。安装或自动恢复失败时查看 `journalctl -u webssh -n 100 --no-pager`。

## 验证范围

两种架构的包采用相同 JavaScript 补丁，不包含二进制或新增依赖。交付前完成 B 接口回归，以及本地 Bash 隔离夹具下的安装、手动回滚、重启/健康检查失败自动恢复、错误架构/校验和/语法拒绝测试。夹具中的架构、systemd、健康检查使用替身，这些测试不代表 ARM 实机安装验证。尚未将本补丁部署到生产 ARM/x86 主机，现场最终验证由安装后的实际读取结果确认。
