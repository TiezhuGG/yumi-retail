# API 设计基线 V1.1

本文件是业务接口设计，尚非完整实现。已实现员工基础、商品收货、库位/同仓移位、库存核对及实物盘点，生成[当前OpenAPI](openapi.json)（0.4.0）；其余交易清单仍为设计。开发入口`/api/v1/docs`、JSON`/api/v1/openapi.json`；生产关闭。`npm run openapi:export`从当前代码重建契约。

## 当前已实现的员工切片

全部路径带`/api/v1`。成功和错误均带requestId；请求头`X-Request-ID`由服务端生成，不采用客户端任意值。

| 方法/路径 | 输入与权限 | 当前结果 |
|---|---|---|
| POST /staff/auth/session | loginName/password；精确允许的Origin | 登录名trim并转小写；严格字段白名单；设置HttpOnly Cookie，只返回expiresAt |
| GET /staff/me | 员工会话 | 最小身份、角色、权限、warehouseIds、csrfToken |
| POST /staff/auth/logout | 会话、Origin、X-CSRF-Token | 撤销本次会话并清Cookie |
| GET /warehouse/warehouses | warehouse.read | 仅授权且启用的仓库 |
| GET /warehouse/warehouses/:warehouseId | warehouse.read和实际仓库范围 | 范围外403，不信任查询参数切换范围 |
| GET /admin/staff | staff.read | 最多100条只读员工；不含密码摘要与会话 |
| GET /health/live；GET /health/ready | 公开 | 进程存活；实际数据库连接 |

Cookie名`yumi_staff_session`，Path=/api/v1，SameSite=Strict，HttpOnly；生产追加Secure。CSRF token只存前端内存，可通过me恢复。没有跨域CORS通配授权，Web通过同源代理访问。无效或未知账号统一401 INVALID_CREDENTIALS；过期/撤销/停用/版本失配401 SESSION_EXPIRED；来源/CSRF校验失败403 ORIGIN_REJECTED/CSRF_REJECTED；限流429 RATE_LIMITED。限流使用数据库15分钟窗口，按直连IP100次、账号+IP10次；暂不信任X-Forwarded-For，生产代理策略需单独验收。

当前权限点按已实现行为授予：SUPER_ADMIN含员工只读、商品维护、库存只读和收货创建/审核/过账；OPERATIONS可维护商品；WAREHOUSE_MANAGER可读商品、库存及收货创建/审核/过账；PICKER只读商品/库存；DISPATCHER目前仅warehouse.read；RIDER预留rider.tasks.self，任务接口未实现；CUSTOMER_SERVICE暂无权限。所有仓库访问（含管理员）均需显式绑定范围。

## 当前已实现的商品/收货接口

全部前缀`/api/v1`。写动作需员工Cookie、Origin、X-CSRF-Token及UUID Idempotency-Key；创建也使用200成功包裹，避免与现有客户端混用201。单据动作body仅`{version}`；服务端重新校验状态/版本和范围。重复同键返回首次结果，变更请求409 IDEMPOTENCY_CONFLICT；同单不同键重复过账409 VERSION_CONFLICT/INVALID_TRANSITION。

| 方法/路径 | 权限与输入 | 输出与边界 |
|---|---|---|
| GET/POST /admin/categories | catalog.read / catalog.write | 最多两级分类，创建name/parentId |
| GET/POST /admin/products | catalog.read / catalog.write | SPU含SKU；创建categoryId/name/description?/skus[] |
| POST /admin/products/:id/publish；.../unpublish | catalog.write，version | 专用上下架，不开放任意status赋值 |
| GET/POST /warehouse/warehouses/:warehouseId/receipts | receipt.read / receipt.write + 范围 | 创建sourceRef、lines[skuId,batchNo,quantity,unitCostCents,producedAt?,expiresAt?]；拣货员无receipt.read，不能读取采购成本 |
| POST .../receipts/:id/approve；.../post | receipt.approve / receipt.post + 范围 | 独立审核与过账动作，version必填 |
| GET /warehouse/warehouses/:warehouseId/stock | stock.read + 范围 | onHand/reserved/blocked/safety/version；id是SKU ID的分页别名，不含成本 |
| GET /products | 匿名 | limit/cursor/keyword/categoryId；仅可展示销售规格，priceCents/available |
| GET /products/:id | 匿名；id为SKU UUID | 单个销售规格详情，productId另列；不可用404 |

列表均按UUID升序游标，默认20、上限50，返回items/hasMore/nextCursor；不按创建时间声称最新。公开查询拒绝warehouseId参数，实际仓来自服务端PUBLIC_WAREHOUSE_ID；未配置/停用503 STORE_UNAVAILABLE。零库存SKU仍返回available=0，客户端显示缺货；详情不暴露成本、批次、员工和供应来源。SKU编码冲突409 DUPLICATE_RESOURCE；生产/到期或SKU状态无效409 INVALID_EXPIRY/SKU_DISABLED；数量/时间格式400。关键交易尚未提供，不以available替代未来下单事务裁决。

## 1. 通用契约

### 实物盘点增量（已实现，2026-10-28）

以下前缀`/api/v1/warehouse/warehouses/:warehouseId/stock-counts`，同样校验仓库范围、会话；所有POST要求Origin、CSRF、UUID Idempotency-Key，200返回单据与无成本快照lines。

| 方法/路径 | 权限与body | 行为 |
|---|---|---|
| GET /；GET /:id | stock.read；列表skuId?/cursor?/limit? | 列表默认20最多50，UUID升序；详情最多200位置，无成本 |
| POST / | count.write；skuId/version/reason | 余额版本匹配后冻结全部位置，公开可售0 |
| POST /:id/submit | count.write且为发起人；version/lines[positionId,counted] | 1–200个不重复位置，必须覆盖完整快照，数量0–10亿整数 |
| POST /:id/approve | count.approve且非发起人；version/reason | 只审批SUBMITTED |
| POST /:id/post | count.post；version | 只过账APPROVED，数量及两级流水同事务 |
| POST /:id/cancel | count.write；version/reason | 终止未结束单据，释放冻结，不修改数量 |

三个count写权限授予SUPER_ADMIN/WAREHOUSE_MANAGER。PICKER只读，RIDER拒绝。错误：409 COUNT_FROZEN/COUNT_SIZE_LIMIT/COUNT_SNAPSHOT_CONFLICT/PROTECTED_STOCK/STOCK_RESERVED/INVENTORY_HOLD/INVENTORY_MISMATCH/STOCK_LIMIT/VERSION_CONFLICT/INVALID_TRANSITION；403 COUNT_OWNER_REQUIRED/INDEPENDENT_REVIEW_REQUIRED；严格字段/整数/缺漏或重复位置400。相同键不同内容409 IDEMPOTENCY_CONFLICT；同键重试返回首次结果，不代表单据目前仍在返回的历史状态，应GET刷新。

stock响应新增activeCountId（可空）独立于inventoryHold。移位遇盘点冻结409 COUNT_FROZEN；收货过账冻结时409 STOCK_UNAVAILABLE。盘点按新流水调整账实差异，不能用来直接覆盖已经不一致的账本。未来预占/出库需复用同一余额锁及冻结检查。

### 库位与核对增量（已实现）

以下前缀均为`/api/v1/warehouse/warehouses/:warehouseId`；服务端每次校验仓库范围。所有POST要求员工Cookie、Origin、CSRF及UUID Idempotency-Key；同键结果持久化且绑定请求摘要。

| 路径/方法 | 权限/输入 | 当前行为 |
|---|---|---|
| GET /locations | stock.read；cursor/limit | 本仓普通库位（含停用） |
| POST /locations | location.write；code/name | 仓内唯一编码，DEFAULT保留 |
| POST /locations/:id/disable；.../enable | location.write；version | 仅空位能停用，默认位拒绝停用 |
| GET /positions | stock.read；skuId?/cursor/limit | 批次位置、货位、数量、版本、效期及销售规格名称；无成本 |
| GET /positions/:id/ledger | stock.read；cursor/limit | 位置增量、主动作键、时间/requestId及移位原因 |
| GET /stock-transfers | stock.read；cursor/limit | 本仓不可改移位记录 |
| POST /stock-transfers | stock.transfer；sourcePositionId/targetLocationId/quantity/version/reason | 一次过账，同仓成对数量流水，不改变汇总数量 |
| POST /inventory-checks | stock.check；skuId | 保存单SKU核对；差异设置核对销售暂停，不修数 |
| GET /inventory-checks | stock.read；skuId?/cursor/limit | 不可改报告，完整issueCount和前100项证据 |
| POST /stock/:skuId/release-check-hold | stock.release-hold；version/reason | 事务中重新核对，一致才解除核对暂停并审计 |

新增4个写权限仅授予SUPER_ADMIN、WAREHOUSE_MANAGER；PICKER可只读上述无成本仓库数据。stock原查询新增skuId过滤、返回inventoryHold；公开products保持原契约，但核对暂停时available=0，正常可售按启用库位的未到期位置数量与汇总上限求小值。

分页默认20、上限50，UUID升序游标，不声称时间倒序。核对证据expected/actual里的三种数量为十进制整数字符串。错误：409 VERSION_CONFLICT/STOCK_RESERVED/INSUFFICIENT_STOCK/LOCATION_NOT_EMPTY/INVENTORY_HOLD/INVENTORY_MISMATCH；403 LOCATION_UNAVAILABLE用于越仓或停用目标；同位移位/非法数量400。核对暂停下收货409 STOCK_UNAVAILABLE。库存核对不是实物盘点，不提供直接改库存接口。

- 前缀 `/api/v1`，UTF-8 JSON；金额 `*Cents` 为非负整数分，数量为整数，币种固定 CNY。
- 对外 ID 为不透明字符串，数据库 BIGINT 不直接序列化成 JS number；时间 ISO8601 UTC，界面按 Asia/Shanghai 展示。截止判断使用服务端时间。
- GET 无副作用；POST 表达业务动作；PATCH 仅允许白名单字段，不提供任意状态修改。版本冲突返回409。
- 成功：`{ data, requestId }`；分页：`data: { items, nextCursor, hasMore }`。后台固定页码可单独返回 page/pageSize/total，不能在同一接口混用。分页上限100，默认20。
- 失败：`{ error: { code, message, details? }, requestId }`，配合真实HTTP状态，不能全部200。
- 消费者 Bearer 会话；员工使用受保护 Cookie 会话及 CSRF；渠道回调不用用户会话，使用渠道签名认证。
- POST 订单、支付准备、取消、过账、出库、配送动作、退款请求及执行均要求 Idempotency-Key。相同作用域/键绑定请求摘要，终态重试返回首次业务结果，内容不一致409。
- 键作用域包括主体+动作+业务对象；关键业务键和唯一约束长期保留，不能仅靠短时缓存；临时请求记录可按保留策略清理。进程中断不能使已提交动作失去幂等结果。
- 客户端变化检查使用 `version`（业务实体版本），不要将浏览器缓存ETag和业务锁版本混为一谈。

| HTTP | 业务码示例 | 客户端行为 |
|---|---|---|
| 400/422 | VALIDATION_ERROR | 定位字段并保留输入 |
| 401 | AUTH_REQUIRED / SESSION_EXPIRED | 登录后恢复上下文，交易结果先查询 |
| 403 | FORBIDDEN | 不重试越权操作 |
| 404 | RESOURCE_NOT_FOUND | 对不属于本人的对象可统一404 |
| 409 | QUOTE_CHANGED / OUT_OF_STOCK / VERSION_CONFLICT / INVALID_TRANSITION / IDEMPOTENCY_CONFLICT | 刷新事实并解释差异 |
| 422 | OUT_OF_SERVICE_AREA / STORE_CLOSED / BELOW_MINIMUM / REFUND_LIMIT_EXCEEDED | 明确业务原因 |
| 429 | RATE_LIMITED | 按返回策略退避 |
| 503 | CHANNEL_UNAVAILABLE / RETRYABLE_CONFLICT | 使用原业务键查询/重试，不能换号重付 |

## 2. 消费者接口

表中“本人”表示每次服务端校验归属，“公开”仍有限流。所有路径均带 `/api/v1` 前缀。

| 方法 / 路径 | 权限 | 主要输入 / 输出 |
|---|---|---|
| POST /auth/wechat/session | 登录凭证 | code→业务会话及最小用户信息，不返回微信敏感凭据 |
| POST /auth/session/refresh；POST /auth/logout | 会话 | 轮换/撤销；refresh令牌受独立限流和校验 |
| GET /me | 本人 | 业务用户资料 |
| GET /store | 公开 | 营业/暂停状态、规则版本、服务说明、运费/起送 |
| GET /service-areas；GET /service-areas/:id/buildings | 公开 | 服务小区及有效楼栋 |
| GET /categories；GET /home | 公开 | 分类树、推荐与横幅 |
| GET /products?categoryId=&keyword=&cursor= | 公开 | 可展示商品/SKU，库存为参考 |
| GET /products/:id | 公开 | SKU与详情、状态、适用资料 |
| GET/POST /addresses；PATCH/DELETE /addresses/:id | 本人 | 地址字段、默认标记；已用地址通过订单快照保存 |
| GET /cart；PUT /cart/items/:skuId；DELETE /cart/items/:skuId | 本人 | 绝对数量与选择状态；并发版本校验 |
| POST /cart/merge | 本人 | 游客条目、合并键→有效/失效项与调整原因 |
| POST /checkout/quotes | 本人 | 地址ID、SKU数量→报价、明细、规则版本、有效期 |
| POST /orders | 本人+幂等 | quoteId、地址ID、备注→订单与支付截止 |
| GET /orders?status=&cursor=；GET /orders/:id | 本人 | 展示状态、三个内部状态映射、快照、可执行动作 |
| GET /orders/by-request/:key | 本人 | 提交超时后查找同意图订单；只查本人订单创建作用域 |
| POST /orders/:id/payment-preparations | 本人+幂等 | 订单版本→小程序支付参数；复用同一有效支付单 |
| GET /orders/:id/payment-status | 本人 | 业务最终状态/待核实；按限流策略驱动查单 |
| POST /orders/:id/cancel-requests | 本人+幂等 | 原因、版本→取消请求/处理中；已付不直接释放 |
| GET /orders/:id/refundable-items | 本人 | 各行可退数量/金额、运费规则 |
| POST /orders/:id/aftersales | 本人+幂等 | 行ID、数量、原因、附件ID→服务端金额与申请 |
| GET /aftersales/:id | 本人 | 审核和退款进度 |
| POST /uploads/intents；POST /uploads/:id/complete | 按用途权限 | 图片元数据→短期受限上传；完成校验后可引用 |

## 3. 报价 / 下单示例

示例使用三个固定规格 SKU，不表示已确定真实商品。金额保持全链路一致。

```json
{
  "addressId": "addr_demo_01",
  "items": [
    { "skuId": "sku_a", "quantity": 2 },
    { "skuId": "sku_b", "quantity": 1 },
    { "skuId": "sku_c", "quantity": 1 }
  ]
}
```

```json
{
  "data": {
    "quoteId": "quo_demo_01",
    "ruleVersion": 1,
    "expiresAt": "2026-10-25T08:02:00Z",
    "lines": [
      { "skuId": "sku_a", "quantity": 2, "unitPriceCents": 450, "subtotalCents": 900 },
      { "skuId": "sku_b", "quantity": 1, "unitPriceCents": 590, "subtotalCents": 590 },
      { "skuId": "sku_c", "quantity": 1, "unitPriceCents": 1680, "subtotalCents": 1680 }
    ],
    "goodsCents": 3170,
    "deliveryFeeCents": 300,
    "discountCents": 0,
    "payableCents": 3470,
    "currency": "CNY"
  },
  "requestId": "req_demo_01"
}
```

`POST /orders` 携带 `Idempotency-Key: <random-purchase-intent>`，输入 `{quoteId,addressId,note}`。报价服务端保存/签名绑定用户、SKU、地址版本与规则，不能相信客户端回传 total。提交时校验报价未过期且重新计算；版本/库存/价格变化返回409，不生成半张订单。

支付准备输出仅包含订单ID及微信调起所需参数（timeStamp、nonceStr、package、signType、paySign等最终以接入官方规范为准），绝不返回商户私钥/APIv3密钥。业务金额只从订单读取。

## 4. 后台商品与运营接口

| 方法 / 路径 | 权限点 | 行为 |
|---|---|---|
| POST /staff/auth/session；POST /staff/auth/logout | 员工身份 | Cookie会话；登录限流与审计 |
| GET /staff/me | 员工 | 角色、仓库范围、权限点 |
| GET/POST /admin/products；GET/PATCH /admin/products/:id | catalog.read/write | 商品与SKU、版本校验 |
| POST /admin/products/:id/publish；POST /admin/products/:id/unpublish | catalog.publish | 检查资料与状态，保留历史订单 |
| GET/POST /admin/categories；PATCH /admin/categories/:id | category.read/write | 两级限制、循环/引用保护 |
| GET /admin/orders；GET /admin/orders/:id | order.read | 只查询授权仓库订单；脱敏策略 |
| GET /admin/dashboard；GET /admin/reports/sales | report.read | 时间区间与口径；无静态假指标 |
| GET/PATCH /admin/store-settings | store.read/write | 白名单字段、规则版本、审计 |
| GET/PUT /admin/home-content | content.read/write | 推荐与静态横幅，发布校验商品状态 |
| GET /admin/staff | staff.read | 已实现最小只读列表，最多100条 |
| POST /admin/staff；PATCH /admin/staff/:id | staff.manage（待实现） | 分配固定角色和仓库范围，不能提升自己权限 |
| POST /admin/staff/:id/reset-password | staff.manage | 受控重置、撤销旧会话、审计 |
| GET /admin/audit-logs | audit.read | 只读，不提供业务删除 |

## 5. 仓库接口

所有请求基于员工会话并检查仓库范围。过账和动作接口均需幂等键，数量/库存版本冲突返回409。

| 方法 / 路径 | 权限点 | 行为 |
|---|---|---|
| GET /warehouse/stock-balances；GET /warehouse/stock-ledger | stock.read | 按仓库/SKU/库位/批次，返回统一口径 |
| GET/POST /warehouse/locations；PATCH /warehouse/locations/:id | location.manage | 库位启停；有库存不得直接删除 |
| GET/POST /warehouse/receipts；PATCH /warehouse/receipts/:id | receipt.write | 草稿，不修改已过账单 |
| POST /warehouse/receipts/:id/post | receipt.post | 数量、效期、来源核验；原子入库与流水 |
| POST /warehouse/stock-transfers | stock.move | 同仓移位，成对批次明细；不实现跨仓 |
| GET/POST /warehouse/stock-counts | count.write | 确定范围、冻结、记录账面快照 |
| PUT /warehouse/stock-counts/:id/lines/:lineId | count.write | 实盘数量、备注、版本 |
| POST /warehouse/stock-counts/:id/post；POST /warehouse/stock-counts/:id/abort | count.post | 审核差异/释放冻结；不可吞并预占冲突 |
| GET/POST /warehouse/write-offs；POST /warehouse/write-offs/:id/post | loss.write/post | 报损审批与过账，不减已被预占部分 |
| POST /warehouse/returns；POST /warehouse/returns/:id/post | return.receive | 实物验收与可售/隔离入库，独立于退款 |
| GET /warehouse/pick-tasks；GET /warehouse/pick-tasks/:id | picking.read | 本仓队列与明细 |
| POST /warehouse/pick-tasks/:id/claim | picking.claim | 领取到当前员工，防重复领取 |
| PUT /warehouse/pick-tasks/:id/lines/:lineId | picking.execute | 批次/库位、实拣、版本；未决异常不可出库 |
| POST /warehouse/pick-tasks/:id/shortages | picking.execute | 上报缺货，不自动改已付金额 |
| POST /warehouse/pick-tasks/:id/dispatch | stock.dispatch | 校验取消/退款/缺货，原子出库并创建配送待办 |

## 6. 调度与骑手接口

| 方法 / 路径 | 权限点 | 行为 |
|---|---|---|
| GET /admin/delivery-tasks | delivery.dispatch | 当前仓库待分配/配送/异常 |
| POST /admin/delivery-tasks/:id/assign | delivery.dispatch | riderId、version、原因；有效骑手且本仓 |
| POST /admin/delivery-tasks/:id/withdraw | delivery.dispatch | 未开始任务撤回；记录旧指派失效 |
| GET /rider/tasks；GET /rider/tasks/:id | rider.self | riderId取会话，不能从查询参数任意指定 |
| POST /rider/tasks/:id/accept；POST /rider/tasks/:id/reject | rider.self | 检查当前指派版本，拒接说明原因 |
| POST /rider/tasks/:id/start | rider.self | 已接单、已出库、未停止 |
| POST /rider/tasks/:id/complete | rider.self | 已配送中、证明方式/附件、version；仅改变履约 |
| POST /rider/tasks/:id/exceptions | rider.self | 原因、说明、可选图片，不伪记送达 |
| POST /admin/delivery-exceptions/:id/resolve | delivery.resolve | 重送/退回/退款协调；不可任意修改资金 |

动作成功后返回任务、版本和可执行动作。断网使用原键重试；重派后即使客户端还持有旧地址，也不能继续访问详情或提交状态。

## 7. 售后、资金与渠道回调

| 方法 / 路径 | 权限 | 行为 |
|---|---|---|
| GET /admin/aftersales；GET /admin/aftersales/:id | aftersales.read | 行与额度、证据、处理历史 |
| POST /admin/aftersales/:id/approve；POST /admin/aftersales/:id/reject | aftersales.review | version、原因；审核不代表到账 |
| POST /admin/aftersales/:id/execute-refund | refund.execute | 固定申请金额、稳定退款号，不能任意回传金额 |
| GET /admin/refunds/:id | refund.read | 渠道状态、查询/重试历史 |
| POST /admin/refunds/:id/reconcile | refund.reconcile | 触发受限查单，不新生成退款单 |
| GET /admin/reconciliation-runs；GET /admin/reconciliation-differences | finance.read | 日账单与业务差异 |
| POST /admin/reconciliation-differences/:id/resolve | finance.resolve | 记录证据与处置，不直接删除差异 |
| POST /webhooks/wechatpay/payments | 渠道签名 | 原始body验签、解密、字段核验、落库去重 |
| POST /webhooks/wechatpay/refunds | 渠道签名 | 原始body验签、解密、额度/商户核验、状态更新 |

Webhook 的应答结构与HTTP码遵循接入时官方渠道规范，不套普通业务 envelope。仅在通知已安全持久化并提交后返回成功；验签失败不能成功应答并接受业务事实。验签使用平台证书/公钥模式按官方接入规则配置，包含轮换与未知序列号处理。

## 8. 健康检查与契约验证

`GET /health/live` 仅检查进程，`GET /health/ready` 检查数据库与必要配置，公网上不返回秘密或完整依赖连接串。版本前缀下也可代理健康检查；具体部署探针与应用保持一致。

OpenAPI 需包含所有业务接口、权限要求、DTO、枚举、分页、错误码、幂等与版本头说明；渠道回调单独描述。契约测试验证金额/枚举/权限/错误，与前端生成类型一致；接口文档存在不等于实现通过。
