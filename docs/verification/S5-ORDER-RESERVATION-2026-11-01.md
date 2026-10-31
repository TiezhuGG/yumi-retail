# S5 订单与库存预占基础 · 2026-11-01

本轮接续报价基础，实现本机开发订单创建、本人列表/详情、主动取消与后台超时释放，并同时交付小程序页面。真实经营规则继续保持未配置，真实支付仍disabled；不把技术测试时限、合成运费或模拟器桥接视为业务确认或交易上线。

## 切片边界与验收案例

- 有效本人报价生成一笔AWAITING_PAYMENT订单，paymentState=NOT_STARTED、fulfillmentState=NOT_READY；重试原键只返回原订单，换键不能再次消费该报价。
- 提交时重新核验会话、购物车、地址、范围、规则、售价和实时可售库存；变化或任一商品失效时整单拒绝，不部分下单。
- 多账号争抢最后库存只产生足额订单；汇总/批次/位置reserved与两级流水一致，on_hand不变；晚期事件失败整体回滚，原键可重试。
- 本人可读订单并取消从未开始支付的订单；源地址删除不改变历史收货快照，跨账号不可读或取消。
- 取消与超时竞争只释放一次，重复任务/取消幂等；未来任何已开始/未知支付必须先对账，不能直接释放。
- 页面真实连接隔离API：创建响应丢失、重新进入页面原键核实、订单列表/详情、取消、加载/空/错误重试与超时结果。

## 实际实现

创建同时保存不可变商品与金额快照、加密收货快照、逐批次/位置预占分配和ORDER_CREATED事件。按SKU有序锁汇总，再锁批次/位置和相关元数据，FEFO优先临期、无效期最后，排除过期/停售/冻结/隔离/账务暂停与无效位置。地址备注和orderNote单独保存，共同AES-256-GCM加密；回执与日志不存联系人明文，创建幂等摘要用HMAC。

取消与worker共用释放内核，按原分配减reserved，追加释放流水和ORDER_CANCELED事件。stock_ledger增加STAFF/CONSUMER/SYSTEM合法结构检查，保留旧员工ID和事实；消费者操作不冒用员工。订单/明细/分配/事件受数据库不可变与延迟配平约束保护。事件目前仅PENDING持久化，未实现投递消费，不启动拣货或配送。

ORDER_DEV_SUBMIT_ENABLED默认0，只允许非生产loopback API及本地yumi_dev/yumi_test。开发预占默认900秒，可通过ORDER_DEV_HOLD_SECONDS=1..900缩短隔离测试；最多5笔待支付为技术保护，非正式经营付款期限。worker启动即检查，此后每30秒一轮、每轮最多20笔、每笔独立事务并SKIP LOCKED，避免与取消/其他worker重复释放。订单创建后暂保留购物车，界面已说明再次购买须重新核验报价。

小程序新增独立“我的订单”和“订单详情”，沿用ui/mini2与既有绿白布局。结算页先保存原账号/报价/键等非联系资料元数据再发送，响应未知/重入保持原操作，读取本人详情后才清除；明确拒绝需用户确认后重新核验，不能默默换键。默认关闭时显示未开放，不展示虚构支付成功。

## 功能检查

实际运行：

| 检查 | 结果 |
|---|---|
| 全部`tests/*.integration.test.ts`，串行真实PostgreSQL | **191/191通过**，含本轮10项订单与全部旧仓储/商品/消费者测试 |
| 客户端`node --import tsx tests/order-intent.test.ts` | **5/5通过**，覆盖持久化前置、失败/重入同键、账号绑定、已知ID恢复、重复点击 |
| 重新生成Prisma客户端后订单专项 | **10/10再次通过** |
| 服务端构建、工作区typecheck、ESLint、Prettier、git diff --check | 通过 |
| 微信weapp编译、9页面产物与3个工程导入根 | 通过；`.local/mini-build.json`为本地编译记录 |
| 实际代码OpenAPI导出 | 已更新docs/api/openapi.json |
| Prisma模型与开发数据库支持结构diff | No difference detected；SQL CHECK/触发器仍以迁移为准 |

首轮旧库存迁移断言把整行JSON作为历史字段，因新增actor_kind/consumer_actor_id而失败。调整为逐一断言旧字段完全不变，并额外验证STAFF/null默认值后，全量191项通过。同步补齐Prisma中已有地址/报价外键及索引名称和图片外键名称元数据；没有删除SQL约束或改旧业务数据。

## UI检查与截图

`scripts/ui/verify-order-preview.mjs`运行实际小程序React源码，通过浏览器组件/生命周期适配访问一次性PostgreSQL API，390px无横向溢出。已实际查看并对照ui/mini2的留白、绿白卡片及金额层次；这是源码适配预览，不是正式H5或微信网络验收。

| 浏览器预览 | 内容 |
|---|---|
| [空列表](UI-ORDER-PREVIEW-EMPTY-2026-11-01.png) | 本人无订单 |
| [原操作待确认](UI-ORDER-PREVIEW-UNKNOWN-2026-11-01.png) | 真实事务成功后受控丢响应，刷新恢复原键 |
| [详情](UI-ORDER-PREVIEW-DETAIL-2026-11-01.png) | 待支付、收货快照、两行商品与2499分应付 |
| [已取消](UI-ORDER-PREVIEW-CANCELED-2026-11-01.png) | 主动取消后库存释放 |
| [列表](UI-ORDER-PREVIEW-LIST-2026-11-01.png) | 本人订单摘要与详情入口 |
| [加载](UI-ORDER-PREVIEW-LOADING-2026-11-01.png) | 暂挂真实读取 |
| [错误重试](UI-ORDER-PREVIEW-ERROR-2026-11-01.png) | 受控503及恢复 |
| [超时](UI-ORDER-PREVIEW-TIMEOUT-2026-11-01.png) | 未开始支付，超时后自动取消 |

`scripts/ui/verify-orders-wechat.mjs`使用已授权微信开发者工具/SDK0.13.0，原生组件通过Node请求桥接同类隔离真实API，真实收货服务生成商品库存。走通创建成功后503、页面reLaunch后原键恢复且仅一笔订单、本人详情清理待确认元数据、取消后reserved归零、列表读取失败恢复；另外启动实际编译worker子进程，仅连接该一次性schema，验证启动tick自动超时取消并归零。开发者工具旧编译缓存曾显示旧按钮，仅清本项目compile缓存并重开后通过，未清登录/用户存储。

已取得并实际查看[微信原生详情](WECHAT-ORDER-DETAIL-2026-11-01.png)和[底部金额/取消区域](WECHAT-ORDER-AMOUNTS-2026-11-01.png)。截图为测试详情停留后的合成资料，夹具随后清理，不能当作经营订单。请求和系统确认弹窗在验收中受控桥接/mock，原生触摸、合法域名、真实微信身份与真机网络仍未验。结束已恢复request/showModal及原登录、游客购物车、待确认订单存储，并读取比对确认；没有把用户原资料发往测试API。

## 本机交付与接续

沿用本机Docker Engine。停止并核实旧API进程后应用`202611010001_order_reservations`至开发/测试库，未重置数据；API和worker加载已验证构建。只读复查：ready=200，匿名订单=401，store为UNCONFIGURED且orderSubmissionEnabled=false；开发库订单、报价、规则、范围、地址均0，隔离order UI schema剩余0。实际经营规则和开发登录/下单开关保持默认关闭；无合成订单、范围或运费进入开发经营库。

入口：小程序“我的→我的订单”或“账号购物车→结算核验”；本机API http://127.0.0.1:3000/api/v1，后台 http://127.0.0.1:5173/。隔离复验需YUMI_LIVE_UI=1和本机yumi_test，分别运行scripts/ui下两个订单脚本。专项命令npm run test:orders、npm run test:order-intent；微信编译npm run build:mini。

没有提交Git、微信上传、生产部署、外部账号连接或真实支付。下一切片为后台订单查询与预占明细，沿用仓库权限和只读审计，不引入通用改状态入口；真实支付/退款、经营规则、合法HTTPS API、真机及仓库履约/骑手另行接续。
