2026-11-01统一证据时间线接续：四来源只读聚合、稳定分页/筛选、外键关联定位与备注原始快照链接、摘要折叠及焦点滚动完成；8项新增与16项相关PG回归、桌面/手机UI及全构建通过。无迁移、无新资金动作，实验与自动查询仍关闭。下项通知/尝试页到核查详情的跨页入口与返回定位，见[记录](docs/verification/S5-EVIDENCE-TIMELINE-2026-11-01.md)。此前下一步按历史理解。

2026-11-01通知关联接续：新尝试固定测试绑定、通知标识/交易号双重去重、关联成功证据与任务结算同事务、错绑拒绝及双向详情完成；8项新增与41项相关PG回归、14项逻辑测试、桌面/手机UI及全构建通过。两库增量迁移已应用，旧记录不补关联，真实支付与自动查询仍关闭。下项核查详情统一证据时间线与关联定位，见[记录](docs/verification/S5-NOTIFICATION-LINKS-2026-11-01.md)。此前下一步按历史理解。

2026-11-01查询分类接续：合成查询分类/证据/建议不可变持久化、退避重试与REVIEW停止分流、相反已知证据冲突保护及详情场景/历史完成；8项新增与26项相关PG回归、12项纯逻辑测试、桌面/手机UI和全构建通过。增量迁移已应用两库，真实渠道及自动查询仍关闭。下项合成通知与支付尝试关联及证据一致性，见[记录](docs/verification/S5-PAYMENT-CLASSIFICATION-2026-11-01.md)。此前下一步按历史理解。

2026-11-01渠道契约接续：查询适配器内部契约、单次超时/中止、13种保护性分类和后台17场景隔离验证完成；6项契约测试、20项真实PG新增/回归、桌面/手机UI及全构建通过。无迁移，真实渠道和自动查询保持关闭；契约尚未接入Worker持久化。下项查询分类结果持久化与任务处理策略的隔离接入，见[记录](docs/verification/S5-PAYMENT-ADAPTER-2026-11-01.md)。此前下一步按历史理解。

2026-11-01补偿核查接续：异常筛选/分页、当前快照详情与不可变核查备注/原键恢复完成；8项新增及18项相关回归共26个真实PG用例、6项判定和全构建通过。两库只新增备注表，写入及自动查询默认关闭，备注不改变资金/库存/证据。下项支付渠道适配器契约与失败分类的隔离基础，见[记录](docs/verification/S5-PAYMENT-REVIEW-2026-11-01.md)。此前下一步按历史理解。

2026-11-01查询补偿接续：合成未知任务、租约抢占/过期恢复/旧令牌拦截、3轮退避耗尽、原键重新安排与详情任务区完成；10项新增及32项回归共42个真实PG用例、6项判定及全构建通过。新增迁移两库已应用，自动查询Worker默认关闭，真实支付未接入。下项补偿任务异常列表与人工核查记录，见[记录](docs/verification/S5-PAYMENT-QUERY-2026-11-01.md)。此前下一步按历史理解。

2026-11-01支付尝试接续：独立合成尝试/不可变证据链、未知结果持久化、后台列表详情与模拟动作完成；8项新增及24项回归共32项真实PG测试、6项共享判定测试和全构建通过。两库新增迁移已应用，默认关闭，不关联真实订单或调用渠道。下项未知结果查询补偿任务与租约的隔离基础，见[记录](docs/verification/S5-PAYMENT-ATTEMPT-2026-11-01.md)。此前下一步按历史理解。

2026-11-01支付关闭接续：关闭前锁定重读、支付证据合并与保护性判定及后台12场景验证页完成；新增6项与18项回归共24项真实PG测试、6项纯判定测试及全构建通过。无迁移，默认关闭，不开放真实支付状态/回调。下项支付尝试与未知结果持久化的隔离基础，见[记录](docs/verification/S5-PAYMENT-CLOSE-2026-11-01.md)。此前下一步按历史理解。

2026-11-01通知持久化接续：合成通知独立记录、事务去重/冲突拒绝及后台列表/详情/重放完成；7项新增与28项相关回归共35项真实PG测试、8项密码学测试及完整构建通过。本机新迁移已应用，默认关闭，未入账或开放真实回调。下项支付结果与订单关闭竞争的隔离处理设计与验证，见[记录](docs/verification/S5-NOTIFICATION-RECORDS-2026-11-01.md)。此前下一步按历史记录理解。

2026-11-01通知验签隔离接续：原文RSA验签、AES-GCM解密及绑定金额核验核心、管理员9场景合成验证页完成；8项密码学/40项相关PG回归和全构建通过。无公开回调或支付成功写入，实验默认关闭且生产拒启。下项通知接收记录与持久化去重隔离基础，见[记录](docs/verification/S5-NOTIFICATION-CRYPTO-2026-11-01.md)。此前下一步按历史理解。

2026-11-01支付接入检查接续：管理员只读11项报告、非敏感配置离线检查与支付模式禁用保护完成；42项相关PG回归、4项配置测试、桌面/手机UI及全构建通过。无新迁移，不读取凭据或联网探测，真实支付始终关闭；下项支付通知验签/解密隔离基础，见[记录](docs/verification/S5-PAYMENT-READINESS-2026-11-01.md)。以下旧下一步按历史记录理解。

2026-11-01支付准备接续：本机PREPARED→CLOSED准备单、同键幂等、取消/超时事务联动及小程序/后台卡片完成；206项真实PostgreSQL全量、微信原生桥接和全工作区构建通过。未调用渠道/扣款，NOT_STARTED保持；经营规则仍未配置，下单/准备默认关闭。下一项支付渠道接入准备与配置校验，见[交付记录](docs/verification/S5-PAYMENT-PREPARATION-2026-11-01.md)。以下较早下一步为历史记录。

2026-11-01后台订单查询接续：授权仓库列表/状态与订单号筛选、游标分页和独立预占详情完成，顾客联系资料不读取；新增7项及订单/员工回归共29项真实PG测试、桌面/手机实际UI与全工作区构建通过。无新迁移，经营规则仍未配置、真实支付关闭。下一项支付单与幂等状态机前置基础，详见[交付记录](docs/verification/S5-ADMIN-ORDERS-2026-11-01.md)。以下较早下一步为历史记录。

2026-11-01订单预占接续：本机开发订单创建、本人列表/详情、取消及worker超时释放完成，UI沿用现有风格；191项真实PostgreSQL全量测试、5项客户端状态测试、微信原生桥接及九页面编译通过。经营规则仍未配置，下单默认关闭，真实支付/微信网络和真机未验。下一项后台订单查询与预占明细，见[交付记录](docs/verification/S5-ORDER-RESERVATION-2026-11-01.md)。以下较早“下一项”按历史记录理解。

2026-10-31结算核验接续：后台运费/起送/免运及手动报价开关、小程序本人地址+账号购物车核验与120秒报价基础完成；新建规则默认暂停，未配置不计算应付。125项相关PG回归、微信原生桥接和浏览器UI验证通过，见[交付记录](docs/verification/S4-CHECKOUT-QUOTE-2026-10-31.md)。本机经营规则仍为空，未生成样例报价；订单/支付和微信真实网络/真机未验，下一项提交订单与库存预占基础，经营规则仍待负责人提供。

2026-10-31收货地址接续：本人地址列表/新增/编辑/删除/显式默认地址、小程序独立表单和有效范围写时校验已实现；联系资料AES-256-GCM加密，审计/回执无明文。37项相关PG回归、微信原生桥接与同源码浏览器检查通过，见[交付记录](docs/verification/S4-CONSUMER-ADDRESS-2026-10-31.md)。本机只新增表与忽略的开发密钥，无合成经营范围/地址；微信真实登录、域名网络/真机和交易未验，下一项结算前校验与报价基础，运费/起送等经营规则仍待确认。

2026-10-31配送范围接续：后台唯一小区与楼栋白名单维护、小程序只读范围/搜索及启停过滤完成；默认停用、真实资料待提供。7项真实PG范围测试通过，隔离API后台和微信快照组件已验证，详见[交付记录](docs/verification/S4-SERVICE-AREA-2026-10-31.md)。本机只新增表，不写入样例范围；地址保存、微信真机与结算未验，下一项消费者收货地址基础。

# 玉米百货 · 项目工作入口

2026-10-30最新要求：UI沿用现有风格，由Codex按实际功能自主完成和调整，不再以逐页确认作为推进前提。本轮完成账号购物车与游客幂等合并，支持数量/勾选/移除、版本冲突和未知结果恢复；开发身份默认关闭，微信登录、真机和结算尚未开放。此前已整理原图偏差、长表单及任务交互。基础UI框架与商品浏览页已调整，实物盘点、隔离/报损、收货纠错、库位/核对及收货入库页已分离列表与详情，完整V1界面仍按功能逐项补齐；见[UI偏差与调整方向](docs/design/UI-ALIGNMENT-2026-10-28.md)。微信根目录导入路径已修复，并在开发者工具模拟器看到商品页。

截至2026-10-28，商品收货、库位/移位/核对、实物盘点、数量隔离/解除/报损及收货逆向纠错已实现，历史78项真实PostgreSQL集成测试通过。2026-10-29微信模拟器浏览与重试已验证；真机、完整UI及交易配送尚未验收。

已确认：单小区、单仓、自营配送；首版暂无生鲜；包含轻量仓库系统与骑手配送端；由项目负责人和 Codex 协作研发，优先性价比与交易可靠性。

## 从这里开始

本轮：[统一证据时间线与关联定位](docs/verification/S5-EVIDENCE-TIMELINE-2026-11-01.md)（四来源只读、精确快照、范围校验）。此前：[合成通知与尝试关联](docs/verification/S5-NOTIFICATION-LINKS-2026-11-01.md)（双重去重、原子证据和任务结算、错绑阻断）。此前：[查询分类持久化与核查分流](docs/verification/S5-PAYMENT-CLASSIFICATION-2026-11-01.md)（合成任务、不可变分类、待核查停止）。此前：[渠道适配器契约与失败分类](docs/verification/S5-PAYMENT-ADAPTER-2026-11-01.md)（单次合成查询、超时保护、默认关闭）。此前：[补偿异常列表与人工核查记录](docs/verification/S5-PAYMENT-REVIEW-2026-11-01.md)（合成核查、只追加说明，不处置资金）。此前：[查询补偿任务与租约隔离基础](docs/verification/S5-PAYMENT-QUERY-2026-11-01.md)（合成查询、自动Worker默认关闭）。此前：[支付尝试与未知结果持久化](docs/verification/S5-PAYMENT-ATTEMPT-2026-11-01.md)（合成记录、默认关闭、无真实资金动作）。此前：[支付结果与关闭竞争隔离判定](docs/verification/S5-PAYMENT-CLOSE-2026-11-01.md)（纯预案与关闭重读保护，真实支付禁用）。此前：[通知记录与持久化去重](docs/verification/S5-NOTIFICATION-RECORDS-2026-11-01.md)（合成记录，默认关闭、未入账）。此前：[通知验签与解密隔离基础](docs/verification/S5-NOTIFICATION-CRYPTO-2026-11-01.md)（合成验证、默认关闭，无真实回调）。此前：[支付渠道接入检查](docs/verification/S5-PAYMENT-READINESS-2026-11-01.md)（管理员只读、脱敏检查、始终不发起支付）。此前：[支付准备单与幂等状态基础](docs/verification/S5-PAYMENT-PREPARATION-2026-11-01.md)（本机准备、取消/超时关闭，未扣款）。此前：[后台订单查询与预占明细](docs/verification/S5-ADMIN-ORDERS-2026-11-01.md)（只读、仓库授权、敏感资料保护）。此前：[订单与库存预占基础](docs/verification/S5-ORDER-RESERVATION-2026-11-01.md)（默认关闭的本机订单、取消/超时释放和独立页面）。此前：[结算核验与报价基础](docs/verification/S4-CHECKOUT-QUOTE-2026-10-31.md)（后台可配置、缺规则阻断、原键报价；不占库存，订单未开放）。此前：[本人收货地址基础](docs/verification/S4-CONSUMER-ADDRESS-2026-10-31.md)（地址加密、范围事务校验与显式默认；微信桥接/原生空态及浏览器预览通过，真实网络/真机未验）。此前：[账号购物车与游客幂等合并](docs/verification/S4-ACCOUNT-CART-2026-10-31.md)（11项真实PG/8项状态测试及微信组件/API桥接验证通过；下一项服务范围白名单基础）。此前：[消费者会话基础（本机开发版）](docs/verification/S4-CONSUMER-SESSION-2026-10-31.md)（开发身份与“我的”页，默认关闭开发登录；非真实微信登录，下一项账号购物车合并）。此前：[游客购物车草稿](docs/verification/S4-GUEST-CART-2026-10-31.md)（9项草稿测试及微信原生夹具验收通过；非下单报价，真机待验）。此前：[商品合并卡片](docs/verification/S3-PRODUCT-CARDS-2026-10-31.md)（67项相关DB及微信卡片夹具验收通过；真机待验）。此前：[消费者真实分类浏览](docs/verification/S2-CONSUMER-CATEGORIES-2026-10-31.md)（64项相关DB、10项分类/浏览状态和微信原生夹具验收通过；真机待验）。此前：[商品详情规格切换](docs/verification/S2-PRODUCT-VARIANTS-2026-10-31.md)（61项相关DB测试、5项状态测试及微信原生夹具验收通过；真机待验）。此前：[商品多图与排序（本地开发版）](docs/verification/S2-PRODUCT-GALLERY-2026-10-31.md)（58项相关DB测试、真实浏览器及微信轮播组件夹具验证通过；生产存储/真机待验）。此前：[商品主图管理（本地开发版）](docs/verification/S2-PRODUCT-IMAGE-2026-10-31.md)（51项相关DB测试、浏览器、weapp编译和微信图片组件夹具验证通过；生产存储/真机待验）。此前：[条码精确查询与收货选品](docs/verification/S2-RECEIPT-BARCODE-2026-10-31.md)（45项相关DB测试及真实收货草稿验证通过，无新迁移）。此前：[SKU条码维护](docs/verification/S2-SKU-BARCODE-2026-10-30.md)（42项相关DB测试及真实页面验证通过，可空条码迁移已应用）。此前：[SKU规格说明维护](docs/verification/S2-SKU-SPEC-2026-10-30.md)（36项相关DB测试及真实页面验证通过，本轮无新增迁移）。此前：[分类名称与启停维护](docs/verification/S2-CATEGORY-MAINTENANCE-2026-10-30.md)（31项相关DB测试及真实页面验证通过，分类版本迁移已应用）。此前：[SKU售价与启停维护](docs/verification/S2-SKU-MAINTENANCE-2026-10-30.md)（25项相关DB测试及真实页面验证通过）。此前：[商品基本资料编辑](docs/verification/S2-PRODUCT-DETAILS-2026-10-30.md)（18项相关DB测试及真实页面验证通过）。此前：[整体UI复核与审阅入口](docs/verification/UI-REVIEW-2026-10-30.md)（弹窗误关/键盘修复，后续依最新UI自主设计要求推进）。此前：[真机验收准备](docs/verification/WECHAT-DEVICE-PREP-2026-10-29.md)（缺少HTTPS测试API，尚未真机联通）。此前：[小程序浏览重试与微信联通检查](docs/verification/WECHAT-BROWSE-2026-10-29.md)（微信模拟器浏览与重试已验证，真机待验收）。此前：[列表状态与微信编译报告](docs/verification/UI-LIST-STATES-MINI-2026-10-29.md)。此前：[收货入库UI与真实多行收货报告](docs/verification/UI-RECEIPTS-2026-10-29.md)。此前：[库位/核对UI与仓管/拣货查询报告](docs/verification/UI-LOCATIONS-2026-10-28.md)，含13项真实DB测试、移动作业真实流程及截图。

| 文档 | 用途 |
|---|---|
| [收货纠错报告](docs/verification/S2-RECEIPT-REVERSAL-2026-10-28.md) | 本轮纠错边界、检查结果、迁移和演示步骤 |
| [隔离报损报告](docs/verification/S2-STOCK-DISPOSITION-2026-10-28.md) | 本轮边界、迁移、检查结果及演示步骤 |
| [实物盘点报告](docs/verification/S2-STOCK-COUNT-2026-10-28.md) | 最新盘点边界、真实检查、演示步骤与迁移影响 |
| [库位与库存核对报告](docs/verification/S2-LOCATIONS-RECONCILIATION-2026-10-27.md) | 最新迁移、移位/差异暂停验证、演示步骤和剩余边界 |
| [商品入库切片报告](docs/verification/S2-CATALOG-INBOUND-2026-10-27.md) | 本轮真实测试、浏览器闭环、演示命令及未验证项 |
| [S1认证基础交付报告](docs/verification/S1-FOUNDATION-2026-10-27.md) | 本轮范围、测试结果、登录演示和剩余边界 |
| [S0验证报告](docs/verification/S0-REPORT-2026-10-27.md) | 实际检查、并发证据、完整复现步骤和未验证项 |
| [版本矩阵](docs/verification/VERSION-MATRIX.md) | 已通过的精确版本与兼容性决策 |
| [开发开工指南](docs/roadmap/START-HERE.md) | 现在能做什么、哪些准备需要补齐 |
| [Codex交互模板](docs/roadmap/CODEX-WORKFLOW.md) | 可复制的开工、切片、接续、报错提示词 |
| [数据库选型评估](docs/architecture/ADR-002-DATABASE-CHOICE.md) | PostgreSQL建议、取舍及采纳后的调整 |
| [本地工具与技能初检](docs/roadmap/ENVIRONMENT-CHECK-2026-10-26.md) | 实际检测结果、已安装技能与验证缺口 |
| [开发总纲](docs/00-MASTER-PLAN.md) | 总体范围、系统组成、交付路线和决策 |
| [现有文档与 UI 评审](docs/review/REVIEW-V1.md) | 逐张图的问题、保留项和修改项 |
| [产品需求](docs/product/PRD-V1.md) | 下单、仓储、骑手、退款的业务规则 |
| [页面与设计规范](docs/design/UI-SPEC-V1.md) | 页面编号、交互、异常状态和设计变量 |
| [技术架构](docs/architecture/ARCHITECTURE-V1.md) | 技术选型、模块边界和一致性设计 |
| [API 设计](docs/api/API-DESIGN-V1.md) | 接口清单、权限、金额和幂等约定 |
| [数据库设计](docs/database/DATABASE-V1.md) | 实体、字段、索引、约束及事务示例 |
| [服务器与上线运营](docs/operations/DEPLOYMENT-AND-LAUNCH.md) | 环境、预算、监控、备份、资质和运营 SOP |
| [开发任务计划](docs/roadmap/DEVELOPMENT-PLAN.md) | 依赖、任务、阶段验收和下一步 |
| [决策与当前状态](docs/roadmap/DECISIONS-AND-STATUS.md) | 已确认、待确认、已完成与尚未验证 |
| [技能调研与官方资料](docs/research/SKILLS-AND-SOURCES.md) | 已有能力、可选技能、来源和核验局限 |

## 启动入口

本机有Docker Desktop时优先使用，没有时使用Docker Engine（负责人2026-10-28确认）。本轮Engine及同版PostgreSQL17.11实测见[仓储UI交付报告](docs/verification/UI-STOCK-TASKS-2026-10-28.md)。首次初始化按S0报告中的完整命令执行；本机使用`npm exec --yes --package=pnpm@10.28.2 -- pnpm install --frozen-lockfile`引导固定包管理器，避开原pnpm11启动器问题。

| 命令 | 默认入口 / 用途 |
|---|---|
| `npm run dev:api` | 127.0.0.1:3000，健康接口`/api/v1/health/ready` |
| `npm run dev:admin` | 127.0.0.1:5173，后台开发首页 |
| `npm run dev:ops` | 127.0.0.1:5174，移动作业工程首页 |
| `npm run dev:worker` | 数据库健康探针，业务任务未实现 |
| `npm run db:stop` | 停止项目数据库，保留数据卷 |

微信开发者工具现可导入仓库根目录（配置指向apps/consumer-mini/dist/），也可导入apps/consumer-mini（指向dist/）。根目录保留负责人配置的AppID，子工程touristappid仅作编译演示；账号能力和真机另验。首次导入先执行npm run build:mini。后端源码修改后重启相应命令，会先编译服务端；当前无热重载。

## 当前交付边界

文档是业务设计基线。已实现员工权限、商品收货、普通库位、批次位置、同仓移位、账本核对、单SKU实物盘点、原库位数量隔离/解除/报损及收货逆向纠错，S0探针表保持隔离。商品名称/分类/说明、SKU售价与启停/规格说明/条码、分类名称及启停编辑、收货条码查询选品、商品多图本地管理、详情轮播及启用规格切换已实现；实体隔离区移位、其余商品维护、交易配送、生产部署及微信真机仍待完成。经营参数仍区分确认值与开发样例。

原始资料已原样归档：[原始研发清单](docs/references/yumi-original.md)、[UI 图目录](docs/references/ui)。原始文件未修改。

本地演示先执行`npm run setup:local`、`npm run db:migrate`、`npm run db:seed`，分别启动API、admin、ops。开发账号和随机密码仅在本机忽略的`.env`中，读取`LOCAL_ADMIN_*`、`LOCAL_WAREHOUSE_*`、`LOCAL_RIDER_*`，不要发到聊天或提交。接口文档：`http://127.0.0.1:3000/api/v1/docs`。执行`npm run build`后可运行`lint`、`format:check`、`typecheck`、`test:s0`、`test:s1`。

可追加`npm run db:seed:catalog`生成3个合成商品及入库数据（450/590/1680分）；重复执行不重复入库。启动后可查看`http://127.0.0.1:3000/api/v1/products`；新增`npm run test:s2`验证正式入库模型，测试在yumi_test的一次性schema隔离运行。

小程序本机默认请求`http://127.0.0.1:3000/api/v1`。真机须提供可达的HTTPS测试API和合法请求域名，显式设置`TARO_APP_API_BASE_URL`后运行`npm run build:mini:device`，再执行`npm run verify:mini:device`；清单写入忽略的`.local/mini-build.json`。手机的127.0.0.1不是开发电脑。不得把演示配置上传生产。

新增`npm run test:inventory`验证迁移、移位与核对。迁移前停止旧API/Worker写入，再执行db:migrate/db:migrate:test并重启新版服务；旧数据不一致时迁移会停止，不能跳过检查或清库。界面通过独立“库位与核对”导航提供库位、位置流水、同仓移位和核对报告。

新增`npm run test:counts`验证盘点；仓库工作台的“实物盘点”可开始冻结、由发起人提交全部位置实盘数、由另一员工审批再过账，也可带原因终止。先按报告启动新版API，迁移后禁止混跑旧服务。

接续先读最新UI/真机报告和当前状态；列表状态及微信模拟器浏览已本地验证，真机准备完成但缺少HTTPS测试API。提供测试地址后继续真机联通；常规UI按已授权风格自主补齐；商品基本资料、SKU售价/启停/规格说明及分类维护已交付，下一项商品图片管理（先完成本地可审查版本），UI自主保持一致风格。G1与完整S2仍不整体标记完成。

新增`npm run test:dispositions`验证隔离/解除/报损。仓库工作台提供立即隔离、独立审批、实物核验过账与带原因取消；隔离保留原库位。详见最新报告；草稿不预扣额度，取消申请不恢复可售。

新增`npm run test:reversals`验证收货逆向纠错；工作台按原批次位置申请、另一员工审批、核验实物后过账，原收货单/流水保留。每次1位置，跨位置分单；见最新报告。

分类维护新增202610300001_category_version迁移，已有分类版本从0起步且不改状态。旧API/Worker停止写入后执行db:migrate，生成Prisma客户端并构建后重启；本机开发库已应用，其他库需先迁移。不要通过清库解决迁移问题。

条码维护新增202610300002_sku_barcode迁移，现有SKU条码默认null，保留原数据。旧服务停止写入后先迁移、生成Prisma并构建再启动新版API；本机开发库已应用。一个SKU一条数字码，具体商品规范待核验，未接入硬件扫码。
