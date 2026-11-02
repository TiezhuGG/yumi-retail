# P2 兑换商品管理与商城浏览 · 2026-11-02

分支：积分商城。切片边界：后台维护兑换商品、小程序商城列表和独立详情，复用真实SKU与可售库存。不提供兑换报价、扣积分、预占、订单或履约；这些属于P3/P4。功能与UI本地验证通过，微信工具/真机和生产验收另行执行。

## 功能与规则

- 每仓每SKU仅一个兑换商品，SKU与仓库来源创建后不可更换；草稿→上架/下架，重新上架复用原商品。名称/规格选择，不要求操作者输入UUID。
- 可配置标题、正整数积分价（十进制字符串，技术范围1–10亿）、排序（小值靠前）、每人累计限额、总配额、可选开始/结束时间。每人限额不超过总配额。时间在后台按北京时间输入、API使用UTC ISO；不自动设置经营参数。
- 修改和上下架必须带当前版本、操作原因及幂等键；事务内重新核验员工会话/角色/仓库。审计和原键结果与商品动作同事务，响应丢失使用原请求恢复；旧版本冲突要求重新读取确认。
- 运营及负责人使用points.write，仅限经营仓库。上架重验启用商品/规格/分类；缺货可展示但数量为0。普通商品停用/下架、分类停用、活动未开始或已结束时，公开列表与详情不提供商品。
- 库存使用现金商品同一个SQL计算：批次效期、启用库位、预占/隔离、安全库存、盘点及inventory_hold。没有第二套实物库存。当前最多可选数量为可售数、总配额及每人限额的最小值；P2无兑换记录，不存在已消费配额。P3实施累计用量、事务限额及提交重新核验前，不得开放兑换。
- 列表按sortOrder、UUID稳定游标分页（每页20）；搜索和分类筛选支持中文名称/规格，后台另有状态筛选。游标来源已不匹配时409 CURSOR_INVALID，重新查询；列表不是事务快照，并发改价、排序或上下架后应重新查询。
- 小程序首页/我的有积分商城入口；商城含本人余额入口（游客显示登录查看）、搜索、分类、商品卡片，详情含固定规格、整数数量与积分合计、限额/时间及配送范围入口。无真实图片时沿用明确标注的包装示意。下单按钮禁用并标记待开放，不虚构销量或兑换成功。
- P2详情的积分合计是展示计算，非服务端兑换报价或价格承诺；P3必须实施短期报价、版本检查及变价重新确认。

## API与数据兼容

OpenAPI0.41.0已从实现代码导出。API前缀/api/v1：

| 接口 | 行为 |
| --- | --- |
| GET /rewards | 公开商品，keyword/categoryId/cursor可选 |
| GET /rewards/:id | 当前可公开的商品详情；不可用404 REWARD_UNAVAILABLE |
| GET /admin/rewards | 本仓商品，keyword/categoryId/status/cursor可选 |
| GET /admin/rewards/skus | 名称/规格搜索与游标选择真实SKU |
| POST /admin/rewards/store/create | skuId、title、pointsPrice字符串、sortOrder、perUserLimit、totalQuota、startsAt/endsAt可选、reason；默认草稿 |
| POST /admin/rewards/:id/update | 除skuId外完整规则及version、reason，不更换来源 |
| POST /admin/rewards/:id/publish、/unpublish | version、reason；专用上下架动作 |

员工Cookie、Origin/CSRF与Idempotency-Key约定沿用。响应redemptionEnabled固定false；公开响应不含经营仓库ID、成本、库存批次或现金售价。错误包括VALIDATION_ERROR、VERSION_CONFLICT、IDEMPOTENCY_CONFLICT、REWARD_UNAVAILABLE、CURSOR_INVALID、DUPLICATE_RESOURCE、INVALID_TRANSITION。

新增迁移202611020011_reward_products与Prisma RewardProduct：仓库/SKU外键、同仓SKU唯一、(id,warehouse_id,sku_id)复合唯一供后续预占关联、积分价/限额/时间约束、来源不可变、合法状态迁移、版本递增及拒绝删除。仅临时schema重放验证；未应用业务主库或生产迁移，不回填历史积分，不改变现金单或库存。部署必须先迁移再运行对应API。回退保留商品、审计及幂等事实，暂停商品维护与商城入口，不删事实。

## 验收案例与执行记录

预定验收：创建重复请求不重复建商品；同SKU重复拒绝；改价并发一个成功；旧版本拒绝；事务晚期审计失败回滚、原键可恢复；角色/跨仓/CSRF拒绝；上下架、开放时间、来源停用与库存冻结/安全数/过期/库位停用影响公开展示；排序分页和筛选隔离；双端加载/空/错误/重试及未知结果恢复；无积分或库存写入。

实际检查使用已有Node24.22.1、pnpm10.28.2，未安装或升级依赖：

| 检查 | 实际结果 |
| --- | --- |
| Prisma生成 | 通过 |
| 全工作区build | API/Worker/后台/作业端/微信weapp均通过 |
| build:mini | 最终样式重编译、新商城/详情产物与三个导入根检查通过 |
| 全工作区及根测试typecheck | 通过 |
| lint、git diff --check | 通过 |
| P2真实PG集成 | 6项通过，覆盖上述幂等、并发、权限、库存及SQL约束场景 |
| P1真实PG回归 | 8项通过，共14项PG测试通过 |
| OpenAPI导出 | 0.41.0，通过 |

浏览器通过：后台创建草稿/上架/查看详情/修改积分价，已成功但响应丢失时原请求恢复且版本只加一次；后台与商城23条记录跨页，续页503保留前20条、原游标重试、未提交搜索草稿不影响续页；规格选择23条跨页；商城游客余额入口、详情数量合计、缺货、下架404、搜索空态、503重试和加载态。19张桌面1440/手机390截图与无页面横向溢出检查，控制台无页面运行错误；数据库确认积分流水仍为0。已实际查看后台桌面/手机表单、小程序列表/详情，并据此完善按钮与选中态样式。浏览器预览采用实际页面源码及API、随机临时PG schema；Taro桥接适配仅用于浏览器验证，不代表微信原生、真实微信身份或真机验收。合成数据与截图仅用于开发验证，脚本结束清理临时schema；截图按现有约定本地忽略。

## 下一步与未验证

P3：服务端兑换报价、本人地址、扣积分与实物预占/配额原子提交、双端订单查询与取消、库存/余额/配额竞争和晚期回滚。不能将当前预览商品直接连接合成演练履约。

真实经营规则/商品和人员尚未确认；微信开发者工具与真机、真实身份/HTTPS网络、生产迁移/部署/备份恢复未验。P2不标记商城已上线。


## 复验入口与截图

保持本机PostgreSQL启动，使用已有.env中的TEST_DATABASE_URL及锁定Node路径，不输出连接凭据：

- `npm run test:rewards`：创建随机schema、重放所有迁移并清理。
- `npm run test:points`：P1账户/发放/冲正回归。
- 设置`YUMI_LIVE_UI=1`、`YUMI_PLAYWRIGHT_PATH`为本机已有Playwright、`YUMI_CHROME_PATH`为本机Chrome后，运行`npm run verify:rewards:ui`：临时API与built浏览器预览，完成验证后关闭并清理schema；不是微信原生验收，不向现有业务库写合成数据。
- 业务环境先应用新迁移，再运行API与后台/小程序；本轮未替负责人执行经营配置或主库迁移。

主要截图：[后台桌面表单](UI-REWARDS-ADMIN-CREATE-DESKTOP-2026-11-02.png)、[后台手机表单](UI-REWARDS-ADMIN-CREATE-MOBILE-2026-11-02.png)、[手机表单操作区](UI-REWARDS-ADMIN-CREATE-ACTIONS-MOBILE-2026-11-02.png)、[未知响应恢复](UI-REWARDS-ADMIN-UNKNOWN-2026-11-02.png)、[商城列表](UI-REWARDS-MINI-LIST-2026-11-02.png)、[商品详情](UI-REWARDS-MINI-DETAIL-2026-11-02.png)、[缺货](UI-REWARDS-MINI-OUT-OF-STOCK-2026-11-02.png)、[加载态](UI-REWARDS-MINI-LOADING-2026-11-02.png)。

代码自查已核对路由接入、共享库存SQL、事务权限重读、幂等/版本保护、迁移约束及客户端迟到响应清理。剩余限制：列表非事务快照；P2没有历史限兑使用量；原生微信/真机与真实经营规则、生产部署/回退仍待验。没有执行P3报价或任何真实积分/库存消费。
