# P4f 真实兑换配送异常上报与未决阻断 · 2026-11-03

分支：积分商城。已核对P4e代码、迁移202611030002、13项专项及历史验收记录，当前接续P4f。状态：本地隔离验证通过，未上线，无真实人员/实物操作。

## 本轮边界

已接货、尚未骑手确认送达的单，由当前有效原骑手本人上报无法联系、地址异常、破损、拒收或其他异常，必填最长300字说明。后台、骑手与消费者订单显示待核查；消费者只收到异常布尔标识及门店联系提示，不返回内部异常说明、人员身份或额外地址。

异常是独立不可变事实，不覆盖原接货、开始或出库事实；HANDED_OVER/DELIVERING仍代表实际已发生阶段。未决异常进入readiness.blockers，禁止新增开始/送达。上报允许在库存效期/冻结或原分配人资格出现问题时留证，但要求原接货归属、当前骑手/会话/本仓权限及ACTIVE/CHECKED来源仍合法。不借由异常退积分、回库、取消、重派或更改配额。本轮每个原接货仅一条异常；处置和恢复由下一项新增模型，不提供直接删除异常入口。

## 实现

新增迁移202611030003_redemption_delivery_exceptions和Prisma RedemptionDeliveryException：原handoff/order复合来源、唯一handoff、类型/说明、本人actor、request及实际数据库时间。独立SQL触发器校验原骑手及送达前资格，事实禁止更新/删除；START/COMPLETE的SQL门禁锁同一handoff并拒绝已有异常。应用沿用人员→元数据→库存→订单→任务→shipment协议，重读阶段和异常，异常/审计/幂等结果同事务；晚期会话校验失败亦回滚。例外上报不因货品已异常而被禁止留证，不能据此绕过配送推进资格。

POST /api/v1/warehouse/warehouses/:warehouseId/redemption-delivery/:id/exception，body仅handoffId、kind、reason；员工Cookie、Origin、CSRF、Idempotency-Key及RIDER的redemption-delivery.work。管理人员不能替另一骑手报异常。额外字段/类型错误400，错来源/重复异常/已送达409，其他骑手或范围外拒绝。默认作业开关关闭和生产/远程拒启沿用P4d/e，不增开关、不改.env。

配送列表/详情新增exception（授权员工可见id/kind/reason/createdAt），readiness增加DELIVERY_EXCEPTION_OPEN，canStart/canComplete变false。消费者/运营兑换订单增加deliveryExceptionReported，保留原履约阶段并优先显示“配送异常待处理”。已消费库存、积分、订单主状态及个人/总配额均不变。API版本0.48.0已从代码导出。

骑手手机独立异常表单，说明为空禁提交；未知网络/5xx保留原请求，重载后原键核实。后台列表/详情和消费者列表/详情优先展示异常，历史阶段另保留。未决期间推进按钮禁用，文字联系负责人，没有尚未实现的恢复按钮。

## 验证

Node24.22.1、pnpm10.28.2、本机PostgreSQL，未安装升级依赖。

- 3项新增真实PG组合用例与13项P4e回归合计16项通过。覆盖原键重复/摘要冲突、本人归属/管理不得代理、接货前拒绝、非法类型/字段、开始阻断、SQL事实不可变和异常后START拒绝、消费者不泄露备注、异常与COMPLETE竞争仅一方成功、晚期审计失败回滚及原键恢复。
- 库存/位置/批次/积分/原订单及预占快照验证异常上报无副作用。P4e全部阶段、权限、效期、会话到期与撤仓回归通过；未重跑所有105项历史集合，不据此宣称全量回归。
- 实际API/临时PG浏览器：原分配/接货/读取弱网回归，异常表单、上报成功响应丢失、重载原键恢复、本人推进禁用、后台与消费者异常提示通过，24张本地截图。已实际查看手机表单/阻断及消费者截图，修正表单纵向布局、状态主标题后整套重跑。消费者只显示通用待核查文案，未展示骑手私有说明。
- Prisma生成、全工作区build（API/Worker/后台/H5/微信weapp）、完整typecheck、lint及OpenAPI导出通过。pg串行查询弃用及浏览器适配包体积提示沿用环境，未更换依赖。

截图：[手机异常表单](UI-REDEMPTION-EXCEPTION-RIDER-EXCEPTION-FORM-2026-11-03.png)、[响应丢失](UI-REDEMPTION-EXCEPTION-RIDER-EXCEPTION-UNKNOWN-2026-11-03.png)、[原键恢复和阻断](UI-REDEMPTION-EXCEPTION-RIDER-EXCEPTION-BLOCKED-2026-11-03.png)、[后台](UI-REDEMPTION-EXCEPTION-ADMIN-EXCEPTION-2026-11-03.png)、[消费者](UI-REDEMPTION-EXCEPTION-MINI-EXCEPTION-2026-11-03.png)。截图本地忽略保留，不提交。

复跑npm run test:redemption-exceptions；UI设置YUMI_LIVE_UI=1、现有YUMI_PLAYWRIGHT_PATH及Windows本机YUMI_CHROME_PATH后npm run verify:redemption-exceptions:ui。仅本机yumi_test随机临时schema，结束清理。小程序同源码浏览器桥接不等于开发者工具、合法域名或真机验收。

## 兼容与后续

只在临时schema重放迁移，未应用业务主库/生产。须迁移后部署新API及三端；旧代码不识别异常，虽SQL阻断新阶段，但会显示错误可操作状态，不可盲退。停写、保留新事实/查询/取消保护，不删异常、不再次动库存或积分。

下一项P4g：本仓负责人/仓管的配送异常处置凭据与恢复，保留原异常，由原骑手按合法阶段继续；退回、协调取消、重派/撤权接续及售后仍需后续切片。真实经营规则、微信/真机、实物送达和生产验收仍未通过。P4/P5未整体验收，商城未上线。
