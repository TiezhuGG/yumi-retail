# E4e 独立正式积分快递门禁 · 2026-11-03

分支：积分商城。本轮完成独立门禁、受控账号限制、订单执行模式与配套界面、只读配置检查/模板。仅本地合成验证，没有部署或开放生产，E4整体未完成。

## 实现与兼容


新增POINTS_EXPRESS_MODE=off/controlled/production，默认off，POINTS_EXPRESS_SUBMIT_ENABLED和POINTS_EXPRESS_OPERATIONS_ENABLED均默认0。controlled仅允许1至50个指定本系统微信账号，production仅NODE_ENV=production且不得保留受控名单；两种正式模式只支持当前AppID的WECHAT账号和EXPRESS订单。开发开关保持原生产/远程拒启，并只处理开发身份的新交易；正式模式启动拒绝开发身份/交易/作业、现金开发下单、拣货/支付演练及原开发Worker混用。微信凭据、经营仓库、加密密钥和声明的HTTPS API origin须配置，正式部署不得连接yumi_dev/yumi_test或自定义schema URL；test仅允许本机yumi_test随机schema，不等于真实TLS受控环境。

新报价/提交独立受submit开关与当前账号资格控制，快递出库/运单更正/消费者反馈/后台回复结束受operations开关与本单原执行模式控制。暂停新提交不阻断已受理单查询、原规则取消/全额退分释放预占配额、既有成功原键核实；名单移除只影响新提交，不追溯取消已受理单的作业资格。关闭作业阻断新动作但成功原键可核实。开关按进程配置生效，环境替换前等待在途事务并核实结果，不承诺撤销已受理事务。真实会话/归属/本仓/当前人员/版本/库存等原校验保持，前端隐藏按钮不替代服务端门禁。

报价快照与订单executionMode由服务端写入DEVELOPMENT/CONTROLLED/PRODUCTION，客户端不能指定。迁移202611030012_points_express_execution_mode新增不可变字段，旧单默认DEVELOPMENT，SQL校验原报价模式一致、正式单必须EXPRESS+WECHAT。正式作业不能处理开发单或其他正式模式单；配置模式变化后旧报价不能新创建，但成功请求仍可恢复。消费者订单/后台详情/配货打印明确来源模式，不把开发或受控单冒充正式单。原本地配送与现金流程不由新门禁启用，未删除旧计划/事实。

GET /api/v1/consumer/redemption-access新增当前本人访问条件，Bearer/no-store、未知查询字段拒绝，返回executionMode/canSubmit/reason，不返回名单或凭据。仅表示可继续核验，报价/提交时仍再次检查资格、快递规则、价格、积分、配额和实时库存。小程序确认页展示暂停/受控限制/读取失败并禁用新报价，仍可核实原请求；报价后暂停由服务端阻断且保留原请求，恢复后可核实。服务端仍对503统一脱敏，小程序仅按明确EXPRESS_SUBMISSION_PAUSED错误码展示固定暂停文案，未放宽错误过滤。403明确拒绝也可确认未创建后重新核验，账号不匹配的原请求不能由其他账号清除。

后台首发检查展示正式模式、独立写开关及受控账号数量，开发适配器均关闭时显示隔离配置满足，不返回ID名单；配置不是验收，canLaunch仍false。新增不含凭据的受控环境模板和只读check:points-express:config工具；工具不联网/不接数据库、不修改配置、不输出URL/secret/名单/仓库ID，只检查声明与隔离规则，configurationValid=true不代表已验收。原本地发布检查新增正式模式/写开关须关闭的保护，不用其操作远程环境。

OpenAPI0.59.0由代码导出，订单/报价/打印增加模式字段，需先迁移再匹配API/Worker/后台与小程序。旧报价模式缺失兼容DEVELOPMENT，历史订单不自动转换。30项真实PG（受控3/旧兑换12/出库8/反馈7）与配置及只读保护测试通过，浏览器12张截图通过。只在随机临时schema和合成微信账号/积分验证；未连接真实微信、HTTPS、外部账号或生产，未改实际.env或主库，仍待真实受控环境、设备、实物、备份恢复和部署授权验收。


## 实际验证

- Node24.22.1、pnpm10.28.2、真实PG临时schema。受控3项、旧兑换12/出库8/反馈7共30项逐项通过；配置模块测试初次因根tsx未启用参数装饰器而失败，拆分纯配置/门禁/控制器后重跑2项配置+3项受控全部通过。运行时补强后2+3再次通过；未重复累计。另2项只读配置检查、2项本地发布保护，共6项配置/保护检查通过。覆盖指定微信账号、开发身份/非名单/旧模式拒绝、报价/订单模式一致不可改、受控无需DEV开关出库、暂停新动作/成功原键恢复、名单移除后取消退分、开发单正式作业拒绝、发货取消竞争一次结算、形式检查不放行/不泄密/不联网。未宣称完整真实生产链路已验。
- 实际API/PG、同源码小程序桥接、React StrictMode/Chrome，12张截图：后台独立门禁、提交暂停、非名单阻断、访问条件读取503/重试、受控报价、报价后暂停提交及恢复原键、订单原模式、后台作业暂停、手机发货、已发、带模式打印、开发单在正式作业中阻断。页面错误/横向溢出断言通过，实际查看手机订单和发货表单；顶部标注合成受控账号、非真实微信/TLS/生产验收。
- 保持全局503脱敏，客户端按明确暂停错误码显示固定文案后复验通过，不将通用“服务暂时不可用”误作业务暂停验收。配置加载、暂停、名单变化和服务端模式限制各自独立，不由前端开关放行。
- Prisma生成、全工作区build（API/Worker/后台/H5/weapp）、typecheck、lint和OpenAPI0.59.0导出通过。最终小程序清单/迁移重放摘要另行补充。tsx沙箱userInfo读取受限后授权本地重跑通过，未换依赖。既有pg弃用和Vite体积提示保留。
- 未改业务主库、真实.env、微信凭据或外部资源；配置工作表全部秘密留空、写开关为0，默认模式off。真实测试环境部署、真实微信/TLS、工具/真机、实物打印/交快递与数据库/密钥备份恢复均未验，不以配置有效或本地截图代替。

## 页面与复跑

[后台门禁](UI-E4E-GATE-ADMIN-GATES-2026-11-03.png)、[新兑换暂停](UI-E4E-GATE-MINI-SUBMIT-PAUSED-2026-11-03.png)、[名单限制](UI-E4E-GATE-MINI-NOT-ALLOWED-2026-11-03.png)、[读取失败](UI-E4E-GATE-MINI-ACCESS-ERROR-2026-11-03.png)、[受控报价](UI-E4E-GATE-MINI-CONTROLLED-QUOTE-2026-11-03.png)、[报价后暂停](UI-E4E-GATE-MINI-PAUSED-AFTER-QUOTE-2026-11-03.png)、[订单模式](UI-E4E-GATE-MINI-CONTROLLED-ORDER-2026-11-03.png)、[作业暂停](UI-E4E-GATE-ADMIN-OPERATIONS-PAUSED-2026-11-03.png)、[手机发货](UI-E4E-GATE-ADMIN-SHIP-MOBILE-2026-11-03.png)、[已发](UI-E4E-GATE-ADMIN-CONTROLLED-SHIPPED-2026-11-03.png)、[带模式打印](UI-E4E-GATE-ADMIN-CONTROLLED-PRINT-2026-11-03.png)、[开发单阻断](UI-E4E-GATE-ADMIN-DEVELOPMENT-BLOCKED-2026-11-03.png)。截图本地忽略。

npm run test:points-express-gate；旧回归文件redemptions/redemption-express-shipping/redemption-after-sales.integration.test.ts；只读工具保护为tests/points-express-inspection.test.mjs及tests/express-release.test.mjs。设置YUMI_LIVE_UI=1及现有YUMI_PLAYWRIGHT_PATH/YUMI_CHROME_PATH后npm run verify:points-express-gate:ui。

## 受控环境接续

最终本地小程序清单/三个工程入口核验通过，56个迁移在新建临时schema重放生成110张表并清理；只读发布摘要为localChecksPassed=true、API0.59.0、miniBuild=LOCAL_OUTPUT_ONLY、canLaunch=false，不代表真实环境已开放。

操作步骤见[手册](../operations/POINTS-EXPRESS-CONTROLLED-ENVIRONMENT.md)、[空白配置工作表](../operations/points-express.controlled.env.example)。下一步是已授权真实隔离环境联调与验收，仍需实际HTTPS测试地址、受控微信配置、测试账号/商品/设备及备份恢复；本轮不要求在聊天发送密钥，也不擅自部署、购买资源或开放生产。
