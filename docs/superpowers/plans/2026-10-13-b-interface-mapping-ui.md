# B接口设备和测点界面优化实施计划

> **For agentic workers:** Use executing-plans to implement inline in the current session; no subagents required.

**Goal:** 把长设备卡片页面重整为可搜索目录和单设备编辑区，集中批量操作与保存入口，保持数据契约和草稿行为。

**Architecture:** 原生JS继续持有全部devices草稿；目录每页10设备、编辑区25测点，过滤只控制显示。纯函数PcBMappingView负责设备/测点筛选和统计，pc-b-interface保持原事件/API/保存路径。顶部统计、折叠导入与告警工具，桌面双栏/手机单栏，底部固定保存与导出。

**Tech Stack:** Node12、原生HTML/JS/CSS、Playwright，无新增依赖。

- [x] 先写纯函数筛选/统计测试并确认失败：按名称/ID/分组检索；AI/DI/ALARM、名称/ID组合筛选；输入不变、筛选不影响统计。
- [x] 实现PcBMappingView并在入口加载，Node12专项验证。
- [x] 重排静态区域、设备目录与单设备编辑；保持已有DOM ID/API/函数名及数据结构。
- [x] 添加搜索/类型过滤、草稿状态与统计；编辑仅更新草稿/统计，不重建输入；全选始终全设备或当前设备全测点。
- [x] 桌面/手机CSS、键盘和只读权限验证。目录按钮有当前状态和完整设备名；空列表和无结果有明确提示；编号覆盖提示可见。目录勾选重建造成焦点丢失先失败后修正通过。
- [x] 浏览器验证500设备分页性能、跨设备草稿、类型过滤跨页全选、测试编号、CSV和告警导入；16个B测试、ARM包契约、Node12检查。
- [x] 新增第57章、部署192.168.50.61，校验静态代码/保存配置不变/双服务，记录双架构限制。最终备份app.bak-20261013101158，6文件hash一致、4静态资源200、双服务active、health200、原B配置不变。

实现文件：proto-conv/assets/js/pc-b-mapping-view.js（纯过滤与统计），pc-b-interface.js（布局和交互），pc-b-interface.css（样式），proto-conv/index.html（脚本加载），tests/b-interface-mapping-view.test.js及浏览器QA。保留所有非本任务修改，不提交或合并Git，不写DCIM数据库，不自动保存生产映射。

验证命令：node tests/b-interface-mapping-view.test.js；npm run test:b-interface；node tests/arm64-fullstack-package.test.js；Node12 --check；本地fixture+Playwright run-code。预期无失败、最多25编辑行、500设备目录仅10项，搜索后保存/导出仍包含全部所选。
