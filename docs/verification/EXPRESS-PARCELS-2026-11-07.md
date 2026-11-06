# 合包确认与统一运单发货 · 2026-11-07

## 交付范围

运营后台「积分兑换订单」新增「合包发货」。选择2–20笔同顾客、相同原收件信息、相同运行模式的有效待发货快递订单，查看每单的商品/规格/数量/备注、原批次及库位，再确认已装入同一包裹并交给快递，登记一份真实运单。选择不满足条件时整批拒绝；库存/库位/批次或作业开关阻断时不可提交。

服务器重新核验全部订单和版本，在一次事务内建立不可变包裹、逐单发货、原分配出库、库位流水、审计和幂等记录。任一失败整包回滚，不再扣积分。原单独发货保留；历史运单排他保留。后台任一成员更正运单时同步整包全部成员，界面明确单数；不能单边更正。顾客按原订单独立确认收货、售后/退分，不自动扩展到同包其他单。

未知结果在本会话保存操作者/授权仓隔离的原键及规范化请求（订单/版本/运单，无收件资料）。刷新后可用原键核实，期间不能修改请求。成功重放不重复出库；暂停经营开关仍可核实已成功的原请求，当前权限必须有效。401/403保留原请求供恢复权限后核查。

## 功能验收

使用Node24.22.1及项目锁定依赖，全部交易测试使用自动建立并清理的PostgreSQL隔离schema，真实API和真实收货预占库存；无真实顾客、快递或退款操作。

最终专项`tests/express-parcels.integration.test.ts`13项通过；回归`express-receipt.integration.test.ts`4项、`redemption-consolidated-print.integration.test.ts`5项、`redemption-express-corrections.integration.test.ts`6项、`redemption-express-shipping.integration.test.ts`8项，共36项（重跑不重复计数）。验证：

- 统一运单及逐单原预占消费、同键/不同键防重、改选/改运单冲突、积分不重扣。
- 独立收货及单品原积分退还，不影响同包其他订单或库存/发货事实。
- 同顾客不同原地址、不同顾客相同地址、缺单、重复/超量、版本、角色/仓权限与CSRF。
- 冻结库存、批次过期、仓/商品/库位及原预占约束；多SKU库存分别出库，未选订单保持预占。
- 单单发货与合包竞争、重叠合包、取消与合包竞争，仅一方完整成功。
- 中途审计失败、会话或效期失效整包回滚；原请求之后恢复一次。
- 更正整包同步、历史运单不被其他单复用，数据库拒绝单边更正、残缺包裹和成员篡改。

全仓typecheck/lint、服务端/公共UI/后台/移动作业端构建、Prettier及diff检查通过。OpenAPI导出至0.80.0。测试仍出现既有pg adapter并发query弃用提示，当前无失败，没有升级依赖。

## UI验收

`YUMI_LIVE_UI=1 YUMI_PLAYWRIGHT_PATH=... node --env-file=.env --import tsx scripts/ui/verify-express-parcels.mjs`通过。实际工作台+隔离API/PG+Chrome，覆盖未选择禁用、加载、错误重试、库存冻结阻断、桌面/390px手机、确认实物后提交、提交成功后断网、刷新用相同原键核实、已发货详情及整包更正，共12张截图。实际查看桌面、手机及手机表单底部，内容可滚动、无横向溢出。浏览器断网发生在真实提交后，不使用伪造成功响应。

- [加载](UI-EXPRESS-PARCELS-LOADING-2026-11-07.png)
- [错误与重试](UI-EXPRESS-PARCELS-ERROR-2026-11-07.png)
- [桌面核对](UI-EXPRESS-PARCELS-READY-DESKTOP-2026-11-07.png)
- [库存阻断](UI-EXPRESS-PARCELS-BLOCKED-2026-11-07.png)
- [手机核对](UI-EXPRESS-PARCELS-READY-MOBILE-2026-11-07.png)
- [手机表单底部](UI-EXPRESS-PARCELS-FORM-MOBILE-2026-11-07.png)
- [结果未知](UI-EXPRESS-PARCELS-UNKNOWN-2026-11-07.png)
- [刷新恢复](UI-EXPRESS-PARCELS-RESTORED-MOBILE-2026-11-07.png)
- [成功登记](UI-EXPRESS-PARCELS-SUCCESS-2026-11-07.png)
- [同包订单详情](UI-EXPRESS-PARCELS-SHIPPED-2026-11-07.png)
- [整包更正提示](UI-EXPRESS-PARCELS-CORRECTION-2026-11-07.png)
- [更正后](UI-EXPRESS-PARCELS-CORRECTED-2026-11-07.png)

## 迁移、兼容性和本地预览

第63项`202611060002_express_parcels`增加不可变包裹和可空shipment.parcel_id，旧记录不回填；历史运单表仍负责跨包裹/原单/历史更正的唯一身份占用，原库存平衡触发器保留。迁移在事务内执行。旧版服务不能安全更正合包运单，生产回退必须先停写并使用已验备份或前向修复，不能直接删除新结构。无本轮生产备份恢复演练。

已严格限定回环地址/yumi_dev执行本地迁移并成功更新API。后台构建先编译`@yumi/web-ui`，再编译admin-web/ops-mobile，避免引用旧公共包dist。常用后台5173/作业5174可访问，实际资源包含parcel-preview与ship-parcel；API live/ready均200、在线OpenAPI0.80.0已注册新接口。

UI和功能通过不等于真实实物或生产验收。未接快递公司、电子面单或批量运单导入；未进行真实打印机、实物装箱/交接、真实微信/工具/真机及生产验收。未开启经营开关、部署生产或使用付费资源。本轮PRD/API/数据设计/总计划/开发计划/商城剩余清单已同步。
