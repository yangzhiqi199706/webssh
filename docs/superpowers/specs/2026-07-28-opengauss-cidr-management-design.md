# openGauss CIDR 管理设计

## 目标

将首次部署和后续白名单维护拆开。完成首次初始化后，管理员可以只修改 openGauss 的允许访问 CIDR，而不重新创建账号、不改密码、不调整内存，也不重启数据库。

默认操作为用一个新的 CIDR 替换 WebSSH 管理的旧 CIDR；需要多网段时，管理员显式选择追加操作。

## 范围

本次只涉及数据库管理页的 openGauss 卡片、对应的 Node 路由，以及容器内 `pg_hba.conf` 的受管规则块。

不修改 MySQL、达梦的配置逻辑；不自动重置 `dcim` 密码；不改动 openGauss 内存参数；不删除非 WebSSH 创建的 HBA 规则。

## 交互设计

openGauss 卡片保留“openGauss 一键启用”，其文案明确为“首次初始化”。新增“访问 CIDR”按钮，打开独立弹窗：

- 显示当前由 WebSSH 管理的 CIDR 列表。
- 输入一个严格校验后的 IPv4 CIDR。
- 默认操作为“替换当前网段”。执行后受管列表仅保留输入的 CIDR。
- 提供“添加网段”操作。执行后保留已有受管 CIDR 并追加输入值。
- 每个受管 CIDR 可单独删除；删除最后一个规则需二次确认。
- 操作结果展示备份路径、最终受管规则、重载结果和 SQL 健康检查结果。

“一键启用”成功后可直接显示当前受管列表；服务未运行时，CIDR 操作按钮禁用并说明需要先启动服务。

## 后端接口

新增三个只管理 HBA 白名单的接口：

- `GET /api/db-manager/opengauss/access-rules`：读取并返回受管 CIDR、全局规则告警和服务状态。
- `PUT /api/db-manager/opengauss/access-rules`：请求体为 `{ mode: "replace" | "append", cidr }`。替换或追加受管 CIDR。
- `DELETE /api/db-manager/opengauss/access-rules/:cidr`：删除一个受管 CIDR。

所有 CIDR 使用严格 IPv4 与前缀长度校验，要求主机位全为零；例如接受 `192.168.50.0/24`，拒绝 `192.168.50.12/24`。接口拒绝空值、IPv6 和非 0-32 的掩码，不接受用户名、密码、内存或服务动作参数。

## HBA 规则所有权

WebSSH 在 `pg_hba.conf` 末尾维护唯一的标记块：

```conf
# webssh:dcim-cidr-begin
host    dcim    dcim    192.168.50.0/24    sha256
# webssh:dcim-cidr-end
```

只重写该标记块，保留文件其他内容和管理员手工规则。首次 CIDR 操作会迁移旧的 `host dcim dcim <CIDR> sha256` 行进入标记块，避免重复匹配。

如果发现 `host all all 0.0.0.0/0 sha256` 等非受管的全网段规则，接口返回 `globalAllowWarning`。界面显示安全告警：该规则仍允许其他网段，受管 CIDR 不能构成严格访问限制。系统不自动删除该规则，以免中断未知业务；收紧为仅受管 CIDR 是后续需单独确认的运维动作。

## 执行与回滚

写入前执行以下安全步骤：

1. 确认 openGauss 服务已运行，定位 `pg_hba.conf` 与数据目录。
2. 创建时间戳备份，使用临时文件原子替换 HBA 文件。
3. 以 `omm` 用户执行 `gs_ctl reload -D <dataDir>`，不调用 systemd restart。
4. 使用容器内 Unix socket 执行 `gsql -d postgres -At -c 'SELECT 1;'`。
5. 任一步失败时恢复备份，再次 reload，并返回原始错误与回滚结果。

不会在 CIDR 操作中调用“一键启用”、`systemctl start/restart`、`gs_guc` 或 `ALTER USER`。

## 错误处理

- 服务未运行：返回明确错误，不写文件。
- HBA 标记块损坏或出现多个块：拒绝写入，要求管理员先修复，避免覆盖未知规则。
- reload 或 SQL 探测失败：自动恢复备份并返回失败。
- 重复追加 CIDR：视为幂等成功，返回当前规则，不写重复行。
- 删除不存在 CIDR：返回 404，不改变文件。

## 测试与验收

新增后端单元测试覆盖：严格 CIDR 校验、标记块解析、替换、追加、删除、重复追加、全局规则告警和回滚命令顺序。新增前端静态/行为测试覆盖按钮、默认替换模式、二次确认和结果回显。

在 192.168.50.197 上验收：先记录当前 HBA，使用“替换”将受管 CIDR 改为 `192.168.50.0/24`，确认 openGauss 仍为 `active`、5432 未断开、`SELECT 1` 成功；随后“添加”一个测试网段并确认两条受管规则共存。整个 CIDR 操作期间不应出现数据库重启。
