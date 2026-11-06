# C3a 微信支付凭据与HTTPS请求层（2026-11-06）

本轮任务边界：在C1协议核心、C2付款人绑定之上，实现可供后续订单接入的私有凭据加载、显式轮换、固定地址HTTPS传输与离线检查。验收重点为凭据隔离、轮换一致性、原文验签和未知结果处理。C3整体尚未完成，不接通运行中的订单，不开启真实资金链路。

## 实际交付

- 新增wechat-credentials内部组件：私有目录/普通文件/所有权/权限检查，拒绝符号与硬链接、FIFO、越目录、超限文件及读取期间变化；严格清单和单一PEM校验；商户证书有效期、CN商户号、私钥匹配及RSA2048/65537检查；独立绑定AppID、商户号和通知地址。
- 公钥模式使用明确配置的微信支付公钥ID与本地信任窗口，不下载或自动信任未知公钥。允许1至4把用于交叠轮换。商户证书与所用公钥在收到应答时仍需有效。
- 显式reload完整校验后原子切换，进程内拒绝较低修订号和同修订号内容替换；失败阻断新调用直到成功重载。在途请求保留原凭据快照，避免用新私钥为旧上下文签名。跨进程/重启防回退及真实密钥灾备仍未实现或验收。
- 新增固定JSAPI HTTPS请求层：POST、TLS1.2以上、证书/主机名验证、默认5秒总时限（含DNS/TLS与完整应答）、64KiB包体和16KiB头部上限；拒绝重定向、压缩、重复微信签名头、超限及截断。保留准确原文交给C1验签，成功只返回内部调起参数和凭据修订号。
- 不自动重试。前置拒绝为NOT_DISPATCHED，交给传输后的所有失败均为RESULT_UNKNOWN，包括HTTP错误、超时、断连、错误/未知签名及无效响应；不返回原始异常/正文，不标记付款失败、成功或关单，不释放库存。
- 新增显式check:wechat-pay-credentials离线命令。可选WECHAT_PAY_CREDENTIALS_DIR不由API启动加载；命令输出不包含身份、路径或密钥，canStartPayment/networkChecked始终false。本机未配目录，实际执行返回CREDENTIALS_NOT_CONFIGURED和退出码1，符合预期；未更改实际.env或任何真实凭据。
- 后台“支付接入检查”新增“凭据加载与HTTPS传输”，总计14项，仍UNVERIFIED；真实商户材料、保管/恢复与外部联通保留待验收。OpenAPI0.72.0已导出，无新的公开支付、密钥上传/重载或参数接口。

## 实际检查

43项测试通过，分别为：

- 7项凭据/命令检查：有效绑定、权限/链接/FIFO/路径约束、私钥证书不符、弱公钥/异常PEM/超限、严格清单与身份匹配、有效期/信任窗口、轮换失败阻断和恢复、离线命令脱敏。
- 8项请求层检查（包含真实本机TLS）：精确UTF-8和Content-Length、独立RSA验证请求与调起签名、重定向和HTTP错误不跟随/重试、重复签名头/压缩/超限/空包、无头及滴流总时限、截断/断连、TLS不受信、固定地址拒绝、篡改/未知/到期公钥、在途商户与公钥轮换、前置不发请求。
- 9项C1协议回归。
- 19项配置/真实PostgreSQL回归：5项支付配置，5项只读后台检查权限与业务数据保护，4项微信登录和5项付款人绑定。PG均使用自动清理的隔离schema，未写主库业务数据。

测试全部使用临时生成的合成证书/私钥/公钥与合成身份，TLS仅连接127.0.0.1。生产请求选项保持固定微信主机，测试依赖显式将连接引至本机并指定测试CA；应用没有替换地址、代理、CA或关闭TLS的配置入口。未调用真实微信、商户或任何资金服务。

后台实际React与隔离API/PG完成8张截图，覆盖桌面/手机、付款人加密已配置、经营暂停/未配置、加载、错误重试及无授权仓库；受限角色无入口。查看桌面和手机全页，无横向溢出。已配置加密状态采用隔离服务的脱敏配置检查输入，不伪造真实联通或支付成功；错误/空仓库边界按脚本标记使用受控响应。

[桌面截图](UI-PAYMENT-READINESS-C3A-DESKTOP-2026-11-06.png)、[手机截图](UI-PAYMENT-READINESS-C3A-MOBILE-2026-11-06.png)、[加密配置状态](UI-PAYMENT-READINESS-C3A-PAYER-CONFIGURED-2026-11-06.png)。其他截图同目录以UI-PAYMENT-READINESS-C3A为前缀，保留前轮C2截图。

API及依赖构建、后台/H5构建、全项目和根测试类型检查、相关ESLint/Prettier及git diff --check通过。小程序源码及产物未改，本轮没有进行微信工具或真机检查。本机API核实目录/命令/日志归属后重启，live/ready均200，实际OpenAPI0.72.0。无新迁移，仍62项，未改变订单、商品、库存或积分。

复现（先构建API及依赖）：

```bash
node --env-file=.env --import tsx --test --test-concurrency=1 tests/wechat-credentials.test.ts tests/wechat-jsapi-transport.test.ts tests/wechat-jsapi.test.ts
node --env-file=.env --import tsx --test --test-concurrency=1 tests/payment-readiness.integration.test.ts tests/wechat-payer.integration.test.ts tests/wechat-login.integration.test.ts tests/payment-config.test.ts
```

本地日志：.local/c3a-protocol-tests.log、c3a-pg-regression.log、c3a-ui.log、c3a-build.log、c3a-web-build.log、c3a-typecheck.log、c3a-lint.log、c3a-format-check.log、c3a-local-credential-check.log。这些本地文件不提交。

## 后续和限制

现有现金订单取消/库存释放逻辑基于尚未发起真实支付。下一项C3b须先建立持久化尝试、原订单结果恢复和取消保护，再连接外部请求；不得直接调用本组件来绕过这些条件。请求成功也只是预支付，后续须在存储已验证结果后才给前端参数；超时/崩溃继续按原尝试核实，不能换订单号绕过未知。

真实商户归属和证书签发链、真实AppID权限、APIv3密钥、查单/关单/入账、退款、HTTPS外部可达性、微信工具/真机及生产验收尚未完成。PAYMENT_MODE保持disabled，小程序账号和服务器尚未准备；本轮不代表可以现金支付或商城整体上线。

官方协议来源及本地约束区分见[凭据运维手册](../operations/WECHAT-PAY-CREDENTIALS.md)，C3拆分见[现金支付路线](../product/CASH-PAYMENT-INTEGRATION-V1.md)。
