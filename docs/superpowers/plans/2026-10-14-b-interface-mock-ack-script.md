# B接口动态ACK脚本生成与复制

**目标：** 把已验证的SoapUI动态ACK脚本集成到接入配置，可按已保存SOAP绑定生成，复制脚本与响应正文。

**实现：** 新增纯生成器proto-conv/b-interface-mock-ack.js，仅读取soap的版本/命名空间/方法/请求参数/响应字段；使用单引号Groovy常量转义和XML转义。GET mock-ack-script沿用登录检查，viewer可用；前端独立工具卡、两种复制入口、展开自动生成与失败/手动复制反馈。不执行脚本、不连接SC或修改注册/队列。

- [x] 先写缺模块失败测试：不泄漏账号、生成四种匹配ACK、SOAP1.2和自定义绑定、注入字符转义与非法配置拒绝。
- [x] 实现generate(config)，返回script/responseBody；生成的Groovy根据每条请求SUId和Name/Code返回对应业务ACK，非法输入给Fault。
- [x] 加GET /api/proto-conv/b-interface/mock-ack-script，401/viewer/无副作用路由及实际主壳测试。
- [x] SoapUI区域加入复制脚本/响应正文与只读预览，使用已保存配置，保存后清模板；复用HTTP剪贴板降级方式，保留已有LOGIN模板。
- [x] 用SoapUI5.10.0实际Groovy运行库验证四种ACK和1.1/1.2/自定义绑定及引号、反斜线、插值字面量；用软件协议模块验证样例ACK。
- [x] 浏览器验证生成、复制、正文与Script位置提示、草稿隔离、错误/降级/viewer/手机；17项B专项、Node12、ARM契约、依赖审计。
- [x] 生成第61章并补使用说明（第60章已有其他功能记录），部署192.168.50.61，hash/配置/服务/新接口认证核验。

命令：node tests/b-interface-mock-ack.test.js；npm run test:b-interface；Node12 --check；java -cp SoapUI5.10.0/lib和bin groovy.ui.GroovyMain验证脚本；Playwright本地fixture。不修改SoapUI正在运行的服务，不发送测试告警，不提交/合并Git。两架构共用源码进入各自打包目录，ARM实机与离线包未验证/未更新时真实记录。
