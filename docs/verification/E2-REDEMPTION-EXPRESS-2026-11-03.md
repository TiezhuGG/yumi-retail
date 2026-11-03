# E2 快递收货地址与订单模式 · 2026-11-03

分支：积分商城。沿用用户明确的快递首发路线及既有绿色UI，原仓配/骑手快照与代码保留，E1改动保留。本轮完成地址、规则和快递订单待发货基础，不实施E3运单发货，不上线。

## 行为与验收边界

小程序“快递收货地址”独立于原小区地址，填写完整省名、市、区县、详细地址、姓名、电话及选填备注。最多20条，本人管理默认/编辑/软删除，独立版本与原键恢复；全部收件字段加密保存，删除后清除地址载荷，订单原快照不跟随改动。页面隐藏和换账号清理旧资料；未知写结果只允许原账号核实，普通消费者不输入UUID/版本/请求号。

后台兑换订单页增加独立折叠“快递寄送规则”：是否开放、完整省名白名单、商家承担运费及调整原因。缺配置默认暂停，不默认全国发货；当前唯一支持SENDER_PAID，顾客现金运费0分，不支持到付或运费现金支付。省市区人工填写，服务端严格非空/长度/控制字符/电话校验并按省名白名单匹配；没有行政区划从属校验、地址定位或承运可达验证，寄出前须人工核实。规则更新有版本、原键、当前权限和变更前后审计，不能声称真实经营参数已确认。

兑换确认改用快递地址及明确EXPRESS模式，核验规则和地址版本后120秒报价，再同事务扣积分/占库存/占配额和创建订单。暂停、范围变化、规则版本变化（包括暂停后重启）或地址变化均拒绝旧报价，不擅自改单。新单显示“待快递发货 · 商家承担运费”，后台/打印同步完整结构化地址；旧单仍为LOCAL_NO_CASH，旧地址/现金流程不变。

Outbox新EXPRESS_WAIT仅表示待快递发货。Worker只选择LOCAL_NO_CASH，SQL拒绝为快递单创建骑手拣货或进入原本地队列状态。打印不发货，不扣第二次库存。当前快递单未发货，可复用本人取消、一次退分/释放预占配额；E3再接快递公司/单号与真实库存出库，E4再完成发货竞争/纠错售后验收。

## 实现与兼容

新增迁移202611030007_redemption_express：ConsumerExpressAddressBook/Address/Operation/Audit独立表，默认地址部分唯一索引、软删除/加密载荷约束、不可变审计；RedemptionExpressPolicy按仓保存enabled/provinces/SENDER_PAID/version。RedemptionOrder新增delivery_mode，旧单默认LOCAL_NO_CASH，新单必须与原报价模式一致且模式不可改。扩展Outbox状态、合法取消转换及原积分库存配平约束，保留所有旧事实。

新接口：GET/POST /consumer/express-addresses，POST /:id/update、default、delete，消费者Bearer/版本/原键及事务内会话，未知结果可原键确认；GET /redemption-express-policy公开范围；GET /admin/redemption-express-policy、POST /update沿用本仓SUPER_ADMIN/OPERATIONS、points.read、Cookie/Origin/CSRF/原键。规则缺失默认disabled、provinces为空，不通过默认值放行。普通订单列表仍不泄露收件资料，E1打印在原授权事务内解密订单快照。

原POST /consumer/redemption-quotes增加可选deliveryMode（省略兼容旧本地模式），快递报价快照含EXPRESS、shippingFeeMode:SENDER_PAID、shippingFeeCents:0；兼容areaVersion字段在快递模式承载规则版本。地址簿版本与规则共享锁保护提交期间快照，库存/账户锁及最终会话/效期校验复用原交易。消费者订单与打印地址契约为两种结构oneOf，增加EXPRESS_WAIT_SHIP；OpenAPI0.53.0由代码导出。

仅随机临时schema重放迁移，不改业务主库、现有.env或生产，不新增外部账号、快递服务或付费资源。开发交易默认关闭及生产/远程拒启保持。部署须先迁移再更新匹配API/Worker及三端，旧SDK不理解快递地址和状态，不能盲退或将新单改回本地；旧数据无须伪造地址回填。正式收件配置、微信工具/真机、实物快递与生产验收未通过。

## 实际检查

Node24.22.1、pnpm10.28.2，现有PostgreSQL、Chrome及依赖。

- 4项新真实PG组合用例与3项E1打印、12项原兑换交易回归共19项全部通过；补充跨账号快递地址报价和规则重启后旧报价拒绝后，本轮4项再次完整通过。覆盖独立加密地址/默认/版本竞争/原键摘要冲突/软删除、本人归属、快递扣分预占原键一单、Worker不建骑手任务、SQL拒绝错队列、原地址打印快照、取消退分与释放、默认暂停/范围外/过期规则、旧本地单继续建原任务、配置权限/版本/审计与晚期事件失败回滚恢复。未声称全量历史仓配回归。
- 实际API/临时PG/React StrictMode浏览器：地址空态/表单、地址响应丢失原操作重试、配置缺失阻断报价、规则响应丢失/刷新后回原订单模块原键恢复、快递报价及0现金运费、下单响应丢失/重载原键恢复、消费者/后台待快递发货及完整地址、快递配货打印；补验隐藏/切换账号后原快递地址清理。共15张最终截图。页面错误和横向溢出断言通过；实际查看手机地址表单、快递订单与后台规则截图。
- Prisma生成、全工作区build（API/Worker/后台/H5/微信weapp）、typecheck、lint、OpenAPI导出通过。初次weapp发现运行时直接引用工作区外TypeScript接口文件未被Taro转译，已改为小程序内格式化帮助函数并全构建复验通过；没有换依赖或打包架构。浏览器脚本已按真实按钮文案及刷新后的实际模块导航修正再运行，不将测试等待当业务实现。
- 不声称浏览器桥接等于微信开发者工具/真机，或打印预览等于真实打印机/快递交接。既有pg弃用及预览包体积提示保留。

截图：[手机地址表单](UI-E2-EXPRESS-MINI-ADDRESS-FORM-2026-11-03.png)、[地址原键恢复](UI-E2-EXPRESS-MINI-ADDRESS-UNKNOWN-2026-11-03.png)、[配置暂停](UI-E2-EXPRESS-MINI-CHECKOUT-PAUSED-2026-11-03.png)、[后台配置](UI-E2-EXPRESS-ADMIN-POLICY-FORM-2026-11-03.png)、[规则恢复](UI-E2-EXPRESS-ADMIN-POLICY-RECOVERED-2026-11-03.png)、[报价](UI-E2-EXPRESS-MINI-EXPRESS-QUOTE-2026-11-03.png)、[快递订单](UI-E2-EXPRESS-MINI-EXPRESS-ORDER-2026-11-03.png)、[后台打印](UI-E2-EXPRESS-ADMIN-EXPRESS-PRINT-2026-11-03.png)、[账号切换](UI-E2-EXPRESS-MINI-ADDRESS-ACCOUNT-SWITCH-2026-11-03.png)。截图本地忽略保存。

复跑npm run test:redemption-express；UI设置YUMI_LIVE_UI=1、现有YUMI_PLAYWRIGHT_PATH及本机YUMI_CHROME_PATH后npm run verify:redemption-express:ui，结束清理随机schema。下一项E3：后台待发货/已发货、快递公司和运单号录入、一次性库存出库与确认发货。商城仍未上线。
