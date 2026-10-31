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
