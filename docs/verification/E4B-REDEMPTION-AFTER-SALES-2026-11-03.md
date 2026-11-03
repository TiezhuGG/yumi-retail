# E4b 最小售后反馈 · 2026-11-03

分支：积分商城。完成本轮业务切片：本人已发快递单的问题反馈、补充说明、后台回复/结束及用户重新反馈；沿用现有绿色界面，独立后台导航和消费者订单卡片。E4整体未完成，下一项E4c首发发布准备与人工/设备验收，未上线。

## 边界与实现


用户本人已发货快递兑换订单新增售后反馈卡片：问题类型为未收到商品、商品破损、商品不符、其他问题；首次提交1至500字说明，一单一个反馈记录，重复问题通过原记录补充。待处理/处理中可补充；门店结束后用户仍可说明原因重新反馈，原记录与回复继续保留。没有附件上传、外部客服消息或时效承诺。反馈不改变兑换订单、发货、运单、积分、配额、预占、库存或配送状态，不代替退款/退货/补寄动作；已发货禁止直接取消保持。未发货/已取消/原配送单不得创建本入口反馈。

后台新增独立“兑换售后反馈”导航，按反馈状态、兑换单号或商品查询，20条分页，详情按时间展示用户说明、门店公开回复、处理状态与北京时间。运营可“回复用户并继续处理”或“回复并结束本次反馈”，均要求1至500字说明；页面勾选确认将回复展示给用户，准确描述已完成的沟通。用户只看到“门店回复/处理说明”，不返回员工姓名/身份；后台显示实际操作人。结束仅表示本次反馈处理结束，用户重新反馈后回到待处理，无财务或库存补偿。

新增GET/POST /api/v1/consumer/redemptions/:id/after-sales，POST /supplement、/reopen；消费者Bearer、本人订单、原键及补充/重开独立版本校验。首次提交category/message，后续version/message，未知字段拒绝；允许换行，拒绝其他控制字符。后台GET /api/v1/admin/redemption-after-sales及/:id，POST /:id/reply、/:id/close，Cookie、SUPER_ADMIN/OPERATIONS、points.read、本仓、Origin/CSRF及Idempotency-Key校验，回复/结束body为version/message。GET响应no-store，列表仅最小订单/类型/状态/时间，不含地址或反馈全文。列表按反馈UUID升序分页，cursor为上一页最后反馈ID，不承诺按最近更新时间排序。

独立反馈状态OPEN/PROCESSING/CLOSED与version，业务动作SUBMITTED/SUPPLEMENTED/REPLIED/CLOSED/REOPENED；同单订单锁串行化，原键摘要/结果及事件同事务，旧版本拒绝，失败完整回滚。消费者事务前后校验当前会话及clock_timestamp，员工事务前后校验当前本仓角色/会话，成功原键仍须当前授权。读取反馈持有反馈行共享锁，使状态/版本与事件历史一致。复用默认关闭的REDEMPTION_PICKING_DEV_ENABLED本地作业开关，关闭阻断新写但可读既有记录、核实成功原键；生产/远程拒启保持，未改.env或默认配置。

迁移202611030010_redemption_after_sales新增RedemptionAfterSales一单唯一来源/类型/状态版本投影和RedemptionAfterSalesEvent不可变动作历史。SQL校验已发快递来源及原用户/仓库、来源字段不可改、连续版本/合法状态动作、当前用户或本仓运营人员、事件与投影版本/状态/时间及完整数量配平；禁止删除来源/修改或删除历史。说明和回复使用现有AES-GCM密钥，按用户与独立事件ID绑定AAD加密，数据库审计仅动作/来源/人员/请求号，无消息明文；用户填写提示勿包含姓名、电话、地址。客户端按账号和订单保存待确认原请求（包含说明），成功/明确拒绝后删除，隐藏/切换账号清理页面资料，不展示或重试其他账号原请求；后台待确认请求仅sessionStorage，原键/说明同请求重试。

OpenAPI0.56.0由代码导出，新增独立接口/模型，不改原兑换/发货/运单契约，不删除旧配送扩展。部署先迁移，再发布匹配API和客户端；新增表无旧数据回填，不盲删事件或退回不认识反馈的版本。仅随机临时schema/合成身份完成验证，未连接外部客服/快递账号或生产；微信工具/真机、实物打印/交快递及生产未验。E4b完成本地交付，下一项E4c首发准备与分项验收，E4整体尚未完成。


## 实际验证

- Node24.22.1、pnpm10.28.2、真实PostgreSQL随机临时schema。7项售后专项+6项运单纠错+8项快递发货共21项通过。覆盖首次/补充/回复/结束/重新反馈、加密载荷/消费者不见员工信息、原键/内容冲突、同单提交和处理竞争、当前用户/本仓/角色/CSRF/版本/状态约束、未发货/取消/原配送拒绝、关闭开关成功原键恢复、事件/审计失败及晚期会话失效完整回滚、SQL不可变来源和事件/投影配平、筛选和游标边界。对订单、原发货、原预占、仓库/批次/库位、积分、流水、Outbox前后全量比较不变。读取共享锁完善后7项专项再次通过；不声称全量历史回归。
- 实际API+PG+React StrictMode+Chrome：后台空态/查询筛选、消费者读取失败重试、类型/说明表单、提交成功响应丢失后重载原键恢复、桌面及390px后台回复、回复成功响应丢失后重载核实、用户回复进度及补充、旧后台版本拒绝/清理/刷新、门店结束/用户重新反馈、状态筛选空态、切换账号清理旧说明、后台操作前失权清理详情/表单。16张截图，页面错误与横向溢出断言通过。实际查看手机提交表单、后台回复表单和用户处理进度；调整手机主按钮使其与现有绿色主操作一致。
- Prisma生成、全工作区build（API/Worker/后台/H5/微信weapp）、typecheck、lint、OpenAPI导出通过。浏览器验证时修正账号切换断言为实际服务端文案，并发现/修复重新读取详情后仍保留上次“结束”选择的问题，读后默认恢复“回复”；补充异步身份读取后的页面序列检查。无依赖升级。pg并发query弃用提示和Vite包体积提示保留。
- 随机schema自动清理，合成用户/地址/反馈，未改业务主库/.env、未部署生产、未调用真实退款/退货/补寄或外部客服消息。微信开发者工具/真机、真实快递交接与生产发布仍未验。

## 页面与复跑

[用户表单](UI-E4B-AFTERSALES-MINI-FORM-2026-11-03.png)、[用户原键恢复](UI-E4B-AFTERSALES-MINI-UNKNOWN-2026-11-03.png)、[后台回复表单](UI-E4B-AFTERSALES-ADMIN-REPLY-FORM-2026-11-03.png)、[手机后台](UI-E4B-AFTERSALES-ADMIN-REPLY-MOBILE-2026-11-03.png)、[后台原键恢复](UI-E4B-AFTERSALES-ADMIN-UNKNOWN-2026-11-03.png)、[用户处理进度](UI-E4B-AFTERSALES-MINI-PROGRESS-2026-11-03.png)、[结束](UI-E4B-AFTERSALES-MINI-CLOSED-2026-11-03.png)、[重新反馈](UI-E4B-AFTERSALES-MINI-REOPENED-2026-11-03.png)、[版本冲突](UI-E4B-AFTERSALES-ADMIN-STALE-2026-11-03.png)、[账号切换](UI-E4B-AFTERSALES-MINI-ACCOUNT-SWITCH-2026-11-03.png)、[失权清理](UI-E4B-AFTERSALES-ADMIN-ACCESS-REMOVED-2026-11-03.png)。截图本地忽略保存。

专项npm run test:after-sales；相关回归tests/redemption-express-corrections.integration.test.ts和redemption-express-shipping.integration.test.ts。设置YUMI_LIVE_UI=1、现有YUMI_PLAYWRIGHT_PATH及本机YUMI_CHROME_PATH后npm run verify:after-sales:ui。消费者为同源码浏览器适配验收，不代表微信真机通过或商城上线。
