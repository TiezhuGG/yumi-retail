# P4e 真实兑换配送开始与骑手确认送达 · 2026-11-03

分支：积分商城。状态：本地实现与隔离验证完成，未上线。本轮边界：真实兑换出库来源→原骑手接货→本人实际开始配送→本人声明全部包裹送达。所有验证使用合成身份和随机临时PostgreSQL schema；“真实来源”指实际兑换/仓储API及库存账证明，不表示已验收现实实物配送。P4/P5未整体验收。

## 业务及验收边界

- 只从原redemption_shipments、assignment、handoff读取，不使用delivery_lab演练或现金订单。START绑定原handoff，COMPLETE绑定同单START，不接受跳步、借用其他单凭据或通用状态修改。
- 仅本仓当前有效、原分配且本人接货的RIDER可操作，负责人/仓管不能代替另一骑手。双角色也须满足本人归属与RIDER资格；失权后不能通过历史幂等键取回操作结果。
- 开始时勾选“已携带本单全部包裹，确认实际出发配送”；送达时勾选“已按原收货地址将全部包裹交付收货人”。两者为骑手本人声明，送达不冒充收货人独立确认，不伪造签名、照片、GPS或自动送达。
- 保留P4d的保守资格校验：原出库消费凭据、当前仓库/商品/规格/库位、批次效期、冻结/盘点，以及骑手/原分配人当前角色与仓库授权。原分配人无须一直保持原登录会话。人员停用、应急接续规则仍待交付/经营确认。
- 每个阶段只追加一次不可变凭据，状态从事实派生：HANDED_OVER→DELIVERING→DELIVERED。原拣货仍CHECKED、兑换主状态仍ACTIVE用于累计有效额度；完成结案和售后另行交付，不把配送声明等同全部流程关闭。
- 不再改实物、预占、积分、原出库消费、用户限兑或总配额；所有已开始履约阶段继续拒绝消费者直接取消。失败不自动退分、释放、回库或改派。
- 列表不含地址，授权详情才读取原加密地址快照；沿用401/403/404清理旧详情、地址及候选人员。操作草稿只持久化动作、来源凭据、确认和原键，不保存顾客地址。

## 数据与迁移兼容

新增`202611030002_redemption_journey`、Prisma RedemptionJourneyFact：handoff/order复合来源、START/COMPLETE、原start_id、本人actor、request、PG实际时钟created_at。handoff/kind唯一；START不允许start_id，COMPLETE必须引用同handoff/order的原START。复合自外键与SQL来源触发器同时约束同单前序及原本人；所有事实禁止更新/删除。SQL还校验ACTIVE/CHECKED原出库、本仓有效RIDER和原管理分配人，锁原接货并用唯一约束裁决竞争。

应用锁序为当前会话/角色/本仓授权及骑手/分配人资格共享锁→商品→库存→兑换单→拣货任务→shipment；重读原接货/阶段后写事实、业务审计和幂等结果，同事务提交。审计后再以真实时钟校验会话、效期和当前源资格，晚失败全部回滚。完成的历史事实不因以后撤权改删。

仅临时schema重放全部迁移并清理，未应用开发业务主库/生产，未改.env或升级依赖。沿用REDEMPTION_PICKING_DEV_ENABLED默认0、生产/远程拒启，无新增开关。须先迁移再部署匹配API/Worker及三端；旧版不识别journey，会将配送中/已送达误显示待开始，不能盲退。停写并保留兼容查询和取消保护，不删除事实、不再次扣库存或退分。

## API与页面交付

OpenAPI 0.47.0已导出。基路径`/api/v1/warehouse/warehouses/:warehouseId/redemption-delivery`新增：

| 接口 | 严格输入 |
|---|---|
| POST /:id/start | handoffId、departureConfirmed:true |
| POST /:id/complete | startId、deliveryConfirmed:true |

新增RIDER独有redemption-delivery.work权限，Cookie、CSRF、Origin及Idempotency-Key不变。详情/列表新增journey.start/completion、canStart/canComplete；readiness.ready保留分配/接货资格语义。state/status新增DELIVERING、DELIVERED，与UNASSIGNED/ASSIGNED/HANDED_OVER互斥。20条UUID分页、游标筛选和本人/本仓范围继续生效。接口字段、错误及SQL详见[API设计](../api/API-DESIGN-V1.md)和[数据设计](../database/DATABASE-V1.md)。

沿用ui/后台与小程序风格，管理端查询实际阶段、骑手手机按阶段显示独立确认表单和记录、消费者/后台订单与仓库出库页同步实际阶段。已送达只显示骑手确认并提供联系门店的文字说明，没有无响应的售后按钮。开始/送达未知网络或5xx保留原输入/键，重载后用原请求核实；不引导换键重做。负责人仍需进行UI审阅，技术验证不等于其UI确认。

## 实际功能检查

锁定Node24.22.1、pnpm10.28.2，本机PostgreSQL。`tests/redemption-journey.integration.test.ts`13项专项：

1. 原接货→START→COMPLETE、原键重放、三端API状态同步；库存/位置/批次/流水、积分账户/流水、订单/分配原值不变，取消继续被拒绝。
2. 禁止跳过接货/开始，错源、未确认实物或额外字段均拒绝。
3. 只有当前被分配骑手可操作，管理代操作/其他骑手拒绝，撤权后禁止原键重放。
4. 不同键并发START和COMPLETE各只能成功一个。
5. 默认关闭保护两个动作，同键变更来源被拒绝。
6. 冻结或原分配人移出仓库阻断新动作，保留原接货/已开始事实。
7. 两动作晚审计失败全部回滚，修复后各原键只恢复一次。
8. SQL拒绝无START送达、错本人/跨单START、事实更新/删除。
9–10. START与COMPLETE审计期间会话到期，各回滚新事实。
11–12. START与COMPLETE审计期间批次到期，各回滚新事实。
13. 初步授权后事务内撤仓仍拒绝，恢复后原键成功。

13项专项与既有92项PG回归合计105项通过。回归覆盖分配接货13、打包出库12、任务领取12、逐项核对10、兑换12、积分8、商品6、现金订单10、现金报价9。4项本机配置检查通过。全部临时schema迁移重放，无真实顾客/员工/积分操作。

Prisma生成、全工作区构建（API/Worker/后台/H5/微信weapp）、完整typecheck、lint、微信产物及三个导入根检查、OpenAPI导出与git diff --check通过。现有Prisma/pg查询串行弃用提示仍存在，未升级依赖；浏览器验收适配包约1034KB有体积提示，实际后台/H5约463KB，构建通过。

## UI检查（单独记录）

`scripts/ui/verify-redemption-delivery.mjs`接实际API和随机临时PG，桌面1440、骑手390×844、小程序同源码390×844浏览器适配验证通过；页面无脚本错误、无横向溢出。最终32张截图本地保留并按仓库现有规则Git忽略。实际查看桌面送达、手机开始表单/送达记录和消费者送达截图；据截图修正消费者配送中/送达后文案后，重新跑完整32张页面验证。

包含后台/本人/其他骑手空态、无有效候选、候选读取失败重试、精确接货数量、冻结阻断、分配/接货原键恢复、读取错误/重试/加载，以及新增开始/送达未勾选禁用、确认表单、提交成功但响应丢失、重载原键恢复、后台和消费者状态、其他骑手持续隔离；末尾管理人员转为骑手后刷新清除他人收货地址。

| 页面证据 | 截图 |
|---|---|
| 手机实际出发确认 | [开始表单](UI-REDEMPTION-JOURNEY-RIDER-START-FORM-2026-11-03.png) |
| 开始响应丢失 | [原请求核实](UI-REDEMPTION-JOURNEY-RIDER-START-UNKNOWN-2026-11-03.png) |
| 手机送达确认 | [送达表单](UI-REDEMPTION-JOURNEY-RIDER-COMPLETE-FORM-2026-11-03.png) |
| 送达响应丢失 | [原请求核实](UI-REDEMPTION-JOURNEY-RIDER-COMPLETE-UNKNOWN-2026-11-03.png) |
| 手机原键恢复及完整记录 | [本人送达记录](UI-REDEMPTION-JOURNEY-RIDER-COMPLETE-RECOVERED-2026-11-03.png) |
| 后台实际配送状态 | [后台送达](UI-REDEMPTION-JOURNEY-ADMIN-COMPLETE-2026-11-03.png) |
| 消费者实际配送状态 | [配送中](UI-REDEMPTION-JOURNEY-MINI-START-2026-11-03.png)、[骑手确认送达](UI-REDEMPTION-JOURNEY-MINI-COMPLETE-2026-11-03.png) |
| 失权清除隐私 | [管理撤权](UI-REDEMPTION-JOURNEY-ADMIN-REVOKED-2026-11-03.png) |

复现：`pnpm test:redemption-journey`；页面使用锁定运行时、`YUMI_LIVE_UI=1`、本机Playwright及Chrome执行`pnpm verify:redemption-delivery:ui`，创建实际API临时schema，退出清理。不要对业务主库运行迁移来复现验收。页面适配不是微信开发者工具/真机。

## 尚未验证与下一项

没有微信工具/真机、真实收货人独立确认、现实实物配送或生产验收；未启用商城或写开关，业务主库没有本轮迁移。异常上报/未决阻断、处置恢复、改派与人员停用接续、已领取消、售后退积分/实物核验及P5经营与上线依赖仍未交付。下一项P4f先做真实兑换配送异常上报与未决阻断，再逐片补齐其余闭环。
