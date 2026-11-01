# API 设计基线 V1.1

本文件是业务接口设计，尚非完整实现。已实现员工基础、商品收货、库位/同仓移位、库存核对、实物盘点、数量隔离/解除/报损、收货逆向纠错，生成[当前OpenAPI](openapi.json)（0.6.0）；其余交易清单仍为设计。开发入口`/api/v1/docs`、JSON`/api/v1/openapi.json`；生产关闭。`npm run openapi:export`从当前代码重建契约。

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
| GET /admin/products/:id | catalog.read | 当前资料/SKU及version，供编辑加载与冲突恢复 |
| POST /admin/products/:id/update-details | catalog.write；version/categoryId/name/description | 固定字段动作，同Product锁/版本/事务幂等；不接受status或SKU字段 |
| POST /admin/products/:id/publish；.../unpublish | catalog.write，version | 专用上下架，不开放任意status赋值 |
| GET/POST /warehouse/warehouses/:warehouseId/receipts | receipt.read / receipt.write + 范围 | 创建sourceRef、lines[skuId,batchNo,quantity,unitCostCents,producedAt?,expiresAt?]；拣货员无receipt.read，不能读取采购成本 |
| GET /warehouse/warehouses/:warehouseId/receipts/:id | receipt.read + 本仓范围 | 完整单据及lines[].sku当前名称/规格/编码/单位/启用与效期标志；无权限拒绝，不向拣货员开放成本 |
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
| GET/POST /admin/products；GET /admin/products/:id；POST /admin/products/:id/update-details | catalog.read/write | 商品与SKU、版本校验 |
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
| 报损接口 | 以文末stock-isolations/stock-dispositions实际接口及权限为准 | 原write-offs路径由0.5.0单据动作替代，不再并行实现 |
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

## 2026-10-28 已实现：隔离与报损

下列路径前缀为`/api/v1/warehouse/warehouses/:warehouseId`，逐次校验员工权限及仓库范围。GET用stock.read；admin/manager拥有新写权限，picker只读、rider拒绝。POST均需Origin、CSRF和UUID Idempotency-Key，严格字段白名单。

| 方法/路径 | 输入及权限 | 结果 |
|---|---|---|
| GET stock-isolations；GET stock-isolations/:id | stock.read；列表skuId/cursor/limit | 隔离原数量与剩余、版本、原因、关联流水 |
| POST stock-isolations | stock.isolate；positionId/quantity/version/reason | 立即增加blocked，不减少onHand |
| GET stock-dispositions；GET stock-dispositions/:id | stock.read；列表可按skuId/isolationId筛选 | 不含成本的处置及审批事实 |
| POST stock-dispositions | disposition.write；isolationId/kind/quantity/positionVersion/isolationVersion/reason | DRAFT；kind=RELEASE或DAMAGE，不预扣额度 |
| POST stock-dispositions/:id/approve | disposition.approve；version/reason | 须非申请人，APPROVED |
| POST stock-dispositions/:id/post | disposition.post；version | RELEASE只减blocked；DAMAGE另需physicalConfirmed=true和physicalEvidence，同减onHand与blocked |
| POST stock-dispositions/:id/cancel | disposition.write；version/reason | DRAFT/APPROVED取消，不改库存 |

列表UUID升序、默认20最多50。数量整数1..100000；原因/核验说明最多200字符。隔离/申请/审批/过账拒绝盘点冻结、核对暂停和账本差异。所有数量写先锁balance，再复核位置及隔离版本；快照变化409，取消旧单重建，不覆盖。解除在过账再次检查效期及启用库位；报损只消费自己隔离记录remaining，不消费预占或旧blocked。终态不可修改，原幂等键重试重放初次结果。详细错误与字段见0.5.0生成契约；取消可在冻结/暂停时执行但不解除任何暂停。

## 2026-10-28 已实现：收货逆向纠错

路径前缀`/api/v1/warehouse/warehouses/:warehouseId`；每次校验stock.read或动作权限及实际仓库范围。admin/manager拥有reversal.write/approve/post，picker只读，rider拒绝。POST均需允许Origin、CSRF和UUID Idempotency-Key。

| 方法/路径 | 输入及权限 | 结果 |
|---|---|---|
| GET receipt-reversal-sources/:positionId | stock.read | 原收货ID/行ID/来源、批次、原数量/已冲回/剩余额度、位置版本/自由数，不含成本 |
| GET receipt-reversals；GET receipt-reversals/:id | stock.read；列表skuId/lotId/cursor/limit | 分页逆向单或详情 |
| POST receipt-reversals | reversal.write；positionId/quantity/positionVersion/reason | DRAFT，不预扣 |
| POST receipt-reversals/:id/approve | reversal.approve；version/reason | 非申请人独立审批 |
| POST receipt-reversals/:id/post | reversal.post；version/physicalConfirmed=true/physicalEvidence | 幂等冲回自由库存，新两级流水 |
| POST receipt-reversals/:id/cancel | reversal.write；version/reason | 前两态取消，不改数 |

数量整数1..100000，原因/核验说明1..200字符；列表UUID升序默认20最多50，字段白名单。GET来源用RepeatableRead返回同一快照提示，POST仍按最新锁内事实裁决；不接受客户端仓库/SKU/原数量或成本。原批次剩余额度不足409 REVERSAL_LIMIT，自由数不足409 INSUFFICIENT_STOCK，旧快照409 VERSION_CONFLICT；COUNT_FROZEN/INVENTORY_HOLD/INVENTORY_MISMATCH拒绝申请、审批及过账。取消不清除冻结/暂停。稳定键重放原结果，同键不同输入409。全字段及状态见实际0.6.0契约。

## 2026-10-29 收货详情与UI读取补充

新增GET收货详情，路径仓库与单据ID同时限定；未登录401、无receipt.read/仓库范围403、本仓找不到单据404、非法UUID400。lines[].sku为当前目录联查资料，包含name/code/spec/unit/enabled/expiryManaged，不是历史名称快照；批次、数量、unitCostCents及效期仍来自原收货行。金额经现有jsonValue规范转换为JSON整数分，时间为ISO日期字符串。GET不写库存或变更单据状态。

创建/审核/过账接口和状态机未改；UI多行表单沿用1–50行、每SKU一批次的现有开发约束。前端核验勾选只用于提醒与防误触，不新增服务端body字段或独立员工要求。前端同窗口内对响应丢失保留原意图重试；完整跨重载恢复尚未验收。OpenAPI已从实际实现导出。

## 商品基本资料编辑（已实现，2026-10-30）

GET详情返回当前Product/SKU及version；POST update-details完整接受version、categoryId、name、description，名称trim后1–120、说明trim后0–2000且允许清空，严格拒绝status/skus/price等额外字段。catalog.write、Origin/CSRF/UUID幂等键必需；商品行锁与上下架串行，旧version为409 VERSION_CONFLICT；目标分类及父分类须启用，不可用400。成功保持原状态/SKU/库存，推进Product.version，事务内写PRODUCT_UPDATE_DETAILS审计及幂等结果。重复原键返回首次结果，界面再读列表/详情取得当前资料，不能把历史重放当作最新数据。审计reason仅记录版本和变化字段，不是完整历史快照。无迁移，见[交付报告](../verification/S2-PRODUCT-DETAILS-2026-10-30.md)。

## SKU售价及启停增量（2026-10-30）

| 方法/路径（/api/v1前缀） | 请求体 | 结果 |
|---|---|---|
| POST /admin/products/:id/skus/:skuId/set-price | `{version,priceCents}` | 完整Product及SKU，version+1 |
| POST /admin/products/:id/skus/:skuId/enable | `{version}` | 同上，保持商品状态 |
| POST /admin/products/:id/skus/:skuId/disable | `{version}` | 同上，保持商品状态 |

均需catalog.write、员工会话、可信Origin、X-CSRF-Token及UUID Idempotency-Key。严格拒绝多余字段；version为0–2147483646整数，priceCents为1–100000000整数分。id/skuId须UUID，规格必须属于路径商品，否则404。旧版本409 VERSION_CONFLICT；重复目标状态409 INVALID_TRANSITION；已上架最后一个启用规格停用409 LAST_ENABLED_SKU。停用后的公开详情404，目录排除；收货创建/过账409 SKU_DISABLED。新价不改变已记账成本。

幂等范围员工/动作/SKU，请求摘要包括商品ID、版本和新售价；相同键不同内容409 IDEMPOTENCY_CONFLICT。成功重放返回首次结果（可能是历史版本），当前状态需GET /admin/products/:id。确认成功后UI关闭并重读列表；响应未知冻结原操作和键重试；冲突保留输入并提供明确覆盖载入。关闭窗口后未提供持久化提交意图恢复。API是增量兼容，无新权限/迁移，见实际openapi.json及[验证报告](../verification/S2-SKU-MAINTENANCE-2026-10-30.md)。

## 分类维护增量（2026-10-30）

| 方法/路径（/api/v1前缀） | 请求 | 结果 |
|---|---|---|
| GET /admin/categories/:id | catalog.read | 当前Category及parent（Category或null） |
| POST /admin/categories/:id/rename | `{version,name}` | 当前Category，version+1 |
| POST /admin/categories/:id/enable | `{version}` | 当前Category，version+1 |
| POST /admin/categories/:id/disable | `{version}` | 当前Category，version+1 |

新增Category.version（默认0）；列表/创建/详情均返回该字段，父分类不依赖列表分页载入。写接口需catalog.write、员工会话、可信Origin、CSRF及UUID Idempotency-Key，拒绝额外字段。version为0–2147483646整数；名称trim后1–80字。错误UUID400、不存在404、旧版本409 VERSION_CONFLICT、重复启停409 INVALID_TRANSITION、启用但父分类停用409 PARENT_DISABLED。同键不同内容409 IDEMPOTENCY_CONFLICT，503事务竞争可用原键原内容重试。只读角色不能维护；前端不要求用户填写内部ID/版本/键。

幂等范围为员工/动作/分类，摘要含版本及新名称；重放返回首次结果，当前状态由GET核对。详情parent表示读取时父分类状态，父级停用不会推进子级version；服务端每次启用子级仍重新锁定/校验父级。停用不改写子级或Product，公开目录始终重新校验祖先enabled。响应未知时UI冻结原意图重试，版本/状态/父级冲突需显式载入；确认后列表刷新失败只提示核对，不继续提交。关闭窗口后没有持久化未知意图恢复。见[报告](../verification/S2-CATEGORY-MAINTENANCE-2026-10-30.md)及实际OpenAPI。

## SKU规格说明接口（2026-10-30）

POST `/api/v1/admin/products/:id/skus/:skuId/update-spec`，严格请求体 `{version,spec}`；version为0–2147483646整数，spec为trim后1–100字非空字符串。需要catalog.write、员工会话、可信Origin、X-CSRF-Token及UUID Idempotency-Key。编码、单位、售价、enabled、expiryManaged等多余字段拒绝400；UUID格式400、SKU不属于商品或商品/SKU不存在404、旧版本409 VERSION_CONFLICT。

成功返回完整Product及SKUs、Product.version+1；其他属性保持原值。使用员工/SKU_UPDATE_SPEC/SKU幂等范围，摘要包括商品ID、version、spec；同键不同内容409 IDEMPOTENCY_CONFLICT，原键重放返回首次结果，当前值需GET /admin/products/:id。事务竞争503可原键原内容重试。响应未知冻结原内容重试，冲突显式载入；确认后重读列表，刷新失败不开放重复提交。关闭窗口后没有持久化未知意图恢复。现有公开和仓储读接口结构不变，仅spec值随更正更新。见[验证报告](../verification/S2-SKU-SPEC-2026-10-30.md)及实际OpenAPI。

## SKU条码接口（2026-10-30）

POST `/api/v1/admin/products/:id/skus/:skuId/set-barcode`，严格body `{version,barcode}`。version为0–2147483646整数；barcode必须为字符串或null且不能缺省，字符串trim后1–64位ASCII数字，空白规范化为null。数字JSON、内部空格、全角数字及其他字符拒绝400；保留字符串前导零。SKU必须属于路径商品，格式错误400，不存在/归属不符404。需要catalog.write、员工会话、可信Origin、X-CSRF-Token及UUID Idempotency-Key。

成功返回完整Product及SKUs、Product.version+1，后台SKU增加可空barcode字段；公开SaleSku及收货详情读结构保持原样，不对顾客暴露新条码字段。旧版本409 VERSION_CONFLICT，其他SKU已绑定409 BARCODE_IN_USE（停用SKU仍占用），同键异内容409 IDEMPOTENCY_CONFLICT，事务竞争503可原键原内容重试。重复绑定竞争由数据库唯一索引保证，不以事先查询替代约束。

幂等范围员工/SKU_SET_BARCODE/SKU，请求摘要包括商品ID、版本及规范化条码。清空后另一SKU复用时，重放旧成功请求只返回首次历史结果，不能重新绑定条码；当前状态由GET /admin/products/:id核对。UI确认后GET当前列表，响应未知冻结原内容及键重试，冲突明确载入；重复条码错误保留可编辑输入。关闭窗口不持久化未知意图。见[记录](../verification/S2-SKU-BARCODE-2026-10-30.md)及实际OpenAPI。

## 收货候选条码精确查询（2026-10-31）

GET `/api/v1/warehouse/warehouses/:warehouseId/skus/by-barcode?barcode=完整条码`，同时要求catalog.read及receipt.write、有效员工会话、本仓授权且仓库启用。查询参数只允许barcode：trim后1–64位ASCII数字文本，不允许空/缺省/额外参数，前导零保留。无CSRF/幂等头要求（只读GET）；错误UUID或条码400，未登录401，角色/仓库/停用仓库403，未绑定404 BARCODE_NOT_FOUND。

返回ReceiptSkuLookup：原Sku字段及商品name，包含enabled/expiryManaged/barcode供显式选择；售价不是收货成本且UI不据此预填。唯一索引完整匹配，非按已载入页面过滤。停用SKU返回200并标记enabled=false（UI禁止选入，收货服务也拒绝）；草稿/下架商品及分类停用下的启用SKU仍可作为收货候选。不返回采购成本、库存量或其他仓数据。没有写业务审计、幂等记录或库存。

结果代表本次读取时的映射，不构成绑定预留；清空返回404、重新绑定后指向新SKU。确认选入后收货payload仍使用skuId，服务端创建/过账重查SKU约束，不按当时条码自动改写SKU。见[记录](../verification/S2-RECEIPT-BARCODE-2026-10-31.md)及实际OpenAPI。


## 商品主图已实现接口（2026-10-31，开发/测试）

POST /api/v1/admin/products/:id/set-image，catalog.write、会话/Origin/CSRF/幂等键，严格 {version,image:{fileName,mime,base64}}，image:null解除，返回商品及SKU。PNG/JPEG原始≤2MiB、16–4096边长且≤900万像素、单页，输出最长1200的PNG≤4MiB；开发JSON≤3MiB，413超限、400无效、409版本/意图冲突、503未配置/繁忙。生产本地适配器不可启用。GET /api/v1/admin/products/:id/image/:imageId需catalog.read；GET /api/v1/product-images/:id/:imageId须满足公开目录条件。两者只读当前同商品绑定，成功image/png，失败JSON；历史/无资格404。目录新增可空imageUrl，Product新增可空imageId。详细边界及实际OpenAPI见[报告](../verification/S2-PRODUCT-IMAGE-2026-10-31.md)和openapi.json；预签名上传意图方案仍是生产待实现设计。


## 商品多图已实现接口（2026-10-31，开发/测试增量）

GET /api/v1/admin/products/:id/images需catalog.read，返回 {product,images:[{id,url}]}。POST同前缀add-image需catalog.write/Origin/CSRF/幂等键，严格 {version,image:{fileName,mime,base64}}，非空逐张追加、最多6张，满额409 IMAGE_LIMIT。POST set-images严格 {version,imageIds:[UUID]}，最多6个不重复，仅当前本商品图片子集；第一张为主图，空集清空，历史/跨商品引用400 INVALID_IMAGE_REFERENCE，版本冲突409。两写接口返回图片集；图片处理及生产禁用规则沿用上轮。

公开SaleSku新增imageUrls（有序数组、无图[]），保留imageUrl首图/null。GET图片路由现读取当前集内任意图片，移出集后404；纯排序保留地址。旧set-image在多图下仅替换/移除首张、保留其他图片并递补，image:null不再必然imageId=null；清空请用set-images空数组。旧响应结构不变，历史幂等重放后应重新GET当前集。详见[兼容性及验收](../verification/S2-PRODUCT-GALLERY-2026-10-31.md)，实际契约见openapi.json。


## 公开详情规格增量（2026-10-31）

GET /api/v1/products/:id保留SaleSku字段，新增variants: SaleSku[]（1–20，同商品启用规格含缺货、UUID升序）。同一SQL读取选中SKU/兄弟规格及价格/原可用量计算，不依赖列表分页。锚点须启用且公开：无效UUID/额外查询参数400、隐藏/停用/未知404、经营仓不可用或异常超过20个启用规格503；不递补其他规格。列表接口结构不变，relatedToSkuId只供内部调用。兼容旧客户端只读顶层；新客户端对旧API无variants按单规格显示，完整功能依赖新版API。GET无业务写入，快照不构成锁价/锁货；见[本轮记录](../verification/S2-PRODUCT-VARIANTS-2026-10-31.md)与实际OpenAPI。


## 公开分类接口（2026-10-31已实现）

GET /api/v1/categories公开分页读取，参数仅limit（默认20，1–50）/cursor（UUID），返回 {items:[{id,name,parentId,parentName}],hasMore,nextCursor}，UUID升序。只返回enabled分类且父节点启用，根parent字段null，子项附父名称，含空分类，无内部维护字段或统计；参数400、经营仓未配置/停用503。GET无业务写入。原GET /products?categoryId=UUID继续父级含直接子级、子级仅自身，可同时keyword/cursor；未知/停用分类返回空商品页。实际契约与功能/UI分离证据见[报告](../verification/S2-CONSUMER-CATEGORIES-2026-10-31.md)和openapi.json。


## 商品聚合卡片接口（2026-10-31）

GET /api/v1/storefront/products公开，严格limit/cursor/keyword/categoryId；默认20、最多50，cursor为商品UUID。返回items的id=商品ID、entrySkuId=价格入口SKU，并含name/categoryId/imageUrl/spec/unit/priceCents/variantCount/hasStock。先筛可展示且匹配的SKU，按商品计数，优先available>0、再priceCents、SKU UUID选代表行；全缺货仍保留最低价参考；按商品游标分页，不返回库存总和。参数400、经营仓不可用503。原/products SKU列表/详情保留，新客户端需新版API，不用旧页前端去重降级。见[兼容性/验证](../verification/S3-PRODUCT-CARDS-2026-10-31.md)与实际OpenAPI。


## 游客草稿接续边界（2026-10-31）

无新API；游客草稿在本机保存，逐SKU复用GET /products/:id读取当前售价/可用量，客户端保留HTTP状态区分404失效与网络/503未知，最多4并发、刷新取消保护。参考小计不是报价，不提供结算动作。此前设计的登录/cart/merge和服务端cart_items未因本轮草稿而实现，不能向公众启用开发身份；见[记录](../verification/S4-GUEST-CART-2026-10-31.md)。


## 2026-10-31 消费者开发会话已实施

POST /api/v1/consumer/auth/dev-session仅显式开启的非生产、隔离本机库、直接回环请求可用；无Forwarded/X-Forwarded-*，有Origin需允许，必须X-Yumi-Dev-Login:1。JSON仅profile=customer-a|customer-b，返回token/expiresAt/user{id,displayName,provider:DEVELOPMENT}；默认关闭404，非法字段400、入口头403、停用401、30次/15分钟/IP后429。GET /consumer/me及POST /consumer/auth/logout用独立Authorization Bearer，拒绝员工Cookie/令牌，不接受userId等额外查询或退出字段；返回最小user/expiresAt或loggedOut。无消费者Set-Cookie，不接受客户端角色/openid；到期/撤销/停用/版本变化401；网络异常5xx不等于退出。没有/auth/wechat/session或/cart/merge实现。OpenAPI已同步，见[记录](../verification/S4-CONSUMER-SESSION-2026-10-31.md)。


## 2026-10-31 账号购物车接口实施

新增消费者Bearer下GET /consumer/cart；POST /consumer/cart/items(version,skuId加入1件)；PUT /consumer/cart/items/:skuId(version,quantity,selected)；DELETE /consumer/cart/items/:skuId(body.version)；POST /consumer/cart/selection(version,skuIds,selected)；POST /consumer/cart/merge(items+Idempotency-Key)。只从会话取userId，严格字段/查询白名单；全购物车版本控制，旧版本409。合并按user+key+规范化请求摘要重放，返回cart与合并当时checks(available/unavailable/excess/unknown)，当前读需另GET，超50行/总200件整笔409 CART_LIMIT_EXCEEDED；无效或缺货引用也保留，不静默丢失。全部为实现接口，替代此前未实施/cart路径的计划项；价格和可用量复用公开商品API，不提供报价/结算。见[契约和异常](../verification/S4-ACCOUNT-CART-2026-10-31.md)。


## 2026-10-31 已实现的配送范围接口

以下均位于/api/v1，OpenAPI已导出。

| 接口 | 输入/返回 |
|---|---|
| GET /admin/service-area | 员工范围鉴权；{area:null或含warehouse/buildings的完整快照} |
| POST /admin/service-area | {name}，全局唯一，默认停用 |
| POST /admin/service-area/update | {version,name,enabled} |
| POST /admin/service-area/buildings | {version,name}，默认停用 |
| POST /admin/service-area/buildings/:id/update | {version,name,enabled}，楼栋必须属于当前小区 |
| GET /service-areas | 公开{items:[{id,name,version}]}，最多1个，未配置或暂停为空 |
| GET /service-areas/:id/buildings | 公开{area:{id,name,version},items:[{id,name}]}，最多200 |
| GET /service-areas/:id/buildings/:buildingId | 公开核验当前有效链，{area,building}；不可替代未来地址/订单写时校验 |

后台需service-area.read/write，SUPER_ADMIN/OPERATIONS且当前经营仓库授权；写入要求Origin、CSRF和UUID Idempotency-Key，不接受客户端warehouse_id/area_id。固定经营仓库由PUBLIC_WAREHOUSE_ID限定。名称trim并合并连续空白，小区最多100字/楼栋80字，拒绝控制字符；楼栋名称按数据库lower唯一，数量200为技术边界。全范围版本不匹配409，历史同键重放返回原快照但仍复验当前角色与仓库范围；客户端成功后GET最新状态。额外字段/查询400，未登录401，无权限/仓库停用403，不存在或公开不可用404，重复/版本/容量/键冲突409，未知结果沿用原键重试。未配置经营仓库的后台503、公开列表为空。


## 2026-10-31 已实现本人收货地址API

原设计/addresses路由未启用，实际均为/api/v1/consumer/addresses并要求消费者Bearer。GET返回{version,items}，条目为id、areaId/areaName、buildingId/buildingName、unit、room、contactName、phone、note、isDefault、available，无userId或密文。最多20条，默认条目前置；失效范围的旧资料仍属本人，可读取和删除，available=false不能作为可下单证明。

| 接口 | 输入/返回 |
|---|---|
| GET /consumer/addresses | 本人完整地址簿；无额外查询字段 |
| POST /consumer/addresses | version、areaId、buildingId、unit、room、contactName、phone、note、isDefault |
| POST /consumer/addresses/:id/update | 同创建的完整可变字段及地址簿version |
| POST /consumer/addresses/:id/default | {version}，目标必须属于本人且范围当前有效 |
| POST /consumer/addresses/:id/delete | {version}，软删除并清除联系密文，不自动另设默认 |

所有写入要求UUID Idempotency-Key，成功仅{id,version}。回执在当前身份复验后、版本/范围校验前查重，历史成功重放不会撤销后来编辑或复活已删地址；相同键不同动作/目标/内容409。归属判定在非重放时优先于版本，外部/已删除ID404。额外字段/格式400、未登录/失效401、归属不存在404、范围停用/旧版本/容量/键冲突409、密钥未配置503。姓名、电话、门牌不得进入日志/回执/审计，正常地址响应仅发送本人。客户端结果未知保持原内容、键和账号，重试成功后GET最新列表；页面退出不自动重发，重新进入应先核对列表。未来结算仍须事务内重新校验范围和地址版本。


## 2026-10-31 已实现的规则、预检与报价

实际路由在/api/v1下，取代此前尚未启用的/checkout/quotes计划路径。

| 接口 | 鉴权及行为 |
|---|---|
| GET /store | 公开{status:UNCONFIGURED/PAUSED/OPEN,policy:null或规则} |
| GET /admin/checkout-policy | checkout-policy.read+当前经营仓库授权，{policy} |
| POST /admin/checkout-policy | checkout-policy.write、Cookie/Origin/CSRF、UUID幂等键；{version:null或整数,deliveryFeeCents,minGoodsCents,freeDeliveryThresholdCents:null或整数,open}；新建open必须false |
| POST /consumer/checkout/preview | 消费者Bearer；{addressId,addressVersion,cartVersion}；返回ready、issues、逐行状态/价格/数量和可空金额；不落报价 |
| POST /consumer/checkout/quotes | 同输入+UUID Idempotency-Key；通过核验才保存并返回{id,createdAt,expiresAt,expired,preview} |
| GET /consumer/checkout/quotes/:id | 本人历史快照及expired，到期不删除或续期；外部ID404 |

preview逐行status为AVAILABLE/UNAVAILABLE/EXCESS，无有效售价为null；整单商品失效/超量时goodsCents=null，任何阻断条件下deliveryFeeCents/payableCents=null。issues区分EMPTY_SELECTION、CART_LIMIT_EXCEEDED、ADDRESS_OUT_OF_RANGE、POLICY_UNCONFIGURED、STORE_PAUSED、ITEMS_UNAVAILABLE、BELOW_MINIMUM。商品额只含当前全部有效选中行，不接受客户端单价、合计或SKU清单。addressVersion是全地址簿版本，不是单地址版本。

额外字段/参数或金额格式400，身份失效401，角色/仓库/CSRF403，非本人地址/报价404，版本/同键内容冲突409；预检中的普通业务阻断返回200和ready=false，生成报价有阻断则409 CHECKOUT_BLOCKED；并发可重试冲突503，超过20个有效报价429。客户端未知结果保留原内容、键和本人账号，重试确认；历史重放保持原时间/金额，不把已过期历史快照变成新报价。规则版本变化或价格变化需重新核验和新键，不能自动覆盖旧报价。该次报价切片未实现订单/支付路由；订单开发基础见2026-11-01增量，支付仍未实现。


## 2026-11-01 本人订单与真实预占（仅本机开发）

`GET /store`新增`orderSubmissionEnabled`，由服务端开发开关决定，默认false；此标志不代表已确认经营规则或支付能力。以下路由均位于`/api/v1`，仅消费者Bearer，不接受员工Cookie替代本人身份。

| 接口 | 输入与行为 |
|---|---|
| POST /consumer/orders | UUID Idempotency-Key；`{quoteId,note?}`，备注最多200字符；成功仅`{id}` |
| GET /consumer/orders | 可选UUID cursor；本人订单按createdAt/id倒序，每页20，返回items/hasMore/nextCursor |
| GET /consumer/orders/:id | 本人订单完整明细、金额、加密收货资料解密结果与状态；外部ID404 |
| POST /consumer/orders/:id/cancel | 空对象；仅本人且从未开始支付的待支付订单，成功`{id}`；已取消重复调用仍成功 |

创建仅在ORDER_DEV_SUBMIT_ENABLED=1、非生产、loopback API和本地yumi_dev/yumi_test数据库允许；默认关闭。提交不接受客户端商品、数量、价格、地址明文或状态。事务内复验会话、原报价归属/有效期/唯一消费、购物车/地址簿/范围/规则版本与实时商品/库存，任何一行失效整单拒绝。锁定汇总/批次/位置后按效期优先、无效期最后预占，同时保存不可变商品/金额及加密地址快照、逐位置分配、汇总和位置流水与ORDER_CREATED待处理事件。实物on_hand不变。下单后购物车保留，再次购买须重新报价。

同账号同键同规范化内容返回原订单ID，即使原报价已到期或订单已取消；改内容409，另一键复用报价409。客户端先持久化原账号/报价/键，响应未知或页面重入使用原键，不自动换键；取到本人订单后才清除待确认记录。401/服务失败保留记录，明确业务拒绝需用户确认后才能重新核验。服务端每账号最多5笔待支付订单属于技术保护，不是经营规则。

状态仅AWAITING_PAYMENT→CANCELED，paymentState=NOT_STARTED，fulfillmentState=NOT_READY。取消/后台超时复用事务释放内核，订单行锁与原分配保证只释放一次；只更改reserved，追加释放流水/事件，不改原事实、不退款。开发预占默认900秒，可设ORDER_DEV_HOLD_SECONDS=1..900用于隔离测试，非已确认付款承诺。worker启动即检查，此后30秒一轮，每轮最多20笔、每笔独立事务并SKIP LOCKED；任何未来已开始/未知支付状态必须先对账/关单，不进入直接释放路径。事件当前持久化为PENDING，未实现消费者、履约派发或外部消息投递。

严格输入400、身份失效401、非本人报价/订单404、过期/变化/已用报价/库存不足/幂等冲突409、开发关闭或并发可重试503。真实支付、退款、微信身份、合法域名与真机网络需另外交付验收。


## 2026-11-01 后台订单只读查询

新增`order.read`，仅SUPER_ADMIN/OPERATIONS默认获得，且必须显式拥有对应warehouse_id。仓管、拣货、骑手、客服不因此取得订单查询权。员工Cookie鉴权和每请求角色/仓库范围复验沿用现有机制；消费者Bearer不可访问。此次无写路由，无代客取消、支付、退款或通用状态编辑。

| 接口（/api/v1下） | 输入与输出 |
|---|---|
| GET /admin/orders | 必填warehouseId；可选status=AWAITING_PAYMENT/CANCELED、q=1–40位英文字母数字订单号前缀（转大写）、UUID cursor；返回items/hasMore/nextCursor，每页20 |
| GET /admin/orders/:id | 必填warehouseId；返回订单商品/金额快照、原预占分配及释放时间、订单动作记录 |

按createdAt/id倒序，以同仓库且匹配当前筛选的订单作游标锚点；跨筛选/不存在游标404，未授权或停用仓库403，仓库内不存在订单404，额外字段/重复参数/无效格式400，未登录401。没有limit、客户姓名/电话检索或批量导出参数。查询事务使用RepeatableRead，避免取消期间混合旧订单状态与新释放记录。

列表和详情显式选择字段，不查询/解密address_payload，不返回用户ID、联系人、电话、门牌、地址/订单备注、原报价ID、幂等键/摘要、请求编号、事件payload或库存操作人的内部ID。金额为整数分；预占展示商品、规格、数量、批次、效期、库位code/name和reserve/release时间，表示该单分配记录，不是当前库位库存。库位名称是当前主数据。订单事件仅返回动作类型/来源类别/时间。查询不追加业务事件或修改订单/库存；拒绝访问仍沿用员工权限审计。


## 2026-11-01 本机支付准备单

本轮只实现渠道调用前的准备记录，非微信预支付单。paymentState仍为NOT_STARTED，实际PAYMENT_MODE=disabled；不接收回调，不提供支付成功/退款入口或支付参数。复用ORDER_DEV_SUBMIT_ENABLED作为本机开发准备开关，默认关闭；其生产/非本地数据库限制沿用订单基础。

| 接口（/api/v1下） | 契约 |
|---|---|
| GET /consumer/orders/:id/payment-preparation | 本人Bearer；无查询参数；{enabled,intent:null或准备记录}，enabled仅表示允许保存开发准备记录 |
| POST /consumer/orders/:id/payment-preparation | 本人Bearer、UUID Idempotency-Key、空对象；成功仅{id}，不接受金额/状态/渠道/用户ID |

服务端锁定本人订单，金额仅取不可变payableCents、币种CNY、渠道DISABLED；仅待支付且未开始支付、预占未到期订单可准备。同用户同键同订单重放原ID，即使记录后来已关闭；同键另一订单409；同订单换键不产生第二记录，409后应GET核实。创建准备不改订单版本/支付状态、不增加或延长库存预占。新准备需要仍启用开发开关；关闭后仍可读取本人已有记录。

状态仅PREPARED→CLOSED，关闭原因CONSUMER_CANCEL/PAYMENT_TIMEOUT。取消与超时复用订单锁和释放事务，同时关闭记录、写审计事件，任一步失败整体回滚；从未向渠道发起请求，因此此处关闭不是渠道关单或退款。未来任何外部渠道请求必须新增支付状态与查单/关单/验签设计后再开放，不能把PREPARED解释为渠道处理中。

公开准备字段仅id/state/channel/amountCents/currency/preparedAt/closedAt/closeReason，不返回幂等键、消费者/仓库内部ID、请求编号、密钥或联系资料。后台GET /admin/orders/:id新增可空paymentPreparation，仍按order.read和仓库范围限制且只读，不在列表附加敏感信息。输入400、身份401、非本人订单404、旧键冲突/已有记录/订单不可准备409、开发关闭或可重试竞争503。


## 2026-11-01 支付接入检查（只读、离线）

GET /api/v1/admin/payment-readiness?warehouseId=UUID。新增payment-readiness.read，仅SUPER_ADMIN默认拥有；每请求仍复验员工角色、显式仓库范围及仓库启用。运营/仓管/骑手/消费者无此权限。缺失/额外/重复或格式错误参数400，未登录401，角色/范围/停用仓库403，无写入/启用/上传凭据接口。

返回{checkedAt,channel:DISABLED,canStartPayment:false,warehouse:{id,name},checks}。11项检查分CONFIGURATION/OPERATIONS/IMPLEMENTATION/ACCEPTANCE，状态为MISSING/INVALID/FORMAT_OK/CONFIGURED/UNVERIFIED/BLOCKED。前三项只检查部署时非敏感WECHAT_PAY_APP_ID、WECHAT_PAY_MCH_ID、WECHAT_PAY_NOTIFY_URL的本地格式；启动后修改需重启生效。API只返回固定状态/说明，不回显原值、配置路径、密钥或用户数据。

本地规则：AppID为wx加16位小写字母数字，商户号8–32位数字；通知地址限512字符内HTTPS域名、标准端口和非根路径，拒绝空白/控制字符/反斜线、IP/本地域名、账号、查询串及片段。这是项目预检策略，FORMAT_OK不代表官方验证、DNS公网解析或地址可达。未配置允许应用保持禁用运行，格式错误报告INVALID，不自动填样例或联网。

经营项从同仓库真实规则与范围读取，存在/开放仅标CONFIGURED或暂停BLOCKED，不冒充负责人经营验收。渠道下单/查单/关闭及通知验签解密/补偿尚未实现，固定BLOCKED；绑定、凭据、微信身份和HTTPS/真机固定UNVERIFIED。因此无论字段是否格式通过，canStartPayment始终false。准备/订单/库存不受检查动作改变，查询使用RepeatableRead。

applicationConfig集中拒绝除disabled外的PAYMENT_MODE（含mock），API/worker现有启动禁用保护保持。离线命令npm run check:payment-config只输出前三项脱敏格式报告和禁止支付标志；缺字段时退出0，字段INVALID或模式不支持退出1。退出0不是可部署/可支付证明。


## 2026-11-01 通知验签/解密隔离基础

本轮不注册公开微信通知接收路由，不接收真实凭据或报文，不更新支付/订单状态。仅新增管理员合成验证接口，复用payment-readiness.read（默认仅SUPER_ADMIN）与显式启用仓库范围。

| 接口（/api/v1下） | 行为 |
|---|---|
| GET /admin/payment-notification-lab?warehouseId=UUID | {enabled,syntheticOnly:true,callbackEnabled:false,cases}，9项场景定义 |
| POST /admin/payment-notification-lab/run?warehouseId=UUID | 员工Cookie、Origin/CSRF、空对象；返回completedAt/结果列表及同样的合成/关闭标志 |

字段和参数严格校验，不能提交rawBody、私钥、APIv3密钥等材料。默认PAYMENT_NOTIFICATION_LAB_ENABLED=0，执行返回503；显式1仅允许非生产loopback API与本地yumi_dev/yumi_test，生产/非本地库拒启。非法输入400、身份401、角色/范围/CSRF403，无权与停用仓库不会因开关而放行。运行是无业务副作用的独立计算，不持久化结果，重复运行不需要业务幂等键。

内部纯函数verifyPaymentNotification只接收调用方提供的可信公钥映射/预期交易信息及原始Buffer：以头部时间戳、随机串、原文字节和末尾换行构造验签串，RSA-SHA256/PKCS1验签后才解析、AES-256-GCM认证解密，再核对商户/AppID/商户单号和整数分金额。返回最小规范化事实，不返回payer或完整明文；无网络、文件、数据库或支付状态迁移。

本地技术保护：原文上限64KiB，签名为规范Base64及RSA2048长度，Wechatpay头拒数组/大小写重复/控制字符，未知标识不自动取证书或回退公钥；可选签名类型只允许WECHATPAY2-SHA256-RSA2048。时间戳要求当前10位秒值并限定正负300秒，资源nonce为12字节、密钥32字节、认证标签16字节，AAD可省略/为空，编码严格UTF-8，资源/交易类型及CNY/安全整数金额严格校验。这些是当前局部保护，不代替可信公钥管理、原始HTTP接收、持久化通知去重、真实支付单核对和补偿。相同报文在时间窗口内可以重复通过纯密码学检查，不能据此重复记账。

GET /admin/payment-readiness仍固定canStartPayment=false，CALLBACK保持BLOCKED，仅说明已有合成验证核心；不将本轮通过转为真实渠道就绪。

## 2026-11-01 合成通知持久化 API（0.17.0）

以下均为员工Cookie及payment-readiness.read（默认SUPER_ADMIN），warehouseId必填且检查授权启用仓库。GET可在实验关闭时查询；POST另需可信Origin/CSRF及PAYMENT_NOTIFICATION_LAB_ENABLED=1，默认503；不接受真实报文、密钥或任意业务状态。

| 方法与路径（/api/v1） | 输入与返回 |
|---|---|
| GET /admin/payment-notification-records | warehouseId、可选cursor；20条最小事实、nextCursor、enabled、syntheticOnly=true、callbackEnabled=false |
| GET /admin/payment-notification-records/:id | 仓库内详情；不存在或其他仓库记录404 |
| POST /admin/payment-notification-records | body仅{key:UUID}，由服务端生成、签名并验证合成通知；返回record、duplicate |
| POST /admin/payment-notification-records/:id/replay | body仅{}，按已有合成标识重新生成签名和密文，重复事实返回同一record |

未知字段/非法UUID400，未登录401，无权限/无仓库范围403，未知游标404，事实冲突409，实验关闭503。每次原文验签及解密后，使用固定字段顺序的已验证事实SHA256判等，不以密文相同为前提；通知标识唯一范围为本隔离表内的warehouseId。事务锁和唯一约束保护竞争，首次记录与业务审计同事务提交；重复接收不重复审计或业务写入。此API没有真实通知入口、订单匹配和付款确认能力；未来真实渠道必须另有商户/渠道命名空间和业务幂等设计。

## 2026-11-01 支付关闭判定实验（0.18.0）

GET /api/v1/admin/payment-close-lab?warehouseId=UUID返回enabled、syntheticOnly=true、callbackEnabled=false及12项code/title。POST同路径/run仅接收空对象{}，返回completedAt及实际纯判定运算结果PASSED/FAILED，不接收订单号、状态或支付报文，不产生业务写入。

员工Cookie、payment-readiness.read（默认SUPER_ADMIN）和授权启用仓库必需；POST还需可信Origin/CSRF及PAYMENT_NOTIFICATION_LAB_ENABLED=1，默认503。非法/额外输入400，未登录401，无权限/无仓库范围403。仍限制非生产loopback及本地yumi_dev/yumi_test。运行结果只是确定性处理预案与结果顺序检查，不能当成渠道并发或支付成功验收。现有消费者取消API/worker接口不变，底层释放改为锁定重读真实订单再决策。

## 2026-11-01 合成支付尝试 API（0.19.0）

以下/api/v1/admin/payment-attempt-lab均需要员工Cookie、payment-readiness.read（默认SUPER_ADMIN）及warehouseId授权启用仓库。GET在实验关闭时仍可读；POST另需可信Origin/CSRF及默认关闭的PAYMENT_NOTIFICATION_LAB_ENABLED=1，仅非生产loopback和本地yumi_dev/yumi_test允许。

| 方法与路径 | 输入/输出 |
|---|---|
| GET / | warehouseId、可选cursor；20条摘要、nextCursor、enabled、syntheticOnly=true、callbackEnabled=false |
| GET /:id | 当前证据、处理预案及最多101条版本顺序事件 |
| POST / | 仅body{key:UUID}；先保存尝试/STARTED事件及审计，返回attempt、duplicate |
| POST /:id/actions/unknown-result | 仅{key:UUID}；保存UNKNOWN_RESULT合成观察 |
| POST /:id/actions/closed-result | 仅{key:UUID}；保存CLOSED_RESULT合成观察 |
| POST /:id/actions/success-result | 仅{key:UUID}；保存SUCCESS_RESULT合成观察 |

不接受订单号、任意状态、凭据或报文。证据NONE/UNKNOWN/CLOSED/SUCCEEDED/CONFLICT与paymentCloseDecision处理预案同查；releaseAllowed始终false。详情锁定同一尝试，避免读取旧汇总配新事件；按createdAt/id稳定降序分页。未登录401，无权限/范围403，非法UUID/动作/额外字段400，不存在记录或游标404，同键动作冲突/100次结果上限409，默认关闭503。同键重试返回当前详情，不承诺重放旧响应快照；幂等保证副作用只发生一次。

## 2026-11-01 查询任务接口增量（0.20.0）

GET /api/v1/admin/payment-attempt-lab/:id详情新增queryJob（可空），含state、attempts、nextRunAt、leaseUntil及按版本排序的任务历史（reason/state/attempts/createdAt）。不返回租约令牌、内部操作键或凭据。任务RETRY/LEASED/DONE/EXHAUSTED表示调度状态，DONE只是停止自动查询，不代表支付入账。

POST /api/v1/admin/payment-attempt-lab/run-query-cycle?warehouseId=UUID仅body{}，处理本仓至多一个到期合成任务，返回processed及syntheticOnly=true；不是所选详情的强制执行接口。没有到期任务时processed=false；第三次租约过期可将任务标耗尽而不再执行查询。该调度动作可重复检查，并不承诺原请求响应重放，任务副作用由租约和操作键保证有效完成一次。

POST /api/v1/admin/payment-attempt-lab/:id/retry-query?warehouseId=UUID仅body{key:UUID}，只允许仍UNKNOWN的耗尽任务重新安排，原键重试返回当前详情且不重复审计/任务事件。不满足条件或键已用于其他任务动作409。沿用员工Cookie、payment-readiness.read、启用仓库范围、Origin/CSRF与默认关闭的PAYMENT_NOTIFICATION_LAB_ENABLED；未登录401、无权403、非法输入400、未知记录404、实验关闭503。所有观察仍来自明确的合成适配器，没有微信查单入口。

## 2026-11-01 合成补偿核查 API（0.21.0）

GET /api/v1/admin/payment-review-lab?warehouseId=UUID&filter=ALL|UNKNOWN|CONFLICT|EXHAUSTED&cursor=UUID：filter默认ALL，返回enabled、syntheticOnly=true、20条待核查摘要和nextCursor。ALL为未知/冲突/耗尽并集；摘要含证据、尝试/任务版本、任务状态、真实备注数量和needsReview，不含凭据或租约令牌。

GET /:id?warehouseId=UUID&notesCursor=UUID：返回锁定读取的当前item、最近20条不可变备注和nextNotesCursor。详情可查看已离开待核查范围的历史，游标限定同仓同尝试。按createdAt/id稳定降序，列表游标不要求锚点仍满足动态筛选，避免状态变化使下一页不可用。

POST /:id/notes?warehouseId=UUID仅{key:UUID,note:string,attemptVersion:integer,jobVersion:integer|null}。CR/CRLF规范为LF、去首尾空白，拒绝空/过长和非Tab/LF的C0及DEL控制字符。服务按仓库→尝试→任务锁顺序校验快照和待核查范围，再原子追加备注与PAYMENT_REVIEW_LAB_NOTE审计。原键先匹配既有备注，再校验新快照，已保存原操作可恢复；同键换内容/版本409 IDEMPOTENCY_CONFLICT，旧快照409 REVIEW_SNAPSHOT_STALE，当前无需核查409 REVIEW_NOT_NEEDED。

沿用员工Cookie、payment-readiness.read（默认SUPER_ADMIN）、启用仓库授权，POST另需Origin/CSRF和PAYMENT_NOTIFICATION_LAB_ENABLED；默认503，生产及非本机隔离拒启。非法输入400、未登录401、无权403、不存在记录/游标404。没有更新/删除备注、标记已支付、退款或解决异常的接口。

## 2026-11-01 渠道契约验证（OpenAPI 0.22.0）

- GET `/api/v1/admin/payment-adapter-lab?warehouseId=<uuid>`：返回enabled、syntheticOnly=true、callbackEnabled=false及17个code/title。
- POST `/api/v1/admin/payment-adapter-lab/run?warehouseId=<uuid>`，严格空JSON `{}`：返回completedAt及results；每行code/title/status(PASSED或FAILED)、classification、evidence(UNKNOWN/SUCCEEDED/CLOSED)、next(RETRY/REVIEW/RECONCILE)、releaseAllowed=false。结果由共享核心实际执行，未保存运行历史。
- 需要员工Cookie、payment-readiness.read和有效仓库授权；POST还校验Origin与CSRF。401未登录，403权限/仓库/CSRF，400未知字段或非法UUID，503 PAYMENT_ADAPTER_LAB_DISABLED。沿用PAYMENT_NOTIFICATION_LAB_ENABLED本机隔离开关，默认关；既有配置拒绝生产、远端数据库启用。

内部PaymentQueryAdapter.query(binding,signal)返回unknown，executePaymentQuery只调用一次，等待默认3000ms，允许1至10000整数毫秒；超时发出abort并丢弃迟到结果，不在内部重试。异常不返回原文。调用方必须保存原查询绑定并负责后续退避、持久化与核查；这些尚未接入。未来HTTP实现需先验证响应原始字节，再提供authenticated=true，外部API不能传入此标志。本轮无真实HTTP请求或渠道回调入口。

查询协议错误码参照[微信支付小程序查单官方文档](https://pay.wechatpay.cn/doc/v3/merchant/4012791900)：RULE_LIMIT对应业务频率限制，ORDER_NOT_EXIST应核查订单创建，SYSTEM_ERROR应以原参数重试。本项目将不存在/绑定异常保留UNKNOWN并转核查，为保护性策略；真实接入仍需独立验签及渠道验收。

## 2026-11-01 查询分类隔离接入（OpenAPI 0.23.0）

- GET `/admin/payment-attempt-lab?warehouseId=…`增量返回queryScenarios(code/title)，供17个固定合成场景选择。
- POST `/admin/payment-attempt-lab/run-query-cycle?warehouseId=…`兼容空JSON，新增可选scenario，默认NOTPAY，值仅queryScenarios中的code。仍需员工Cookie、支付检查权限、授权仓库、Origin及CSRF，实验关闭503；未知场景/原始响应/多余字段400且不领取任务。返回processed表示是否成功提交一条本仓到期任务，不保证是当前详情记录。
- 尝试详情queryJob.events新增可空classification、resultEvidence、next、scenario。历史/领取/停止事件没有查询结果时全部null；不返回租约令牌或原始渠道材料。任务状态新增REVIEW。
- `/admin/payment-review-lab?warehouseId=…&filter=REVIEW`筛选分类待核查任务。备注的taskState快照兼容REVIEW；其他权限、游标及版本校验不变。

手动“运行一轮”是一次执行触发，不是原键重放命令；响应不明时应刷新详情确认，界面不自动重试。领取仍排除未到期及REVIEW任务，租约令牌只允许一次有效完成。原键重新安排仅适用于UNKNOWN+EXHAUSTED，不能恢复REVIEW。真实支付接口未增加。
