# 全页面 UI 对照进度

2026-11-05：按负责人本轮要求，将现有消费者小程序和运营后台统一到本目录 `png/` 图集。下面按实际注册的 **17 个小程序页面、31 个后台入口** 对照，不将图集中尚未开发的业务视为已经实现。

本地浏览器使用实际 React 页面、实际 API 和一次性 PostgreSQL schema 内的合成资料检查。小程序分别检查 390px 和 320px；后台检查 1440px 和 390px。表单、详情、打印、加载、空结果、错误重试另有截图；本轮共 152 张，页面级横向溢出和 React 运行时错误均为 0。微信开发者工具、真机、真实支付和生产验收仍未完成。

[本轮验证记录](../../verification/UI-ATLAS-IMPLEMENTATION-2026-11-05.md) · [本机截图总览](../../verification/atlas-pages-2026-11-05/index.html)

## 小程序

| 实际页面 | 对应图集 | 本轮交付 |
| --- | --- | --- |
| index | points/store | 商城品牌、摄影横幅、积分入口、兑换卡片及加载骨架 |
| account | points/account | 深橄榄会员卡、积分入口、订单分类、地址与服务 |
| login | points/login | 品牌登录卡、微信登录、错误及返回操作 |
| points | points/balance | 深色余额卡、明细、增减积分与来源入口 |
| rewards | points/store、retail/category、retail/search | 商品搜索、分类、双列商品卡和空结果 |
| reward | points/reward | 商品图、积分价格、数量限额、说明及底部操作 |
| redemption-checkout | points/confirm、points/insufficient、points/gate | 地址、商品、报价、积分与真实门禁提示 |
| redemptions | points/redemptions | 状态标签、兑换单摘要和详情入口 |
| redemption | points/pending、shipped、cancel、canceled、feedback、feedback-log | 进度、收货快照、运单、取消和反馈 |
| service-area | retail/area | 小区范围、楼栋查询、空与错误状态 |
| addresses | retail/address、retail/address-form | 小区地址卡、独立新增与编辑表单 |
| express-addresses | points/addresses、address-form、address-blocked | 快递地址卡、独立表单和范围校验提示 |
| product | retail/product | 商品图、规格选择、价格及底部加购操作 |
| cart | retail/cart、retail/merge | 勾选与数量、草稿合并、费用说明和结算区域 |
| checkout | retail/checkout、retail/requote | 收货选择、商品核验、报价、金额和提交门禁 |
| orders | retail/orders | 订单卡、状态、数量金额及详情入口 |
| order | retail/pay、retail/order、retail/pay-review | 订单阶段、收货与金额、支付准备及取消 |

三个原生标签页仍为“商城 / 兑换订单 / 我的”，补齐正常及选中图标。积分相关五个详情/列表页面补齐原生标题配置。商品缺少真实图片时继续明确显示“包装示意”，不把图集商品摄影套到不对应的真实商品。

## 运营后台

序号与本机截图 `admin-{序号}.png` 对应。

| 序号 | 实际入口 | 对应图集 |
| --- | --- | --- |
| 0 | 工作台 | admin/overview、express/overview |
| 1 | 商品管理及基本资料、售价、规格、条码、图片窗口 | admin/catalog、product、sku |
| 2 | 商品分类及维护窗口 | admin/categories、category-edit |
| 3 | 订单查询与详情 | admin/orders、order |
| 4 | 配送范围及小区/楼栋表单 | admin/service |
| 5 | 报价规则及维护表单 | admin/service |
| 6 | 积分账户及流水 | express/accounts、ledger |
| 7 | 积分发放审批与预算 | express/approvals、grant、approval |
| 8 | 积分误发冲正 | express/correction |
| 9 | 兑换商品及新增/维护窗口 | express/reward-list、reward-edit |
| 10 | 积分兑换订单、快递范围、发货、打印及更正 | express/orders、order、coverage、ship、shipped、print、tracking-edit |
| 11 | 兑换售后反馈及回复 | express/support、reply |
| 12 | 积分快递首发检查 | express/release |
| 13 | 库存总览 | warehouse/stock、batches |
| 14 | 收货入库及新建/详情窗口 | warehouse/receipts、receipt、receipt-detail |
| 15 | 库位与核对 | warehouse/locations、location-edit、move、ledger |
| 16 | 实物盘点及发起窗口 | warehouse/counts、count |
| 17 | 隔离与报损 | warehouse/isolation、loss |
| 18 | 收货纠错及新建窗口 | warehouse/receipt-reversal |
| 19 | 兑换拣货 | warehouse/picks、ready、shortage、recheck、outbound |
| 20 | 兑换骑手交接 | admin/dispatch、assign、delivery、withdraw、resolve、returns |
| 21 | 拣货准备 | warehouse/ready |
| 22 | 拣货演练 | warehouse/picks、shortage、outbound；保留合成演练标识 |
| 23 | 配送演练 | admin/dispatch、delivery、exceptions；保留合成演练标识 |
| 24 | 支付接入检查 | admin/system |
| 25 | 通知记录 | admin/notifications |
| 26 | 补偿核查 | admin/payments、payment-review、payment-note、review-summary |
| 27 | 支付尝试 | admin/payment-attempts |
| 28 | 支付关闭验证 | admin/payments、system；按实际隔离验证能力设计 |
| 29 | 渠道契约验证 | admin/system；按实际隔离验证能力设计 |
| 30 | 通知隔离验证 | admin/notifications、system；按实际隔离验证能力设计 |

后台登录对应 `admin/login`。各入口使用同一侧栏、线性图标、标题、暖灰工作区、筛选、表格、状态标签、输入和弹窗规范。长侧栏可独立滚动，手机上改为可横向浏览的导航；授权范围仍由原服务端权限决定。

## 兼容性与保留边界

- 仅调整前端视觉、信息组织及相应验证脚本；无业务模型、API 契约、数据库迁移、依赖版本或经营参数变化。
- 已有收货、盘点、隔离、纠错及积分写入仍使用原业务动作和幂等处理。未新增修改状态的通用接口。
- 图集内的员工权限维护、零售退款、渠道对账、经营报表等尚无对应独立功能的页面，不因本次 UI 对齐新增样例业务入口。
- 页面适配按实际字段与能力调整，不复制图集示例订单、余额、销量、范围或可用性声明。原支付、发货与发布门禁保持真实状态。
- 功能检查、浏览器布局检查、小程序原生工具/真机及生产验收分别记录；本轮不能据此标记上线。
