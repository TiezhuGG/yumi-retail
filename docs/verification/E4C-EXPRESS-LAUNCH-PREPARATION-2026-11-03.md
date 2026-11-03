# E4c 积分快递首发本地准备 · 2026-11-03

分支：积分商城。完成首发检查API和对应后台界面、只读业务监控、CLI版本清单/临时迁移重放、实例重建恢复验证与发布操作手册。**本地准备完成，真实发布条件未通过，E4整体未完成。**

## 交付边界


后台新增“积分快递首发检查”，GET /api/v1/admin/redemption-express-readiness，仅有效本仓SUPER_ADMIN/OPERATIONS、points.read与员工Cookie可读，未知查询参数拒绝，响应no-store。页面只展示当前仓库、快递规则/已上架商品数量/加密密钥是否配置，以及本仓待发/已发/未结束反馈与最早待发时间；不返回收件资料、反馈正文、运单号、消费者身份或密钥值。只读RepeatableRead快照，当前权限事务内再次核验；刷新/失败先清空旧结果，失权不保留旧统计。没有更改状态、录入验收或发布按钮。

服务端即时核对快递订单与Outbox/原发货、原预占消费或释放/数量、快递不进入骑手任务、每个原/更正运单的历史归属，以及售后投影/完整事件链。统计显示三类差异总数；没有差异只说明本次这些检查未发现问题，不代表全量账实一致或已验收。待发和反馈没有擅自设定超时阈值，没有外部告警；读失败表示未知。仓库/寄送规则/商品/加密项显示已配置与否，正式微信身份和生产写门禁明确阻断，HTTPS/真机/实物打印与交快递/备份恢复/经营值守/部署明确未验。纯积分快递首发不依赖现金支付、骑手或电子面单。

canLaunch始终false：目前仅DEVELOPMENT消费者适配器，且开发兑换/快递作业开关拒绝生产，不能通过放宽开发限制实现正式首发。本轮不改变这些开关、.env或生产配置。E4c仅完成本地准备，设备/实物/备份恢复和受控发布条件仍未通过；E4整体未完成。下一项可推进的实现为正式微信身份接入与受控测试环境准备，完成后再分项验收，不能把该检查页刷新当上线。

新增check:express:release/verify:express:migrations本地CLI，验证锁定Node、本机数据库范围、默认安全开关/支付禁用、必需构建入口，输出API版本、迁移名称与SHA256、固定产物指纹和小程序清单状态；不输出URL/密钥，未知参数拒绝。指纹只标识当前文件，不证明新鲜度、构建对应源码、健康或外部验收。rehearse须先通过本机配置检查，只在随机临时schema重放全部迁移并清理；生产/远程/打开开发写开关均拒绝演练。保持原仓配检查工具和历史方案不变，不将其现金支付/骑手条件移植为本次积分首发门槛。

本轮54个迁移重放生成109张表后清理，43项检查及打印/地址/兑换/发货/纠错/反馈PG回归，加1项API关闭/连接池断开后同schema重建实例、原加密快照/事实和原键恢复，共44项PG通过；2项CLI保护通过，9张实际API后台桌面/390px浏览器截图通过。实例重建未丢失积分/库存/运单/反馈且原键不重复写，但不等于进程断电或备份恢复。新增接口OpenAPI0.57.0由代码导出，无新迁移；部署需配套API/后台。完整操作手册见operations/POINTS-EXPRESS-LAUNCH-RUNBOOK.md，未执行主库迁移或生产部署。


## 实际结果

- Node24.22.1/pnpm10.28.2；3项检查专项、打印3/地址4/发货8/纠错6/反馈7/兑换12共43项真实PG通过；另1项API实例重建验证通过。检查专项覆盖真实汇总、角色/本仓隔离、no-store/未知参数拒绝、不返回私密明文、不改变交易，以及仅在临时schema注入运单归属缺失，检查发现差异并显示阻断，修复后归零。重建实例复用同临时schema与同密钥，解密地址/反馈并恢复原运单、历史/原键，无重复出库或积分；不是进程断电、备份或密钥恢复验收。
- CLI保护2项通过：外部人工声称“已验收”不改变canLaunch=false；非法/远程/生产/开发写开关打开时拒绝迁移演练，未知发布参数拒绝；报告不含合成密码/密钥。全54迁移/109表在新的临时schema重放，结束清理。
- 实际API/PG/React StrictMode/Chrome，9张截图：加载、读取失败重试、空待办、待发订单、已发+反馈汇总、390px汇总/阻断卡片、寄送暂停、失权后清空旧汇总。页面错误及横向溢出断言通过；实际查看手机汇总与桌面检查页。未自动填写人工验收结果。
- 全工作区构建、typecheck、lint和OpenAPI0.57.0导出通过；本地小程序构建与完整文件清单验证通过，target=local，开发登录UI关闭。清单只代表本地编译产物，未用伪域名生成device包。Vite体积和pg并发query弃用提示保留，未升级依赖。
- .local/express-release-report.json记录localChecksPassed=true、canLaunch=false、API0.57.0、LOCAL_OUTPUT_ONLY及迁移重放摘要；文件忽略保存，不含凭据。没有操作业务主库/.env、外部账号、付费资源或生产。重建测试初始CSRF字段取值错误后改用真实会话profile并复跑通过，不改服务端保护。

## 页面与复跑

[桌面检查](UI-E4C-READINESS-METRICS-2026-11-03.png)、[手机汇总](UI-E4C-READINESS-METRICS-MOBILE-2026-11-03.png)、[手机阻断项](UI-E4C-READINESS-BLOCKERS-MOBILE-2026-11-03.png)、[加载](UI-E4C-READINESS-LOADING-2026-11-03.png)、[读取错误](UI-E4C-READINESS-READ-ERROR-2026-11-03.png)、[空待办](UI-E4C-READINESS-EMPTY-2026-11-03.png)、[待发](UI-E4C-READINESS-WAITING-2026-11-03.png)、[暂停](UI-E4C-READINESS-POLICY-PAUSED-2026-11-03.png)、[失权](UI-E4C-READINESS-ACCESS-REMOVED-2026-11-03.png)。截图本地忽略保存。

npm run test:express:release、npm run test:express:regression、npm run check:express:release、npm run verify:express:migrations。UI设置YUMI_LIVE_UI=1及现有YUMI_PLAYWRIGHT_PATH/YUMI_CHROME_PATH后npm run verify:express-readiness:ui。操作与人工验收案例见[手册](../operations/POINTS-EXPRESS-LAUNCH-RUNBOOK.md)。

## 尚未完成与接续

最终小程序发布检查补齐了E2新增快递地址页的JS/WXML和app.json路径清单；原校验脚本遗漏该页造成清单生成失败，修正后重新编译并验证三个工程导入根及完整产物清单。发布检查现将小程序清单缺失/过期作为本地失败项，不以app.json存在代替。2项CLI保护与5项既有小程序构建边界测试共7项再次通过，最终报告miniBuild=LOCAL_OUTPUT_ONLY、localChecksPassed=true、canLaunch=false。

正式微信身份及独立生产兑换/快递门禁未实现；真实测试域名、工具/真机、实际商品/地址/费用/打印机/交快递、独立数据库及密钥备份恢复、值守/告警与受控部署均未验。下一项先实现正式微信身份与受控测试环境准备，再按手册完成设备/实物/恢复验收；不将无法本地完成的项勾为通过，不把现金支付或骑手接回首发链路。
