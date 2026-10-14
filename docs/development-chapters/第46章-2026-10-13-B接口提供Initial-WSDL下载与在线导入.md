# 第46章 - B接口提供Initial-WSDL下载与在线导入

日期：2026-10-13
状态：功能记录

## 功能目标

B接口接入配置提供SU和SC WSDL下载，SU服务支持按白名单在线导入

## 开发范围

- `SU与SC文件下载`
- `SU在线WSDL`
- `SoapUI导入说明`

## 关联文件

- `proto-conv/b-interface-wsdl.js`
- `proto-conv/b-interface-routes.js`
- `proto-conv/b-interface-forwarder.js`
- `proto-conv/assets/js/pc-b-interface.js`
- `proto-conv/assets/css/pc-b-interface.css`
- `tests/b-interface-wsdl.test.js`
- `tests/b-interface-server.test.js`
- `docs/b-interface-forwarding.md`

## 验证记录

- TDD：新增下载测试先出现真实的 404/200 断言失败；实现路由、生成器及在线服务后通过。
- `npm run test:b-interface`：9 个测试脚本通过；包含实际主服务登录后的管理员/只读下载和未登录 401。
- Node12.22.12 执行新增 WSDL 测试通过；前端 JS 语法检查通过。
- Playwright 实际下载 SUService.wsdl 和 SCService.wsdl，验证文件名、已保存 URL、草稿隔离、停用提示、只读账户下载和 390px 手机布局。两份下载文件的 XML 解析、内嵌 XSD 编译均通过。
- `node tests/arm64-fullstack-package.test.js` 通过。共用源码进入现有 x86/ARM 的 proto-conv 打包路径；未重新生成任何架构全栈离线包，也未部署 ARM 实机。
- 自审覆盖绑定与现有 SOAP 包装一致、配置 XML 转义、Host 不参与服务地址生成、账号及设备信息不进入 WSDL、管理接口会话认证、SU socket IP 白名单、下载不计入心跳/业务查询日志和不访问上级服务。

## 实现摘要

- 新增纯 JS WSDL 生成器，复用 XML 转义，不增加依赖。内嵌字符串参数 XSD，支持当前保存的 SOAP 1.1/1.2、命名空间、方法、参数、结果及 SOAPAction。
- 主壳两个下载 GET 接口沿用本地登录和角色规则，停用时也可下载；文件名固定为 SUService.wsdl/SCService.wsdl。缺少地址时返回可读错误。
- SU 服务在现有路径提供 `?wsdl`（大小写兼容）GET/HEAD，使用配置中的 SU 地址，不信任请求 Host；保留现有 IP 白名单及安全响应头。
- 新增接入配置区下载按钮和只读在线地址，只使用已保存配置；本地文件下载无需启用，在线地址需 SU 已监听。

## 部署记录

- 已按持续授权在 2026-10-13 11:19 更新 192.168.50.61（x86_64）；显式设置目标 host，备份保留数设置为 100000，原有 9 个备份均保留。
- 回滚目录：`/opt/webssh/app.bak-20261013031926`；上传 SHA256 校验通过。
- 5 个应用变更文件的本地/远端 SHA256 一致；业务配置对象与部署前备份一致。
- 本机实际访问 `http://192.168.50.61:8079/services/SUService?wsdl`，GET 和 HEAD 均为 200；原有 POST GET_AIDATA 返回 GET_AIDATA_ACK 和有效 Value。
- 未登录访问主壳下载接口仍为 401；health.ok=true；webssh 与 webssh-protocol 均 active。证据：`output/deploy-20261013/b-interface-wsdl-50.61.json`。

## 后续注意事项

- WSDL 为匹配本软件当前绑定的联调文件，正式平台应核对其实际 WSDL；修改配置后重新下载/更新 SoapUI Definition。
- 在线地址保持上级白名单限制；停用状态使用登录后的文件下载。WSDL 导入不会维持 SC 心跳。
- 本次没有变更依赖。原有依赖审计报告有 2 个 critical、1 个 high、2 个 moderate，涉及 mysql2/proxy-addr/ws/body-parser/qs，记录于 output/b-interface-wsdl-audit.json；不声称整个仓库依赖审计通过。新增 WSDL 路径不使用数据库、代理信任头或 WebSocket。本次未进行影响 Node12 兼容性的依赖升级。
- 后续扩展本功能时，新增下一章记录具体变更，不回写本章的已交付结论。
