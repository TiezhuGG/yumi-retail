# E4a 运单资料更正 · 2026-11-03

分支：积分商城。E4先按纠错、最小售后、首发验收拆分；本轮仅交付E4a的模型、API、后台表单/历史、消费者与打印同步及实际验证。E4整体未完成，下一项E4b最小售后反馈与处理。

## 行为与兼容


E4按可验证边界拆为E4a运单纠错、E4b最小售后反馈与处理、E4c首发发布准备及人工/设备验收。本轮仅完成E4a，不将售后、真实快递交接、微信真机或生产记作完成。未发货取消/全额退分与发货竞争已在E2/E3实现，本轮回归保持；已发货仍不能直接取消，不做退分、退货入库或补寄。

后台已发货快递单新增“更正运单资料”独立表单，显示当前值，填写更正后的快递公司/运单号、1至200字原因，并勾选已核对原包裹真实运单。仅纠正原包裹的录入错误，不修改收件人/地址、原发货时间、订单版本/状态、积分、配额、库存、预占或Outbox，也不代表重新寄出。原因提示勿填写个人信息，拒绝控制字符；资料不变拒绝保存。后台可查看原发货和逐次更正的公司/单号、原因、操作人及北京时间。用户端和配货打印只展示最新有效运单，标明资料已更正；不返回内部原因或员工信息，复制使用新单号。

POST /api/v1/admin/redemptions/:id/shipping-corrections，严格body为version（当前独立更正版本，初始0）、carrierCode、可选carrierName（OTHER必填）、trackingNo、reason、verified:true。沿用本仓SUPER_ADMIN/OPERATIONS、points.read、员工Cookie、Origin/CSRF、Idempotency-Key及事务内前后权限；只接受ACTIVE+EXPRESS+EXPRESS_SHIPPED且有原发货事实的订单。公司和运单校验与E3一致，标准化大写后计算原键摘要。订单锁串行化同单更正，独立版本防止旧页面覆盖；更新失败整笔回滚，更正记录、运单归属、审计及原键结果一起提交。跨账号/本仓失权后，即使原键成功也拒绝访问。

GET /:id/shipping继续no-store，增加canCorrect和仅后台的shipmentHistory；shipment增加correctionVersion及correctedAt。消费者/后台订单列表、详情、打印统一投影最新更正；shippedAt始终为原发货时间。已出库后的冻结、商品下架或批次后来过期，不阻断仅纠正运单的操作；不借纠错重新运行出库逻辑。复用默认关闭的REDEMPTION_PICKING_DEV_ENABLED本地作业开关，关闭时新更正503，既有成功原键可核实，生产/远程拒启保持。

迁移202611030009_express_shipping_corrections新增不可变RedemptionExpressShipmentCorrection：原发货来源FK、独立连续版本唯一、公司/单号、原因、操作人快照、请求编号及时间；SQL锁原发货来源校验连续版本、已发快递单、当前角色/仓库、值必须变化，禁止覆盖/删除历史。新增SQL运单归属表redemption_express_waybills，回填所有原发货身份；原发货及每次更正自动占用同仓+公司代码+名称+单号唯一身份，归属永久保留。另一订单不能使用任何历史身份；同一订单可核实后更正回自己的原值。唯一索引处理跨订单并发，延迟约束拒绝无对应事实的伪归属；表无外部通用写接口。

OpenAPI0.55.0由代码导出。兼容原E3字段、发货凭据不可变和旧LOCAL_NO_CASH流程；不删除旧迁移/骑手扩展。部署先执行新迁移，再匹配API与前端；旧服务只读原发货资料会显示旧单号，不可盲退服务或丢弃更正/归属历史。仅随机临时schema与合成身份，未改业务主库/.env或生产，未接外部快递服务。


## 实际验证

- Node24.22.1、pnpm10.28.2，现有PostgreSQL。6项纠错专项、8项E3发货、3项打印回归，共17项全部通过。覆盖原键归一化重试/冲突、连续历史不可变、各读接口最新投影、员工角色/异仓/失权/CSRF/消费者归属、未发/取消/旧配送拒绝、输入/无变化/旧版本拒绝、关闭开关原键恢复、同单竞争及跨单运单唯一竞争、原值/已更正历史身份不能用于第二单、晚期审计/会话失效完整回滚及原键修复恢复、SQL错误版本/人员/伪归属/修改历史拒绝。纠错前后订单、原发货、积分、仓库/批次/库位和流水、Outbox完全相同。未宣称全量历史骑手/仓配回归。
- 实际API、随机PG schema、React StrictMode和Chrome：读取失败重试、原发货显示、未更改/错误单号阻断、桌面/390px手机表单、成功响应丢失后重载核实原更正请求、原值/原因/人员/时间历史、消费者新运单及更正提示/复制、不泄露内部原因、打印最新运单、旧页面版本冲突后清理并刷新、提交前撤销仓库权限后清理收件资料/表单。10张截图、页面错误和横向溢出断言通过；实际查看手机表单和消费者更正页，保持绿色界面。
- Prisma生成、全工作区build（API/Worker/后台/H5/微信weapp）、typecheck、lint、OpenAPI导出通过。没有升级依赖。既有pg并发query弃用提示和预览包体积提示保留。
- 测试迁移在随机临时schema重放并自动清理，页面使用合成地址/身份。未操作主库/.env、生产、真实客户/商户/承运账号；微信开发者工具/真机、实物打印机、实际快递交接、轨迹和签收未验。

## 交付页面和复跑

[原发货](UI-E4A-CORRECTION-ADMIN-ORIGINAL-2026-11-03.png)、[桌面表单](UI-E4A-CORRECTION-ADMIN-FORM-2026-11-03.png)、[手机表单](UI-E4A-CORRECTION-ADMIN-FORM-MOBILE-2026-11-03.png)、[断网待核实](UI-E4A-CORRECTION-ADMIN-UNKNOWN-2026-11-03.png)、[历史](UI-E4A-CORRECTION-ADMIN-HISTORY-2026-11-03.png)、[消费者](UI-E4A-CORRECTION-MINI-CORRECTED-2026-11-03.png)、[打印](UI-E4A-CORRECTION-ADMIN-PRINT-2026-11-03.png)、[版本冲突](UI-E4A-CORRECTION-ADMIN-STALE-2026-11-03.png)、[失权清理](UI-E4A-CORRECTION-ADMIN-ACCESS-REMOVED-2026-11-03.png)、[读取错误](UI-E4A-CORRECTION-ADMIN-READ-ERROR-2026-11-03.png)。截图本地忽略保存。

专项npm run test:express-corrections；回归tests/redemption-express-shipping.integration.test.ts和redemption-print.integration.test.ts。设置YUMI_LIVE_UI=1、现有YUMI_PLAYWRIGHT_PATH及本机YUMI_CHROME_PATH后npm run verify:express-corrections:ui。仅本地隔离验收，不代表已上线。
