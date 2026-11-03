# P4d 真实兑换骑手分配与本人接货 · 2026-11-03

分支：积分商城。状态：本地实现、隔离PostgreSQL和实际页面验证通过，未上线。本轮边界为已真实出库来源的兑换单→本仓负责人/仓管分配骑手→被分配骑手本人核对包裹及每项实物后接货。没有开始配送、送达、改派或售后，不把接货当作已配送；P4/P5未整体验收。

## 业务边界与验收案例

- 只读取真实redemption_shipments及原pack/allocation，不使用合成delivery_lab任务或现金订单。尚未出库的兑换单不能分配，客户端不能传任意订单状态。
- SUPER_ADMIN/WAREHOUSE_MANAGER在本仓有效授权内分配启用且有RIDER角色的本仓员工。骑手候选以姓名选择；普通拣货员、骑手和DISPATCHER没有管理分配权限。本轮分配一次保留不可变凭据，不提供覆盖/改派。
- RIDER只能查询和处理分配给自己的出库单。管理人员不能代替另一骑手接货；双角色员工也必须本人被分配且具RIDER资格。接货输入必须绑定当前assignment，核对原包裹数与全部原装包分配完整整数件数并确认实物，不接受部分、错项或重复项。
- 分配及接货检查原出库/消费证明、仓库、原商品/规格、冻结/盘点、库位与效期。接货前同时检查当前骑手与原分配人启用、角色及本仓授权；原分配人不需要保持原登录会话一直在线。保守源资格校验是开发行为，经营应急规则、改派及人员停用接续仍待交付/确认。
- 分配、接货、逐项接货证明不可变，当前阶段由事实派生UNASSIGNED→ASSIGNED→HANDED_OVER。此次不再动库存、积分、配额、原打包或出库事实；失败不自动退款、释放或换人。
- 消费者与后台订单同步ASSIGNED_WAIT_HANDOFF、RIDER_RECEIVED_WAIT_START；仓库出库页同步实际分配/接货阶段，避免已接货后仍提示等待接货。所有已开始履约阶段继续禁止消费者直接取消。
- 列表不返回顾客地址/电话；只有本仓管理人员或被分配本人详情可解密原加密地址快照。错误仓库、非本人和未出库统一404，不泄露资源是否存在。UI在401/403/404后清除旧详情、地址及候选人员，防止失权/范围改变后仍展示缓存地址；操作草稿只保存原请求的来源ID、数量、确认及键，不保存顾客地址。

## 数据与锁、迁移兼容

新增迁移202611030001_redemption_delivery和Prisma模型，仅随机临时schema重放，未修改旧迁移或业务主库。

- redemption_assignments引用原shipment/order，shipment和order各唯一；冻结骑手/分配人id、名称、请求和时间。
- redemption_handoffs引用assignment/shipment/order复合来源，assignment、shipment和order各唯一，记录本人、包裹数/请求/时间。
- redemption_handoff_lines引用同单原allocation和handoff/order，每个分配只接一次，数量为正整数。

全部事实禁止UPDATE/DELETE。SQL约束校验当前ACTIVE真实出库、原拣货CHECKED、本仓管理分配人和有效RIDER本人；接货人必须等于assignment.rider_id。延迟约束要求包裹数和全部原pack_lines与handoff_lines双向完整匹配，拒绝空接货、漏项、额外项及不完整件数。原打包、出库消费及各层库存配平约束继续生效。

事务先共享锁定有效员工会话/角色/本仓授权、骑手和分配人资格，再按商品/库存→兑换单→拣货任务→shipment顺序锁定重读。分配/接货及逐项事实、审计、幂等结果一起提交；撤权在事务内重查，末尾按真实时钟重查会话与批次。晚审计、批次过期或会话到期全部回滚，不影响原出库。完成的历史事实不因日后人员停用而改删。

沿用REDEMPTION_PICKING_DEV_ENABLED默认0，生产/远程拒启，未新增依赖、环境变量或修改现有.env。先迁移再部署匹配API/Worker/三端；Worker共享读取现在关联交接事实，旧库不可直接启动新版本。存在交接后不得盲退旧SDK/API而误显示等待接货；关闭写入、保留兼容查询与取消保护，不删凭据或再次扣库存/退分。

## API与页面

OpenAPI0.46.0已导出。新基路径`/api/v1/warehouse/warehouses/:warehouseId/redemption-delivery`：GET列表、GET /:id、GET /riders、POST /:id/assign和POST /:id/accept。id是原shipment.id；Cookie、Origin/CSRF、Idempotency-Key及当前权限/归属在服务端校验。严格输入/正整数、互斥状态筛选、20条UUID升序分页和游标范围限制。具体请求、错误和隐私投影见[API设计](../api/API-DESIGN-V1.md)、[数据设计](../database/DATABASE-V1.md)。

新增redemption-delivery.read/assign/accept权限，RIDER额外获warehouse.read仅用于本人授权仓库列表，不授予拣货或库存明细读取。新“兑换骑手交接”入口按角色呈现；后台姓名选择分配，手机按原批次/库位清点，普通输入不要求UUID、版本或请求键。

未知网络/5xx保存完整原始动作与输入/键，重载后用原请求核实；分配和接货均不可通过换键重复提交，失权后不能重放。接货页面将核对表单提前至地址/历史之前，出库与交接记录可展开，减少手机寻找主要操作的滚动；数量不符、未核实实物或当前源资格异常时禁用。

## 实际功能检查

使用锁定Node24.22.1、pnpm10.28.2和本机PostgreSQL，全部为临时schema、合成身份、真实收货服务入账及真实兑换/核对/出库API创建的来源。

`tests/redemption-delivery.integration.test.ts`最终整组13项全部通过：

1. 来源快照、不可变分配/接货与原键恢复，库存/位置/流水、积分完全不变，消费者及取消保护同步。
2. 骑手本人任务、未分配池隔离、非本人/错仓404、列表无地址而授权详情解密地址，以及无权限角色拒绝。
3. 候选人员启用/角色及仓库过滤、非法目标、未出库、CSRF、未知字段和无效筛选保护。
4. 精确原包裹数、每个原分配件数、实物确认；拒绝漏项、错项、重复、非整数和旧assignment。
5. 两管理人员竞争仅一次分配，两次不同键接货仅一次事实，无第二次库存变化。
6. 冻结、批次过期及当前骑手/分配人角色或仓库权限变化阻断接货，保留原分配待核查。
7. 分配/接货晚审计失败同事务回滚，原键在修复后各成功一次。
8. SQL拒绝不合法分配对象、改写分配、空接货、删除接货和修改逐项证明。
9. 外层授权后事务内撤仓阻断；恢复后原键可完成，再次失权拒绝重放。
10. 默认关闭时拒绝分配/接货，接货处理中批次到期回滚。
11. 接货审计期间骑手会话到期，接货及逐项事实回滚，库存保持不变。
12. 两个真实批次的完整接货、漏项拒绝且不再次扣库存；仓库出库页反映已分配/已接货。
13. 21个实际出库来源的20+1分页、跨状态/骑手游标隔离，列表不含地址。分页夹具保留同一消费者20份有效报价的既有保护，第21单由另一合法合成消费者报价创建，没有放宽业务代码。

既有79项真实PG回归全部通过：打包/出库12、任务/领取12、核对/异常10、兑换12、积分8、兑换商品6、现金订单10、现金报价9。总计92项PG（13新增+79回归）。每个用例重放迁移并清理临时schema；未操作真实人员、顾客积分或业务实物。

4项本机安全配置检查通过；Prisma生成、全工作区构建（API/Worker/后台/H5/微信weapp）、最终后台/H5构建、完整typecheck、lint、微信产物/三个导入根及git diff --check通过。导出并核对OpenAPI0.46.0及assign/accept路径。现有锁定Prisma/pg仍有查询串行弃用提示，未升级依赖或声称未来版本兼容；验收适配包约1030KB有体积提示，实际后台/H5包约460KB，构建通过。

## 实际UI验证与截图

`scripts/ui/verify-redemption-delivery.mjs`采用实际React/Taro源码、真实API与随机PG schema，20个场景全部通过：后台空列表、无可用骑手、候选读取503、分配表单与未知结果；骑手空列表、另一骑手任务隔离、待接货、数量不符、冻结、完整接货、未知结果；管理/骑手/消费者阶段同步、详情503重试、加载及管理权限撤销后清空私密详情。

分配与接货分别注入“请求已提交但响应丢失”，重载原键恢复，最后只有一份assignment、handoff和逐项接货事实。无页面运行错误或横向溢出。已实际查看后台分配、手机核对表单、消费者待开始配送、撤权后无地址的最终截图，沿用现有UI样式，并将接货操作提前、历史折叠。供负责人审阅，未替代真实人员实物交接或正式UI确认。

- [后台分配](UI-REDEMPTION-DELIVERY-ADMIN-ASSIGN-FORM-2026-11-03.png)
- [分配未知结果](UI-REDEMPTION-DELIVERY-ADMIN-ASSIGN-UNKNOWN-2026-11-03.png)
- [另一骑手无任务](UI-REDEMPTION-DELIVERY-OTHER-RIDER-EMPTY-2026-11-03.png)
- [手机精确接货](UI-REDEMPTION-DELIVERY-RIDER-ACCEPT-FORM-2026-11-03.png)
- [数量不符禁用](UI-REDEMPTION-DELIVERY-RIDER-COUNT-MISMATCH-2026-11-03.png)
- [冻结阻断](UI-REDEMPTION-DELIVERY-RIDER-BLOCKED-2026-11-03.png)
- [接货未知结果](UI-REDEMPTION-DELIVERY-RIDER-ACCEPT-UNKNOWN-2026-11-03.png)
- [本人已接货及记录](UI-REDEMPTION-DELIVERY-RIDER-RECEIVED-2026-11-03.png)
- [消费者待开始配送](UI-REDEMPTION-DELIVERY-MINI-RECEIVED-2026-11-03.png)
- [权限变化清空地址](UI-REDEMPTION-DELIVERY-ADMIN-REVOKED-2026-11-03.png)

截图本地保留并忽略。小程序是同源码浏览器适配，骑手端为390px H5，未使用微信开发者工具或真机，不能当作原生、真机、真实顾客配送或生产验收。

## 复现与后续

使用现有本机TEST_DATABASE_URL和锁定Node，不输出凭据：`npm run test:redemption-delivery`、相关既有PG测试、`npm run verify:redemption-delivery:ui`（YUMI_LIVE_UI=1及已有Playwright/Chrome路径）。脚本创建可运行临时API与页面，结束即清理，无需迁移业务主库。

下一项P4e真实配送开始与送达；后续异常处置、改派与人员停用接续、协调取消、售后退分、规模负载和P5仍待交付。经营应急规则、微信身份/开发工具/真机、真实商品及人员实物作业、生产部署/备份恢复均未验收。本机作业与Worker仍默认关闭，商城未上线。
