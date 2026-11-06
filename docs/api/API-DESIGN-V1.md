## 2026-11-06 商品上架检查（OpenAPI0.74.0）

新增GET /admin/rewards/:id/readiness，points.write、员工会话及当前经营仓授权，UUID id，不接受任何查询参数。范围外商品和不存在404、无效输入400、身份/权限401/403、未配置经营仓503。RepeatableRead内读前后复验权限；不写商品/库存/积分/审计业务记录。

返回checkedAt、canPublish（当前非已上架且无已有阻断）、displayableNow（当前上下架和时间满足公开展示条件，不承诺有库存）、inventoryAvailable（仅库存可用量，不因源商品草稿误报缺货）、submissionEnabled（现环境提交开关，不代表上线）、product最小维护定位和version、reward当前规则快照、10项checks。检查状态READY/WARNING/BLOCKING/INFO，action为固定维护类型或null，不接受客户端指定URL或经营状态。快照不含成本、顾客身份、图片对象键或密钥。封面仅检查有效元数据，文件实际加载须在原图片管理核验。

原发布接口、版本/幂等、上下架门槛及匿名积分商品契约均不变。检查和提交之间可能变化，既有动作再次裁决；不得将canPublish当作授权令牌、库存预占或真实经营验收结果。

## 2026-11-06 运营商城（OpenAPI0.73.0）

新增POST /admin/mall-products：员工Cookie/Origin/CSRF/UUID Idempotency-Key，catalog.write与points.write并校验当前运营/管理员及经营仓权限。输入categoryId/name/description?/单元素skus[]（沿用编码/规格/单位/整数分/效期）/pointsPrice?（null或1至10亿整数字符串）/reason；不接受任意状态或库存。事务创建商品/SKU与可选兑换草稿，商品/兑换审计及幂等记录一起提交。返回id/skuId/rewardId（可空），同键恢复，改内容409，分类/价格无效400，权限403，冲突可重试503。原POST /admin/products等接口保持兼容。

新增GET /admin/customers：points.read、当前角色/会话/经营仓复验；keyword（80字）、provider=WECHAT/DEVELOPMENT、enabled=true/false、UUID cursor。每页20条，按UUID升序，包含零余额/停用账号；游标须符合相同筛选，否则409。列表仅id/displayName/provider/enabled/createdAt/balance，未知/重复参数400。GET /admin/customers/:id返回user及lastLoginAt、当前仓orders/redemptions/pendingGrants/pendingCorrections，缺失404；不返回subject/OpenID、会话、地址、手机号或密文。

GET /admin/rewards后台列表新增priceCents（整数分），与pointsPrice并列；匿名/rewards原契约保持，不新增现金字段。GET /admin/points/grants、/corrections和/corrections/sources新增可选UUID userId过滤，原仓授权和写动作不变；不新增余额修改、任意扣分或绕过审批接口。顾客页定向操作仅预选目标，财务正确性仍由原服务校验。

## 2026-11-06 请求层C3a（OpenAPI0.72.0）

GET /admin/payment-readiness新增IMPLEMENTATION/JSAPI_TRANSPORT，UNVERIFIED；总项数及maxItems为14。显示私有凭据/固定HTTPS请求层本地已验证，订单尝试持久化/恢复/取消保护未接入；真实商户、公钥来源及灾备仍未验收。原权限、仓库范围、channel=DISABLED与canStartPayment=false保持。

没有新增公开支付、凭据读取/上传/重载、签名或调起参数接口。内部createWechatJsapiGateway.prepay只接受服务端订单/付款人，返回经原文验签的参数与凭据修订号，既不落库也不更改订单。前置拒绝NOT_DISPATCHED，传输开始后的失败统一RESULT_UNKNOWN，不返回上游错误正文或系统细节；未来业务调用须先持久化尝试、事务外HTTP、结果持久化后再提供参数。离线命令不接入Web API，具体材料/调用约束见[运维手册](../operations/WECHAT-PAY-CREDENTIALS.md)。

## 2026-11-06 支付身份C2（OpenAPI0.71.0）

POST /consumer/auth/wechat-session仍只接受code，既有用户/token响应不变，不返回OpenID、密文、密钥标识或session_key。配置独立加密密钥后，在已核验微信身份的同一登录事务内创建/刷新付款人绑定；未配置时保持原哈希身份登录。登录审计或绑定失败整笔回滚，不发出半成品会话；已领取code仍不可复用。

GET /admin/payment-readiness新增CONFIGURATION/PAYER_STORAGE（MISSING/INVALID/CONFIGURED），总项数及maxItems为13；仅返回说明，不返回密钥或标识。原权限/仓库范围与canStartPayment=false保持。内部paymentPayer(tx, request, appId)从当前会话本人的服务端绑定解密，重新校验会话、启用、身份版本、AppID；不提供任何公开查询或任意用户解密接口。未来C3必须在受控的短事务中使用它，不得信任前端OpenID或把数据库锁带入外部HTTP等待。内部错误为401会话失效、403身份/AppID不符、409/PAYER_REFRESH_REQUIRED需重新登录，503加密不可用/身份不可读；本轮不新增公开支付调用。

## 2026-11-06 支付检查C1（OpenAPI0.70.0）

GET /admin/payment-readiness新增JSAPI_PROTOCOL检查项，IMPLEMENTATION/UNVERIFIED，仅说明JSAPI签名协议已完成离线实现、实际商户/HTTP下单和订单入账未接入；总检查项12，maxItems由11更新12。原角色/仓库权限、状态枚举、channel=DISABLED及canStartPayment=false保持。内部协议不提供公开签名/凭据/支付参数接口，不改变消费者准备单契约，无迁移。支付用户身份项反映原始OpenID安全绑定仍缺，不将已有登录代码误称未实现。

## 2026-11-06 本人昵称（OpenAPI 0.69.0）

新增 POST /consumer/profile/nickname，消费者Bearer/no-store，body为displayName和expectedDisplayName两个字符串，不接受顾客编号或查询参数。目标去除首尾空白并NFC规范化后限制1至20个Unicode码点，拒绝不可见控制/格式字符；expectedDisplayName原样取自GET /consumer/me的当前值，最长80码点。只更新会话本人显示名，返回与GET /consumer/me相同的user/当前会话expiresAt，不发新token。当前值等于原昵称或已等于目标时成功，其他情况409/PROFILE_CHANGED；输入400、无有效身份401。使用当前值比对而非历史版本号；重复请求只能写相同目标，没有财务动作或新幂等键契约。GET /consumer/me新增no-store，其他消费者契约保持，无迁移。



## 2026-11-06 消费者售后反馈列表（OpenAPI 0.68.0）

新增 GET /consumer/redemption-after-sales。消费者Bearer/no-store，仅返回本人EXPRESS兑换单的最小反馈摘要；可选status=OPEN/PROCESSING/CLOSED、keyword（最多80字符，标题/订单号不区分大小写字面匹配）、UUID cursor。每页20条；游标须属于本人和相同筛选条件，否则409/CURSOR_INVALID。未知/重复/非法参数400、未登录401。响应不含反馈正文、收货地址、员工姓名或身份；原按订单读取/提交/补充/重开接口无变化，无迁移。
2026-11-02最新优先级：负责人要求新增积分商城，小程序与运营后台同时交付，优先实现并上线，其他功能随后依次上线。详见[积分商城首发设计](../product/POINTS-MALL-V1.md)。本轮为设计，尚未实现或上线；积分经营参数仍待配置。该要求覆盖历史排除积分及旧下一步顺序，必要的真实登录、库存、履约、售后和生产验收依赖仍须完成。API与数据新增内容均为设计草案，非已发布契约。

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

## 2026-11-01 通知关联（OpenAPI 0.24.0）

- GET `/api/v1/admin/payment-notification-records/attempts?warehouseId=…&cursor=…`：授权仓库的可关联新尝试，20条，items含id/label/amountCents及nextCursor；固定路由优先于记录`:id`。旧无绑定尝试不列出。
- POST `/api/v1/admin/payment-notification-records?warehouseId=…`兼容原`{key}`独立记录，增量允许`{key,attemptId}`。仅服务器生成合成签名密文和固定交易事实，不接受rawBody、密钥或任意交易状态。关联不存在404、验签/绑定拒绝400、同通知事实/交易绑定冲突409、默认关闭503。既有员工Cookie/支付检查权限/仓库范围/Origin/CSRF保持。
- 返回record增量application(nullable，含attemptId/eventId)，state为RECORDED_ONLY或LINKED_SYNTHETIC。写入结果新增applied：仅首次追加尝试证据为true；duplicate仍表示通知记录本身是否已存在。新通知标识+同交易返回duplicate=false、applied=false。
- 已关联记录重放沿用原尝试绑定及固定交易号，重新签名加密但返回原事实记录。无关联记录保持旧独立行为。
- 尝试详情新增notificationBinding(nullable，含测试商户单号、金额/币种及创建时间)和最近20条notifications(id/notificationId/createdAt)。关联不代表真实支付，releaseAllowed仍false。

手动创建失败保留按尝试分开的原操作键，切换目标不复用另一目标的键；响应不明先原键重试或刷新。原始报文、付款人字段和密钥既不落库也不回传。尚无公开回调或真实商户HTTP请求。

## 2026-11-01 只读核查时间线（OpenAPI 0.25.0）

新增GET `/api/v1/admin/payment-review-lab/:id/timeline?warehouseId=…`，员工Cookie、payment-readiness.read及仓库授权；实验关闭仍可只读查看已有事实。未知尝试404，匿名401，越权/仓库撤销403。严格query仅warehouseId/filter/cursor/focus，未知字段400。

filter为ALL(默认)、ATTEMPT、QUERY、NOTIFICATION、NOTE。cursor和focus为服务器生成的`SOURCE:uuid`引用，不能同时使用；服务器重新在当前尝试/仓库内查锚点，不信任客户端时间或任何外部URL。来源不支持、UUID无效、与非ALL筛选冲突400；引用不属于当前范围404。cursor排除锚点加载更早页；focus包含目标且排首位，再向更早记录分页。

响应item是同次锁定读取的当前核查摘要，items最多20，nextCursor可空，filter/focusedRef/syntheticOnly如实返回。行包含id/ref/source/createdAt/title、只读entries(label/value)和最多2个related(ref/label)。字段为核查展示投影，不作为状态写入参数。无leaseToken、事件幂等键、原始报文、付款人或密钥；接口通用requestId元数据保持原样。

旧核查详情及notesCursor接口保持兼容，新UI用统一时间线及NOTE筛选呈现历史，不改变POST备注的CSRF/Origin、幂等和版本校验。分页是实时keyset读取，新增事实需刷新；不提供跨请求冻结快照。


## 2026-11-01 核查跨页入口与返回定位

本轮仅客户端导航，沿用OpenAPI0.25.0，没有新增接口或参数。来源将实际warehouseId/attemptId及NOTIFICATION:记录UUID或ATTEMPT:事件UUID交给核查详情/时间线；目标继续调用既有详情与timeline的focus参数，服务端重新检查权限、仓库与尝试归属，不能凭来源快照越权。目标可以不在当前异常筛选中；备注写入资格、版本校验、幂等和审计不变。

GET失败保留来源返回路径，不显示上一个目标详情。备注保存响应丢失后的未确认键/文本/快照仅存当前会话内存，切换目标后按原内容恢复原键；不新增任何资金或任务动作。


## 2026-11-01 合成核查只读概览

新增GET `/api/v1/admin/payment-review-lab/summary?warehouseId=UUID`，OpenAPI0.26.0。仅允许warehouseId，未知字段/数组/缺失或非法UUID400；匿名401、无角色权限/未分配仓库/停用仓库403。沿用payment-readiness.read（当前SUPER_ADMIN）与仓库范围校验；默认实验关闭可读取既有数据。

返回warehouseId、generatedAt（数据库统计语句开始时刻）、syntheticOnly=true、enabled（既有实验写入开关）和counts={ALL,UNKNOWN,CONFLICT,EXHAUSTED,REVIEW}非负整数。ALL按尝试对四种原因取并集去重，其余按当前证据/任务状态独立计数，已知结果仍可能EXHAUSTED/REVIEW；不把四分类相加。空仓五项均0。

单条SQL从当前仓库尝试LEFT JOIN唯一attempt_id任务并执行COUNT FILTER，所有分类共享语句MVCC快照，统计全量而非20条列表投影；没有事件/备注JOIN导致计数放大。统计不读取报文、凭据、备注正文或顾客资料，不写入审计、尝试、任务、订单或库存。概览和列表为独立实时请求，可在并发更新期间不同时刻；不承诺冻结一致。旧端点响应兼容不变。


## 2026-11-01 S6拣货准备只读核验

新增只读GET `/api/v1/warehouse/picking-readiness?warehouseId=UUID&q=订单号前缀&cursor=UUID`，每页20条；q为1–40个英文字母/数字，统一大写，按订单创建时间/UUID倒序，游标须匹配仓库与当前搜索。列表仅含订单号、三个状态维度、创建时间、规格种数及总件数，不返回顾客/地址/支付金额。

GET `/api/v1/warehouse/picking-readiness/:id?warehouseId=UUID`，返回上述摘要、checkedAt、claimEnabled=false、去重blockers、商品快照及分配明细。明细含批次、效期、库位、原分配数量、released及issues；activeReserved是本订单该SKU未释放分配总量，不是全仓余量。核对订单需求/当前SKU预占、库位和批次预占/可承载预占数量、库存冻结、库位启用、批次到期；不暴露余额明细、流水内部编号、报价/请求/幂等键、密文、联系人、资金与合成支付事实。

阻挡码：READ_ONLY_PHASE（始终包含）、ORDER_CANCELED或ORDER_NOT_ACTIVE、PAYMENT_UNCONFIRMED、FULFILLMENT_NOT_READY、RESERVATION_RELEASED、RESERVATION_MISMATCH、LOCATION_DISABLED、LOT_EXPIRED、STOCK_FROZEN。已释放分配不再展示针对当前库位的可作业判断。所有核验仅诊断，未开放真正资格通过/领取动作。

权限picking.read只授予SUPER_ADMIN/WAREHOUSE_MANAGER/PICKER，不授予运营或骑手；不向拣货员开放order.read。匿名401、角色/仓库归属/启用失败403，严格参数400，未找到本仓订单/无效游标404。列表/详情均RepeatableRead，仓库校验沿用已有锁；不写审计/订单/库存，无POST领取、实拣或出库。OpenAPI0.27.0，旧接口兼容。


## 2026-11-01 拣货领取与逐行核对隔离演练

OpenAPI0.28.0新增`/api/v1/warehouse/picking-lab`（所有端点须warehouseId）：GET列表（cursor可选，20条）、GET `/:id`、POST创建、POST `/:id/claim`、POST `/:id/check`。创建体仅{key:UUID}；领取{key,version:0..3}；核对{key,version,lineId,quantity:0..200整数}，lineId仅PAPER_SINGLE/PAPER_TRIPLE，数量必须分别2/1。严格拒绝额外字段、真实订单/SKU或通用状态输入。

读权限picking-lab.read、作业picking-lab.work授予SUPER_ADMIN/WAREHOUSE_MANAGER/PICKER；创建picking-lab.create仅前两者。所有写入Origin/CSRF检查；当前仓库范围和启用重新校验。核对只能任务owner本人，读本仓任务不等于能改他人任务。匿名401、权限/非本人/仓库范围403、参数400、本仓任务/游标404、版本/数量/竞争/幂等内容冲突409、默认关闭503。生产配置拒启，关闭后已有合成历史仍可只读。

读返回enabled及task或分页items；任务投影含合成标识/短标签、state/version、ownerId/name、固定两行需求/checked、最多4条操作历史。写返回{task,duplicate}；同键精确恢复返回当前完整投影，不重复事件/审计。投影不含请求键、expectedVersion、真实订单/SKU、凭据或顾客资料。创建键按仓库+创建者隔离，动作键按任务+操作者隔离并绑定全部输入；原键先于版本/终态判定恢复，禁止抢占。

同任务写入锁定任务行；创建唯一键竞争只建一次；读取使用RepeatableRead，创建重复响应加共享锁保持事件快照一致。任务、事件、业务审计原子提交，失败均回滚。前端5xx/网络未知结果保留原操作；重试不是新意图，刷新不会确认写入结果。无正式订单领取、部分实拣、异常处置、出库或配送端点。


## 2026-11-01 合成缺货上报与未决阻断

OpenAPI0.29.0新增POST `/api/v1/warehouse/picking-lab/:id/shortages?warehouseId=UUID`：体{key,version,exceptionVersion,lineId,missingQuantity,reason}。领取人且具picking-lab.read/work可上报，行仅PAPER_SINGLE/PAPER_TRIPLE、原因仅MISSING/DAMAGED，正整数数量不超过原固定需求，拒绝已核对/重复未决明细。

POST `/:id/shortages/:shortageId/restore?warehouseId=UUID`：体{key,version,exceptionVersion,shortageVersion,confirmedQuantity}；picking-lab.resolve仅SUPER_ADMIN/WAREHOUSE_MANAGER，当前仓库重新鉴权，拣货员403。确认数量必须等于原需求2/1；只将该记录置RESOLVED，不改checkedLines。两端点严格Origin/CSRF和字段校验，400参数/401匿名/403权限归属/404本任务记录不存在/409版本、数量、未决冲突或上限/503默认关闭/500事务失败。

任务投影新增exceptionVersion和shortages（最多50条，每条最多2条不可变事件），含合成行、上报数量/原因、OPEN/RESOLVED、版本、上报/处理姓名、时间及动作历史；不含内部操作键、期望版本、凭据、顾客或真实库存引用。GET旧列表/详情接口仍使用原路径，读取同一RepeatableRead快照。

CLAIM/CHECK新增可选exceptionVersion，省略按0解释，旧无缺货任务/原键保持兼容；出现缺货变化后旧版本0请求409，需要刷新并提交新版本。原领取/核对事件保存缺货快照，原请求键绑定该字段；已成功原键仍先恢复再判断新状态。上报/处理幂等键按任务+操作者隔离，绑定动作、任务版本、缺货版本、明细或记录、数量/原因及记录版本，变更409。

所有新动作与CHECK锁定同一任务，序列化缺货/核对竞争。OPEN时任何CHECK均被服务端和数据库阻止；上报与处理的任务/缺货/事件/业务审计原子提交。未知网络/5xx保留原操作，明确4xx拒绝后可刷新修正；无通用改状态、部分放行或真实出库接口。

## 2026-11-01 合成打包/出库接口

OpenAPI0.30.0由实际应用导出，新增`POST /api/v1/warehouse/picking-lab/:id/pack`及`/:id/dispatch`，均要求warehouseId查询参数、员工会话、可信Origin和X-CSRF-Token；返回`{task,duplicate}`。

pack严格字段：key(UUID)、version(0–3)、exceptionVersion(0–100)、packageCount(1–20)、singleQuantity/tripleQuantity(整数0–200)。实际数量必须2/1，任务必须CHECKED/两行已核对/无OPEN；仅领取人且有picking-lab.work。dispatch严格字段：key、version、exceptionVersion、packId(UUID)，需负责人/仓管的picking-lab.ship；所引用打包必须属于当前任务且快照一致。

GET列表/详情和写回投影增加packingReadiness（ready/blockers：PICKING_INCOMPLETE、SHORTAGE_OPEN、PACK_ALREADY_RECORDED）及可空pack。pack含id、actorName、packageCount、singleQuantity、tripleQuantity、createdAt和可空dispatch（id、actorName、createdAt）；不暴露原请求键。原任务状态/版本和既有接口不变。

同任务行锁串行化，先识别已成功同人员/键，再核验当前快照。原键内容改变409 IDEMPOTENCY_CONFLICT；另一键/人员重复该阶段409 PICKING_STAGE_RECORDED；旧快照409 PICKING_VERSION_STALE；不完整409 PICKING_INCOMPLETE；未决缺货409 PICKING_SHORTAGE_OPEN；数量不匹配409 PICKING_PACK_QUANTITY；无打包/错打包/过时打包分别409 PICKING_PACK_REQUIRED/MISMATCH/STALE。角色/归属403、未知任务404、严格参数400、默认关闭503；5xx/网络失败只能判定结果未知，客户端保留原请求。旧GET客户端可忽略新增字段，新增UI须配合0.30.0 API与迁移部署。

## 2026-11-02 合成配送分配与本人任务

OpenAPI0.31.0已由实际应用导出。新增`/api/v1/delivery-lab`：

| 方法/路径 | 权限与行为 |
| --- | --- |
| GET /warehouses | delivery-lab.read，仅返回本人启用授权仓库的id/code/name，不新增骑手warehouse.read权限 |
| GET /riders?warehouseId | read+assign，仅返回本仓启用RIDER的id/displayName，不包含联系方式/账号凭据 |
| GET /?warehouseId&cursor? | read；有assign权限可查本仓已合成出库任务，其余人员限定assignment.riderId=本人；20条稳定分页，nextCursor可空 |
| GET /:id?warehouseId | read，id为合成出库id；同仓且本人归属，不可见或不存在统一404 |
| POST /:id/assign?warehouseId | read+assign，严格body={key(UUID),riderId(UUID)}，可信Origin/CSRF必需；只首次分配，返回{task,duplicate} |

SUPER_ADMIN/WAREHOUSE_MANAGER新增delivery-lab.read及assign；RIDER仅read。列表返回enabled、selfOnly、items、nextCursor；详情返回enabled/task。task为id、label、packageCount、dispatchedAt、syntheticOnly=true、可空assignment(id/riderName/actorName/createdAt)、handoffReadiness(ready/blockers)。只返回姓名快照，不暴露原请求键、原骑手/分配者内部id、真实订单或顾客数据。交接资格报告不等于当前查看者的动作授权。

资格阻断码：LAB_DISABLED、UNASSIGNED、RIDER_DISABLED、RIDER_ROLE_REMOVED、RIDER_WAREHOUSE_REMOVED、PICKING_NOT_READY。账号/角色/范围来自当前数据库快照；列表/详情在RepeatableRead事务中读取，不把历史分配等同持续有效资格。

写入先锁原任务，已成功原人员/键先恢复，改骑手409 IDEMPOTENCY_CONFLICT；换键/人员重复阶段409 DELIVERY_ALREADY_ASSIGNED；无合成出库404 DELIVERY_LAB_NOT_FOUND；原快照不满足409 DELIVERY_NOT_READY；目标骑手不合格409 RIDER_INELIGIBLE。当前仓库/权限403，格式或额外字段400，默认关闭503。未知网络/5xx不得视为未提交，原请求应保留恢复；资格撤销后原成功请求仍返回原凭据和当前阻断信息。没有接货、送达、改派或通用状态修改接口。

## 2026-11-02 合成骑手接货增量（待运行验证）

已编写本人合成接货实现：POST /api/v1/delivery-lab/:id/accept?warehouseId=…，请求严格限定key(UUID)、packageCount(1–100整数)，需CSRF与delivery-lab.accept（仅RIDER角色授予）。服务端按当前仓库及本人分配过滤；未分配/他人任务404，包裹数与原合成出库不一致409。提交锁原合成任务，重新锁定核验当前启用账号/RIDER/仓库范围及出库快照、未决缺货。

新增delivery_lab_handoffs，assignment_id唯一外键、原请求键、核对数量、创建时间；骑手身份取不可变分配，不接受客户端操作者。原本人/键/数量重试恢复，新键或数量改变409；凭据与DELIVERY_LAB_ACCEPT审计同事务。数据库触发器复核数量/资格/快照，拒绝凭据更新删除。响应新增可空handoff{id,packageCount,createdAt}，不暴露原键。历史分配不补造接货。

骑手详情提供独立数量核对与原请求重试，仓管只读接货凭据；仍无真实订单/库存/支付/配送送达动作，演练沿用默认关闭及生产拒启。迁移202611020002_delivery_handoffs尚未应用；先迁移、生成Prisma Client再部署。回退须关闭演练并保留凭据，禁止旧服务重复交接。

本次环境无项目依赖/本地配置，未找到Node/npm，故PG集成测试、构建、OpenAPI自动导出和浏览器截图未运行。本节是实现契约及待验证说明，不是业务或UI验收通过声明；OpenAPI JSON待实际应用导出。

2026-11-02验证更新：本节接货实现已通过37项相关PG、1项配置及实际API浏览器检查；OpenAPI0.32.0已自动导出。前述无Node/未运行说明已由后续恢复环境和验证覆盖；迁移仅应用临时测试schema，正式开发库未启用。完整检查及剩余微信/真实交接边界见S7-DELIVERY-HANDOFF-2026-11-02验收记录。

## 2026-11-02 合成配送开始与送达

已实现本人合成接货→开始→送达的显式动作接口start/complete，仅请求key(UUID)，需delivery-lab.work（仅RIDER授予）、CSRF和本仓本人归属。跳步409、他人404、无权限403；首次提交重验账号/角色/仓库及出库快照，事务内锁任务并生成凭据/审计，同阶段原键恢复、新键409，完成后仍可恢复原开始凭据而不回退阶段。

新增delivery_lab_journey_facts，assignment_id+kind唯一，kind限定START/COMPLETE；数据库复核接货/开始前置与当前资格并拒绝修改删除。DTO新增journey.start/completion可空{id,createdAt}，旧记录不补造。骑手详情明确勾选合成动作并支持未知结果原请求恢复，仓管只读进度。不涉及真实顾客签收、照片/定位、订单/库存扣减或支付；PICKING_LAB_ENABLED仍默认关闭/生产拒启。

迁移202611020003_delivery_journey仅在真实PG临时schema应用验证，正式开发库未部署；目标部署先迁移、生成Prisma Client、重建服务，回退关闭演练且保留事实。OpenAPI0.33.0已导出，24项PG及1项配置检查、实际API桌面/手机UI通过；微信真机/真实交付仍未验收。详见S7-DELIVERY-JOURNEY-2026-11-02记录。

## 2026-11-02 合成配送异常基础

已接货且未合成送达的本人任务可POST /delivery-lab/:id/report-exception（warehouseId查询参数，key UUID、reason限定UNREACHABLE/REFUSED/DAMAGED），需delivery-lab.work及CSRF。每分配最多一份不可变未决异常，原键/原原因恢复，改原因或新键409。异常与送达锁同一任务串行竞争；未决异常阻断新开始/送达，已有凭据原键恢复只读不改变阶段。本轮无处置/退款/改派/退回入库。

新增delivery_lab_exceptions及202611020004_delivery_exceptions，DB阶段门禁同时复核接货/完成和异常；凭据/审计同事务且事实不可修改删除。DTO新增可空exception{id,reason,createdAt}，OpenAPI0.34.0；历史任务不补造。迁移仅临时PG schema验证，部署先迁移并重建，回退关闭演练保留事实。18项PG与实际API桌面/手机UI通过，真实配送/微信真机/生产仍未验收。截图仅本地保留并由Git忽略，详见S7-DELIVERY-EXCEPTION-2026-11-02记录。

## 2026-11-02 合成异常处置与恢复

本仓负责人/仓管通过resolve-exception显式确认合成异常已处理，请求仅key、exceptionId UUID，需assign权限/CSRF/仓库范围。新增不可变delivery_lab_resolutions（异常唯一、分配/处置人FK及姓名/键/时间），原人原键恢复、新人/键冲突；原异常保留，未决条件改为缺少处置凭据。处置与审计同事务，DB复核当前处置人/骑手资格及异常归属，只解除隔离阻断，不自动推进阶段或改变真实库存资金。OpenAPI0.35.0、迁移202611020005仅临时PG schema验证，部署先迁移并重建，回退关闭演练保留事实。20项PG及实际桌面/手机UI通过；真实配送/微信真机/生产未验。详见S7-DELIVERY-RESOLUTION-2026-11-02记录。

## 2026-11-02 合成异常清单与概览

配送GET列表新增exceptionState=ALL/OPEN/RESOLVED/NONE（默认ALL），当前授权仓库/骑手本人范围内过滤；游标也校验筛选。summary返回all/open/resolved/none/readAt，三类互斥覆盖全部，统计不受分页/筛选影响并与当前页同一RepeatableRead快照。异常已处置不等于送达。UI计数筛选、原因标识、空/错态和详情返回刷新完成。OpenAPI0.36.0，无迁移和新写入动作；22项PG及实际桌面/手机UI验证通过，截图仅本地忽略。完整边界见S7-DELIVERY-EXCEPTION-LIST-2026-11-02记录。

## 2026-11-02 合成配送凭据时间线

任务DTO新增最多7节点timeline{id,kind,createdAt,actorName,reason,relatedId}，只聚合已保存出库/分配/接货/开始/异常/处置/送达事实，按记录时间及同毫秒固定次序展示；姓名来自不可变凭据/原分配快照，处置关联原异常，不暴露请求键或员工内部ID。复用本仓/本人服务端权限，无迁移或新增状态写入。UI支持异常过滤、无异常空态及滚动/键盘焦点定位。OpenAPI0.37.0，23项相关PG及实际桌面/手机UI验证通过，真实履约/真机/生产仍未验收；详见S7-DELIVERY-TIMELINE-2026-11-02记录。

## 2026-11-02 异常清单追溯与返回

异常卡片可直达当前上报/处置时间线事实并聚焦；返回按原筛选重读原已加载页数，恢复来源按钮焦点/滚动位置。来源不在已加载结果时提示并聚焦列表标题；返回503保留详情供整段重试，401/403清除缓存。导航仅组件进程内保存，不承诺跨侧栏/整页重载持久化；多页逐请求读取不承诺跨页固定快照。复用现有API及服务端范围，无接口/模型/迁移变化，OpenAPI仍0.37.0。实际PG浏览器验证和构建/类型规范通过，历史PG套件本轮未重跑。详见S7-DELIVERY-NAVIGATION-2026-11-02记录。

## 2026-11-02 合成履约权限回归

分配人权限新增事务内启用/管理角色/当前本仓资格重验及共享锁，入口鉴权后已提交撤权会403且不产生分配/审计。新增迁移202611020006_delivery_assigner_gate同步加强DB门禁；表结构、接口及OpenAPI0.37.0不变。迁移仅临时PG schema验证，部署先迁移再服务，回退关闭演练保留事实及更严格门禁。最终53项PG、1项配置及实际API桌面/手机弱网注入回归通过，真实履约/真机/生产仍未验收；详见S6-FULFILLMENT-REGRESSION-2026-11-02。


## 2026-11-02 积分P1a账户查询增量

本人余额/分页流水及后台授权账户查询已实现，积分为十进制字符串；新用户真实零余额，无发放或兑换动作。新增账户/不可变流水及延迟配平约束，仅临时schema迁移验证。P1整体未完成，实际UI截图与微信/真机待验；详见P1A-POINTS-ACCOUNTS-2026-11-02验证记录及POINTS-MALL-V1计划。


## 2026-11-02 P1b积分发放已实现（本地）

正向发放申请直接提交待审批，另一负责人批准/驳回、本人撤销；单笔与北京时间每日预算，缺配置默认暂停。批准同事务写余额/不可变流水/审计及幂等结果，终态不可改删。新增points_grant_policies/points_grants及Prisma模型，迁移202611020009仅临时schema验证；OpenAPI0.39.0。6项真实PG及实际双员工浏览器闭环通过，小程序同源码预览查到账，微信/真机与生产未验。下一项P1纠错扣减/冲正及来源追溯，不跳到P2。详见P1B-POINTS-GRANTS-2026-11-02验证记录。


## 2026-11-02 P1c关联误发冲正（本地已实现）

仅从本仓已入账发放发起部分/全额冲正，待审批及已批准占用原来源额度；独立审批、本人撤销，余额不足保持待审批并拒绝负数，不自动追缴，冲正不恢复发放预算。新增points_corrections与来源复合外键/SQL保护，迁移202611020010仅临时schema验证。后台独立入口及小程序负流水来源展示、原键恢复完成；OpenAPI0.40.0，8项真实PG及28张浏览器截图通过。微信/真机及生产未验。下一项P2兑换商品管理与商城/详情。详见P1C-POINTS-CORRECTIONS-2026-11-02验证记录。


## 2026-11-02 P2兑换商品与商城浏览增量

后台按真实名称/规格选择SKU，维护积分价、上下架、排序、时间与累计限兑/总配额配置；一仓一SKU一个兑换商品，来源不可更换，版本与审计/原键恢复同事务。公开列表/详情复用现金商品可售SQL，受效期、冻结/隔离、预占、库位及源商品启用约束。新增reward_products及迁移202611020011，含来源复合唯一和SQL保护；仅临时schema验证，不应用业务主库。GET /rewards、/:id，GET /admin/rewards、/skus，POST /admin/rewards/store/create及/:id/update、publish、unpublish；版本0.41.0。小程序商城/详情展示整数数量与积分合计，redemptionEnabled固定false，不是兑换报价，无扣积分/预占/订单；累计已兑与配额占用在P3实现后才开放下单。正式经营规则仍待确认。具体契约及验收见P2-REWARD-CATALOG-2026-11-02记录；最终检查结果以该记录为准。


## 2026-11-02 P3积分兑换交易增量

本机隔离报价（120秒）、单SKU扣分/实物预占/累计限兑、双方订单与本人取消已实现；默认REDEMPTION_DEV_SUBMIT_ENABLED=0，生产/远程拒启。独立redemption_quotes/orders/allocations/outbox/events、消费者身份积分流水及来源复合外键/SQL配平/不可变约束；现金单复用原锁与预占算法，不冒用支付单或合成拣货。总/个人用量在兑换商品锁内按有效单聚合，取消同事务退分、释放库存与配额并撤销待办；价格/地址/资格变化需重新报价。小程序独立确认、列表和详情，持久化原账号/报价/键恢复，后台只读预占及动作证据。OpenAPI0.42.0；新增迁移202611020012仅临时schema重放，旧SDK的积分actor非空模型须做兼容，不可在新流水存在后盲退旧版。正式经营规则仍未确认，不开生产兑换；Outbox无真实执行器，下一项P4真实拣货接入及领取/取消竞争。完整边界、接口与实际检查见P3-REDEMPTIONS-2026-11-02记录。


## 2026-11-02 P4a兑换真实拣货任务与领取

新增redemption_picking_tasks/events及redemption_outbox_events，扩展Outbox租约/最多3次退避重试/耗尽与人工恢复。唯一任务绑定兑换单、仓库和SKU复合来源，不连接合成演练。Worker幂等建READY，不再扣分或动实物；本仓有效负责人/仓管/拣货员按真实批次/库位资格竞争领取，只有管理角色重试失败待办。领取与消费者取消按库存→订单→Outbox→任务锁内互斥；READY可取消，CLAIMED拒绝直接退分/释放。默认REDEMPTION_PICKING_DEV_ENABLED和REDEMPTION_FULFILLMENT_WORKER_ENABLED均0，生产/远程拒启，不改业务主库。API基路径/warehouse/warehouses/:warehouseId/redemption-picking，GET列表/:id和POST/:id/claim、/:id/retry，员工Cookie/CSRF/原键/版本及事务内权限；OpenAPI0.43.0。后台、仓库手机和消费者状态同步，未提供出库配送或假完成。新增迁移202611020013仅临时schema验证，须迁移后部署匹配API/Worker，旧P3取消不能处理新待办状态与版本，不可盲退旧版。完整规则、约束、接口和实际检查见P4A-REDEMPTION-PICKING-2026-11-02记录。下一项领取人按真实预占核对与缺货阻断，P4/P5未整体验收。


## 2026-11-02 P4b兑换逐项核对与异常阻断

真实预占分配逐项完整件数核对、领取人缺货/破损上报、仓管确认原需求备齐及重新核对、全项完成拣货已实现，本地验证见[P4b记录](../verification/P4B-REDEMPTION-PICKING-WORK-2026-11-02.md)。异常不改库存或积分，不换批次；某项上报会使此前核对失效，处置后仍须领取人重新核对。未决异常、漏项、数量不符及当前冻结/效期/来源资格变化阻断完成；CHECKED仅表示拣货核对完成、待打包，仍未出库或配送。CLAIMED/CHECKED均禁止消费者直接取消，未交付协调取消/重派/出库/配送/售后。沿用本机作业开关默认关闭、生产拒启，经营规则与真机/生产未验，P4/P5未整体验收。下一项P4c打包前完整性与真实幂等出库，需继续校验原预占与库存账实约束；已领取消/员工停用后接续仍是后续必需能力。

OpenAPI 0.44.0，基路径 `/api/v1/warehouse/warehouses/:warehouseId/redemption-picking`，新增 POST `/:id/check`、`/:id/report`、`/:id/resolve`、`/:id/complete`。统一员工Cookie、Origin/CSRF、Idempotency-Key，仓库和会话/角色在事务内重查；不允许额外字段。check/report/complete由任务当前领取人执行（redemption-picking.work），resolve仅本仓负责人/仓管（redemption-picking.resolve）。

|动作|请求体|行为|
|---|---|---|
|check|version、allocationId、quantity|原预占完整件数，未决异常拒绝|
|report|version、allocationId、quantity、kind|kind=SHORTAGE/DAMAGE；1..该分配件数；冻结/过期仍可记录；同项未决拒绝重复报|
|resolve|version、allocationId、quantity、issueId|匹配当前未决原异常；quantity必须原分配完整件数，确认原批次/库位已备齐；不是换货/调账|
|complete|version|当前领取人、全部原分配最新事实CHECK且现时资格通过，转CHECKED|

version为当前任务版本，每个动作递增一次。相同员工/动作/订单/键及完全相同输入返回历史结果；改体同键409；失权后拒绝重放。GET列表新增status=CHECKED，详情/列表项增work.complete/canComplete、lines[].checked/issue及history[]（事实id、action、allocationId、quantity、actorId、createdAt）。history保留已处置异常，quantity在COMPLETE为空。消费者及后台订单fulfillmentState增PICKED_WAIT_PACK；既有客户端须升级后部署，不能把新状态误当可直接取消。

错误包括400 VALIDATION_ERROR；403 PICKING_OWNER_REQUIRED/FORBIDDEN；409 VERSION_CONFLICT、ALLOCATION_INVALID、QUANTITY_MISMATCH、PICKING_ISSUE_OPEN、ISSUE_CHANGED、ALREADY_CHECKED、PICKING_INCOMPLETE、PICKING_BLOCKED；503 REDEMPTION_PICKING_DISABLED/RETRYABLE_CONFLICT。未知网络/5xx保留原键及完整原始输入，刷新或重载后同键核实，不能自动另建请求。


## 2026-11-02 P4c原预占打包与真实幂等出库

领取人逐项原批次/库位完整装包、本仓负责人/仓管核验实物出库已实现，本地验证见[P4c记录](../verification/P4C-REDEMPTION-PACKING-2026-11-02.md)。打包只写不可变凭据；出库同事务写唯一出库凭据、每项原预占消费指针、库位/批次/仓库on_hand与reserved等量扣减及主/位置流水、审计和幂等结果。冻结、盘点、失效来源、停用库位、过期、数量/完整性不符均阻断，晚失败全部回滚。出库不再扣积分、不退积分、不释放累计限兑/总配额；兑换单仍ACTIVE，履约由真实事实展示PACKED_WAIT_SHIP或SHIPPED_WAIT_HANDOFF。消费者不能直接取消已开始履约的单。仍为本机默认关闭的开发能力，未操作业务主库或生产，未接骑手配送、售后或协调取消；P4/P5未整体验收。下一项P4d真实兑换骑手分配与接货，后续继续配送、异常、售后及经营上线门禁。领取人停用接续/重派、已领取消及打包后异常恢复仍是上线前必需能力。

OpenAPI 0.45.0，基路径 `/api/v1/warehouse/warehouses/:warehouseId/redemption-picking`，新增：

|动作|请求体|权限/行为|
|---|---|---|
|POST /:id/pack|version、packageCount、lines:[{allocationId,quantity}]|redemption-picking.work；原领取人，当前CHECKED，全部原分配逐项精确数量；唯一打包事实|
|POST /:id/ship|version、packId、physicalConfirmed:true|redemption-picking.ship；本仓SUPER_ADMIN/WAREHOUSE_MANAGER，当前有效打包及同一拣货版本，明确核验实物，全部出库一次|

员工Cookie、Origin/CSRF、Idempotency-Key、事务内有效会话/角色/仓库均需通过。version使用完成拣货任务的当前版本，阶段事实不重写原拣货核对；packId必须当前本单打包凭据，普通用户界面自动选择。packageCount为1..100整数，lines为1..1000个不同原分配；每项quantity为1..100000整数且必须等于原分配完整件数；这些是开发技术保护上限，不是已确认经营参数。不接部分出库/换批/拆单；同仓跨单分配也拒绝。

同员工/动作/订单/原键可恢复同一结果；内容改变409，pack lines按allocationId规范排序。新键重复阶段409 STAGE_ALREADY_RECORDED；未核验实物400 PHYSICAL_CONFIRMATION_REQUIRED；漏项/换项/件数不符409 PACK_QUANTITY_MISMATCH；尚无匹配打包409 PACK_REQUIRED；其余沿用VERSION_CONFLICT、PICKING_OWNER_REQUIRED、PICKING_INCOMPLETE、PICKING_BLOCKED与默认关闭503。未知5xx或网络结果保留原始完整输入/键，不能自动换键再出库。失权后拒绝重放；同一员工兼具领取及仓管角色可打包和出库，本轮未新增独立审批业务规则。

GET列表增加互斥status=PACKED/SHIPPED；CHECKED只筛拣货完成但尚未打包。列表/详情新增packing.canPack/canShip（阶段和源资格条件，不代替员工权限校验）、packing.pack（id、包裹数、执行人、时间及逐项件数）、packing.shipment（id、执行人、时间）。顶层state是事实派生PACKED/SHIPPED，task.state仍CHECKED表示原拣货完成事实；实际阶段以顶层state和packing读取。

消费者及后台订单fulfillmentState增加PACKED_WAIT_SHIP、SHIPPED_WAIT_HANDOFF；出库后不声称开始配送。后台分配增加consumed布尔，released仍为取消释放，reserved沿用历史已预占凭据含义；显示优先consumed→released→预占中。出库后的当前待预占量按未消费分配计算，不错误要求已消费预占仍留在reserved。新旧客户端和服务端应匹配部署。


## 2026-11-03 P4d真实兑换骑手分配与本人接货

已出库的真实兑换单接入本仓负责人/仓管分配、被分配骑手精确核对包裹及原装包逐项件数后接货，本地验证见[P4d记录](../verification/P4D-REDEMPTION-DELIVERY-2026-11-03.md)。分配/接货为独立不可变事实，引用原shipment/pack/allocation；不再变库存、积分或配额，不接合成演练。骑手只读本人分配单；列表不返回顾客地址，授权详情才解密原订单地址，403/404等失权或范围变化清空旧详情。原分配人及骑手当前角色/仓库资格、货品效期和原出库完整性变化会阻断新交接；这些为保守开发校验，不等同于经营应急规则已确认。消费者与仓库页同步分配/已接货状态，明确尚未开始配送。沿用本机REDEMPTION_PICKING_DEV_ENABLED默认0及生产/远程拒启，业务主库、现有.env和生产未改，未进行真实人员实物交接。下一项P4e真实配送开始与送达；改派/撤权接续、异常处置、协调取消、售后与P5仍待交付，商城未上线。

OpenAPI0.46.0，基路径 `/api/v1/warehouse/warehouses/:warehouseId/redemption-delivery`，id指原真实shipment.id，不能传合成演练任务或未出库order.id。

|接口|请求/行为|
|---|---|
|GET /|cursor、status可选；status=UNASSIGNED/ASSIGNED/HANDED_OVER，默认全部；UUID升序20条，游标必须在当前状态和授权范围，跨范围409|
|GET /:id|单条Page信封；授权详情才附address原订单地址快照，列表不包含address|
|GET /riders|负责人/仓管读取有效本仓RIDER候选的id/displayName；非本仓、停用及无骑手角色者不列入|
|POST /:id/assign|{riderId}；本仓SUPER_ADMIN/WAREHOUSE_MANAGER，原出库只分配一次，不提供改派|
|POST /:id/accept|{assignmentId,packageCount,lines:[{allocationId,quantity}],physicalConfirmed:true}；仅有RIDER角色的被分配本人，逐项精确完整接货|

新增权限redemption-delivery.read（负责人/仓管/骑手）、redemption-delivery.assign（负责人/仓管）、redemption-delivery.accept（骑手）；给骑手增加warehouse.read仅用于读取本人授权仓库列表，不授予拣货/库存明细权限。DISPATCHER、PICKER、骑手无管理分配权限；双角色员工按当前有效角色授权，接货仍必须本人被分配且有RIDER资格。

员工Cookie、Origin/CSRF、Idempotency-Key，严格请求体/查询字段；包裹数1..100、最多1000个不同原分配、件数1..100000整数作为开发技术保护，数量必须与原pack全部匹配。接口不接受任意状态、员工姓名或顾客信息。分配和接货唯一事实充当阶段版本，接货必须绑定当前assignmentId；同员工/仓库/动作/出库单/原键返回历史结果，改体409，lines按allocationId排序规范化。失权或非本人范围不能重放。停止写开关后读取保留，写入及原写请求核实503，不自动换键。

响应Page含enabled、selfOnly、items、nextCursor；每项含原兑换单号/商品/规格/件数、包裹数、出库时间、state、原批次库位/效期、assignment（id、骑手id/名称、分配人名称、时间）、handoff（id、包裹数、时间）及readiness。readiness.ready为阶段与当前源资格条件，不替代服务端操作权限；已接货后ready=false而历史事实仍保留。原分配人仅检查当前启用/管理角色/本仓授权，不要求其原登录会话一直在线。

错误包括：403 FORBIDDEN；404 REDEMPTION_DELIVERY_NOT_FOUND（含非本人/错仓/未出库，不泄露资源是否存在）；409 CURSOR_INVALID、DELIVERY_PERSON_UNAVAILABLE、DELIVERY_ALREADY_ASSIGNED、ASSIGNMENT_CHANGED、DELIVERY_ALREADY_ACCEPTED、DELIVERY_BLOCKED、HANDOFF_QUANTITY_MISMATCH、IDEMPOTENCY_CONFLICT；400 VALIDATION_ERROR/PHYSICAL_CONFIRMATION_REQUIRED；503 REDEMPTION_DELIVERY_DISABLED/RETRYABLE_CONFLICT。未知网络/5xx保存原始输入和键，重载原键核实。401/403/404清除缓存的地址、详情及人员，避免范围改变后继续展示旧详情。

消费者/后台订单增加ASSIGNED_WAIT_HANDOFF与RIDER_RECEIVED_WAIT_START；禁止显示已开始配送/送达或重新允许直接取消。仓库拣货详情packing.shipment增加deliveryState=UNASSIGNED/ASSIGNED/HANDED_OVER，避免已接货后仍提示等待接货。部署须同步API、Worker依赖客户端及三端。


## 2026-11-03 P4e兑换配送开始与送达声明（OpenAPI 0.47.0）

沿用真实兑换交接基路径 `/api/v1/warehouse/warehouses/:warehouseId/redemption-delivery`，id是原shipment.id；不复用合成delivery_lab。新增RIDER独有`redemption-delivery.work`权限，必须是本仓当前有效且被分配的骑手本人。管理角色不能代操作；双角色也须满足当前RIDER和本人归属。Cookie、Origin/CSRF、Idempotency-Key及严格字段校验不变。

| 动作 | 请求 | 验收语义 |
|---|---|---|
| POST `/:id/start` | `{handoffId, departureConfirmed:true}` | 绑定本单本人原接货，实际携全部包裹出发；只可追加一次START |
| POST `/:id/complete` | `{startId, deliveryConfirmed:true}` | 绑定本单本人原START，声明全部包裹交付原地址收货人；只可追加一次COMPLETE |

成功返回`{id:shipmentId}`。400 PHYSICAL_CONFIRMATION_REQUIRED/VALIDATION_ERROR，403当前权限失效/管理代操作，404非本人/错仓/无原出库，409 JOURNEY_SEQUENCE_REQUIRED未完成前序、JOURNEY_SOURCE_CHANGED原凭据不匹配、JOURNEY_ALREADY_RECORDED阶段重复、DELIVERY_PERSON_UNAVAILABLE人员资格变化、DELIVERY_BLOCKED当前来源/效期/冻结变化、IDEMPOTENCY_CONFLICT同键变参；默认关闭503 REDEMPTION_DELIVERY_DISABLED。请求失败不自动退分或释放/回库。事实、审计与幂等结果同事务，末尾真实时钟复查会话和效期，晚失败全回滚。已提交同键重放仍核验当前授权与本人资源，不因失权返回历史结果。

列表/详情新增`journey:{start:{id,createdAt}|null,completion:{id,createdAt}|null}`、`canStart`和`canComplete`。readiness.ready仍只表示分配/接货资格，保留既有语义；readiness.blockers给出当前源资格告警，不覆盖历史阶段。state及status筛选新增DELIVERING、DELIVERED；HANDED_OVER仅接货且尚无START，DELIVERING有START无COMPLETE，DELIVERED有COMPLETE，五种状态互斥。20条UUID升序、游标本筛选及本仓/本人归属限制不变；列表仍不含地址，只有授权详情才解密原快照。

消费者/后台兑换订单fulfillmentState新增DELIVERING/DELIVERED，仓库出库凭据deliveryState同步。DELIVERED仅表示骑手确认送达，不代表收货人独立确认。兑换主status不增加COMPLETED，仍ACTIVE用于累计有效额度，后续完整结案/售后另交付。所有已开始履约阶段继续禁止消费者直接取消。新旧端须协同部署，旧枚举客户端不得误报等待出库或开放取消。详见[P4e验证](../verification/P4E-REDEMPTION-JOURNEY-2026-11-03.md)。


## 2026-11-03 P4f真实兑换配送异常（本地）

原骑手接货后/送达前可上报类型及说明，独立不可变异常绑定原handoff/order；未决阻断开始与送达，允许在货品冻结/效期异常时本人留证。无退款/回库/改派/恢复动作。新增迁移202611030003、RedemptionDeliveryException及SQL阶段门禁，POST兑换配送/:id/exception，员工详情exception、消费者deliveryExceptionReported，OpenAPI0.48.0；16项PG及24张双端浏览器截图通过。仅临时schema验证，微信/真机与生产未验，下一项P4g本仓异常处置凭据与恢复。详见P4F-REDEMPTION-EXCEPTIONS-2026-11-03验证记录。


## 2026-11-03 P4g 配送异常处置与原骑手恢复（本地）

本仓有效负责人/仓管填写处置说明并确认包裹、原地址可由原骑手继续，新增独立不可变处置凭据；不删除原异常，不自动送达。恢复前重新校验出库、库存效期/冻结、原骑手及分配人资格，其他阻断未解除仍拒绝。恢复后原骑手按原阶段继续，也可再次上报新异常。此规则取代P4f“每个接货仅一条异常”的阶段限制：每个接货可有多条历史异常，同时最多一条未决，每条异常最多一次处置。

POST /api/v1/warehouse/warehouses/:warehouseId/redemption-delivery/:id/resolve：员工Cookie、Origin/CSRF、本仓redemption-delivery.assign权限及Idempotency-Key；body仅exceptionId、reason（必填最多300字）、continuationConfirmed:true。错误输入400、无权403、来源变化/已处置/其他阻断409，功能关闭503；处置、审计和幂等结果同事务。详情新增exception.resolution及exceptionHistory；消费者deliveryExceptionReported只表示当前未决，不返回内部说明与人员身份。OpenAPI 0.49.0由代码导出。

新增迁移202611030004_redemption_delivery_resolutions及Prisma RedemptionDeliveryResolution，exception_id唯一外键、actor_id及姓名快照、reason、request_id和数据库时间；禁止UPDATE/DELETE。异常handoff唯一约束改普通索引，SQL触发器串行锁原handoff、限制一条未决，并仅用未决异常阻断START/COMPLETE。已消费库存、积分、订单主状态、地址、骑手分配及配额不变。处置确认是管理人员声明，并非独立实物证明。迁移先于API部署；旧P4f代码仍将历史异常视为未决，不可盲退或删除事实。

3项新专项、3项P4f及13项P4e合计19项真实PG测试通过；实际API浏览器闭环30张截图，含处置响应丢失原键恢复、原骑手继续和消费者阶段同步。全工作区构建、类型检查、lint、Prisma生成及OpenAPI导出通过。仅随机临时schema，未改业务主库/.env/生产，沿用默认关闭及生产/远程拒启。微信工具、真机、真实实物和生产仍未验，P4/P5未整体验收。下一项P4h未接货分配撤回/改派及人员撤权接续，后续协调取消和售后。详见[本轮验证记录](../verification/P4G-REDEMPTION-RESOLUTIONS-2026-11-03.md)。


## 2026-11-03 P4h 未接货分配撤回及重新分配（本地）

本仓有效负责人/仓管填写原因（必填最多300字），声明骑手尚未接货、全部包裹仍在仓库，可撤回当前分配。原分配与撤回均为不可变事实；撤回后回到已出库待分配，由管理人员再选当前有效本仓骑手，新骑手凭新分配核对接货。两步操作之间允许保持待分配，不自动择人，不退库存、积分或配额。即使原骑手/原分配人停用、撤权或撤仓，现任管理人员仍可撤回；货品冻结等不阻碍撤回，但仍阻断新分配。已接货禁止撤回，不能据此冒充实物回交。管理确认仅是人员声明。

POST /api/v1/warehouse/warehouses/:warehouseId/redemption-delivery/:id/withdraw，body仅assignmentId、reason、warehouseCustodyConfirmed:true；员工Cookie、Origin/CSRF、本仓redemption-delivery.assign和Idempotency-Key。输入错误400、无权403、错来源/旧版本分配/已接货409、关闭503；处置、审计及幂等结果同事务。新分配沿用/assign，不能覆盖现存有效分配。旧骑手列表/详情/接货只认当前未撤回分配，不返回旧单地址或新骑手资料；员工管理查询增加assignmentHistory，消费者只同步实际阶段，不返回内部原因。

新增迁移202611030005_redemption_assignment_withdrawals：RedemptionAssignmentWithdrawal链接唯一原assignment、当前管理人员及姓名快照、原因、请求号、数据库时间，禁止修改删除。解除assignment的shipment/order唯一约束，保留复合来源外键并增加索引；按原shipment行锁保护同单至多一条有效分配，撤回与接货互斥，SQL禁止撤回已接货及用撤回凭据接货。Prisma shipment.assignment改为assignments集合，各查询只按未撤回记录计算当前状态。旧凭据保留，不改原接货。迁移后须部署匹配API/Worker及页面；旧代码将多条分配错误视为单条，不可盲退或重建旧唯一约束。

OpenAPI 0.50.0已导出。4项新PG专项及32项相关PG回归（初跑34/36，修正两处测试模型/账号引用后定向复验通过）共36个不同用例通过；18张实际API浏览器截图、类型检查、lint、全工作区构建、Prisma生成通过。仅临时schema、默认开关关闭、生产/远程拒启，未改业务主库/.env/生产，微信工具/真机和真实交接未验。P4h仅交付未接货接续；下一项P4i已接货人员撤权后的实物回交与接续，领取人停用接续、协调取消及售后仍须继续。详见[验证记录](../verification/P4H-REDEMPTION-WITHDRAWALS-2026-11-03.md)。


## 2026-11-03 P4i 整单实物回交与重新配送（本地）

本仓有效负责人/仓管可对已接货、未送达的当前交接，填写原因并按原包裹数、全部原批次/库位分配件数完整核对回交，分别声明全部实物完整完好已由仓库接收、原地址及异常情况允许重新安排配送。仅支持整单完整完好回交；部分、破损、已送达及无法确认原地址/异常可重配均不得使用。本轮规则为隔离开发实现，不宣称正式经营应急规则已经确认，两项声明均不是系统独立实物证明。回交终止原配送保管关系，再分配有效本仓骑手并重新逐项接货、重新开始和送达。原骑手或分配人撤权/停用/撤仓不妨碍现任管理人员核验回交；冻结等仍阻断新的分配/接货。

POST /api/v1/warehouse/warehouses/:warehouseId/redemption-delivery/:id/return-custody，body仅handoffId、reason（必填最多300字）、packageCount、lines[{allocationId,quantity}]、intactCustodyConfirmed:true、redispatchConfirmed:true；员工Cookie、Origin/CSRF、本仓redemption-delivery.assign和Idempotency-Key。输入/缺确认400、无权403、错当前接货/已回交/送达/数量不符409、关闭503。回交主/逐项事实、审计及幂等结果同事务，晚失败回滚。保留原分配、接货、START及异常，旧骑手失去查询/推进/旧键重放资格；SQL也拒绝给已回交的旧接货追加阶段、异常或原骑手继续型处置。回交并非库存入库、售后退货或取消，不动库存、积分、订单主状态、配额和地址。

新增迁移202611030006_redemption_custody_returns及RedemptionCustodyReturn/Line，唯一原handoff和完整shipment/order来源、管理人员姓名快照、原因、数量、请求号和数据库时间，事实禁止修改删除，延迟SQL约束验证全部原装包行和包裹数。解除handoff的shipment/order和handoff_line的allocation唯一约束，允许不同配送尝试复用同一已消费出库来源；同一分配仍唯一接货。按shipment及handoff行锁保护唯一当前保管关系、回交与送达竞争。未接货撤回也改为只检查当前assignment，不被已回交历史误阻断。有效分配统一为未withdrawal且无handoff.returned。

员工管理查询增加returnHistory及assignmentHistory.returned，显示原骑手/是否出发/接收人/原因/原异常；消费者只增加deliveryReturnRecorded并按本次配送阶段显示，不返回内部备注或人员。原未决异常随回交终止的是原配送尝试，不删除、不伪造原骑手继续型resolution；重新分配前由管理人员单独声明原地址和异常允许重配，并继续检查当前库存等资格。OpenAPI 0.51.0由代码导出。部署必须先迁移再更新API/Worker及三端，旧代码不识别回交不能盲退；不删除历史或恢复旧唯一约束。

5项新真实PG专项及相关回归、实际API三端浏览器检查见[验证记录](../verification/P4I-REDEMPTION-CUSTODY-RETURNS-2026-11-03.md)。沿用默认关闭及生产/远程拒启，仅随机临时schema，未改主库/.env/生产，微信工具/真机和实际实物未验。下一项P4j仓库领取人停用后的接续与重核；部分/破损回交、协调取消及售后仍待后续切片，P4/P5未整体验收，商城未上线。


## 2026-11-03 首发调整与E1订单打印（本地）

用户明确将积分商城首发调整为积分兑换、生成订单、后台打印配货单、人工快递发货。原仓配/骑手P4路线及代码/事实保留扩展，暂停P4j，不再强制快递运营人员进入领取、逐项拣货或骑手界面。现行顺序为E1打印、E2快递地址与订单模式、E3快递发货与一次性库存出库、E4取消售后及上线验收，详见[新路线](../product/POINTS-MALL-EXPRESS-V1.md)和[原路线快照](../product/POINTS-MALL-LOCAL-DELIVERY-ARCHIVE-2026-11-03.md)。原小区地址订单不自动转换快递单；全国发货范围、运费及经营参数未擅自确认，不对接电子面单/自动轨迹。

E1新增POST /api/v1/admin/redemptions/print-preview，严格body仅ids（1至20个不同UUID），沿用员工Cookie、本仓SUPER_ADMIN/OPERATIONS、points.read及Origin/CSRF；无Idempotency-Key要求，因为仅查询，无任何业务写入。整批验证归属、有效状态及当前会话；输入400、无权403、部分不存在/越界404、含取消单409。按请求顺序返回generatedAt及最小配货字段：原订单号/时间、原商品规格/件数/积分、真实配送模式和原加密收件地址快照。解密仅在本仓授权事务内进行，Cache-Control:no-store；普通列表仍无收件人地址，未知配送模式明确拒绝，不冒充快递。

后台详情打印本单、列表勾选最多20单批量预览。屏幕预览和点击打印分别重新请求校验；失败清空旧预览，关闭/切换清理内存和iframe，不持久化收件信息。隔离同源空白iframe使用DOM textContent写数据，备注不会作为HTML执行；A4每单分页，显示原配送方式、配货单非面单、打印不等于发货。允许重复打印，不声称打印机成功；不改变积分、库存、配额、订单、Outbox或骑手阶段。OpenAPI0.52.0由代码导出，无模型/迁移，不删除或覆盖旧事实。新增API/页面需匹配发布；E2接入快递模式时扩展同一打印契约。

3项专项及12项原兑换交易合计15项真实PG通过；实际API浏览器9张桌面/手机截图、两单两页A4 PDF输出、取消后拒绝打印及数据清理通过。全工作区构建、类型检查、lint和OpenAPI导出通过。仅随机临时schema，未改业务主库/.env或生产；打印机纸张、微信工具/真机、快递寄出及生产均未验。当前E1只完成旧单的真实配货打印，不将其记作快递交易上线。详见[E1验证记录](../verification/E1-REDEMPTION-PRINT-2026-11-03.md)。


## 2026-11-03 E2 快递地址与订单模式（本地）

新小程序兑换确认使用独立快递地址簿：完整省名、市、区县、详细地址、姓名、电话、选填备注及默认地址，最多20条、本人归属、独立版本/原键、软删除后清除加密载荷；旧小区地址簿及现金流程不变。全部快递收件字段AES-GCM加密，不将地址明文写入操作摘要或审计。页面隐藏/换账号清理旧地址及编辑状态，未知写结果同账号可用原请求核实，不冒用其他账号操作。

后台兑换订单内新增可折叠快递寄送规则，由本仓有效负责人/运营配置是否开放、最多34个不重复完整省名、明确SENDER_PAID商家承担运费和原因；缺配置默认暂停，无默认全国寄送。顾客快递运费为0分，不接现金支付/到付。省市区为人工输入，目前只按完整省名白名单校验，不验证行政区划从属或承运可达性，寄出前仍需人工核实。规则有独立版本、原键和变更前后审计；更改/暂停/重新开放使旧报价失效。

新增consumer/express-addresses及/:id/update、default、delete（消费者Bearer、原键、版本），GET /redemption-express-policy（公开支持范围），GET /admin/redemption-express-policy、POST /update（员工Cookie、points.read、Origin/CSRF、Idempotency-Key及事务内本仓校验）。原报价接口可选deliveryMode:EXPRESS，省略时兼容旧LOCAL_NO_CASH；报价仍120秒，明确模式、原地址簿版本、规则版本、运费承担及整数分0，提交再次核验。新订单delivery_mode明确保存EXPRESS、旧单默认LOCAL_NO_CASH且不可改写，地址原快照不随地址编辑/删除改变。

新快递单扣分/预占/配额复用原交易同事务逻辑，Outbox为EXPRESS_WAIT（待快递发货），Worker仅选择LOCAL_NO_CASH，SQL禁止快递单进入骑手拣货及本地队列状态。消费者/后台显示EXPRESS_WAIT_SHIP，不显示骑手流程；E1打印兼容快递模式和结构化地址。当前未发货快递单可复用本人取消、退分释放预占与配额，取消事件/待办终态仍配平。未实现运单、实际出库发货及自动物流，留E3；不将打印当作发货。

新增迁移202611030007_redemption_express：独立ConsumerExpressAddressBook/Address/Operation/Audit及RedemptionExpressPolicy；独立默认地址唯一索引、软删除载荷约束、地址审计不可变；RedemptionOrder.deliveryMode默认兼容旧单，新SQL匹配报价模式和待办分流，原事实不可变约束保持。扩展既有Outbox状态及取消合法迁移、verify_redemption配平检查，不删除历史。OpenAPI0.53.0由代码导出，快递/旧地址响应使用oneOf，旧报价客户端可省略模式，现金地址及订单契约不改。

4项快递专项及3项打印/12项兑换回归共19项PG通过，补充跨账号报价和规则重启后旧报价拒绝后4项专项复跑通过。实际API浏览器弱网与后台/小程序截图详见[E2验证记录](../verification/E2-REDEMPTION-EXPRESS-2026-11-03.md)。迁移只在随机临时schema重放，未改业务主库、.env或生产，开发交易默认关闭/生产拒启保持。部署先迁移再匹配API、Worker及三端；旧客户端不理解快递地址/状态，不能盲退或把新单改回旧模式。微信工具/真机、正式经营配置、实际快递与生产仍未验。下一项E3快递公司、运单号录入及一次性库存出库/确认发货。

## 2026-11-03 E3 快递确认发货（本地）

后台兑换订单增加待快递发货/已快递发货/原配送筛选；详情展示原收件快照、原预占批次/库位/件数，填写快递公司、实际运单号并勾选整单实物、地址、运单和交快递确认后操作。首发一单一运单、一次整单出库，不支持拆包、分次发货或电子面单。已发货详情、配货打印及消费者订单显示快递公司/运单/记录时间，小程序可复制单号，运输进度由用户凭单号联系快递公司查询，不伪造轨迹或签收。

GET /api/v1/admin/redemptions/:id/shipping返回本仓原地址、发货开关、可发状态、阻断原因及既有凭据，Cache-Control:no-store。POST /:id/ship严格body为version、carrierCode、可选carrierName（OTHER必填）、trackingNo、dispatchConfirmed:true；员工Cookie、本仓SUPER_ADMIN/OPERATIONS、points.read、Origin/CSRF及Idempotency-Key校验。已知承运方代码SF/ZTO/YTO/STO/YUNDA/JD/EMS/POST/DEPPON/OTHER；已知名称服务端固定，其他名称最多40字且无控制字符；运单标准化大写，6至40位字母/数字/连字符，同仓同公司名称与单号不得用于第二单。格式校验不等于快递公司验证。

仅ACTIVE+EXPRESS+EXPRESS_WAIT、原版本、原预占完整且未释放/消费、无骑手任务时可新发货；仓库、商品、批次效期、冻结/盘点、库位、库存及扣分凭据须通过服务端检查。沿用元数据→库存→订单→Outbox锁序，事务内保存发货事实、消费全部原预占，逐项扣减仓库/批次/库位onHand与reserved，创建库存/库位流水、Outbox事件、审计及原键结果。末尾再次校验会话和效期，任一步失败全部回滚。发货与取消互斥，已发货拒绝取消/退分/释放；没有重复扣积分、释放配额或改写原订单版本，原订单status仍ACTIVE，由快递事实和EXPRESS_SHIPPED履约状态表示发货。

发货复用现有默认关闭的REDEMPTION_PICKING_DEV_ENABLED本地作业开关，内部名称不要求运营走拣货页；生产/远程拒启保持。关闭开关阻断新操作，已成功原键可核实。浏览器按员工和订单在sessionStorage仅保留原请求，不保存地址；结果未知时禁止另起请求，重载后可核实原键。资料重读/失权/失败先清旧地址，已知拒绝后需重新获取服务端状态。暂停新兑换的寄送规则不改写已接受订单的原收件/运费快照；发货另受作业开关和实时库存约束。

迁移202611030008_redemption_express_shipping新增RedemptionExpressShipment不可变事实、一单唯一、同仓同承运方运单唯一、来源复合外键、操作者快照和请求编号；数据库延迟约束同时核验整单全部原预占消费、匹配负数库存/库位流水及发货Outbox。扩展EXPRESS_SHIPPED及其事件和合法迁移；保留旧LOCAL_NO_CASH打包/出库校验路径，禁止两种履约混用。没有快递回调、轨迹或签收状态。OpenAPI0.54.0由代码导出，订单/打印增加expressShipment及EXPRESS_SHIPPED，后台列表增加fulfillment过滤，消费者不能使用后台筛选参数。

部署需先迁移再匹配API、Worker及客户端；已消费库存的发货事实不可盲删、盲退旧版本或改回待发货。只在随机临时schema运行迁移和合成验收，未改业务主库/.env/生产。8项专项加31项快递地址/打印/兑换/旧打包回归，共39项真实PG通过；13张真实API浏览器截图通过。未声称全量历史仓配回归或微信开发工具/真机、实物打印机、实际交快递/承运验证、生产验收。下一项E4：纠错留痕、最小售后与受控上线准备。

## 2026-11-03 E4a 运单资料纠错（本地）

E4按可验证边界拆为E4a运单纠错、E4b最小售后反馈与处理、E4c首发发布准备及人工/设备验收。本轮仅完成E4a，不将售后、真实快递交接、微信真机或生产记作完成。未发货取消/全额退分与发货竞争已在E2/E3实现，本轮回归保持；已发货仍不能直接取消，不做退分、退货入库或补寄。

后台已发货快递单新增“更正运单资料”独立表单，显示当前值，填写更正后的快递公司/运单号、1至200字原因，并勾选已核对原包裹真实运单。仅纠正原包裹的录入错误，不修改收件人/地址、原发货时间、订单版本/状态、积分、配额、库存、预占或Outbox，也不代表重新寄出。原因提示勿填写个人信息，拒绝控制字符；资料不变拒绝保存。后台可查看原发货和逐次更正的公司/单号、原因、操作人及北京时间。用户端和配货打印只展示最新有效运单，标明资料已更正；不返回内部原因或员工信息，复制使用新单号。

POST /api/v1/admin/redemptions/:id/shipping-corrections，严格body为version（当前独立更正版本，初始0）、carrierCode、可选carrierName（OTHER必填）、trackingNo、reason、verified:true。沿用本仓SUPER_ADMIN/OPERATIONS、points.read、员工Cookie、Origin/CSRF、Idempotency-Key及事务内前后权限；只接受ACTIVE+EXPRESS+EXPRESS_SHIPPED且有原发货事实的订单。公司和运单校验与E3一致，标准化大写后计算原键摘要。订单锁串行化同单更正，独立版本防止旧页面覆盖；更新失败整笔回滚，更正记录、运单归属、审计及原键结果一起提交。跨账号/本仓失权后，即使原键成功也拒绝访问。

GET /:id/shipping继续no-store，增加canCorrect和仅后台的shipmentHistory；shipment增加correctionVersion及correctedAt。消费者/后台订单列表、详情、打印统一投影最新更正；shippedAt始终为原发货时间。已出库后的冻结、商品下架或批次后来过期，不阻断仅纠正运单的操作；不借纠错重新运行出库逻辑。复用默认关闭的REDEMPTION_PICKING_DEV_ENABLED本地作业开关，关闭时新更正503，既有成功原键可核实，生产/远程拒启保持。

迁移202611030009_express_shipping_corrections新增不可变RedemptionExpressShipmentCorrection：原发货来源FK、独立连续版本唯一、公司/单号、原因、操作人快照、请求编号及时间；SQL锁原发货来源校验连续版本、已发快递单、当前角色/仓库、值必须变化，禁止覆盖/删除历史。新增SQL运单归属表redemption_express_waybills，回填所有原发货身份；原发货及每次更正自动占用同仓+公司代码+名称+单号唯一身份，归属永久保留。另一订单不能使用任何历史身份；同一订单可核实后更正回自己的原值。唯一索引处理跨订单并发，延迟约束拒绝无对应事实的伪归属；表无外部通用写接口。

OpenAPI0.55.0由代码导出。兼容原E3字段、发货凭据不可变和旧LOCAL_NO_CASH流程；不删除旧迁移/骑手扩展。部署先执行新迁移，再匹配API与前端；旧服务只读原发货资料会显示旧单号，不可盲退服务或丢弃更正/归属历史。仅随机临时schema与合成身份，未改业务主库/.env或生产，未接外部快递服务。

## 2026-11-03 E4b 最小售后反馈（本地）

用户本人已发货快递兑换订单新增售后反馈卡片：问题类型为未收到商品、商品破损、商品不符、其他问题；首次提交1至500字说明，一单一个反馈记录，重复问题通过原记录补充。待处理/处理中可补充；门店结束后用户仍可说明原因重新反馈，原记录与回复继续保留。没有附件上传、外部客服消息或时效承诺。反馈不改变兑换订单、发货、运单、积分、配额、预占、库存或配送状态，不代替退款/退货/补寄动作；已发货禁止直接取消保持。未发货/已取消/原配送单不得创建本入口反馈。

后台新增独立“兑换售后反馈”导航，按反馈状态、兑换单号或商品查询，20条分页，详情按时间展示用户说明、门店公开回复、处理状态与北京时间。运营可“回复用户并继续处理”或“回复并结束本次反馈”，均要求1至500字说明；页面勾选确认将回复展示给用户，准确描述已完成的沟通。用户只看到“门店回复/处理说明”，不返回员工姓名/身份；后台显示实际操作人。结束仅表示本次反馈处理结束，用户重新反馈后回到待处理，无财务或库存补偿。

新增GET/POST /api/v1/consumer/redemptions/:id/after-sales，POST /supplement、/reopen；消费者Bearer、本人订单、原键及补充/重开独立版本校验。首次提交category/message，后续version/message，未知字段拒绝；允许换行，拒绝其他控制字符。后台GET /api/v1/admin/redemption-after-sales及/:id，POST /:id/reply、/:id/close，Cookie、SUPER_ADMIN/OPERATIONS、points.read、本仓、Origin/CSRF及Idempotency-Key校验，回复/结束body为version/message。GET响应no-store，列表仅最小订单/类型/状态/时间，不含地址或反馈全文。列表按反馈UUID升序分页，cursor为上一页最后反馈ID，不承诺按最近更新时间排序。

独立反馈状态OPEN/PROCESSING/CLOSED与version，业务动作SUBMITTED/SUPPLEMENTED/REPLIED/CLOSED/REOPENED；同单订单锁串行化，原键摘要/结果及事件同事务，旧版本拒绝，失败完整回滚。消费者事务前后校验当前会话及clock_timestamp，员工事务前后校验当前本仓角色/会话，成功原键仍须当前授权。读取反馈持有反馈行共享锁，使状态/版本与事件历史一致。复用默认关闭的REDEMPTION_PICKING_DEV_ENABLED本地作业开关，关闭阻断新写但可读既有记录、核实成功原键；生产/远程拒启保持，未改.env或默认配置。

迁移202611030010_redemption_after_sales新增RedemptionAfterSales一单唯一来源/类型/状态版本投影和RedemptionAfterSalesEvent不可变动作历史。SQL校验已发快递来源及原用户/仓库、来源字段不可改、连续版本/合法状态动作、当前用户或本仓运营人员、事件与投影版本/状态/时间及完整数量配平；禁止删除来源/修改或删除历史。说明和回复使用现有AES-GCM密钥，按用户与独立事件ID绑定AAD加密，数据库审计仅动作/来源/人员/请求号，无消息明文；用户填写提示勿包含姓名、电话、地址。客户端按账号和订单保存待确认原请求（包含说明），成功/明确拒绝后删除，隐藏/切换账号清理页面资料，不展示或重试其他账号原请求；后台待确认请求仅sessionStorage，原键/说明同请求重试。

OpenAPI0.56.0由代码导出，新增独立接口/模型，不改原兑换/发货/运单契约，不删除旧配送扩展。部署先迁移，再发布匹配API和客户端；新增表无旧数据回填，不盲删事件或退回不认识反馈的版本。仅随机临时schema/合成身份完成验证，未连接外部客服/快递账号或生产；微信工具/真机、实物打印/交快递及生产未验。E4b完成本地交付，下一项E4c首发准备与分项验收，E4整体尚未完成。

## 2026-11-03 E4c 首发本地准备与未验项

后台新增“积分快递首发检查”，GET /api/v1/admin/redemption-express-readiness，仅有效本仓SUPER_ADMIN/OPERATIONS、points.read与员工Cookie可读，未知查询参数拒绝，响应no-store。页面只展示当前仓库、快递规则/已上架商品数量/加密密钥是否配置，以及本仓待发/已发/未结束反馈与最早待发时间；不返回收件资料、反馈正文、运单号、消费者身份或密钥值。只读RepeatableRead快照，当前权限事务内再次核验；刷新/失败先清空旧结果，失权不保留旧统计。没有更改状态、录入验收或发布按钮。

服务端即时核对快递订单与Outbox/原发货、原预占消费或释放/数量、快递不进入骑手任务、每个原/更正运单的历史归属，以及售后投影/完整事件链。统计显示三类差异总数；没有差异只说明本次这些检查未发现问题，不代表全量账实一致或已验收。待发和反馈没有擅自设定超时阈值，没有外部告警；读失败表示未知。仓库/寄送规则/商品/加密项显示已配置与否，正式微信身份和生产写门禁明确阻断，HTTPS/真机/实物打印与交快递/备份恢复/经营值守/部署明确未验。纯积分快递首发不依赖现金支付、骑手或电子面单。

canLaunch始终false：目前仅DEVELOPMENT消费者适配器，且开发兑换/快递作业开关拒绝生产，不能通过放宽开发限制实现正式首发。本轮不改变这些开关、.env或生产配置。E4c仅完成本地准备，设备/实物/备份恢复和受控发布条件仍未通过；E4整体未完成。下一项可推进的实现为正式微信身份接入与受控测试环境准备，完成后再分项验收，不能把该检查页刷新当上线。

新增check:express:release/verify:express:migrations本地CLI，验证锁定Node、本机数据库范围、默认安全开关/支付禁用、必需构建入口，输出API版本、迁移名称与SHA256、固定产物指纹和小程序清单状态；不输出URL/密钥，未知参数拒绝。指纹只标识当前文件，不证明新鲜度、构建对应源码、健康或外部验收。rehearse须先通过本机配置检查，只在随机临时schema重放全部迁移并清理；生产/远程/打开开发写开关均拒绝演练。保持原仓配检查工具和历史方案不变，不将其现金支付/骑手条件移植为本次积分首发门槛。

本轮54个迁移重放生成109张表后清理，43项检查及打印/地址/兑换/发货/纠错/反馈PG回归，加1项API关闭/连接池断开后同schema重建实例、原加密快照/事实和原键恢复，共44项PG通过；2项CLI保护通过，9张实际API后台桌面/390px浏览器截图通过。实例重建未丢失积分/库存/运单/反馈且原键不重复写，但不等于进程断电或备份恢复。新增接口OpenAPI0.57.0由代码导出，无新迁移；部署需配套API/后台。完整操作手册见operations/POINTS-EXPRESS-LAUNCH-RUNBOOK.md，未执行主库迁移或生产部署。

## 2026-11-03 E4d 微信消费者身份适配器（本地）

新增GET /api/v1/consumer/auth/methods（只返回微信与开发登录是否开放）和POST /consumer/auth/wechat-session（严格body仅code，1至128位字母/数字/下划线/连字符），no-store。小程序账户页按服务端能力显示开放/暂停/加载/读取失败，微信登录由Taro.login获取新code后发送服务端，不读取头像、昵称或手机号，不要求客户端填写用户编号/OpenID/UnionID，不将临时code存储到本机。已有本机会话须恢复或退出后切换；隐藏/离开取消晚响应，丢弃未使用会话时尽力撤销，登录记录仅保存本系统不透明token与expiresAt，状态不公开token。

服务端固定HTTPS api.weixin.qq.com/sns/jscode2session，参数为配置AppID/AppSecret、临时code及authorization_code，不接受客户端指定地址或凭据；禁止重定向，5秒超时、最多16KiB响应，不自动重试同code。只提取合法OpenID，校验session_key格式后丢弃session_key/unionid；不持久化或返回这些原始值，不记录微信完整URL、响应errmsg、code或密钥。失效/已用code返回401、平台限频429、网络/服务/异常响应503，并使用固定脱敏错误。Taro官方登录文档说明了客户端取code再由服务端换取身份的流程，微信官方API页面本轮浏览不可达，真实平台响应仍需受控联调验证。

配置新增WECHAT_LOGIN_ENABLED（默认0）、WECHAT_APP_ID、WECHAT_APP_SECRET（仅服务端）。启用时缺失或格式无效拒绝启动；只修改.env.example，不改实际.env或填写真实凭据。正式身份可独立于开发身份配置，但不开放正式兑换/出库门禁；开发身份仍拒绝生产、远程数据库及非回环请求。测试替身仅createApplication显式注入，且须test+本机yumi_test+随机临时schema；生产/普通schema拒绝，正常构建无环境变量可切成模拟微信。后台首发检查区分适配器是否配置与真实账号/HTTPS/真机仍未验收，canLaunch仍false。

微信账号provider=WECHAT，subject=SHA256(AppID+分隔符+OpenID)，额外wechatAppId固定来源；原DEVELOPMENT主体与资料保留，未自动合并积分、购物车、地址或订单。不同AppID的相同OpenID映射到不同本系统用户，配置AppID变化后旧账号会话不可用。生成32字节随机token，数据库只保存token哈希；会话继续校验有效期、用户enabled、authVersion，微信会话还校验当前微信登录开关与AppID；退出仅撤销当前会话。通用显示名“微信顾客”不伪造昵称，新账号无自动赠分或历史账务迁入。

微信登录以服务端socket地址哈希进行每分钟60次数据库限流，不信任客户端Forwarded/X-Forwarded-For。反向代理下可能共享同一桶，正式部署须单独验证可信代理和限流容量，不能直接放宽为信任任意请求头。AppID+code哈希在网络调用前原子占用10分钟，重复/并发只一次调用上游；过期哈希每次登录最多清理100条。网络未知、上游失败或晚期事务回滚均需要重新Taro.login取新code，不用原code恢复令牌，不在幂等表缓存原始token。数据库事务内并发upsert同一身份、签发会话及最小审计，失败不留下半个新账号/会话，已停用账号只留拒绝审计。

迁移202611030011_wechat_consumer_identity兼容原账号：扩展provider/subject约束与WECHAT_LOGIN审计动作，新增consumer_users.wechat_app_id及consumer_wechat_login_codes哈希临时凭证表，身份来源不可变触发器禁止改写provider/subject/AppID/ID/创建时间。保留原provider+subject唯一键和原subject约束名，兼容测试扩展脚本。无开发账号迁移、无真实数据回填。OpenAPI0.58.0由代码导出，user.provider增加WECHAT；需先迁移，再配套API与小程序，旧客户端不认识新provider需升级，不能删除身份/会话事实或改回开发身份回退。

本轮28项真实PG（微信4/旧会话9/快递地址4/发货8/首发检查3）及10项逻辑（微信协议和小程序流程2/旧会话8）通过；微信4项增强跨AppID后再次通过，11张同源码浏览器截图通过。适配器替身及传输模拟全部合成、未向真实微信发送凭据或连接账号；不能写成真实微信、开发工具或真机通过。生产交易门禁、HTTPS/合法域名、真实AppID工程匹配、真实联调/真机、备份恢复和实际快递仍待完成，下一项独立正式兑换/快递门禁与受控测试环境准备。

## 2026-11-03 E4e 独立正式积分快递门禁（本地）

新增POINTS_EXPRESS_MODE=off/controlled/production，默认off，POINTS_EXPRESS_SUBMIT_ENABLED和POINTS_EXPRESS_OPERATIONS_ENABLED均默认0。controlled仅允许1至50个指定本系统微信账号，production仅NODE_ENV=production且不得保留受控名单；两种正式模式只支持当前AppID的WECHAT账号和EXPRESS订单。开发开关保持原生产/远程拒启，并只处理开发身份的新交易；正式模式启动拒绝开发身份/交易/作业、现金开发下单、拣货/支付演练及原开发Worker混用。微信凭据、经营仓库、加密密钥和声明的HTTPS API origin须配置，正式部署不得连接yumi_dev/yumi_test或自定义schema URL；test仅允许本机yumi_test随机schema，不等于真实TLS受控环境。

新报价/提交独立受submit开关与当前账号资格控制，快递出库/运单更正/消费者反馈/后台回复结束受operations开关与本单原执行模式控制。暂停新提交不阻断已受理单查询、原规则取消/全额退分释放预占配额、既有成功原键核实；名单移除只影响新提交，不追溯取消已受理单的作业资格。关闭作业阻断新动作但成功原键可核实。开关按进程配置生效，环境替换前等待在途事务并核实结果，不承诺撤销已受理事务。真实会话/归属/本仓/当前人员/版本/库存等原校验保持，前端隐藏按钮不替代服务端门禁。

报价快照与订单executionMode由服务端写入DEVELOPMENT/CONTROLLED/PRODUCTION，客户端不能指定。迁移202611030012_points_express_execution_mode新增不可变字段，旧单默认DEVELOPMENT，SQL校验原报价模式一致、正式单必须EXPRESS+WECHAT。正式作业不能处理开发单或其他正式模式单；配置模式变化后旧报价不能新创建，但成功请求仍可恢复。消费者订单/后台详情/配货打印明确来源模式，不把开发或受控单冒充正式单。原本地配送与现金流程不由新门禁启用，未删除旧计划/事实。

GET /api/v1/consumer/redemption-access新增当前本人访问条件，Bearer/no-store、未知查询字段拒绝，返回executionMode/canSubmit/reason，不返回名单或凭据。仅表示可继续核验，报价/提交时仍再次检查资格、快递规则、价格、积分、配额和实时库存。小程序确认页展示暂停/受控限制/读取失败并禁用新报价，仍可核实原请求；报价后暂停由服务端阻断且保留原请求，恢复后可核实。服务端仍对503统一脱敏，小程序仅按明确EXPRESS_SUBMISSION_PAUSED错误码展示固定暂停文案，未放宽错误过滤。403明确拒绝也可确认未创建后重新核验，账号不匹配的原请求不能由其他账号清除。

后台首发检查展示正式模式、独立写开关及受控账号数量，开发适配器均关闭时显示隔离配置满足，不返回ID名单；配置不是验收，canLaunch仍false。新增不含凭据的受控环境模板和只读check:points-express:config工具；工具不联网/不接数据库、不修改配置、不输出URL/secret/名单/仓库ID，只检查声明与隔离规则，configurationValid=true不代表已验收。原本地发布检查新增正式模式/写开关须关闭的保护，不用其操作远程环境。

OpenAPI0.59.0由代码导出，订单/报价/打印增加模式字段，需先迁移再匹配API/Worker/后台与小程序。旧报价模式缺失兼容DEVELOPMENT，历史订单不自动转换。30项真实PG（受控3/旧兑换12/出库8/反馈7）与配置及只读保护测试通过，浏览器12张截图通过。只在随机临时schema和合成微信账号/积分验证；未连接真实微信、HTTPS、外部账号或生产，未改实际.env或主库，仍待真实受控环境、设备、实物、备份恢复和部署授权验收。

## 2026-11-04 E4f恢复验证边界

本轮不修改API契约/版本。冷备恢复后使用现有受控门禁、订单/打印相关事实、运单更正、反馈和取消接口验证原键与归属；没有新增备份/恢复HTTP接口，也没有通过后台按钮停止数据库。工具仅限本机随机独立集群，见[记录](../verification/E4F-LOCAL-EXPRESS-RECOVERY-2026-11-04.md)。

## 积分个人中心订单筛选

消费者 GET /api/v1/consumer/redemptions 支持可选 fulfillment=EXPRESS_WAIT_SHIP 或 EXPRESS_SHIPPED。两者仅匹配当前本人有效快递单，并沿用原分页游标与筛选范围校验。已取消使用 status=CANCELED。未指定 fulfillment 时保留原列表语义。管理员专用 LOCAL 仍由消费者接口拒绝。没有数据库结构变化。


## 2026-11-05 E5已发货兑换退货与退积分（OpenAPI0.60.0）

本人有效已发货EXPRESS订单可申请售后；原订单保留ACTIVE/EXPRESS_SHIPPED，售后独立记录，不随意取消已发货单。原兑换价×申请整数件数为唯一可退积分，客户端不得传退款金额。申请中、审核通过和已退款件数共同占用可退额度，合计不超过原quantity；驳回/撤销释放售后可退件数，退积分不释放原累计限兑或总配额。适用原订单executionMode和正式operations开关，沿用本地默认关闭、生产拒用DEV适配器。成功原键在暂停后仍可核实，当前会话/本人/本仓权限每次检查。

| API | 严格请求与语义 |
|---|---|
| GET /consumer/redemptions/:id/returns | 本人售后申请、剩余可退件数、原单价、开关、状态和历史，无其他用户信息 |
| POST 同路径 | {quantity,reason}，Idempotency-Key；加密原因、同账号原键恢复，不自动退分 |
| POST 同路径/:returnId/cancel | {}；只允许本人未审核申请，一次撤销记录 |
| GET /admin/redemption-returns | cursor/keyword/status筛选，20条UUID升序分页；本仓points.read，列表仅售后必要字段，无地址电话 |
| GET /admin/redemption-returns/:returnId | 本仓申请所属订单售后记录，服务端校验当前员工与仓库 |
| POST 同路径/approve | {requiresReturn:boolean,reason}，负责人明确是否退货 |
| POST 同路径/reject | {reason}，仅未审核申请 |
| POST 同路径/receive | {quantity,condition,location,physicalConfirmed:true,reason}；件数须与本次批准申请完全一致，condition为UNOPENED/DAMAGED/WRONG_ITEM，记录实际隔离位置，不支持部分包裹验收 |
| POST 同路径/refund | {confirmed:true,reason}；仅无须退货已批准或退货已完整验收，原账户原价退还一次 |

员工写接口需要Cookie、Origin/CSRF、Idempotency-Key和returns.manage（SUPER_ADMIN独有）；OPERATIONS只有本仓读取权限，不授予骑手/拣货员财务权限。负责人仍须当前有效SUPER_ADMIN/本仓授权，处理末尾重查真实时钟会话；金融动作及审计/幂等同事务。消费者Bearer及资源归属、会话实际到期/版本在末尾复查。不存在/非本人/错仓404，字段/实物确认不符400，超出原件数RETURN_QUANTITY_EXCEEDED、阶段变化RETURN_STATE_CHANGED、同键变参IDEMPOTENCY_CONFLICT、游标跨筛选CURSOR_INVALID为409；开关关闭503，不自动补偿回库或改派。

投影状态REQUESTED→WAIT_RETURN（需退货）→READY_TO_REFUND→REFUNDED；批准不需退货直接READY_TO_REFUND；未审核可REJECTED或CANCELED。每个申请/阶段不可改删，无通用状态接口。退款记录给出points十进制字符串，事件包括说明、时间及隔离验收信息；员工名称仅后台返回，消费者不暴露内部员工名。原因与处理说明使用AAD绑定用户/申请的加密数据，缓存失权后清理。

积分流水新增entryKind=AFTER_SALES_RETURN及原兑换单关联，展示“售后退积分”，不同于取消退积分。底层points_ledger保持员工正向流水来源，RETURN_REFUND:<申请ID>唯一，由不可变退款事件关联；不冒充取消、发放或恢复原库存。申请/处理结果未知时各端保存原输入和键，重载后使用原请求核实。分类按钮弹窗使用原GET /categories游标遍历所有公开标签，无新分类契约；我的页复用积分/订单/地址/登录API，无虚构统计。详见[E5记录](../verification/MALL-RETURNS-CATEGORIES-ACCOUNT-2026-11-05.md)。

## 2026-11-05 多商品积分结算（OpenAPI 0.61.0）

新增消费者 Bearer 会话接口，均严格拒绝额外字段，POST 必须提供 `Idempotency-Key`：

- `POST /consumer/redemption-cart-quotes`：`{items:[{rewardId,rewardVersion,quantity}],addressId,addressVersion}`，1—20种，重复商品/规格拒绝；仅 EXPRESS 同一地址。返回 `quotes:RedemptionQuoteView[]`、`totalPoints/balance/remainingBalance` 十进制字符串、`expiresAt`。统一积分余额，逐项规则/配额/可售校验，报价整次写入或整次回滚；本人有效报价总数上限20（两分钟后释放额度）。
- `POST /consumer/redemption-cart-orders`：`{quoteIds:string[]}`，1—20条，全部必须属于本人、未使用、有效、同一快递地址及政策版本、商品/规格不重复。返回 `{id,orderIds,totalPoints}`；`id`为第一条商品订单ID，`orderIds`是本次完整商品订单列表，不是独立的合并发货订单。单个 PostgreSQL 事务内按统一锁序创建全部原订单、扣分流水、库存预占、分配、事件和 outbox；失败全回滚。末尾再次校验全部报价、活动、批次效期和会话。

幂等作用域为 `userId:REDEMPTION_CART_QUOTE` / `userId:REDEMPTION_CART_CREATE`，重试必须使用原内容和原键；同键不同内容409，恢复成功结果在新提交门禁前完成。401会话失效、403身份不符、404非本人报价、409规则/积分/库存/过期/复用冲突、429报价频率、503并发可重试或门禁关闭。原单商品报价/创建/取消/发货/售后契约保持兼容；购物车商品仍需逐单操作取消和发货。

## 2026-11-05 不限额规则（OpenAPI 0.62.0）

按负责人最新要求，`/rewards` 列表/详情中的 `available` 仅使用共享可售库存结果；单商品及购物车报价/创建不再校验历史每人累计限兑或总兑换配额。库存、安全库存、盘点冻结、库位/批次状态、商品有效期、本人会话、地址政策和积分余额仍按原接口核验，幂等与整次回滚不变。

`perUserLimit` / `totalQuota` 标记 deprecated，仅为历史客户端/数据兼容保留字段及旧结构校验，不再是有效经营限制；后台新建表单自动填写兼容值、编辑保留原值，界面不再提供限额设置。新客户端不可用这些字段计算可兑换件数。历史报价中无配额快照，仍按原效期及商品版本核验。本轮新增移除旧限额约束触发器的迁移，服务与迁移必须一起部署；不支持新旧规则进程混跑。

## 2026-11-05 微信接入准备接续

微信登录HTTP契约不变：GET /consumer/auth/methods、POST /consumer/auth/wechat-session（body仅code）、GET /consumer/me、POST /consumer/auth/logout。登录失败由用户再次触发Taro.login，重新获取code；不把登录作为可重放token的普通交易幂等请求。新增的是只读CLI和构建检查，不新增调试登录API、不向消费者暴露AppSecret，也不自动开启正式积分兑换。


## 2026-11-05 售后待办指标（OpenAPI 0.63.0）

`GET /admin/redemption-express-readiness` 的 `metrics` 追加非负整数 `returnsRequested`（待审核）、`returnsWaitingReceipt`（待退货验收）、`returnsReadyToRefund`（待退积分）、`inconsistentReturns`（存在售后事实/退积分流水差异的申请数）。前三项与 `GET /admin/redemption-returns?status=REQUESTED|WAIT_RETURN|READY_TO_REFUND` 共用状态过滤逻辑，不受列表20条分页上限影响。当前仓、员工Cookie/points.read、未知查询参数拒绝、no-store及事务内复核权限保持不变，不返回申请ID、正文、个人资料或积分流水明细。`INVARIANTS` 同时纳入售后差异，`canLaunch` 仍固定false。前后端需匹配构建；旧客户端可忽略新增字段。


## 2026-11-05 积分账号购物车（OpenAPI 0.64.0）

新增 `GET /consumer/points-cart`，返回 `{version, items:[{rewardId,quantity}]}`，无记录返回版本0和空数组，不在GET中写库。新增 `POST /consumer/points-cart`，请求 `{action:REPLACE|MERGE, version, items}`，必须携带UUID `Idempotency-Key`；响应同GET。两者均要求消费者Bearer会话、仅本人资源、拒绝未知参数、响应no-store。每项quantity整数1至100000，最多20种且rewardId不能重复；保存只保存引用和数量，不信任价格、不预占库存/积分，失效引用可保留删除。合并累加数量，容量超出409；版本冲突409/CART_VERSION_CONFLICT；同键异内容409/IDEMPOTENCY_CONFLICT，同键重放返回原操作结果，客户端再GET最新版本。权限/会话失效401，格式400。

`POST /consumer/redemption-cart-orders` 追加可选布尔 `consumeCart`（默认false）。true时在同一交易事务按本人报价原商品/数量扣减账号积分购物车，成功原键重放不二次扣减；失败全部回滚。省略/false沿用原请求摘要兼容旧未决请求，true计入摘要禁止中途更改来源。新小程序使用checkout intent的cloudCart标记，仅新账号购物车订单发送true；旧intent不补该标记、不改变原键/摘要。先迁移数据库并部署兼容API，再更新小程序；旧客户端可继续使用本机购物车并随后明确导入。


## 2026-11-05 快递收货确认（OpenAPI 0.65.0）

新增 `POST /consumer/redemptions/:id/confirm-receipt`：消费者Bearer会话、UUID Idempotency-Key、请求 `{received:true}`，拒绝未知查询/字段，返回 `{receivedAt}` ISO时间，no-store。必须是本人ACTIVE、已具快递发货事实且Outbox为EXPRESS_SHIPPED的订单；未发货/已取消409，他人或不存在404，无消费者身份401，非明确确认/非法输入400，作业门禁关闭503。重复同键或不同键均返回原确认时间，不新增第二份事实；成功原键在作业暂停时仍可恢复。

共享 `RedemptionExpressShipmentView` 追加 `receivedAt:string|null`；历史未确认默认null，列表、详情、后台快递面板与打印预览契约一致。原订单status与fulfillmentState保持既有语义，收货状态单独读取此字段，不把已有快递出库状态改成新通用状态。消费者订单列表/详情响应追加no-store。

订单列表fulfillment增加 `EXPRESS_WAIT_RECEIPT`（ACTIVE已发货且无收货确认）、`EXPRESS_RECEIVED`（ACTIVE已发货且有确认），消费者和本仓后台共用条件；旧 `EXPRESS_SHIPPED` 保持所有已发货语义，含已确认，用于历史客户端/售后列表。游标仍须属于相同用户/仓库和当前筛选，状态改变后返回409/CURSOR_INVALID，客户端重新读取。

兼容顺序：先第61项迁移和API，再小程序/后台。旧客户端可忽略receivedAt，原已发货筛选继续可用，不能把历史发货记录自动回填成签收。


## 2026-11-06 消费者订单搜索（OpenAPI 0.66.0）

`GET /consumer/redemptions` 新增可选 `keyword`（string，trim后最多80字符；省略/空白视为无关键词），按本人订单快照title或orderNo不区分大小写部分匹配。消费者搜索对LIKE特殊字符百分号、下划线及反斜线转义为字面文本，不扩大匹配；员工原搜索语义保持。与status/fulfillment取交集，仍每页20条及nextCursor，游标须属于本人、关键词和状态范围，否则409/CURSOR_INVALID。重复参数、非字符串、超长和未知字段400，未登录401；不允许传userId切换资源归属。

返回结构与no-store不变，不新增写接口；旧客户端省略keyword行为保持。客户端固定已提交关键词处理刷新、分页及重试，切换查询重置游标并隔离迟到响应。API/小程序匹配构建更新，无迁移。


## 2026-11-06 消费者售后汇总（OpenAPI 0.67.0）

新增 `GET /consumer/redemption-returns`，消费者Bearer身份、no-store；只读本人申请且其订单也须归本人。可选status为PROCESSING、REFUNDED、CLOSED，省略为全部；PROCESSING对应REQUESTED/WAIT_RETURN/READY_TO_REFUND，CLOSED对应REJECTED/CANCELED。可选keyword为trim后最多80字符的商品标题/订单号、不区分大小写部分匹配，LIKE特殊字符按字面转义。cursor为UUID，同本人/当前关键词/状态范围校验，失效409/CURSOR_INVALID；未知/重复/非法参数400，未登录401，服务不可用503。

返回 `{items,nextCursor}`，每页20条；摘要包含id/orderId/orderNo/title/quantity/points/state/createdAt/requiresReturn，points按原订单单件积分价乘本申请件数并以字符串返回。摘要不解密申请原因、不返回处理历史或员工身份；详情沿用本人订单既有售后读取接口，仅在页面展示指定申请，无新增写接口。读取使用RepeatableRead并在事务首尾核验会话。旧接口与客户端兼容，无迁移，先更新API再小程序。


## 2026-11-06 商城待办（0.75.0）

新增员工Cookie接口 `GET /api/v1/admin/mall-tasks`，`Cache-Control:no-store`，需要points.read及当前SUPER_ADMIN/OPERATIONS经营仓授权，事务首尾校验会话/角色/仓库；消费者或仓管不能访问，不接受客户端warehouseId。RepeatableRead只读事务，不创建库存、审批、审计或幂等记录。

查询：threshold为0至1000的规范整数字符串，默认5，仅本次库存查看条件；stock为ALL（默认，缺货与低库存）/ZERO（缺货）/LOW（正库存且≤阈值）；cursor为UUID。未知参数/非法值400，无会话401，无权限403，经营仓未配置503。库存items按兑换商品UUID升序返回最多20条，nextCursor或null；统计不受cursor/stock影响，但lowStock随threshold变化。不是跨请求固定快照，库存变化后应刷新。

返回 `MallTasks`：checkedAt、lowStockThreshold、stock{outOfStock,lowStock,items:[{id,title,name,spec,unit,available}],nextCursor}、queues:[{code,count,oldestAt}]。8个code固定为WAIT_SHIP/GRANTS/CORRECTIONS/FEEDBACK_OPEN/FEEDBACK_PROCESSING/REQUESTED/WAIT_RETURN/READY_TO_REFUND。无待办count=0、oldestAt=null；反馈时间为最近更新，退回/退分时间由APPROVE/RECEIVE事实确定。只返回数量、时间和商品展示信息，无顾客身份、电话、地址、内部成本或密钥。库存复用visibleSkus，限定当前开放的本仓上架兑换商品；冻结、盘点、安全量、预占、隔离、效期和库位均参与计算。

兼容增加 `GET /admin/points/grants` 与 `/admin/points/corrections` 可选status=SUBMITTED/APPROVED/REJECTED/CANCELED，服务端在分页前筛选，可组合userId与cursor；不传保留原行为，非法400。前端待办带SUBMITTED进入，审批仍需原独立负责人及预算校验。现有订单/反馈/售后接口未改契约，仅新增前端初始筛选及商品详情定位。无新写接口，无迁移。


## 2026-11-06 积分报表（0.76.0）

新增 `GET /api/v1/admin/points/report`，员工Cookie、points.read及当前有效SUPER_ADMIN/OPERATIONS经营仓授权，Cache-Control:no-store；在RepeatableRead事务首尾复验会话/角色/仓绑定，仅查询，不接受客户端warehouseId。消费者401，无权限或仓绑定失效403，经营仓未配置503。

查询from/to为必填有效YYYY-MM-DD，按北京时间自然日包含起止日，转换为[from零点,to次日零点)的入账时间范围，1至366天；非法日期、范围、未知参数400。kind可选GRANT/REDEEM/CANCEL/RETURN/CORRECTION；view为LEDGER（默认，期间入账流水）或ISSUES（本仓全历史差异）。cursor为原响应不透明业务键，按key升序分页最多20条，种类/范围过滤在分页前执行；accountCursor为原响应账户UUID，独立分页全局账户差异。请求间不维持历史快照，处理/数据变化后应刷新首页。

响应 `PointsReport`：checkedAt、from、to、view、totals[{kind,count,points}]、netPoints、daily[{date,incoming,outgoing,net}]、reconciliation、items、nextCursor、accountDifferences{items,nextCursor}。所有积分值包括累计SUM为十进制字符串，不转换JS Number。totals/daily按所选日期全部类型入账流水统计，不受kind/view/cursor限制；incoming/outgoing为非负绝对值，net及各kind.points为带符号变动。daily只返回有流水日期，按日期升序，最多366条。

reconciliation固定为当前全历史：本仓sourceIssues/missingLedger/invalidLedger/unexpectedLedger、全局accountIssues/currentGlobalBalance/globalLedgerTotal、全局unassignedCount/unassignedPoints。不将全局余额当作本仓期间余额；未归属流水排除各仓业务分类并单独提示。账户差异items为userId/displayName/balance/ledgerTotal，只读授权资料。业务明细items为key/kind/sourceId/reference/displayName/expectedPoints/actualPoints/occurredAt/ledgerAt/issue，issue=MISSING/INVALID/UNEXPECTED或null；无流水actualPoints/ledgerAt为null，尚未批准或未发生入账业务的expectedPoints为0。不返回手机号、收件地址、OpenID、密文、会话、密钥或私有成本。

核对覆盖标准业务action_key、用户、delta、actor/consumer_actor、redemption_id/action及REFUND事件ledger_id；原业务状态决定应记/不应记。错误动作键或未知来源另外进入未归属提示，不声称它们都已有可核实来源。无新写接口/迁移，旧接口不变。


## 2026-11-06 顾客账号专用状态动作（0.77.0）

顾客目录/详情user增加兼容字段stateVersion:integer（既有consumer_users.auth_version，用于状态并发；不改变消费者响应）。旧客户端可忽略，调用新写接口须读取后携带。无通用状态写入接口。

`POST /api/v1/admin/customers/:id/status/disable`或`enable`：员工Cookie、CSRF、Idempotency-Key，points.write且事务内当前SUPER_ADMIN/有效会话/启用经营仓绑定，OPERATIONS无权变更。body严格为{version:0..2147483646整数,reason:1..200字符,confirmed:true}，不接受query或额外字段。返回{id,enabled,stateVersion}为原动作确认结果，不保证是重放时当前状态，客户端成功后必须重读资料。未知动作/顾客404、非法输入/缺确认400、无会话401、无权/缺CSRF403、状态已变/重复状态/改键内容409、并发可重试503；不暴露令牌或原始身份。相同键不同body拒绝，相同键并发只变更/审计一次。

动作在ReadCommitted事务内先验证权限、锁原请求、检查已保存结果，再锁consumer_users FOR UPDATE。要求version与当前auth_version一致且处于相反状态，更新enabled并递增auth_version；操作审计使用实际DB clock_timestamp，避免把等待锁之前的事务开始时间当作动作时间。审计与幂等记录同事务。重放在等待锁后也重新校验当前权限/会话有效期，不绕过撤权。停用及恢复都使旧会话永远不匹配；不删除session或其他业务记录。新登录可在恢复后重新获取当前代次。

`GET /api/v1/admin/customers/:id/status-history?cursor=UUID`：points.read及当前有效负责人/运营经营仓授权，Cache-Control:no-store。返回CustomerStatusHistory{items:[{id,action:CUSTOMER_DISABLED|CUSTOMER_ENABLED,actorName,reason,fromEnabled,toEnabled,createdAt}],nextCursor}，按(createdAt,id)倒序，每页20；cursor须属于该顾客专用操作，否则409。资料、原因和姓名属于授权运营信息，不返回会话、subject、OpenID、密钥、电话或收件资料。账号是全局身份，历史按顾客全局展示，不以操作来源仓错误隐藏身份变更。

不改变原退款/发放审批等业务API契约。发放申请新增事务内有效用户共享锁，已停用时与原审批一致拒绝；不会自动驳回历史申请。原语义保留，无迁移。


## 2026-11-06 顾客内部备注（0.78.0）

新增 `/api/v1/admin/customers/:id/notes`，员工Cookie，服务端当前SUPER_ADMIN/OPERATIONS、启用经营仓绑定及有效会话，Cache-Control:no-store。GET需要points.read，POST需要points.write/CSRF/Idempotency-Key，消费者401、仓管/失权403，不接受query中的warehouseId或额外字段。与顾客全局账号状态不同，备注按经营仓隔离。

GET支持cursor=原记录UUID，返回CustomerNotesPage{scopeId,items:[{id,message,actorName,createdAt}],nextCursor}，按(createdAt,id)倒序最多20条。scopeId为当前服务端经营仓，用于请求一致性核对，不能选择查询外仓。cursor须为该顾客、本仓、CUSTOMER_NOTE_ADDED记录，否则409；顾客不存在404，非法参数400。授权后才解密正文，不返回payload、subject、会话或收件资料。

POST严格body={scopeId,message}，scopeId须匹配当前服务端经营仓，不能借参数切换仓；不匹配409 SCOPE_CHANGED。message为trim后1至500 UTF-16单位文本，允许LF换行，拒绝其他C0/DEL控制字符。返回{id}，不把正文放入幂等结果。按员工/仓库/顾客/键串行，规范正文和范围哈希一致才可重放；改内容409 IDEMPOTENCY_CONFLICT，等待锁后/提交前复验当前权限，撤权不能通过历史请求读取旧成功结果。缺CSRF403，密钥未配置503 CUSTOMER_NOTES_UNAVAILABLE，已有记录不可解密503 CUSTOMER_NOTES_UNREADABLE，并发冲突503 RETRYABLE_CONFLICT。

备注事件和幂等记录同事务，失败不留下部分备注，原键可恢复。记录可供后台为停用顾客跟进，不恢复该账号或旧会话，不改变积分、订单或售后事实。无通用编辑/删除接口，无旧接口字段变化，无迁移。

## 2026-11-06 多订单汇总配货打印（0.79.0）

`POST /api/v1/admin/redemptions/consolidated-print-preview`：当前经营仓SUPER_ADMIN/OPERATIONS及points.read权限，要求有效会话和CSRF，响应`Cache-Control: no-store`。请求仅`{ids: string[]}`，2–20个不重复UUID；未知字段、重复或数量错误400，缺单404，无权限403，已取消/非待发货/混顾客/混原地址/混运行模式409。无幂等键需求（纯读取）。

响应沿用`RedemptionPrintPreview`的`generatedAt/items`，新增可选`consolidatedLines`（title/spec/unit/quantity）；该接口始终返回汇总行，旧逐单打印接口不返回。items保留请求顺序和原订单地址/备注/积分；不返回顾客UUID、地址密文或库存分配。比较联系人/电话/省市区/详情/地址备注，订单备注单独保留。按SKU+历史标题/规格/单位分组，合计积分采用BigInt。订单按UUID顺序FOR SHARE，串行于取消/发货操作，事务末重验当前权限。预览不授权未来操作；每次点击打印重新请求并在失败时清空旧预览。OpenAPI已同步，旧接口兼容。

## 2026-11-07 合包确认与发货（0.80.0）

- `POST /api/v1/admin/redemptions/parcel-preview`：points.read、当前SUPER_ADMIN/OPERATIONS经营仓权限及CSRF；仅`{ids}`，2–20个不重复UUID；no-store。返回executionMode、原address、逐单items（id/orderNo/version/title/spec/unit/quantity/orderNote及原allocations的批次/库位名/数量）、canShip及可读blockers。状态/归属/地址/运行模式不合格整批拒绝，不返回部分私密资料；库存或作业开关阻断时展示完整核对资料并禁用提交。
- `POST /api/v1/admin/redemptions/ship-parcel`：points.write、当前SUPER_ADMIN/OPERATIONS仓权限、CSRF与Idempotency-Key。请求`{orders:[{id,version}],carrierCode,carrierName?,trackingNo,dispatchConfirmed:true}`；2–20个不重复订单，要求实物已核对并同包交给快递。服务端排序订单、规范化运单后哈希，作用域为操作者+动作+经营仓（改选订单不能复用原键），只存包裹ID和orderIds结果。返回`{id,orderIds}`。成功原键可在开关暂停后核实，当前会话/角色/仓权限仍必须有效。未知结果不产生新键。
- 400参数/实物确认缺失，403权限/CSRF，404授权范围内缺单，409混顾客/原地址/模式、状态/版本/库存/运单占用冲突，503开关关闭或可重试竞争；500事务失败不允许前端宣称已发货。全部订单一次提交或全部回滚。
- 现有`/:id/shipping-corrections`若属于合包，会排序锁整包订单并追加所有成员的同版本运单更正；原因和原始事实继续保留。原接口路径/参数不变，UI提前告知整包影响；任何成员不符合条件整包失败。原单更正语义不变。
- `RedemptionExpressShipmentView`新增可选`parcel:{id,orderCount}`（旧单不附加），消费者只看到本人订单最新运单和同包数量，不暴露其他顾客、操作者或收件地址。收货与售后仍按原单处理，不自动批量确认。
