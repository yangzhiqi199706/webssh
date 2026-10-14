# 第44章 - B接口复用Modbus模拟量状态量识别AIDI

日期：2026-10-13
状态：功能记录

## 功能目标

新导入测点按DCIM和Modbus分类识别AI/DI，提供保留编码的已有类型批量更新

## 开发范围

- `模拟量AI`
- `开关状态量DI`
- `已有条目分类修正`
- `手动类型保留`
- `未知类型保护`

## 关联文件

- `proto-conv/assets/js/pc-point-types.js`
- `proto-conv/assets/js/pc-b-interface.js`
- `proto-conv/b-interface-source.js`
- `proto-conv/index.html`
- `tests/b-interface-point-types.test.js`
- `tests/helpers/b-interface-classification-browser-qa.js`

## 验证记录

- `B接口八组测试通过`
- `浏览器分类回归通过`
- `Node12分类与语法检查通过`
- `ARM包契约通过`

## 后续注意事项

- 后续扩展本功能时，新增下一章记录具体变更，不回写本章的已交付结论。

## 实现摘要与验证结果

- Modbus 当前分类汇总为 6223 个模拟量、3864 个开关量。只读取类型数量，没有读取或记录凭据。
- 新增 pc-point-types.js 共用纯 JS 判定：模拟量/遥测/AI 对应 AI，开关量/状态量/遥信/DI 对应 DI。未知类型返回 null，不根据名称、当前值或 int/float 推断。
- DCIM 单设备读取和新 Modbus 导入共用此规则。普通重复导入保留已有手动调整，避免重读覆盖用户选择。
- 新增「按 Modbus 更新 AI/DI」按设备 ID+参数名匹配完整草稿，处理所有分页，保留联通编码、勾选与 ALARM 映射；未知/冲突类型保持原选择，核对后由用户保存。
- 八组 B 接口测试、真实浏览器分类回归通过；验证新导入默认分类、已有 AI 修正、隐藏页、手动覆盖保留、ALARM/编码/勾选保护及只读权限。
- Node12 分类单测和前端语法检查、ARM64 包契约通过。前后端共用此源码，无新增架构依赖；未重打两架构离线包、未更新其他 ARM 机器，不宣称 ARM 实机部署验证完成。
- 用户使用 Ctrl+F5 刷新后，新导入自动分类；现有条目需点击分类按钮并核对保存。本次不自动改写运行时 B 接口配置，也不自动生成联通监控信息 ID。

## 192.168.50.61 部署验证

- 2026-10-13 10:17（北京时间）主壳增量更新完成，备份 `/opt/webssh/app.bak-20261013021659`，全部八个备份保留；最终类型列样式在 10:19 通过 SFTP 原子替换静态 CSS。
- 双服务 active，health 正常；新版分类资源外部访问 200，五个关键文件 SHA256 与本地一致。
- 远端 Node12 执行模拟量→AI、开关量→DI 验证通过；B 接口配置与部署前备份字节一致，未自动保存类型或向 SC 发送测试报文。
- 验证证据：output/deploy-20261013/b-interface-types-50.61.json。
