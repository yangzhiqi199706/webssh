# B接口告警批量映射：DCIM 数据库只读调查

日期：2026-10-13（北京时间）。目标：192.168.50.61 的 dcim 容器及其 DCIM API。

本次使用容器内 mysql 客户端执行 SHOW/SELECT，凭据从容器既有数据库配置在内存读取；没有修改数据库、告警状态或 B 接口配置，也没有部署新功能。

## 数据库结果

`dcim-alarmnotifymode` 保存设备告警配置，含 id、DevId、AlarmType、AlarmKey、AlarmName、AlarmUpLimit、AlarmDownLimit、AlarmValue、AlarmLevel、status 等字段。status=1 表示未删除，不能直接据此断言所有规则的触发条件有效。

- 未删除定义：12,993 条，涉及 472 个 DevId。
- 同设备同 AlarmName 的重复组合：17 组，不能仅按设备和名称合并所有定义。
- 类型分布：AlarmType=0 为 12,469 条，1 为 53 条，5 为 471 条。实际触发事件类型需要结合源系统生成逻辑确认，不能直接把规则类型与事件类型视为完全相同。
- 目前 `dcim-alarmlist` 的 428 条事件 NotifyModeID 都为 0。现有事件不能直接通过这个字段关联配置表规则 id；保留规则 id 适合作为导入审计信息，但当前不能据此实现事件匹配。
- `dcim_protocol_alarmmode` 为协议告警模板，`dcim-alarmnotifymode` 才是本机已有设备定义的首选导入来源。

当前 B 接口已保存的五个设备具有以下未删除定义：

| DCIM设备ID | 设备 | 定义数 |
| --- | --- | ---: |
| 3 | 1办3号楼1号温湿度 | 3 |
| 4 | 1办3号楼2号温湿度 | 3 |
| 5 | 1办3号楼3号温湿度 | 3 |
| 17 | 1办3号楼UPS | 84 |
| 31 | 1办1号楼外网机房7053开关模块 | 17 |
| 合计 | 已配置五个设备 | 110 |

## 接口结果与匹配差异

实测实时和历史接口均返回 428 条当前可见记录，不能用这些记录代替完整定义库。

- GetRealAlarmsKey 有 eventId、eventName、deviceName、hisLsh、updatedate、TextMessage 等字段；样例 eventName 为“断线设备连接异常”。TextMessage 还包含区域、设备、等级和时间，是动态描述。
- GetHistoryAlarmsKey 有 AlarmId、DeviceId、DeviceName、AlarmName、AlarmValue、DateOnRes 等字段；同一事件的 AlarmName 也是“断线设备连接异常”。
- 配置表对应断线定义的 AlarmName 为“断线”，因此配置表名称和 API 事件名称需要按源系统语义对照，不能原样复制全部规则名称并期待现有精确匹配成功。
- 现有 B 源名称优先顺序在实时 API 下会先取 TextMessage，之后才取 eventName。批量导入实现应一并调整稳定事件名的提取，保留动态描述作为 AlarmDesc；不能把动态 TextMessage 当作通用映射名称。

## 推荐实现

1. 按已选设备从数据库读取完整告警定义，展示数量及预览；不依赖告警是否发生过。
2. 导入只追加新映射，保留已有名称、编码和勾选；重复或无法确定事件名称的规则列入待核对，不自动套用到不确定告警。
3. 在明确源事件命名规则后生成可精确匹配的事件名，使用 API 稳定 eventName/AlarmName；规则 id、AlarmKey、类型等作为核对依据。当前 NotifyModeID=0 的事件不能使用规则 ID 直接关联。
4. 空 ID 可生成不冲突的测试编号，正式联通编码使用标准对照表批量导入；数据库 SNMP AlarmID 等字段不是联通十二位监控信息 ID。
5. 默认作用于已选设备；当前 B 接口总测点限制为 10,000，全库定义已超过此值，全量接入需另行设计容量和分批查询，不能静默截断。

## 证据

- `output/soapui-b-interface/alarm-db-schema.txt`：表结构、只读统计及关联查询结果，不含数据库口令。
- `output/soapui-b-interface/alarm-api-inspection.txt`：实际接口字段和少量记录样例。
- `tmp/b-interface/inspect-alarm-schema.js`、`inspect-alarm-api.js`：本次只读诊断脚本。

这份记录为方案调查，不代表批量导入功能已经开发或上线。
