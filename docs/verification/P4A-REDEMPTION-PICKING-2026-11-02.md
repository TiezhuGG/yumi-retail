# P4a 兑换真实拣货任务接入与领取/取消竞争 · 2026-11-02

分支：积分商城。状态：本地实现与隔离PG/浏览器验证通过，未上线。P4首个切片：兑换Outbox→唯一真实来源拣货任务→合法员工竞争领取，以及消费者取消与任务领取的互斥。没有逐项核对、缺货处置、打包出库、骑手配送或售后，不代表P4整体或商城上线。

## 范围与业务动作

- Worker仅处理已扣积分、仍ACTIVE的独立兑换单，通过外键关联真实预占批次/库位。创建READY任务不扣第二次积分、不再预占、不减少on_hand，不连接picking_lab_tasks、现金支付或合成商品。
- 首轮PENDING或到期RETRY可抢占为LEASED；独立随机租约令牌，默认30秒。多个Worker使用SKIP LOCKED，每单最多一个任务。处理前后都核验令牌/租约有效期；旧Worker不能完成新租约。任务、CREATED事件、COMPLETED待办事件同事务，晚期失败回滚。
- 失败只记录固定错误码，不保存原始SQL或私密异常。第1/2次按2/4秒退避，第3次失败进入FAILED；租约过期可恢复，连续3次过期也进入FAILED。订单、积分及预占不因后台失败丢弃或自动退款。仓管/负责人核查修复后，可按当前版本、原键重试，重置新一轮最多3次尝试；普通拣货员不能重置。
- SUPER_ADMIN、WAREHOUSE_MANAGER、PICKER可读取本人授权仓库的任务；上述角色可领取READY，前两者可重试FAILED。OPERATIONS、DISPATCHER、RIDER无作业权限。领取人由当前有效会话推导，客户端不能填写owner或任意状态。任务一旦CLAIMED不可由别人抢领或重派。
- 建任务与领取都校验经营仓库启用、商品/规格/分类有效、实际扣积分证据、完整预占、盘点/库存冻结、批次效期、库位启用及各层预占量。已受理兑换不因商城调价或兑换商品下架而自动作废，但原SKU/普通商品停用、实物资格异常会阻断作业。此处使用本人已预占量，不能错误地要求同样数量的“自由库存”。
- 消费者可以在PENDING/LEASED/RETRY/FAILED，或任务已创建但仍READY时取消。取消同事务停止Outbox、把READY任务置CANCELED并记消费者事件、释放预占和配额、退积分。若租约已获取，取消使旧令牌失效，Worker不得建单。
- 领取与取消按库存→订单→Outbox→任务顺序串行。取消先完成：员工领取409且无owner；领取先完成：消费者直接取消409 CANCELLATION_REVIEW_REQUIRED，不退分、不释放预占。消费者界面此时隐藏直接取消并提示联系门店核实；协调停止/取消能力在后续切片实现，不伪造已停止履约。

## Worker与开关

- `REDEMPTION_PICKING_DEV_ENABLED=0`：API领取/人工重试默认关闭，读取和既有消费者取消不依赖该写开关。
- `REDEMPTION_FULFILLMENT_WORKER_ENABLED=0`：自动建任务默认关闭。启用后现有Worker每秒处理一次待办，沿用其健康/退出流程；关闭新增兑换不妨碍已受理单的待办处理。
- 两个开关仅供本机开发/测试，生产、公开API绑定、远程或非yumi_dev/yumi_test数据库拒启；连接URL只允许schema选项，拒绝通过host等选项绕过本机限制。没有修改已有.env或启动业务库Worker。
- `.env.example`和本机预检已纳入两个默认关闭开关。真实投产需要另行满足P5、正式身份/业务参数和生产授权，不能简单把开发开关改成生产放行。

## 数据、锁与回退

新增迁移202611020013_redemption_picking：扩展redemption_outbox状态、attempts/version、lease_token/lease_until、next_attempt_at和last_error_code；新增不可变redemption_outbox_events、redemption_picking_tasks、redemption_picking_events及索引/复合外键。

任务按order_id唯一，经(order_id,warehouse_id,sku_id)复合外键关联兑换来源；task_id/order_id复合外键约束作业事件。SQL保护READY→CLAIMED/CANCELED、初始READY、版本递增、来源不变、合法Owner角色/仓库，以及事件/任务/Outbox/订单一致性。CLAIMED不允许消费者取消；终态和事件不可改删。旧PENDING/CANCELED待办保留version=0，不伪造历史任务或租约事件；任何后续变更必须递增版本且有对应不可变事件。

P3的积分、地址快照、预占配平约束继续保留；只替换其Outbox状态检查以允许LEASED/RETRY/FAILED/COMPLETED。领取不改变兑换主状态或主单version，任务有独立version；消费者取消必须核验最新任务状态，不能仅凭订单version判断安全。

租约抢占只短暂持有Outbox行锁，不反向取得订单/库存锁。建任务处理：仓库/商品元数据共享锁→库存余额、批次、位置和库位锁→订单→Outbox。领取先事务内核验并共享锁定员工/会话/角色/仓库，再按相同库存/订单/待办/任务顺序处理。取消仍保留P3账户/商品→库存→订单→Outbox→任务顺序；Worker和员工领取不反向锁积分账户或兑换商品，因此不与扣分/取消形成反向锁链。

库存与商品锁实现从API原样下沉至数据库共享模块，现金订单仍通过原语义包装调用，并执行现金订单/报价回归。领取事务末尾重读当前会话及真实时钟下的批次资格；慢写入期间过期也回滚。

仅随机临时PG schema重放，未应用业务主库/生产迁移，不生成真实经营数据。必须先迁移，再部署匹配API与Worker。旧P3版本不能正确取消扩展状态及递增待办版本，因此不得在新任务/租约事实存在后直接回退旧API；先关闭新增兑换及两个作业开关，保留兼容读取/取消版本、任务及事件，不能删表或流水回滚。已领取任务仍需后续协调机制处理，不因回退自动归还。

## API与界面

OpenAPI0.43.0已从实际实现导出。接口基路径`/api/v1/warehouse/warehouses/:warehouseId/redemption-picking`：

| 接口 | 作用 |
| --- | --- |
| GET 基路径 | 按cursor、status（READY/CLAIMED/CANCELED/FAILED/QUEUED）、mine=1读取本仓任务和待办，每页20，UUID升序 |
| GET /:id | 按兑换单ID读取来源商品、批次/库位、预占件数、当前资格、领取人和待办尝试/错误；不返回顾客联系资料、加密地址或租约令牌 |
| POST /:id/claim | version为当前任务版本，Idempotency-Key、员工Cookie、Origin/CSRF；不允许指定领取人 |
| POST /:id/retry | version为当前失败Outbox版本，负责人/仓管专用，幂等且审计 |

新增redemption-picking.read/claim/retry权限，服务端对每次请求和事务写入重验。常见错误REDEMPTION_PICKING_DISABLED、PICKING_BLOCKED、TASK_ALREADY_CLAIMED、ORDER_CANCELED、VERSION_CONFLICT、FORBIDDEN、CURSOR_INVALID；不把拒绝当作领取成功。

后台与移动作业端新增独立“兑换拣货”导航，按仓库/任务状态/本人筛选、列表和独立详情组织。普通操作者看到商品名称规格、兑换单号、批次库位和数量，无UUID/版本/请求键输入。资格是读取时快照，按钮禁用不能替代服务端领取裁决。显示建任务尝试及固定错误原因；只有管理角色可核查后重试。领取响应未知时，sessionStorage按员工+仓库保存原订单/动作/版本/键；侧栏保留组件，整页重载可恢复原请求，不产生第二次有效领取。

消费者与后台兑换订单同步PENDING、READY_TO_PICK、PICKING、REVIEW_REQUIRED及CANCELED展示。消费者待领取可取消、已领取隐藏直接取消；不显示假出库/配送/送达结果。UI沿用ui/board1和ui/mini1及既有品牌绿/白色卡片，仓库按任务组织；本轮只领取，逐项核对与出库入口尚未提供。

## 验收与实际检查

边界案例：默认关闭及隔离限制、并行Worker唯一租约/任务、重复完成、取消在建任务前/后生效、双员工竞争、领取撞取消、旧令牌/租约恢复、退避耗尽和管理重试、冻结/效期/库位/源SKU资格、晚期失败及慢写入回滚、角色/跨仓/CSRF/事务内撤权、真实Worker进程启停/重启不重复建任务。

- 新增12项真实PostgreSQL专项通过；实际启动Worker子进程验证关闭时保留PENDING、启用后建任务、重启不重复；所有子进程和随机schema清理。
- 原交易回归45项通过：P3兑换12、积分账户/发放/冲正8、兑换商品6、现金订单10、现金报价9；没有把这45项冒称本轮新增用例。
- 实际API/临时PG浏览器闭环通过，17张截图：后台空/待建/待领/冻结、仓库手机领取未知结果及重载原键恢复、领取人同步、消费者待领取消及已领禁取消、租约耗尽/管理重试/恢复、手机503重试和加载。截图检查无页面横向溢出、无页面运行错误；已实际查看手机任务、后台失败、消费者拣货状态，调整筛选触控布局并校正粘性导航的全页截图位置。
- Prisma生成、全工作区构建（API/Worker/后台/作业端/微信weapp）、完整typecheck、lint、git diff --check均通过；OpenAPI0.43.0导出和微信产物/三个导入根检查通过；新增作业及Worker开关纳入本机预检，4项配置测试通过。另重跑原P3浏览器闭环通过，19张回归截图，确认报价/扣分/取消原键恢复、24条订单分页和账户清理行为保持有效。执行环境Node24.22.1、pnpm10.28.2，无依赖升级。日志有当前Prisma/pg适配器的查询串行弃用提示；本轮未修改锁定依赖，未将提示当作测试失败或未来版本兼容通过。

浏览器使用真实React/Taro页面源码和API，Taro组件/存储/生命周期桥接仅用于同源码预览，不是微信开发者工具/真机验收。移动作业端为手机宽度H5浏览器，未声称真实仓库人员在手机实物作业通过。没有真实出库、支付、配送或生产操作。

## 重跑与截图

保持本机PG、已有.env中的TEST_DATABASE_URL和锁定Node，不输出连接凭据：

- `npm run test:redemption-picking`：12项专项，含真实Worker子进程生命周期。
- `npm run verify:redemption-picking:ui`：需YUMI_LIVE_UI=1，YUMI_PLAYWRIGHT_PATH指向已有Playwright，YUMI_CHROME_PATH指向本机Chrome；随机schema/临时API/built预览，完成即清理。
- `npm run test:redemptions`、`test:points`、`test:rewards`、`test:orders`、`test:checkout`用于相关回归。

[手机待领取](UI-REDEMPTION-PICKING-OPS-READY-2026-11-02.png)、[原请求恢复](UI-REDEMPTION-PICKING-OPS-UNKNOWN-2026-11-02.png)、[本人已领取](UI-REDEMPTION-PICKING-OPS-CLAIMED-2026-11-02.png)、[后台失败](UI-REDEMPTION-PICKING-ADMIN-FAILED-2026-11-02.png)、[人工重试](UI-REDEMPTION-PICKING-ADMIN-RETRY-2026-11-02.png)、[消费者拣货中](UI-REDEMPTION-PICKING-MINI-PICKING-2026-11-02.png)、[领取前取消](UI-REDEMPTION-PICKING-MINI-CANCELED-2026-11-02.png)。截图本地忽略，不提交真实资料。

## 后续与未验证

下一切片P4b：领取人按真实预占逐项数量核对、缺货/破损上报及未决阻断；随后协调取消、打包/幂等真实出库、骑手与售后。已领取者停用后的管理接续/重派、任务核对完成、部分出库、长期负载和超过20条本切片作业列表的规模UI另待验收。当前不允许已领取自动退分释放；P4与P5未整体通过。

真实微信身份/网络与真机、真实商品仓库人员/经营规则、生产部署/备份恢复仍未验收。经营未确认参数保持未配置，不能把本地真实来源任务当作实际经营上线。


代码自查已核对Worker租约与取消的锁序、真实来源复合外键、状态/事件约束、事务权限及末尾时钟、原键恢复与读取隔离、旧P3取消迁移兼容边界。业务主库和生产未应用迁移，未改变已有.env或操作真实顾客积分/实物。
