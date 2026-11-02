# P3 兑换报价、扣分预占、订单与取消 · 2026-11-02

分支：积分商城。状态：本地实现与隔离验证通过，未上线。此切片提供消费者报价/确认兑换、积分与库存/配额原子提交、双方订单查询和履约开始前本人取消。不接入支付、不调用合成拣货或配送任务，不开放生产兑换。P4负责真实拣货、出库、骑手及售后。

## 功能边界与规则

- `REDEMPTION_DEV_SUBMIT_ENABLED`默认0，只有本机开发/测试可启用；生产、非本机API绑定、非本机yumi_dev/yumi_test数据库均拒绝启用。没有修改已有.env、业务主库或经营开关。关闭新增兑换后，原成功请求重放、订单读取与取消仍可处理。
- 纯积分本机验证，不收现金运费，不套用现金起送门槛，不建支付单。这是隔离开发行为，不代表“不收运费”经营方案已确认。真实预算、商品积分价、人员与配送售后参数仍待确认，P5前不得向顾客开放。
- 每次单SKU、整数件数，使用本人有效地址及地址簿版本。报价绑定用户、兑换商品版本、规格/价格/标题、数量、地址版本、服务范围版本及商品资料版本；有效期120秒。报价只读积分与库存，不扣分、不预占、不占配额。重复原键保留原有效期，已过期报价不延期；每人最多20条尚未过期报价。
- 提交只接受quoteId，客户端不能指定总积分/单价。重新核验身份、开放时间、商品/分类/规格、本人地址和范围、余额、累计限兑/总配额、真实库存与批次资格。改价或规则/地址变化要求重新报价确认，不自动多扣积分。
- 成功同事务保存独立兑换单及加密地址快照、负积分流水、实物预占及批次/库位账本、配额事实、不可变业务事件、唯一履约Outbox和幂等结果；任一失败全部回滚。预占不减少on_hand，送达/出库均未实现。
- 总配额与个人累计用量按有效兑换单的件数聚合，在兑换商品行锁内裁决；本轮只有ACTIVE/CANCELED，取消释放用量，不单独维护易漂移的计数器。后台不允许把总配额/个人限额调低至当前有效用量以下。P4增加完成态后，完成和售后订单仍须计入累计限兑，不因退积分自动释放。
- ACTIVE订单记录已扣积分和实物预占，Outbox为PENDING，双端明确显示“待履约接入”。当前无消费者付款流程，无假支付成功、假拣货、假送达。
- 仅本人可取消当前未开始履约的订单；检查版本及PENDING待办，锁内释放全部预占、追加一次正积分退还流水、把Outbox和订单标记CANCELED，原负流水/预占/事件均保留。原请求及不同键重复取消均不二次退分。关闭新增兑换、商品下架或库存冻结不妨碍释放已有预占。
- 不能随意改订单状态；后台只读，普通运营不能代替消费者取消。开始拣货后协调取消、取消撞领取/出库、部分退分及退货属于P4，当前不能声称已验证这些竞争。

## 数据、锁顺序与兼容

新增迁移`202611020012_redemptions`及Prisma模型：redemption_quotes、redemption_orders、redemption_allocations、redemption_outbox、redemption_events。积分流水增加可空staff actor、consumer_actor_id、redemption_id与redemption_action；CHECK确保员工调整或本人兑换来源恰选一种，消费者不会冒用员工。旧员工流水不回填、不改写。

兑换单通过(quote_id,user_id)约束报价归属，通过(reward_id,warehouse_id,sku_id)复合外键约束兑换来源；预占通过(order_id,warehouse_id,sku_id)复合外键关联真兑换单，并连接实际批次/库位及预占/释放流水。没有无外键的“订单来源字符串”。兑换和现金预占是独立关联表，实物余额/批次/位置/账本共用。

SQL延迟约束核对兑换快照金额、负流水/取消正流水、预占件数与库位流水、业务事件和Outbox；额度约束同时覆盖商品调额和有效订单变化。报价、事件、流水不可改删，来源与订单快照不可改；预占只允许首次填释放凭据，订单只允许ACTIVE→CANCELED且版本递增。Outbox只允许PENDING→CANCELED，本轮没有Worker领取或消费它。

锁协议：有效消费者会话/用户共享锁→本人兑换请求advisory锁及幂等检查→积分账户FOR UPDATE→兑换商品FOR UPDATE→地址簿/范围/经营仓库共享锁→商品/分类/规格共享锁→按SKU排序的库存余额、批次、库位位置及库位启用锁。提交后的业务动作、幂等结果均同事务。取消在账户/商品/库存后再锁订单和Outbox。发分/冲正仍按原协议最终锁账户；不额外取得兑换商品或库存锁。

现金订单原有的metadataLocks/inventoryLocks原样提取成共用函数；预占增量函数保留ORDER默认前缀，兑换显式使用REDEMPTION前缀。没有改变现金单锁顺序和语义，已经加入现金订单/报价回归。相反锁序导致的可重试DB冲突返回503并要求原请求恢复，不使用Redis作账本或库存唯一真相。

事务末尾重新检查真实时钟下报价/批次/开放时间和会话有效期；等待和晚期事件写入期间过期也必须回滚。幂等摘要仅含规范化业务编号/版本/数量，不含明文联系资料。地址快照继续AES-256-GCM并绑定用户与兑换单ID；后台订单响应不返回顾客地址、电话或解密资料。

仅在随机临时PostgreSQL schema重放迁移，未迁移业务主库或生产；不迁移合成订单为真单。部署先迁移再运行对应版本，默认保持新增兑换关闭。回退先停新增，保留受理单的查询/取消、Outbox与账本；不能删流水恢复积分。新消费者流水允许actor_id为空，旧SDK模型可能不兼容，不能在已有兑换流水后直接回滚到未识别消费者actor的旧版本；须保留兼容查询/模型及受理单处理能力。

## API与页面

OpenAPI0.42.0已从实际实现导出。前缀/api/v1，消费者Bearer与员工Cookie/Origin/CSRF沿用：

| 接口 | 请求与行为 |
| --- | --- |
| POST /consumer/redemption-quotes | rewardId、rewardVersion、quantity、addressId、addressVersion及Idempotency-Key |
| GET /consumer/redemption-quotes/:id | 仅本人报价，返回原有效期和expired |
| POST /consumer/redemptions | quoteId及Idempotency-Key，原子扣分/预占 |
| GET /consumer/redemptions、/:id | 本人列表/详情；cursor/status筛选，详情含本人加密快照的解密结果 |
| POST /consumer/redemptions/:id/cancel | version及Idempotency-Key，整单退分/释放 |
| GET /admin/redemptions、/:id | points.read且当前经营仓库授权，列表keyword/status/cursor，详情含批次/库位预占及动作记录，不含顾客联系资料 |

积分数为十进制字符串，数量为整数件。新增错误包括REDEMPTION_SUBMISSION_DISABLED、POINTS_INSUFFICIENT（说明缺少积分）、QUOTA_EXCEEDED、QUOTA_BELOW_USAGE、STOCK_UNAVAILABLE、QUOTE_CHANGED/EXPIRED/ALREADY_USED、ADDRESS_VERSION_CONFLICT、CURSOR_INVALID、CANCELLATION_REVIEW_REQUIRED等。严格拒绝客户端总额、任意状态和未知字段。列表按UUID升序分页，每页20，非按时间倒序，也非跨页固定快照。

P2公开商品的available新增减去有效兑换的总配额用量，redemptionEnabled反映本机开关；游客展示不计算本人历史已兑量，最终以本人报价/提交裁决。消费者明细新增REDEMPTION/REDEMPTION_RETURN与本人兑换单关联，退还流水关联原负流水，不展示员工身份或内部业务凭据。

小程序新增独立确认兑换、兑换列表、兑换详情页；商品详情显示明确的开发兑换入口，未启用则保持待开放。确认页按本人地址选择、报价有效期、余额/扣除/剩余和明确扣分按钮组织；原请求持久化绑定用户、报价与幂等键，未知结果及整页重载后恢复，不引导换键重复下单。其他账号有待确认操作时提示恢复原账号。取消也保存原键与版本，重复核实不重复退分。已成功兑换必须读取本人详情确认后才清理待核实记录。报价本身无资金副作用，离开页面会放弃内存报价意图，重新进入须重新核验；兑换提交意图不会因此清除。

沿用ui/mini1与ui/board1现有品牌绿、白色卡片、列表/筛选/独立详情；后台独立“积分兑换订单”导航，不把管理和用户确认堆到同页。入口/异步页面包含加载、游客、空、错误及重试状态；隐藏/卸载清除旧资料并忽略迟到响应。真实微信身份、小程序原生网络/生命周期和真机尚未验收。

## 验收边界与实际记录

验收案例：报价幂等/无扣分占用、报价归属/金额权威、同键重复提交、两个设备花最后积分、两个用户争最后配额、个人累计限兑、现金单与兑换争最后实物、改价/下架/范围/冻结/报价过期、晚期事件写入失败及会话/批次过期回滚、取消重复/回滚与原键恢复、员工仓库权限、预占复合外键、双端弱网及账号清理。

实际执行（Node24.22.1、pnpm10.28.2，未升级依赖）：

| 检查 | 结果 |
| --- | --- |
| Prisma生成 | 通过 |
| 全工作区构建 | API/Worker/后台/作业端/微信weapp通过 |
| 微信产物 | 新确认/列表/详情页面及三个导入根通过 |
| 全工作区与根测试typecheck | 通过 |
| lint、git diff --check | 通过 |
| 兑换专项 | 最终12项真实PostgreSQL通过，包含事务末尾会话/批次过期回滚 |
| 相关真实PG回归 | 现金报价9、现金订单10、积分账户/发放/冲正8、兑换商品6，共33项通过；与兑换专项合计45个不同用例 |
| 本机预检配置回归 | 4项通过，新增兑换开关的非零/非法值纳入预检拒绝条件 |
| OpenAPI导出 | 0.42.0通过 |
| 实际API浏览器 | 双端闭环通过，19张截图，无页面横向溢出与页面运行错误 |

PG回归先合跑44项（含当时兑换11项），新增晚期批次过期保护后最终兑换12项全部重跑通过；不是声称最终同一命令一次运行45项。完整构建、类型、lint和微信产物在最终源码下执行。

浏览器验证：本人地址及报价/余额剩余；提交成功响应丢失后保留原键，并在整页重载后恢复为同一兑换单；本人详情确认后清除待核实记录；取消响应丢失后原键恢复，仅一笔退分；后台真实预占/释放与动作证据、小程序正负积分来源；改价拒绝不多扣、余额不足说明；双端24条订单分页及消费者续页503保留前20条/原游标重试；后台空/503重试、消费者游客清理与加载态。实际查看桌面/手机详情、确认页和积分来源截图，按结果统一链接按钮与触控尺寸。

代码自查核对了共享库存锁/预占兼容、事务权限及末尾时钟、积分来源与外键/配平、回滚及重放、双端迟到响应/持久化原意图和迁移回退边界。所有测试使用合成数据和随机临时PG schema；浏览器预览使用实际Taro/React页面源码及API，替换Taro组件/存储/请求/生命周期桥接，不是微信原生验收。测试结束关闭API/浏览器并清理schema。

24条分页场景额外复制经真实API创建并取消的快照，重新按各自ID加密地址、写配平的正负积分与预占/释放流水、事件/取消Outbox；全部外键与触发器保持启用，仅临时schema合成规模夹具，不能当作24次真实兑换。

## 下一步

P4先做真实拣货任务接入、Outbox领取/租约/重试及取消与领取竞争，然后出库、骑手和售后退积分。当前Outbox待办尚无执行器，不能开放真实顾客兑换以积压未履约订单。真实微信登录/HTTPS、真机、经营规则、生产迁移/部署/备份恢复以及全部P5门禁仍未验收。


## 复验与截图入口

使用本机已有PostgreSQL和.env的TEST_DATABASE_URL（不输出连接凭据），锁定Node24路径：

- `npm run test:redemptions`：12项兑换专项，随机schema重放迁移并清理。
- `npm run test:points`、`npm run test:rewards`、`npm run test:orders`、`npm run test:checkout`：相关回归。
- `npm run test:fulfillment:local`：配置预检回归，不等于真实履约门禁通过。
- 设置`YUMI_LIVE_UI=1`、`YUMI_PLAYWRIGHT_PATH`为已有Playwright、`YUMI_CHROME_PATH`为本机Chrome，再运行`npm run verify:redemptions:ui`：临时API及built浏览器预览与截图，完成后清理schema。

主要截图：[确认报价](UI-REDEMPTIONS-MINI-QUOTE-2026-11-02.png)、[提交结果未知](UI-REDEMPTIONS-MINI-CREATE-UNKNOWN-2026-11-02.png)、[待履约](UI-REDEMPTIONS-MINI-ORDER-ACTIVE-2026-11-02.png)、[取消后](UI-REDEMPTIONS-MINI-ORDER-CANCELED-2026-11-02.png)、[后台桌面证据](UI-REDEMPTIONS-ADMIN-DETAIL-DESKTOP-2026-11-02.png)、[后台手机证据](UI-REDEMPTIONS-ADMIN-DETAIL-MOBILE-2026-11-02.png)、[改价需重新确认](UI-REDEMPTIONS-MINI-QUOTE-CHANGED-2026-11-02.png)、[余额不足](UI-REDEMPTIONS-MINI-INSUFFICIENT-2026-11-02.png)、[续页失败](UI-REDEMPTIONS-MINI-PAGE-ERROR-2026-11-02.png)。截图仅本地保留并忽略，没有提交真实用户资料。
