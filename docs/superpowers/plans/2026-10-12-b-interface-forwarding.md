# 联通 B 接口转发开发方案

用户已确认：DCIM 数据和告警转换为上级 B 接口平台可接入的 SU。

依据：用户提供 QB/CU 132-2024 V3.0；GitHub htgd/wh_fsu 的 SOAP 双向结构仅用于研究，不复制其 GPL 代码。PDF 未嵌入 SCService/SUService WSDL，默认 invoke/xmlData/invokeReturn、命名空间可调整，必须现场核对。

## 架构与范围

新增 proto-conv/b-interface-* 独立模块，server.js 仅负责注册。Node12/ARM Node16 共用纯 JS；sax 严格解析 XML，不使用本机原生依赖。独立 HTTP SOAP 端口默认 8080，上级 IP 白名单；管理接口复用本地账号和同源保护。默认停用。

实现 LOGIN/LOGOUT、SCIP 分配、GET_AIDATA/GET_DIDATA/GET_ALARM/GET_SUINFO、SEND_ALARM 与断线历史补报。AI 有值属性，DI 末两位携带状态，缺失数据空值/FF。设备五位 ID、测点十二位 ID 必须人工按联通编码表映射，禁止自动编造。告警必须精确映射到设备和告警内容，恢复只认历史恢复记录。

保存配置、告警序号及待确认队列到权限 0600 的原子文件；仅业务 ACK 成功后出队，恢复复用开始序号，队列满时显示错误。心跳三个周期超时重新注册、三注册地址轮询。FTP、升级、遥控、遥调、时间设置和控制逻辑返回明确失败，界面及说明注明本次为数据/告警转发子集，不宣称完整规范认证。

## 实施及验证

1. 先写协议测试：SOAP 字符串、转义/CDATA、安全边界、LOGIN/遥信编码/ACK，再实现 b-interface-protocol.js。
2. 先写本地模拟 DCIM/SC 集成测试：业务失败不出队、重启重试、BEGIN/END同序号、白名单、回查、权限，再实现 source/manager/routes。
3. 增加原生 JS 配置弹窗：接入配置、设备和测点编辑、复用 Modbus 已选设备、分组读取 DCIM 测点、采集预览、启停与日志。保留现有 DOM 和功能。
4. 运行新测试、现有协议转换/微信/部署回归与 npm test；浏览器模拟验证界面及移动布局；检查 Node12兼容、双架构目录包含规则。实际机器未授权部署，产物和机器验证状态如实记载。
5. 按 AGENTS.md 创建新的开发章节并填写结果，提供联调指南。
