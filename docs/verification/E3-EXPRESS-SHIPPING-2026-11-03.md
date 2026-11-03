# E3 快递确认发货 · 2026-11-03

分支：积分商城。保持既有绿色界面与原仓配扩展，本轮切片为整单人工快递确认及原预占实物一次性出库，完成本地验证，未上线。下一项E4资料纠错、售后和首发验收。

## 本轮行为


后台兑换订单增加待快递发货/已快递发货/原配送筛选；详情展示原收件快照、原预占批次/库位/件数，填写快递公司、实际运单号并勾选整单实物、地址、运单和交快递确认后操作。首发一单一运单、一次整单出库，不支持拆包、分次发货或电子面单。已发货详情、配货打印及消费者订单显示快递公司/运单/记录时间，小程序可复制单号，运输进度由用户凭单号联系快递公司查询，不伪造轨迹或签收。

GET /api/v1/admin/redemptions/:id/shipping返回本仓原地址、发货开关、可发状态、阻断原因及既有凭据，Cache-Control:no-store。POST /:id/ship严格body为version、carrierCode、可选carrierName（OTHER必填）、trackingNo、dispatchConfirmed:true；员工Cookie、本仓SUPER_ADMIN/OPERATIONS、points.read、Origin/CSRF及Idempotency-Key校验。已知承运方代码SF/ZTO/YTO/STO/YUNDA/JD/EMS/POST/DEPPON/OTHER；已知名称服务端固定，其他名称最多40字且无控制字符；运单标准化大写，6至40位字母/数字/连字符，同仓同公司名称与单号不得用于第二单。格式校验不等于快递公司验证。

仅ACTIVE+EXPRESS+EXPRESS_WAIT、原版本、原预占完整且未释放/消费、无骑手任务时可新发货；仓库、商品、批次效期、冻结/盘点、库位、库存及扣分凭据须通过服务端检查。沿用元数据→库存→订单→Outbox锁序，事务内保存发货事实、消费全部原预占，逐项扣减仓库/批次/库位onHand与reserved，创建库存/库位流水、Outbox事件、审计及原键结果。末尾再次校验会话和效期，任一步失败全部回滚。发货与取消互斥，已发货拒绝取消/退分/释放；没有重复扣积分、释放配额或改写原订单版本，原订单status仍ACTIVE，由快递事实和EXPRESS_SHIPPED履约状态表示发货。

发货复用现有默认关闭的REDEMPTION_PICKING_DEV_ENABLED本地作业开关，内部名称不要求运营走拣货页；生产/远程拒启保持。关闭开关阻断新操作，已成功原键可核实。浏览器按员工和订单在sessionStorage仅保留原请求，不保存地址；结果未知时禁止另起请求，重载后可核实原键。资料重读/失权/失败先清旧地址，已知拒绝后需重新获取服务端状态。暂停新兑换的寄送规则不改写已接受订单的原收件/运费快照；发货另受作业开关和实时库存约束。

迁移202611030008_redemption_express_shipping新增RedemptionExpressShipment不可变事实、一单唯一、同仓同承运方运单唯一、来源复合外键、操作者快照和请求编号；数据库延迟约束同时核验整单全部原预占消费、匹配负数库存/库位流水及发货Outbox。扩展EXPRESS_SHIPPED及其事件和合法迁移；保留旧LOCAL_NO_CASH打包/出库校验路径，禁止两种履约混用。没有快递回调、轨迹或签收状态。OpenAPI0.54.0由代码导出，订单/打印增加expressShipment及EXPRESS_SHIPPED，后台列表增加fulfillment过滤，消费者不能使用后台筛选参数。

部署需先迁移再匹配API、Worker及客户端；已消费库存的发货事实不可盲删、盲退旧版本或改回待发货。只在随机临时schema运行迁移和合成验收，未改业务主库/.env/生产。8项专项加31项快递地址/打印/兑换/旧打包回归，共39项真实PG通过；13张真实API浏览器截图通过。未声称全量历史仓配回归或微信开发工具/真机、实物打印机、实际交快递/承运验证、生产验收。下一项E4：纠错留痕、最小售后与受控上线准备。


## 实际验证

- Node24.22.1、pnpm10.28.2、真实PostgreSQL随机临时schema；8项新专项和原快递地址4项、打印3项、打包12项、兑换12项，合计39项全部通过。覆盖准确消费原预占/多批次、原键重复/摘要冲突、同单并发、发货取消竞争、异仓/角色/CSRF/本人隔离、版本/物理确认/单号校验、重复运单、冻结/效期/商品/库位阻断、晚期审计/会话/效期异常整笔回滚、恢复原键、数据库拒绝无出库事实的伪发货和不可变凭据。没有产生骑手任务。
- 实际API+PG+React StrictMode+Chrome：待发/已发筛选空态、原收件信息、读失败重试、库存冻结阻断/修复、输入/勾选约束、桌面与390px手机发货、成功响应丢失后刷新核实原键、消费者已发/复制单号/禁止直接取消、配货打印含运单、撤销本仓权限后地址清除。13张截图，页面错误与横向溢出断言通过。实际查看桌面发货表单及手机已发页，原批次/库位凭据在发货区域下方。
- Prisma生成、typecheck、lint、OpenAPI导出、全工作区build（API/Worker/后台/H5/微信weapp）通过。初次沙箱内Taro目录读取受限，授权本地构建复跑通过。已有pg并发query弃用提示及预览包体积提示，不改变依赖。
- UI错误模拟需覆盖StrictMode重复读取，已修正测试拦截；检查并修复成功重读后按钮忙碌状态，复验原键恢复后刷新按钮可用。临时schema结束清理，截图忽略保存；无生产部署、真实客户或快递账号。

## 页面与复跑

[后台发货表单](UI-E3-SHIPPING-ADMIN-SHIP-FORM-2026-11-03.png)、[手机后台](UI-E3-SHIPPING-ADMIN-SHIP-FORM-MOBILE-2026-11-03.png)、[断网待核实](UI-E3-SHIPPING-ADMIN-SHIP-UNKNOWN-2026-11-03.png)、[原键恢复](UI-E3-SHIPPING-ADMIN-SHIP-RECOVERED-2026-11-03.png)、[消费者运单](UI-E3-SHIPPING-MINI-SHIPPED-2026-11-03.png)、[发货后配货打印](UI-E3-SHIPPING-ADMIN-SHIPPED-PRINT-2026-11-03.png)、[失权清理](UI-E3-SHIPPING-ADMIN-ACCESS-REMOVED-2026-11-03.png)。截图不包含真实客户数据。

专项：npm run test:express-shipping。相关回归为tests/redemption-express.integration.test.ts、redemption-packing.integration.test.ts、redemption-print.integration.test.ts、redemptions.integration.test.ts。UI设置YUMI_LIVE_UI=1、现有YUMI_PLAYWRIGHT_PATH和本机YUMI_CHROME_PATH后npm run verify:express-shipping:ui。页面连接随机schema实际API；消费者浏览器桥接仍需后续微信开发工具及真机验收，不代表已上线或实际快递寄出。
