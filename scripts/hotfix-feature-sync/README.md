# WebSSH B 接口累计功能热更新（__ARCH__）

包名：`__RELEASE__`。适用于 2026-10-12/2026-10-14 已部署的 WebSSH 全栈版本，以及已经安装第62章告警配置路径补丁的版本。未对未知定制版本作兼容承诺；安装器逐文件核对原哈希，未知修改会在覆盖前拒绝。

## 更新内容

- 补齐接入配置里的“SoapUI / 告警ACK自动响应”：生成/刷新动态 Groovy 脚本、复制脚本、复制响应正文。支持 LOGIN、LOGOUT、SEND_ALARM、SEND_HISALARM，并按已保存的 SOAP 1.1/1.2 绑定生成。
- 累计包含 B 接口 SU/SC 通道、告警上报/重试、AI/DI 类型识别、测试编码、设备/测点批量操作、CSV 导出、WSDL 下载、查询请求与报文预览、数据库告警定义映射和相关界面改进。
- 包含上一轮 ARM 配置路径回退、BOM 兼容和安全错误分类，无需先安装单文件补丁。
- SAX 1.4.1 随包离线提供，只有纯 JavaScript 文件。保留已有 Node/Python 与所有架构二进制。

本次已检查其他模块业务源码，范围和逐文件差异见 `AUDIT.md`/`audit.json`。这是本地安装包比较，不是生产服务器实时盘点。

## 安装

将包和同名 `.sha256` 上传到宿主机同一目录。使用 root 在宿主机 Bash 执行，不要进入 DCIM 容器：

```bash
sha256sum -c __RELEASE__.tar.gz.sha256
tar -xzf __RELEASE__.tar.gz
cd __RELEASE__
bash install.sh
```

默认程序目录 `/opt/webssh/app`、Node `/opt/webssh/runtime/node/bin/node`、健康检查 `http://127.0.0.1:3010/health`。自定义目录/端口时设置 `WEBSSH_APP_DIR`、`WEBSSH_NODE_BIN`、`WEBSSH_HEALTH_URL`；回滚使用相同参数。

安装器先检查架构、SHA256、JavaScript 语法、原文件版本、运行依赖及现有服务健康。备份后原子替换文件，检查 ACK 生成和模块加载，再重启 `webssh` 并检查 `/health`。会短暂中断终端和转发连接，协议助手可能按 systemd 配置联动重启。无需重启 Docker/DCIM/MySQL。不覆盖 config、连接密码、设备测点映射、告警状态文件、Python 子站、自定义协议规则或数据库。

失败时自动恢复原文件、撤销本次新增文件并尝试恢复服务。程序含未知文件修改时拒绝覆盖，界面输出文件路径便于核查；没有强制覆盖参数。

## 验证功能

1. 浏览器按 **Ctrl+F5** 刷新，打开 **协议转换 → B接口转发 → 接入配置**。
2. 展开 **SoapUI / 告警ACK自动响应**，点击生成/刷新、复制脚本、复制响应正文。根据已保存的 SOAP 配置生成，不需要更改生产接入配置来验证。
3. 将脚本放在 SoapUI SC MockService 的对应 Response 1 底部 Script，响应 XML 正文使用软件提供的 `${bAckEnvelope}`。脚本会按每条请求动态返回对应 ACK；测试 Mock 不鉴权、不保存告警。不要把 Groovy 脚本粘贴到 XML 正文区域。
4. 在“设备和测点”重新批量读取告警定义并核对预览；读取不会自动导入或保存映射。

## 回滚

安装器输出备份编号和回滚命令。原文件及新增文件清单保存在 `/opt/webssh/app/.hotfix-backups/<备份编号>/`：

```bash
bash install.sh --rollback <安装时输出的备份编号>
```

回滚校验原备份及当前全部补丁文件，拒绝覆盖之后的更新。当前服务不健康也允许尝试回滚，不要求先修复新版本的健康检查。保留解压目录和备份。恢复失败时检查 `journalctl -u webssh -n 100 --no-pager`。

## 交付验证限制

交付前执行 B 接口专项、文件事务测试、Bash 隔离安装器测试，并对实际归档校验完整性、两架构补丁一致性及 ACK 模块。Bash 夹具的架构/systemd/curl/运行依赖探测使用替身，不等同于 ARM 实机验证。本轮未连接或部署生产 ARM/x86，安装后的实际接入与数据库读取需现场确认。
