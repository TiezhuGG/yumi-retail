2026-11-02最新优先级：负责人要求新增积分商城，小程序与运营后台同时交付，优先实现并上线，其他功能随后依次上线。详见[积分商城首发设计](../product/POINTS-MALL-V1.md)。本轮为设计，尚未实现或上线；积分经营参数仍待配置。该要求覆盖历史排除积分及旧下一步顺序，必要的真实登录、库存、履约、售后和生产验收依赖仍须完成。API与数据新增内容均为设计草案，非已发布契约。

# 数据库与库存账本设计 V1.1

2026-10-26：用户已确认[PostgreSQL决策](../architecture/ADR-002-DATABASE-CHOICE.md)。以下为PostgreSQL业务设计草案；S0迁移仅建立带validation_前缀的隔离验证模型，不代表所有业务表已实现。

这是业务逻辑/物理设计草案，尚未全部转成业务Prisma schema。当前已建立真实PostgreSQL开发/测试库，验证S0模型，并落地员工/仓库基础与商品收货库存表；订单/支付/配送等仍待实现。下方规划表不等于实际字段清单，不能直接复制示意SQL到生产。

### S1已落地模型与迁移影响

2026-10-28增量：`202610280001_stock_counts`新增stock_counts及stock_count_lines；stock_balances新增active_count_id，复合外键确保同仓/SKU。部分唯一索引保证每SKU最多一个FROZEN/SUBMITTED/APPROVED盘点；deferred触发器验证冻结指针与活跃单据一致，不能孤立解冻。`202610280002_count_reason_constraints`额外拒绝NULL审批/终止原因，防止SQL CHECK空值被当成满足条件。旧数量与旧流水保持原样。

盘点快照记录所有位置及on_hand/reserved/blocked/version，实盘counted只允许冻结阶段由空值写入一次；提交后明细不可改删，终态单据不可改删。状态迁移、保护数量、独立审批和时间字段有SQL约束/触发器。员工外键、位置及单据复合外键均RESTRICT。应用先锁balance再重读单据；所有盘点动作和收货/移位遵守同一锁序。

盘点冻结期间，数据库BEFORE触发器拒绝位置/批次数量写入和余额数量变化。盘点过账在事务内设置对应APPROVED单据ID的本地写标记，新增COUNT:<countId>:<lineId>主流水及位置流水后再转终态并清指针。标记只供可信服务事务，不能当作面向客户端的授权手段。盘盈保留既有批次成本来源，不重估成本；未知批次不通过此接口创建。差异先减后加，余额按净差额更新，避免相抵差异导致中间临界量溢出。

迁移是加法，但旧API公开库存查询不认识盘点冻结，因此须停止旧写/读服务后迁移并部署新版本，不允许混跑或直接回退旧API。回退兼容代码需保留冻结、快照和两级账本，不能删除事实或清库。Prisma diff仅核对其支持的结构，SQL冻结与约束用真实集成测试另验。

当前增量：202610270003_locations_reconciliation及202610270004_require_position_entries已部署，新增warehouse_locations、stock_positions、position_ledger、stock_transfers、inventory_checks；stock_balances新增inventory_hold，business_audits新增可空reason。下方S2固定货位说明为历史模型，已由本增量演进。

迁移在事务内锁住旧库存写入，先验证汇总=批次、批次=主流水的三种数量；不一致直接停止，不修改数量。为已有仓库创建DEFAULT，为旧批次的历史location_code建位，按旧批次数量落stock_positions；position_ledger引用原stock_ledger回填历史、保留原时间，旧主流水不UPDATE。新仓由AFTER INSERT触发器建立DEFAULT。迁移前停止旧写服务，迁移后只能运行新版收货服务。

StockLot的on_hand/reserved/blocked暂作批次缓存，StockPosition为真实位置；lot.location_code仅历史兼容字段，不再表示当前唯一库位。位置同时通过复合外键关联批次/仓库/SKU及本仓库位。主流水新增复合唯一键供位置流水约束；位置流水按主流水+位置唯一。同仓移位产生零仓库增量主流水及两条位置流水（−N/+N），StockTransfer关联源/目标与原因，汇总version变化但数量不变。

位置/主流水在提交时通过deferred constraint trigger配平，零增量主流水也必须有明细。位置流水、移位单、核对报告有不可改/删触发器；数量与非负/占用边界有SQL CHECK。应用收货/移位/核对都按仓库SKU余额锁串行；今后预占/出库也必须遵守同一锁协议，不能只锁位置。旧版本收货遗漏位置流水时提交失败，禁止混跑旧写服务或直接回退旧写代码。

InventoryCheck保存单SKU报告（CONSISTENT/DIFFERENCES、issue_count、前100条issues、操作者与时间），不执行数量修复。核对比较汇总↔批次/主流水、批次↔位置/主流水、位置↔位置流水、主流水↔位置明细；比较证据的数量使用十进制整数字符串，避免汇总证据超出JS安全整数时失真。差异触发inventory_hold，不自动释放。解除需新检查一致及审计原因；不解除blocked、预占或其他业务限制。

兼容迁移保留旧列/主流水，接口新增字段为加法；但写协议已升级，旧应用不可继续收货。回退应部署仍支持位置账本的兼容代码并保留数据，禁止回滚DDL/删除历史流水。Prisma diff不检查SQL函数、CHECK和触发器语义，已另用真实DB测试覆盖。

最新增量：`202610270002_catalog_inbound`已在本机开发/测试库部署；新增categories、products、skus、inbound_receipts、inbound_lines、stock_balances、stock_lots、stock_ledger、business_audits、idempotency_records（10表）。员工基础迁移不改。商品/收货状态及版本、金额/数量和库存不变量有SQL CHECK；订单与配送表仍未实现。

本轮实际模型：库存汇总复合主键(warehouse_id,sku_id)，批次关联唯一receipt_line_id，固定location_code=DEFAULT，批次同时承载数量；尚未拆stock_positions。复合外键保证单据行、批次、流水的仓库/SKU一致。每行成本price以BIGINT分保存，当前边界0–100000000（售价至少1）；数量1–100000，库存最大10亿件；JSON输出前转换为范围内安全number。生产/到期必须成对，expires_at>produced_at；业务层校验未来/已到期。

流水action_key唯一、receipt_line_id唯一防重复事实，流水及业务审计有BEFORE UPDATE/DELETE触发器拒绝修改/删除。幂等表按(scope,key_hash)唯一，保存请求摘要与首次JSON结果，无中间状态提交；事务级advisory锁串行相同意图，单据行锁阻止不同键重复过账，按SKU顺序原子建余额/加库存。失败回滚后同键可重试。无自动清理库存关键幂等记录。

兼容性：本轮仅新增表/函数/触发器，不重置原数据；回退应用时保留这些表，禁止通过删除流水实现回退。未来多库位需将批次数量迁移到位置，核对汇总与账本后再切换。新增DB适配器显式schema与search_path支持，用于yumi_test一次性schema测试；默认仍public。Prisma diff不覆盖SQL CHECK/触发器语义，测试另行验证。

迁移`202610270001_staff_foundation`新增warehouses、staff、staff_roles、staff_warehouses、staff_sessions、staff_login_throttles、auth_audit_events，全部UUID主键或组合主键。仅新增表，不重命名/删除S0数据；历史S0迁移保持不变。仓库当前只有code/name/enabled，地址与经营配置将在业务切片补充。

staff实际字段为login_name/display_name/password_hash/enabled/auth_version/created_at。staff_sessions为员工专用，不与消费者共表；含token_hash(CHAR64唯一)、auth_version、created_at/expires_at/revoked_at；CHECK要求expires_at>created_at，员工有效性与版本每次请求重查。角色为7个固定代码的CHECK；范围表组合唯一，外键删除RESTRICT。auth_audit_events只记录认证、退出与权限拒绝，当前不是完整业务审计表；无明文凭据或原始Cookie。

staff_login_throttles使用摘要键、数据库窗口起点与原子UPSERT计数，跨实例共享。会话/限流/审计数据保留与定期清理任务尚未实现，须在上线前补齐。开发seed只允许本机yumi_dev且禁止production，重复执行不覆盖既有员工、密码、仓库或库存。未来消费者会话、轮换族、仓库作业审计需另建迁移，不能把下方设计表当成已落地字段。

## 1. 统一数据约定

- PostgreSQL17、UTF8；本机Docker Desktop隔离开发与测试库。事务关联用真实外键；历史交易不级联删除。字典停用，员工/商品软停用，订单/支付/流水不物理业务删除。
- 内部主键可 BIGINT，外部 public_id 用不可预测ID并设唯一；API只返回字符串。订单号/商户单号为独立唯一字符串，不依赖时间戳毫秒防碰撞。
- 金额 BIGINT整数分（API返回前验证安全范围），数量 INT整数且非负；不使用FLOAT/DOUBLE金额。成本也是分，成本来源不齐时不计算毛利。
- 时间 TIMESTAMPTZ(3) 表达绝对时间，按UTC存取；到期日期按经营时区定义后转换 cutoff_at。日期边界、含当日与否必须用样例测试。
- 业务实体有 created_at、updated_at、version；流水有 created_at、业务发生时间和操作者，不允许编辑已过账事实。
- 字符串字段长度、枚举、CHECK与索引在迁移中显式定义。JSONB只承载不可变快照、元信息与脱敏审计差异，不把需要索引的核心数量/状态全塞JSON。

## 2. 主要实体关系

```mermaid
erDiagram
    USER ||--o{ ADDRESS : owns
    USER ||--o{ ORDER : creates
    PRODUCT ||--|{ SKU : contains
    WAREHOUSE ||--o{ STOCK_BALANCE : holds
    SKU ||--o{ STOCK_BALANCE : aggregates
    SKU ||--o{ STOCK_LOT : batches
    STOCK_LOT ||--o{ STOCK_POSITION : located
    ORDER ||--|{ ORDER_ITEM : snapshots
    ORDER ||--o{ RESERVATION : reserves
    RESERVATION ||--|{ RESERVATION_LINE : allocates
    STOCK_POSITION ||--o{ RESERVATION_LINE : occupied
    ORDER ||--o{ PAYMENT : pays
    ORDER ||--o{ PICK_TASK : picks
    ORDER ||--o{ DELIVERY_TASK : delivers
    ORDER ||--o{ AFTERSALE : disputes
    AFTERSALE ||--|{ AFTERSALE_ITEM : claims
    AFTERSALE ||--o{ REFUND : refunds
```

关系图展示核心关系，不等于要求每个模块同时建表上线。表名用单数概念示意；落地统一 snake_case 命名。

## 3. 身份、经营与商品表

| 表 | 关键字段 / 约束 | 索引与说明 |
|---|---|---|
| users | id/public_id、wechat_app_id、openid、status | UNIQUE(app_id,openid)，UnionID如适用可空，不当唯一业务主键 |
| staff | id、login_name、password_hash、name、status | login_name唯一；不存明文密码 |
| staff_roles | staff_id、role_code | UNIQUE(staff_id,role_code)；固定角色，权限点在代码版本化 |
| staff_warehouses | staff_id、warehouse_id | 组合唯一，限制仓库数据范围 |
| sessions | subject_type/id、token_hash、expires_at、revoked_at、rotation_family | token_hash唯一，索引有效期；消费者/员工会话隔离 |
| warehouses | code、name、address、status | code唯一，首期1条有效经营仓库 |
| service_areas | warehouse_id、singleton、name、enabled、version | 全局singleton=true唯一，warehouse_id唯一，默认停用 |
| service_buildings | area_id、name、name_key、enabled | UNIQUE(area_id,name_key)，name_key=lower(name)，默认停用；编码/单元规则未实现 |
| store_settings | singleton/business_id、opening_rules、min_goods_cents、delivery_fee_cents、paused、rule_version | 修改留审计；金额/暂停状态独立列 |
| consumer_addresses（已实现） | user_id、area_id、building_id、payload、is_default、deleted | payload为联系/门牌JSON的AES-256-GCM密文；本人索引；有效默认部分唯一 |
| consumer_address_books（已实现） | user_id、version | 每人独立版本和锁；当前默认用地址表部分唯一标记，未建立user_preferences |
| categories | parent_id、name、sort、status | (parent_id,status,sort)，应用层禁止循环与超过两级 |
| products | public_id、category_id、name、description、status | (category_id,status,id)，关键字检索初期限制范围并分页 |
| skus | product_id、sku_code、barcode、spec、unit、price_cents、expiry_managed、status | sku_code唯一；barcode可空且唯一策略按真实商品规范确定 |
| assets | public_id、owner_type/id、purpose、object_key、visibility、mime、bytes、verified_at | object_key唯一，私有图片按归属授权 |
| product_assets | product_id、asset_id、sort、usage | 组合唯一；图片不能引用未校验上传 |
| home_content | slot、product_id/asset_id、sort、enabled | 受控推荐/横幅，不做自由脚本配置 |
| cart_items | user_id、sku_id、quantity、selected、version | UNIQUE(user_id,sku_id)；当前售价不写死在购物车 |

地址快照必须加密/受控保存，不因为联系方式加密就允许日志明文输出。字段级加密密钥位于独立配置，备份恢复同时考虑密钥恢复与访问权限。

## 4. 仓储与库存表

| 表 | 关键字段 / 约束 | 索引与说明 |
|---|---|---|
| locations | warehouse_id、code、type、status | UNIQUE(warehouse_id,code)，type含收货/存储/隔离 |
| stock_balances | warehouse_id、sku_id、on_hand、reserved、blocked、safety、version | UNIQUE(warehouse_id,sku_id)，所有操作先锁本行 |
| stock_lots | warehouse_id、sku_id、lot_no、received_at、produced_at、expires_at、unit_cost_cents、quality_status | (warehouse_id,sku_id,expires_at,id)，批次号按仓库/SKU/来源定义唯一 |
| stock_positions | lot_id、location_id、on_hand、reserved、blocked、version | UNIQUE(lot_id,location_id)，库位须属于同仓 |
| reservations | order_id、warehouse_id、status、expires_at、released_at | order_id首期唯一；(status,expires_at)；状态ACTIVE/CONSUMED/RELEASED/PARTIAL |
| reservation_lines | reservation_id、order_item_id、position_id、allocated_qty、released_qty、consumed_qty | 按行和库位唯一；累计释放+消耗≤allocated |
| stock_ledger | action_id、position_id、warehouse_id、sku_id、delta_on_hand、delta_reserved、delta_blocked、source_type/id/line_id、actor_id、reason | UNIQUE(action_id,position_id)，(warehouse_id,sku_id,id)、(source_type,source_id) |
| warehouse_documents | type、warehouse_id、doc_no、status、source_ref、reason、actor/reviewer、posted_at、reverses_id | doc_no唯一；类型为收货/盘点/报损/退货/移位，分别限定字段与状态 |
| warehouse_document_lines | document_id、sku_id、lot_id、from/to_location_id、quantity、book_qty、counted_qty、unit_cost_cents、expiry_fields | (document_id,id)，已过账不可改，按type校验必填 |
| stock_freezes | warehouse_id、sku_id、position_id?、count_document_id、status、expires_at | 活跃冻结范围唯一策略；过期需核对任务后释放，不能静默清掉进行中盘点 |

仓储单据共用表头/行不意味着共用一个任意“调整数量”接口。收货、盘点、报损、退货、移位由不同应用服务执行类型约束、权限和过账规则，避免泛化CRUD绕过账本。

### 4.1 不变量

1. 每个汇总/库位行的 on_hand、reserved、blocked、safety 均≥0，且 `reserved + blocked <= on_hand`。
2. 汇总 on_hand/reserved/blocked 与有效库位明细合计相等；safety在SKU仓库层维护，不在每个库位重复扣除。
3. 可售数量同时受汇总安全库存与可用批次限制，禁止单独凭汇总库存卖出过期/隔离批次。
4. 有效预占行的未释放未消耗数量合计，与库位reserved及汇总reserved一致。
5. stock_ledger 记录每个位置的增量；业务过账+位置+汇总+流水同事务。汇总初始值加流水增量可重建当前余额。
6. 库位移位记录一减一加，仓库 on_hand 总量不变；移动已预占库存首期禁止，先由授权流程重分配。
7. 隔离/到期发现占用：未被预占部分进入blocked，已预占部分进入履约异常并禁止出库，随后重分配或取消释放后转blocked；不能将同一数量同时算reserved和blocked。
8. 盘点真实数量小于已占用量时，先异常处理相关订单，不通过强制负数修正。

可售：`max(0, on_hand - blocked - reserved - safety)`，再与可分配批次可售合计取较小值。库存真相是数据库中一致提交的事实；内存、Redis、商品列表缓存都不是最终裁决。

### 4.2 预占事务示意

```sql
-- 仅示意一个SKU的汇总条件更新；真实实现必须与订单、批次位置、
-- reservation_lines、ledger、幂等记录同事务提交。
UPDATE stock_balances
SET reserved = reserved + $1, version = version + 1
WHERE warehouse_id = $2 AND sku_id = $3
  AND on_hand - blocked - reserved - safety >= $1
RETURNING warehouse_id, sku_id, reserved;
-- 返回行数必须为1，否则整体回滚；实际实现使用参数化查询。
```

实际实现顺序：锁/确认幂等记录 → 按SKU排序锁汇总 → 检查冻结 → 锁可用批次位置（近效期/先进先出）→ 校验商品价格与全部数量 → 分配预占 → 写订单与快照 → 写流水/Outbox/幂等结果 → 提交。可通过参数化原生SQL完成条件写，禁止字符串拼SQL。

### 4.3 主要动作的账本效果

| 动作 | on_hand | reserved | blocked |
|---|---:|---:|---:|
| 可售收货+N | +N | 0 | 0 |
| 隔离收货+N | +N | 0 | +N |
| 下单预占N | 0 | +N | 0 |
| 未出库取消N | 0 | −N | 0（若批次已隔离则转blocked） |
| 出库N | −N | −N | 0 |
| 不可售报损N | −N | 0 | −N |
| 可售品发现损坏N | 0 | 0 | +N；先建立数量隔离，再按独立报损单处理 |
| 退款无退货 | 0 | 0 | 0 |
| 实物退回且可售N | +N | 0 | 0 |
| 实物退回隔离N | +N | 0 | +N |

盘点按差异过账，先判断可售/隔离与预占影响；不能简单覆写余额且不写流水。

## 5. 报价、订单与支付表

| 表 | 关键字段 / 约束 | 索引与说明 |
|---|---|---|
| checkout_quotes（已实现） | user_id、key、digest、snapshot、request_id、created_at、expires_at | UNIQUE(user_id,key)，(user_id,expires_at)；无地址联系明文 |
| orders | public_id、order_no、user_id、warehouse_id、area_id、order_status、fulfillment_status、goods_cents、delivery_fee_cents、payable_cents、paid_cents、refund_reserved_cents、refunded_cents、payment_deadline、paid_at、address_snapshot_ciphertext、version | order_no唯一；(user_id,created_at,id)、(warehouse_id,order_status,created_at)、(order_status,payment_deadline) |
| order_items | order_id、sku_id、name/spec/unit/image_snapshot、unit_price_cents、ordered_qty、canceled_qty、dispatched_qty、subtotal_cents、refund_reserved_qty/cents、refunded_qty/cents | (order_id,id)，快照不跟随商品修改；行金额核对 |
| order_events | order_id、event_type、before/after、actor_type/id、reason、request_id、created_at | (order_id,id)，只追加 |
| cancellation_requests | order_id、reason、requested_by、status、resolution、version | (order_id,status)，只允许一个有效取消请求，已付走退款流程 |
| payments | order_id、out_trade_no、provider_transaction_id、status、amount_cents、currency、prepay_ref、success_at、last_queried_at、version | out_trade_no唯一，provider_transaction_id非空时唯一；首期每订单一张有效支付单 |
| payment_notifications | provider、provider_event_id、type、payload_digest、encrypted_payload_ref、processed_at | UNIQUE(provider,event_id)，不公开明文通知 |

出库行数量必须≤订购−已取消；退款数量不直接改变订购数量或出库数量。商品售后不代表未履约行被取消，需区别售后原因与履约决议。

未支付订单 payable_cents 在创建后不可随意修改。渠道成功必须匹配原单 amount、currency、商户和AppID；unknown状态要保留查询证据。金额字段恒等式在服务层与可适用的CHECK双重校验。

## 6. 仓库任务与骑手表

| 表 | 字段 | 索引 / 约束 |
|---|---|---|
| pick_tasks | order_id、warehouse_id、assigned_staff_id、status、claimed_at、packed_at、dispatched_at、version | 首期order_id唯一；(warehouse_id,status,created_at) |
| pick_task_lines | task_id、order_item_id、position_id、required_qty、picked_qty、shortage_qty、resolution | 行关联预占位置；任务+订单行+位置唯一 |
| warehouse_exceptions | order_id/task_id、type、affected_line_id、quantity、status、resolution、actor_id | (warehouse_id,status,created_at)，联系与决议可追溯 |
| delivery_tasks | order_id、warehouse_id、rider_id、status、assignment_version、accepted_at、started_at、delivered_at、proof_type/asset_id、version | 首期order_id唯一；(rider_id,status,created_at)、(warehouse_id,status,id) |
| delivery_assignments | task_id、rider_id、assigned_by、assignment_version、assigned_at、revoked_at、reason | UNIQUE(task_id,assignment_version)，不覆写历史 |
| delivery_exceptions | task_id、type、note、reported_by、resolution、resolved_by、resolved_at | (task_id,status)，附件关联assets |

骑手可复用 staff 身份，用固定 rider 角色与仓库范围约束。配送任务当前指派是冗余快照，更新时与指派历史同事务；客户端 version/assignment_version必须匹配。送达不写库存负向流水。

## 7. 售后与退款表

| 表 | 关键字段 / 约束 | 索引与说明 |
|---|---|---|
| aftersales | order_id、user_id、type、reason、status、requested_cents、approved_cents、shipping_refund_cents、reviewer_id、review_note、version | (user_id,created_at)、(status,created_at)，金额服务端计算 |
| aftersale_items | aftersale_id、order_item_id、quantity、goods_refund_cents、reason | 申请+订单行唯一；关联额度占用 |
| refunds | aftersale_id、payment_id、out_refund_no、provider_refund_id、amount_cents、status、success_at、last_queried_at、version | out_refund_no唯一，渠道ID非空唯一；(status,updated_at) |
| refund_allocations | refund_id、order_item_id?、allocation_type、amount_cents、quantity | 区分商品与运费；合计=本次渠道退款金额 |

申请额度在事务内锁定订单与相关行；检查已退+有效占用+本次≤原实付，同时检查数量。订单退款金额计数、行金额/数量计数、申请与分配在同一事务更新。运费另设受限额度（可用独立订单字段或独立allocation聚合），不能让每个申请都再退一份运费。

渠道超时/处理中保留额度；退款最终成功将reserved转refunded；申请被拒绝/正式终止才释放。退款失败仍有义务时保留占用并重试/人工处理。首版一次申请只发一张有效退款单；若官方渠道要求对确认终态失败新建退款单，必须记录前后替代关系、确认旧单不可能成功并保留同一业务义务，不能在网络超时后简单换号。

已退款不能因重放通知重复增加 refunded_cents。退款总额只能≤渠道确认支付金额。每个退款都能追溯订单行、运费和操作者。

## 8. 基础可靠性与对账表

| 表 | 字段 / 约束 | 用途 |
|---|---|---|
| idempotency_records | scope、key_hash、request_hash、status、resource_id、result_json、expires_at | UNIQUE(scope,key_hash)，提交结果与业务动作同事务 |
| outbox_events | event_id、aggregate_type/id、type、payload、status、next_run_at、lease_until、attempts | event_id唯一；(status,next_run_at,id)，可重放 |
| background_jobs | kind、business_key、payload、status、next_run_at、lease_owner/until、attempts、last_error | UNIQUE(kind,business_key)，扫描+重试，不依赖进程定时器 |
| audit_logs | actor_type/id、warehouse_id、action、resource_type/id、reason、result、request_id、redacted_changes | (resource_type,resource_id,id)、(actor_id,created_at)，只追加 |
| reconciliation_runs | provider、bill_date、bill_type、status、source_digest、started/completed_at | UNIQUE(provider,bill_date,bill_type)，下载重试可追踪 |
| reconciliation_differences | run_id、business_no、type、local_cents、provider_cents、status、resolution、resolved_by | UNIQUE(run_id,business_no,type)，处置留痕 |

Outbox消费业务还需自身唯一键（如pick_tasks.order_id），仅把事件标记已消费不能保证业务侧恰好一次。目标是至少一次投递加业务幂等。

## 9. 迁移、备份与验证

- 每个模块交付迁移、索引、开发样例、回退/修复说明；生产禁用reset、db push替代迁移或自动清库。
- 采用先增后改后删的兼容迁移；大表索引与回填独立执行，观察锁和耗时。
- 开发样例：1仓、1小区、若干楼栋、3普通SKU、2员工角色组合、1骑手，价格450/590/1680分；不使用真实居民信息。
- 集成验证：多SKU中途失败完全回滚；最后一件争抢；重复出入库；盘点/报损与预占冲突；断点重启；退款并发；库位流水重建与聚合余额一致。
- 每日核对汇总与明细、预占与订单、出库与履约；检查不变量失败立即告警并停用受影响SKU销售，不能无声修正数据。

## 2026-10-28 隔离/报损实际增量

迁移`202610280003_stock_dispositions`新增stock_isolations（原位置/批次、quantity、remaining、version、reason、创建员工、唯一stock_ledger_id）及stock_dispositions（关联隔离、RELEASE/DAMAGE、数量、位置/隔离版本快照、状态/版本、独立审批、实物说明和唯一过账流水）。复合外键限定同仓/SKU/批次/位置，原始事实不可改删，终态不可改。已部署迁移不重写。

延迟触发器在提交时检查remaining=quantity−已过账处置之和、每条动作恰好一条正确主流水和一条正确位置流水、位置blocked不小于其隔离remaining总和。历史blocked不回填来源，也不能通过新单据消费。SQL CHECK拒绝空原因、无独立审批过账、报损缺核验说明、终态时间/流水不配对。全部数量更新、隔离余额、单据、两级流水、审计、幂等结果同事务。

加法迁移，无旧数量回填或历史流水改写。部署停旧API/worker、备份后执行db:migrate及db:migrate:test并启动新版；旧服务不理解新增隔离事实，禁止混跑/降级丢弃事实。回退保留新表与全部防护，使用兼容代码修复。Prisma结构diff为空不涵盖触发器语义，另用真实DB集成验证。

## 2026-10-28 收货逆向纠错实际增量

`202610280004_receipt_reversals`新增receipt_reversals，一单一个原批次位置：quantity/position_version、不可变reason/creator、状态/版本、独立reviewer/review_reason、physical_evidence、取消/过账时间和唯一stock_ledger_id。仓库/SKU/批次/位置及流水复合外键约束归属，索引(warehouse_id,sku_id,id)与lot_id。来源通过lot.receipt_line_id追溯，不复制或接受客户端修改原数量/成本。

CHECK和触发器约束初始/迁移/终态、独立审批、非空核验、不可改删；延迟检查原单POSTED、按lot累计已过账逆向≤原收货quantity、恰一条RECEIPT_REVERSE主流水及恰一条对应位置流水且deltaOnHand=−quantity、R/B=0。延迟额度核对锁原lot；API统一先锁balance，再检查快照、额度与完整账本。单据、三层库存、双流水、审计和幂等结果同事务。

原已过账收货及其行新增不可改删保护，也禁止追加行；lot原收货行/仓库/SKU/批次号/成本来源禁止改写。旧原单和流水不改，不回填/重估金额，不修改隔离remaining。加法迁移，停旧写服务、备份、部署两库并重启新版；禁止混跑旧代码或删除事实回退。Prisma结构diff不覆盖SQL约束语义，另用真实DB测试证明。

## 2026-10-29 收货详情读模型说明

本轮无表、列、索引或迁移变化。收货详情按warehouse_id和单据id查询inbound_receipts，联查inbound_lines及当前SKU/商品目录，仅供receipt.read员工；现有单据行数量、成本、批次、效期与历史流水不改。接口展示的商品名称/规格为当前目录资料，未新增名称快照字段，不将其声称为入库时历史名称。BigInt成本在既有金额边界内转换为JSON整数分；合计只在UI用整数分乘整数件计算。

## 商品基本资料编辑（2026-10-30，无迁移）

复用Product.name/category_id/description/version，UPDATE不包含status或SKU/库存字段。先锁Product并比对version，与上下架共享串行点；目标分类/父分类按ID共享锁后重读启用状态。成功版本+1，现有BusinessAudit action=PRODUCT_UPDATE_DETAILS，reason记录旧/新版本及字段名（现有varchar200）；不新增历史前后值表。现有幂等scope按员工/动作/商品，审计、商品版本/资料、首次结果同事务提交，晚期失败全回滚；旧键返回历史结果，最新资料另GET。表、列、索引和约束未变，无数据迁移；既有收货/库存事实不改。18项相关真实DB检查见[报告](../verification/S2-PRODUCT-DETAILS-2026-10-30.md)。

## SKU维护并发与兼容性（2026-10-30）

本切片没有DDL/迁移。复用Sku.priceCents（整数分BigInt）/enabled及Product.version，不新增SKU版本。规格动作事务先Product FOR UPDATE，校验归属/版本，再Sku FOR UPDATE；商品资料和上下架也先取同一Product锁，保证最后启用规格规则和聚合版本串行。收货新建按已排序skuId加FOR SHARE再校验启用；过账沿用Sku FOR SHARE后校验启用，因此与停用串行。停用先提交则过账拒绝且库存不变，过账先完成则保留已入库事实，后续停用不追溯扣库。未引入Product/库存反向加锁依赖。

SKU_SET_PRICE / SKU_ENABLE / SKU_DISABLE审计resourceId为SKU，reason包含商品ID、旧→新Product.version和旧→新整数售价/启用值（现有200字内），与目录变化、幂等结果同事务提交。库存汇总/批次/位置/账本、收货行成本不写；停用不是报损。历史审计及幂等不可变约束保留，没有补建完整字段历史表。既有客户端仍可读取原Product/SKU结构；旧页面动作可能因共享商品版本推进收到409，须刷新。

## 分类版本与层级锁（2026-10-30）

新增迁移202610300001_category_version：categories.version INTEGER NOT NULL DEFAULT 0，CHECK version>=0。已有分类以0起步，不重写名称、层级、enabled、商品或库存事实。Category接口增加version，CategoryDetail增加parent。发布顺序：停止旧API/Worker写入→应用迁移→生成Prisma并构建→启动新版；未迁移库不能先运行新Prisma客户端，HTTP旧读客户端可忽略额外字段。应用回退可保留该增量列，不应删除数据/审计作为回退。

父分类关系本切片不可变。分类维护先读取父ID，再按UUID排序对自身和父分类FOR UPDATE，重读version/状态；只推进自身版本。商品创建、编辑目标分类及上架持Product锁（已有商品）后按相同UUID顺序FOR SHARE锁分类/父分类，重读enabled。分类动作不加Product锁，不引入类别→商品反向锁顺序；新建子分类也共享锁父分类后校验。父级停用与子级启用、商品创建/编辑/上架按事务次序串行，父级停用不自动更新子/商品状态。

CATEGORY_RENAME / CATEGORY_ENABLE / CATEGORY_DISABLE审计以分类为resourceId；reason记录旧→新版本和字段名或旧→新启用值，不记录完整名称前后值历史。目录变化、版本、审计、幂等结果原子提交；库存和收货表不写入。名称仍非唯一，层级及外键约束保留。真实测试验证非负版本、幂等/竞争及晚期审计失败回滚。

## SKU规格说明更正一致性（2026-10-30）

沿用现有Sku.spec VARCHAR(100)，本轮无新模型、列、索引或迁移。已有分类version迁移仍为运行前置，不能运行新客户端到未迁移库。规格说明更正先Product FOR UPDATE，检查SKU归属及聚合version，再Sku FOR UPDATE，只写spec及Product.version+1；与售价/启停、商品资料/上下架共享锁顺序，其他SKU不写。库存、收货行、批次、位置、两级流水和成本均不更新；仓储读接口继续联查当前目录，不新增历史规格文字快照。

审计SKU_UPDATE_SPEC的resourceId是SKU，reason含商品ID、旧→新版本及fields spec；不是完整文字前后值历史。目录变更、版本、审计及首次幂等结果同事务提交，晚期失败全回滚，原键可再试。没有单位换算/包装身份变更模型，接口只提供说明文字更正，不能自动判别自然语言中的实物差异。

## SKU条码列、唯一性与迁移（2026-10-30）

新增迁移202610300002_sku_barcode：skus.barcode VARCHAR(64)可空，CHECK为null或1–64位ASCII数字，唯一索引skus_barcode_key。Prisma Sku.barcode String? @unique；不回填现有商品码，已有SKU均null，多行null允许。一个SKU一条码，停用行仍参与唯一索引；清空释放该绑定，但保留审计。当前不设跨时间永久不可复用规则、不设校验位算法或多码映射表。

先停止旧API/Worker写入，应用增量迁移、生成Prisma并构建后启动新服务；未迁移库不能使用新客户端。额外可空字段对旧HTTP读客户端增量兼容；应用回退可保留列/索引，不通过删除绑定/审计回退。本机开发库已应用，其他环境仍需按序迁移。

写事务顺序Product FOR UPDATE→SKU归属/版本校验→Sku FOR UPDATE，只写barcode及Product.version；唯一索引处理不同商品同时绑定同码，P2002映射BARCODE_IN_USE并全部回滚，不推进失败商品版本。已有售价/规格/启停等共享商品版本，旧表单409。SKU_SET_BARCODE审计resourceId为SKU，reason含旧→新版本及旧→新条码/null（64+64位及版本文案在200字内）；条码/版本/审计/幂等结果原子提交。幂等成功后即使绑定已清空/转给其他SKU，历史重放不再次执行更新。库存、收货、成本和两级流水不写。

## 条码读取与收货草稿（2026-10-31）

本轮无DDL/迁移。复用Sku.barcode唯一索引findUnique读取，再附当前Product.name；仓库鉴权优先于查询，不新增库存/成本读写。GET不生成业务审计或幂等记录，权限拒绝仍沿用认证审计。此前条码/分类迁移仍需先应用，本机已具备。

查询不持有绑定租约，不把结果作为收货唯一真相；前端明确选择skuId，清空/重绑后查询反映新映射，但不追溯替换已选行。候选可能来自未载入的目录页，前端按id缓存该候选供该草稿展示/校验，不复制为新商品。创建收货及过账沿用仓库权限、SKU共享锁/启用/效期、唯一明细、成本整数分、幂等和库存事务；查询本身不增加数量或成本。不新增收货行条码历史快照。


## 商品主图增量（202610310001_product_images）

products.image_id可空，旧行NULL；product_images保存id/product_id/object_key/mime/bytes/width/height/created_at，object_key唯一、(id,product_id)唯一，产品(image_id,id)复合外键限制同商品引用。MIME限定PNG、字节1..4194304、边长1..1200。文件位于本地开发目录，不存PG二进制。版本/绑定/审计同事务，失败确认无DB引用才删除新对象；不确定结果保留待核对。解除/替换不删历史元数据，旧URL不可再读。数据库与对象需一起备份，恢复演练未完成；verify:product-images仅只读盘点。迁移已应用本机开发库并在测试隔离schema验证，无库存迁移。见[记录](../verification/S2-PRODUCT-IMAGE-2026-10-31.md)。


## 图片集和结构化审计迁移（2026-10-31）

202610310002_product_gallery：product_images.sort_order可空，CHECK 0..5、UNIQUE(product_id,sort_order)，非空为当前集，NULL为历史。只回填当前同商品主图为0，不激活历史对象。应用持商品行锁、清空旧顺序再写连续位置，同事务同步products.image_id=首图或NULL、version、审计与幂等；已有复合归属外键保留。202610310003_audit_details：business_audits.details可空JSONB，保存完整before/after有序图片ID，reason只存200字符内版本/数量摘要，旧记录不改。

两项迁移已应用本机开发库并在隔离测试schema验证；无库存迁移。需停止旧API写入后应用全部迁移再重启新版，不允许旧写入和新排序逻辑混跑。移除只解绑/清空排序，历史元数据/对象保留、API不提供旧图片恢复。备份/恢复和只读对象盘点边界沿用前轮，见[报告](../verification/S2-PRODUCT-GALLERY-2026-10-31.md)。


## 规格详情读取增量（2026-10-31）

无DDL或新迁移。复用skus.product_id索引及公开目录SQL，以启用的锚点SKU所属product_id限定兄弟规格，同一语句快照继续计算公开仓各SKU可用量。最多20+1检测异常过量，不分页截断。GET不改商品、库存、成本、审计或幂等记录；商品创建1–20上限不变。此前图片集/审计增量仍为工程运行前置。见[验证记录](../verification/S2-PRODUCT-VARIANTS-2026-10-31.md)。


## 公开分类读取增量（2026-10-31）

无DDL/新迁移。复用categories父关联及UUID游标，条件enabled且父enabled，投影id/name/parent_id与父name；公开分类和商品共享经营仓可用性检查。读取不写分类版本、审计、幂等、库存/成本。商品筛选继续本级或直接子级，并按既有公开目录条件过滤。见[验证记录](../verification/S2-CONSUMER-CATEGORIES-2026-10-31.md)。


## 商品聚合列表读取（2026-10-31）

无新表/DDL/迁移。提取既有公开SKU SQL供SKU列表/详情与商品卡片共用；以匹配SKU窗口计数/BOOL_OR有货及ROW_NUMBER选最低有货价（否则最低参考价，UUID打破同价），随后以product_id做游标和limit。价格/有货/入口同语句快照，金额仍整数分，混合单位不相加库存；不写业务数据/审计/幂等。旧SKU接口身份和分页不变。见[验证记录](../verification/S3-PRODUCT-CARDS-2026-10-31.md)。


## 游客草稿本机结构（2026-10-31）

无PG表/迁移变化。微信本机键yumi.guest-cart.v1:API_BASE_URL保存 {version:1,items:[{skuId,quantity,selected,name,spec,unit}]}，只缓存身份标签，不存售价/库存/顾客资料。数量1–200、最多50 SKU且总量≤200，非法/重复/未知版本保留原值并拒绝操作，明确重置才覆盖；同步写入成功才发布新状态，每次修改重新读当前稿。现有cart_items/user_id设计仍待登录购物车切片。无订单/资金/库存唯一真相落在本机，见[验收记录](../verification/S4-GUEST-CART-2026-10-31.md)。


## 2026-10-31 消费者开发会话增量

202610310004_consumer_sessions新增consumer_users(provider,subject唯一；当前约束仅DEVELOPMENT和两项预设身份)、consumer_sessions(随机令牌SHA256摘要、user_id、auth_version、绝对到期及撤销)、consumer_login_throttles和consumer_auth_audits。与staff完全独立，不改既有商品/库存/金额表。默认会话8小时，技术配置范围60–86400秒。开发库已迁移；集成测试仅一次性schema，yumi_test/public尚未应用新迁移。前端yumi.consumer-session.v1:API_BASE_URL只存token/expiresAt；购物车键不变。真实users微信身份及cart_items仍是后续设计，不能将开发subject当作openid，见[兼容性记录](../verification/S4-CONSUMER-SESSION-2026-10-31.md)。


## 2026-10-31 账号购物车数据实施

202610310005_consumer_carts新增consumer_carts(user_id唯一/version)、consumer_cart_items(user_id+sku_id唯一/数量1–200/selected/未核验标签)、consumer_cart_merges(user_id+key唯一/digest/result)及consumer_cart_audits。依附consumer_users；不设SKU外键，保留失效或未知引用，禁止通过隐藏商品资料补全。全购物车版本代替计划中逐行版本，所有动作锁本人cart、复验并共享锁会话/用户，购物车写入、版本、审计、回执同事务。无价格/库存/成本快照，无库存预占；回执暂不自动过期。开发库已应用，测试为一次性schema，yumi_test/public未迁移。原本机键保留version1/items并增加可选merge:{key,userId,items独立快照}，待确认时冻结，权威拒绝保留稿解除、成功确认才清空。真实微信用户仍待下一适配，见[兼容性记录](../verification/S4-ACCOUNT-CART-2026-10-31.md)。


## 2026-10-31 服务范围增量

迁移202610310006_service_areas仅增加上述两表，外键RESTRICT，整数版本非负，不触碰历史商品/库存/购物车；无默认小区和楼栋。全范围版本随所有小区/楼栋修改递增。写事务先经营仓库共享锁，再全局小区advisory锁及小区行排他锁，名称唯一和200栋容量在锁内校验；审计和既有idempotency_records同事务提交。公开楼栋读取在事务内共享锁定有效父小区和仓库，返回该快照的有效楼栋；下次刷新可能变化，未来地址写入仍需重新事务校验。

本机yumi_dev/public已增量迁移；测试使用一次性yumi_test schema完整迁移后删除。部署顺序：停API、迁移、生成客户端/构建、重启。无删表回退；不修改已应用迁移。真实范围尚待提供，不在种子脚本写入样例。


## 2026-10-31 本人地址增量

202610310007_consumer_addresses新增地址簿、地址、幂等操作回执、地址审计四表；外键RESTRICT，数据库约束有效默认唯一，已删行必须payload=null且非默认。20条容量在本人地址簿排他锁内计算；当前消费者/会话在共享锁下二次核验。范围共享锁持续至地址、默认标记、版本、审计及回执一起提交，与范围启停互斥。默认替换先清本人旧默认，再设置本人目标，同事务回滚。没有地址删除级联影响其他模块。

payload使用AES-256-GCM随机12字节nonce、128位认证标签，AAD绑定userId:addressId；存v1.nonce.tag.ciphertext，不存联系明文。回执只存id/version、内容摘要用同环境密钥HMAC-SHA256，避免对电话等低熵内容暴露无密钥摘要；审计仅动作、地址ID、本人ID、版本、requestId和时间。默认查询返回解密后的本人资料以及当前小区/楼栋名称、available状态。

ADDRESS_ENCRYPTION_KEY为32随机字节的64位hex环境配置，无默认值；缺失时地址服务503，其他模块保持可用。已有密文必须保留对应密钥，备份数据库时另行受控备份密钥；当前仅单密钥v1，轮换须显式离线解密/重加密及回执摘要迁移，禁止直接改值。生产KMS、多密钥轮换/保留清理仍未实施。删除清payload，不删除最小墓碑/审计/回执，避免迟到重试重新创建。

迁移已应用本机yumi_dev/public并重启API，无样例地址/经营范围。隔离测试schema完整迁移后清理；yumi_test/public未做本次增量。其他环境先停消费者写入、迁移、生成客户端/构建、重启，不删表回退。订单快照模型后续实现，不能由地址可变行替代。


## 2026-10-31 报价增量

202610310008_checkout_quotes新增checkout_policies与checkout_quotes。规则warehouse_id主键并外键绑定仓库，整数分配送/起送/免运在0–100000000，免运可null，open默认false，版本非负。报价user_id外键绑定消费者，唯一(user_id,key)，保存规范化输入摘要和不可变JSON明细、服务端生成时间/到期时间、request_id，不存电话/门牌/联系人。snapshot引用地址ID与全地址簿版本、购物车版本、范围版本、规则版本和SKU数量/名称/规格/单价/行额/可用量快照。未创建订单、库存预占或事件表。

预检/报价使用READ COMMITTED事务：共享锁二次校验消费者会话；共享锁本人地址簿、本人购物车及有效范围链、规则行，使这些配置在本次校验期间保持一致；已选商品的可见性/批次/库位/余额汇总在一个SQL语句快照读取。效期使用statement_timestamp()，防止事务等锁后仍按事务开始时间销售已过期批次。只在短事务期间保护配置，事务提交不持库存锁或预占，之后可能变化。

生成报价先按用户取advisory事务锁串行化多键创建和查重，同键摘要冲突409，已成功重放先于当前版本/范围重新核验以保持历史结果但不延长到期。最新有效报价最多20条，过期记录暂保留以保障迟到重放；自动清理/存储治理仍待后续设计。未来订单必须重新核验报价所有依赖、过期、价格和库存，不能只信snapshot.ready。无独立报价审计表，报价不可变行保存本人/时间/requestId作为生成记录；规则变更用既有business_audits同事务。

已应用本机yumi_dev/public并重启API，未配置经营规则或样例报价。全部测试使用一次性yumi_test schema并清理，未改变public结构或库存。部署按停写/迁移/生成客户端/构建/重启执行，不删表回退。


## 2026-11-01 订单预占增量

迁移`202611010001_order_reservations`新增consumer_orders、order_items、order_allocations、order_events，不回填合成订单或修改旧库存数量。订单以BIGINT整数分保存金额，以(user_id,key)、quote_id及order_no唯一；报价必须属于同消费者。商品快照和逐位置分配数量受延迟约束检查，预占/释放流水必须与仓库、SKU、批次、位置及数量配平。分配只能一次性补写release_ledger_id，不可删除；商品/事件追加后不可改；订单快照不可改，只允许未支付取消及version+1。现有事件仅PENDING，不宣称完整Outbox消费者已实现。

地址小区/楼栋名称、联系人/电话/门牌/地址备注及单独orderNote整体AES-256-GCM加密，以订单+用户ID作AAD；随机nonce，复用已配置地址密钥。源地址修改/删除不改变订单快照。key/digest使用规范化请求HMAC，不把备注明文放入流水、事件、日志或幂等回执；密钥须随数据库备份，未配置不能创建/读取联系资料。

stock_ledger增量actor_kind默认STAFF，既有actor_id与原字段值不改；actor_id变可空，新增consumer_actor_id。CHECK强制三种合法结构：STAFF仅员工、CONSUMER仅消费者、SYSTEM无用户ID。消费者预占/主动取消记录真实consumerActorId，后台超时记SYSTEM，不借用员工身份。现有员工写入不传actor_kind仍取STAFF，保持兼容。实物on_hand不因创建/取消/超时改变，reserved在汇总、批次、位置同事务增减，stock_balance和position版本递增；配套不可变两级流水。

创建按SKU有序锁汇总，再锁批次/位置及商品元数据，分配FEFO并排除过期、停售、冻结、隔离、核对暂停和无效位置。取消与超时先锁订单，再按SKU有序锁汇总，共用释放内核；最后库存争抢、晚期事件失败、取消/超时竞争均通过真实PostgreSQL验证。工作进程每次事务只处理一笔，最长批次20笔，不将Redis当库存真相。


## 2026-11-01 后台订单读取模型

本轮无表结构或数据迁移，复用consumer_orders、order_items、order_allocations及order_events。按warehouse_id与不可变created_at/id进行20笔游标分页，订单号前缀/状态由服务端筛选；游标锚点限定同仓库且匹配筛选。详情通过原分配关联StockPosition→批次/库位及预占/释放流水时间，不使用当前汇总reserved冒充本单数量。

读取事务采用RepeatableRead，订单、分配与事件处在同一快照。取消并发时，返回取消前的一致预占记录或取消后的一致释放记录，不混合两者。显式字段白名单不读取联系密文和消费者身份，查询不更改订单/两级库存账/事件；原有取消、超时、不可变约束和加密密钥不变。员工权限使用代码中的order.read及现有StaffWarehouse范围，每请求重新验证，无权限数据回填。


## 2026-11-01 支付准备单增量

迁移202611010002_payment_preparation新增payment_preparations与payment_preparation_events，无历史数据回填。order_id唯一并外键绑定订单，(user_id,key)唯一；记录订单归属/仓库与金额快照、CNY、DISABLED渠道、PREPARED/CLOSED及建立/关闭时间和原因。重复的归属/仓库字段通过延迟约束与原订单核对，金额严格等于payable_cents，建立时间须在订单创建与预占截止之间。SQL CHECK拒绝其他币种/真实渠道/成功等状态，关闭时间与原因不可缺失。

快照不可改，只能首次PREPARED→CLOSED；准备记录不可删除，事件追加后不可改删，(preparation_id,type)唯一。延迟一致性触发器挂在准备记录、事件及原订单更新上，验证金额/归属、NOT_STARTED及订单状态、关闭原因和相应CONSUMER/SYSTEM事件；直接改原订单不能遗留打开的准备记录。查询不读取密钥或顾客联系密文，事件不存用户提供的备注/请求体。

准备事务按用户幂等键串行化后锁订单，与取消/超时共享订单行锁。库存释放内核同事务关闭准备、追加关闭事件再取消订单；准备关闭失败时库存计数/两级流水/订单/事件一并回滚。历史无准备记录的订单仍按原逻辑释放。没有更改订单NOT_STARTED约束，PREPARED不能进入渠道处理中或履约；未来真实支付接入必须另行迁移和实现渠道事实核验。


## 2026-11-01 接入检查读取模型

本轮无迁移或配置写表。非敏感格式状态在应用配置阶段计算，只保留状态/固定说明；不将原AppID、商户号、通知地址或凭据存入接入报告。经营项在授权仓库的RepeatableRead事务内读取checkout_policies和service_areas/有效楼栋；仅说明配置存在或暂停，不改变订单、支付准备、库存、事件或业务规则。权限沿用每请求员工角色与StaffWarehouse授权，不新增默认跨仓库权限。


## 2026-11-01 通知合成验证边界

本轮没有数据库迁移、通知收件箱或支付成功写入。管理员运行仅在授权仓库核验后，用服务端内存生成的RSA/AES材料调用纯函数，返回固定用例结果；不保存密钥、原文、明文、结果或payer信息，不修改订单、支付准备、库存、流水、事件。重复通知的持久化唯一性与业务状态迁移尚未实现，密码学检查通过不能触发付款确认或履约。

## 2026-11-01 合成通知独立记录表

新增迁移202611010003_notification_lab_records，无既有行变更。notification_lab_records保存id、warehouse_id、notification_id、out_trade_no、transaction_id、整数分amount_cents、CNY、合成success_time、facts_hash和首次created_at。通知/订单/交易标识仅允许合成前缀；无真实订单/支付准备外键、付款人、报文或密钥字段。warehouse_id引用仓库，(warehouse_id,notification_id)唯一，仓库/创建时间/id索引用于稳定游标；数据库触发器拒绝UPDATE/DELETE。表用于隔离基础，不是正式通知收件箱或已支付账本。

服务先验证签名与解密，再在事务内检查仓库、按仓库+通知标识取事务锁、查已有事实摘要。相同事实返回原记录；冲突拒绝覆盖。首次写入及NOTIFICATION_LAB_RECORDED业务审计原子提交，审计失败整体回滚。签名/密文及接收时间不参与事实判等；当前合成生产器按操作键生成稳定事实，重启后依赖PostgreSQL而非内存去重。重复尝试次数、冲突尝试和处理状态不在本轮持久化。

部署需停旧API/Worker写入，应用迁移，生成客户端并构建后启动新版；只增表，可保留表退回旧版应用，不能删除记录或清库回退。本机开发/测试库已应用，其他环境需自行按部署门禁执行。

## 2026-11-01 关闭前重读与支付证据判定

本轮无迁移。releaseUnpaidOrder在事务内按订单ID FOR UPDATE重读id/user_id/warehouse_id/status/payment_state，校验调用者身份/仓库/支付快照，再基于真实行判断。已取消返回，只有AWAITING_PAYMENT+NOT_STARTED才允许本地释放；现有余额/分配/支付准备关闭/流水与事件仍在同一事务，数据库约束未放宽。旧快照并发调用在锁后看到已取消，不再重复释放或因旧快照二次过账。

新增纯paymentCloseDecision及mergePaymentEvidence。NONE/UNKNOWN/CLOSED/SUCCEEDED/CONFLICT为隔离证据输入；合并满足幂等、交换、结合，成功与关闭冲突粘滞，未知不降级已知结果。只有未发起且无证据返回releaseAllowed=true。其余返回查单、请求关闭、事务核对或人工核查预案；没有实现这些动作。本轮证据不持久化，未来适配器必须按同一支付尝试在数据库锁内合并证据，持久化支付已发起状态后才可调用渠道，不能将纯函数返回值直接当作入账或释放许可。现有真实支付禁用，订单仍无PAID/PENDING状态。

## 2026-11-01 合成尝试与证据事件链

新增202611010004_payment_attempt_labs迁移。payment_attempt_labs保存id、warehouse_id、创建key、evidence、version、created_at，(warehouse_id,key)唯一且有仓库/时间/id游标索引。payment_attempt_lab_events保存attempt_id、操作key、业务action、observation、合并后evidence、version、created_at，(attempt_id,key)/(attempt_id,version)唯一。独立合成表与真实订单/支付准备没有关联，无金额、顾客、凭据或报文字段。

创建以仓库/键事务锁保证一次STARTED；后续按尝试行FOR UPDATE串行合并。首次写入和每个新操作的业务审计同事务，重复操作不追加事件或审计。STARTED为版本0且key等于创建键；每个新结果版本加1，上限100。数据库触发器拒绝变更身份/创建时间、删除尝试、修改或删除事件；延迟约束验证完整连续事件链、观察与动作映射、合并规则及最终汇总一致。SQL合并函数与共享纯函数全25对证据组合对比通过，成功/关闭冲突不可被未知结果洗掉。

本轮仅持久化隔离证据及预案，未接收真实渠道结果，未实现自动查单任务/租约/重试调度或支付入账。部署需停旧API/Worker写入、迁移、生成客户端并构建后启动新版；只增表，无已有数据回填。本机开发/测试库已应用；其他环境仍需按门禁部署，可保留新表退回旧应用，禁止删除事实或清库回退。

## 2026-11-01 查询任务、租约与补偿历史

新增202611010005_payment_query_labs迁移：payment_query_lab_jobs每个合成attempt_id唯一，复合外键(attempt_id,warehouse_id)固定同仓；state、attempts(0..3)、next_run_at、lease_token/lease_until、version及created_at。RETRY/LEASED/DONE/EXHAUSTED字段约束租约组合。payment_query_lab_events保存不可变任务历史、操作键、原因、状态、领取次数、版本及可空attempt_event_id，(job_id,key)/(job_id,version)唯一，关联的证据事件必须属于同一尝试。延迟约束要求任务汇总与完整版本历史一致，触发器拒绝无历史更新、身份变更、任务删除及历史修改/删除。

保存UNKNOWN观察与安排任务在同事务。迁移事务为旧UNKNOWN合成记录回填唯一RETRY任务及SCHEDULED历史，已知结果不回填。领取使用数据库时间、FOR UPDATE SKIP LOCKED，设置新随机租约令牌且增加领取次数；仅当前未过期令牌可完成。完成按仓库共享锁→尝试锁→任务锁重读，再原子提交UNKNOWN证据事件及任务历史/重试安排，晚期失败整体回滚。领取只锁任务且先提交，不持有任务锁等待尝试；与API保持锁序，避免互相等待。

普通未知结果最多3次领取，1秒/5秒退避后耗尽；第3次过期租约也耗尽，不无限回收。已知/冲突结果或100证据上限停止查询，旧Worker不能降级或重复提交。耗尽后负责人可原键幂等重新安排，保留旧历史，重置本轮次数0。没有自动退款/释放/入账，不将任务表作为交易账本。

本机两库已应用；其他环境需停旧API/Worker、迁移、生成客户端并构建后再启动。新增表保留即可退回旧应用；若其他环境已有UNKNOWN，迁移会补任务但默认关闭的自动Worker不执行。不得清库或删除历史回退。

## 2026-11-01 合成核查不可变备注

新增202611010006_payment_review_labs，只增加payment_review_lab_notes及约束/索引/触发器，无既有行回填。保存attempt_id/warehouse_id复合外键、actor_id员工外键、actor_name姓名快照、操作key、note(500)、evidence、attempt_version、可空task_state/job_version和created_at。同尝试/员工/键唯一，尝试/时间/id索引用于历史分页；任务状态及任务版本须同时为空或非空。

服务锁序仓库共享锁→尝试更新锁→任务共享锁；插入触发器再核对当前证据和版本快照，拒绝伪造快照。备注不可UPDATE/DELETE。首次备注与业务审计同事务，晚期失败回滚，审计只记noteId及合成标识，不复制自由文本。既有备注随后不受新证据变化影响，作为当时快照保留。无真实订单/资金状态关联或写入。

历史回填测试原先排除“最后一个”任务迁移，本轮新增更晚迁移后修正为只执行任务迁移之前的历史，避免新备注表提前引用尚不存在的复合约束；该历史场景已单独重验通过。部署停旧API/Worker、迁移、生成客户端/构建后重启；本机两库已应用，其他环境另行执行，可保留表退回旧应用，不清库或删除备注回退。

## 2026-11-01 查询适配器契约兼容性

本轮无模型、约束或迁移变化，不写订单、库存流水、支付准备、合成尝试、查询任务、备注或业务审计。契约只在内存生成分类/证据/后续建议，后台运行结果不保存。PaymentQueryLabJob及其不可变事件仍使用既有固定UNKNOWN算法；不得把新RETRY/REVIEW建议宣称为已持久化的任务状态，也不能将合成SUCCEEDED/CLOSED写入真实订单。后续需要单独设计分类事件的不可变记录、租约校验和回滚测试。无迁移回填或数据兼容影响。

## 2026-11-01 查询分类事件迁移

新增迁移202611010007_payment_query_classifications：PaymentQueryLabEvent增加可空classification(VARCHAR32)、resultEvidence(VARCHAR16)、next(VARCHAR16)、scenario(VARCHAR32)；任务/事件及备注快照允许REVIEW，新增REVIEW_REQUIRED和CLASSIFIED_KNOWN原因。历史四字段保持null。

SQL检查分类/证据/建议/任务状态的允许组合和固定场景白名单，要求分类结果关联同一尝试的不可变证据事件；插入触发器核对结果与关联observation、完成原因及已知冲突必须REVIEW。保留原事件不可变、版本链、摘要一致性及禁止事实删除约束。任务领取只扫描RETRY和过期LEASED，REVIEW不会被自动重领。

运行固定合成查询在事务外进行；完成按仓库共享锁→尝试更新锁→任务更新锁，重读数据库时钟并检查当前令牌、任务归属及有效期。分类、尝试版本/事件和任务版本/事件同事务；晚期插入失败全部回滚，仍有效的原租约可重试一次完成。已知相反证据合并CONFLICT而不是丢弃；未知结果不降级已知证据。

部署需先停旧API/Worker，再应用迁移和启动新构建；新触发器要求新完成事件携带分类，旧Worker不宜与迁移后结构混跑。迁移只扩展实验表，不改真实订单约束或经营配置；回退旧应用需要另行兼容迁移，不删除新历史。两库本机迁移已应用。

补充边界：REVIEW任务后来追加合成成功证据，也保留在“全部待核查”列表且needsReview=true，不能通过证据按钮清除核查要求；已补对应断言及原筛选回归。

## 2026-11-01 通知绑定与应用事实迁移

迁移202611010008_payment_notification_links新增PaymentNotificationLabBinding（attemptId主键、复合仓库FK、固定测试身份/2499分/CNY、仓库商户单号唯一）及PaymentNotificationLabApplication（每尝试唯一、仓库交易号唯一、不可变关联成功事件）。NotificationLabRecord新增可空applicationId及关联历史索引；不更新旧记录、不回填绑定。

两张新表禁止更新/删除。应用插入触发器核对尝试/成功observation/action及事件幂等键；通知插入触发器核对仓库、交易号、成功时间、商户单号、金额和币种与绑定/应用一致。延迟触发器要求应用在提交前确有通知记录，孤立应用整笔回滚。既有不可变通知及尝试版本链继续校验。

按仓库共享锁→尝试更新锁→通知标识与交易号事务锁→查询任务锁处理。服务器强制使用不可变绑定作为密码学验证的expected，不能信任来料expected自声明。通知记录、唯一应用、尝试证据、任务变更和审计同事务；审计保存合成标识、关联ID和是否首次生效，不复制报文。新通知标识共享既有应用，不新增成功事件。

查询历史原因扩展NOTIFICATION_EVIDENCE，无查询分类字段；结算清除租约令牌，DONE或REVIEW，保留已有REVIEW。旧令牌完成被拒绝。无真实订单/库存/资金表变化。两库已应用本机迁移，需停旧服务后升级；回退旧应用应处理新响应/关联事实，不删除历史。

## 2026-11-01 统一证据只读投影

本轮无模型或迁移变化。API持有仓库、尝试及任务共享锁，按既有写入锁序读取；UNION ALL只选择四来源的id、类型、固定排序权重和createdAt，先在数据库按createdAt/source-rank/id降序取21个键，再按最多20个键显式选择允许展示的字段和关联。候选通过attemptId/warehouseId及既有索引过滤，不在内存全量加载备注或通知。

cursor/focus重新从同范围来源查询锚点；同刻权重NOTE4、NOTIFICATION3、QUERY2、ATTEMPT1，UUID继续降序，跨表相同UUID用来源区分。来源过滤与排序、定位均在数据库执行。备注引用按attemptVersion/jobVersion匹配不可变事件，不使用当前最新版本替换旧快照；同交易通知分别显示并共享唯一成功证据链接。

单请求按现有API写入锁序与版本约束读取一致事实，页间不持有事务、不宣称冻结快照。API只读，不追加审计、备注、事件或任务，不改变订单/库存/资金；未使用Redis缓存。历史无通知绑定、无任务或无备注时不补造关系。


## 2026-11-01 核查跨页入口与返回定位

无模型、迁移或回填变化。跨页目标引用已有仓库/尝试/通知/事件主键；不新增数据库关联。客户端内存缓存按仓库与尝试隔离保存草稿、未确认请求键和原版本，工作空间按账号、会话及授权范围重建，不将缓存作为权限或事实来源。所有读取与备注写入仍由既有事务/范围/版本/幂等及审计约束处理。


## 2026-11-01 合成核查只读概览

无模型、迁移或回填变化。只读统计沿用payment_attempt_labs.warehouse_id索引与payment_query_lab_jobs.attempt_id唯一约束，一条聚合语句按尝试计数，不关联不可变事件/备注明细。所有分类使用同一MVCC语句快照；generatedAt来自statement_timestamp，不将读取作为业务事件或创建统计缓存真相。复用既有仓库启用锁与归属权限校验，不锁定/更改支付尝试或任务。不新增资金、库存、订单状态。


## 2026-11-01 S6拣货准备只读核验

本轮无迁移、新表、回填或库存写入。复用consumer_orders/order_items/order_allocations与stock_positions/stock_lots/stock_balances/warehouse_locations做最小只读投影，未修改订单状态约束、付款证据、预占流水或资金模型。

列表和详情分别使用REPEATABLE READ；详情在同一事务核对订单/原分配/未释放数量及当时库存条件，避免并发取消时拼接出“取消但仍有旧预占”的跨时刻响应。checkedAt为事务内数据库读取时刻，不承诺刷新后仍成立。按本单同SKU/批次汇总核查当前预占承载量，不将其他订单预占当成本单新分配，不修改库存或建立新的预占真相。当前正式订单仍不能转为已付/可领取状态。

新picking.read为代码内角色权限，无数据库角色种子更新；API每请求重新核对角色与范围，前端重新进入会读取新权限。未来任务持久化、领取竞争、行核对及幂等出库需要独立模型和增量迁移，本轮没有冒充实现。


## 2026-11-01 拣货领取与逐行核对隔离演练

新增迁移202611010009_picking_labs：picking_lab_tasks与picking_lab_events，已应用本机yumi_dev/yumi_test。仅FK仓库/员工及演练任务；不关联正式订单、SKU、批次、库位、库存流水或资金。FIXED_V1不可变模板定义在API，数据库限制fixture固定值及两种checked_lines；不回填历史或建立真实预占。

任务唯一(warehouse_id,creator_id,key)；事件唯一(task_id,actor_id,key)及(task_id,version)。READY版本0无领取人/无核对行；PICKING版本1/2为唯一人员领取后0/1行；CHECKED版本3为2个不同合法行。无删除/重开/重派。事件记录动作、原期望版本、精确行数量、状态/人员/已核对行及操作者姓名快照，更新/删除拒绝。

更新触发器约束身份不变、版本逐次递增、领取人不变、每次仅加一条核对；延迟一致性触发器核对完整连续历史、创建者/创建键、领取/核对人员、行数量及最终状态。核对数量/行/expected_version须显式非NULL。缺事件、篡改历史、抢占或无审计事务失败不落地；业务审计与写入在同一事务，已测晚失败回滚。

原正式订单付款/履约约束与库存表未改。部署新代码前需应用迁移并生成Prisma Client；旧应用不访问新表，兼容保留旧行为。不提供删除演练事实的回退脚本；代码回退或关闭开关不删除历史。


## 2026-11-01 合成缺货上报与未决阻断

新增迁移202611010010_picking_shortages：picking_lab_tasks及picking_lab_events增加exception_version默认0，新增picking_lab_shortages与picking_lab_shortage_events；已应用本机开发/测试库，Prisma Client已生成。旧历史只补默认0，不伪造缺货记录，不改正式订单/库存/资金模型。

任务同一行锁串行化REPORT/RESTORE/CHECK。缺货记录FK独立演练任务/员工，固定合成明细/数量/原因，OPEN版本0→RESOLVED版本1且必须有处理人/时间；同任务同明细最多一条OPEN（部分唯一索引）。缺货事件唯一(task_id,actor_id,key)、(task_id,revision)及(shortage_id,action)，REPORT/RESTORE不可修改/删除；记录身份不变、仅首次处理，不删除事实。

exception_version独立于原任务version，每次新缺货事件递增。任务更新触发器允许只递增缺货版本而不改原进度，OPEN时拒绝核对推进；延迟触发器检查连续缺货事件数/版本、上报与处理记录一致、领取人归属、未核对明细和当前阻断状态。原领取/核对事件插入前必须匹配当前缺货版本，防止处理后用旧快照写入。应用审计晚失败会回滚记录/事件/任务版本，已实测。

每任务最多100条缺货事件/50次上报；新上报为当前OPEN和新记录预留对应RESTORE事件空间，数据库也要求exception_version+未决数≤100，避免达到上限后无法解除已有记录。保持旧无缺货流程兼容；有新缺货事实后旧写入快照会拒绝，不能回退到不识别缺货的写服务继续作业。回退需关闭演练写入，保留所有事实，不提供删表/删历史脚本。

## 2026-11-01 合成打包与出库凭据

迁移202611010011_picking_dispatch新增picking_lab_packs及picking_lab_dispatches，已应用本机yumi_dev/yumi_test，Prisma Client已生成。仅关联原合成任务/员工/打包；正式订单、库存、资金、预占表不改，不回填旧任务的打包或出库事实。旧任务保留CHECKED状态及原version，阶段由新增只读关系投影。

打包task_id唯一，保存领取人姓名、原键、任务/缺货版本、精确两行数量及包裹数。出库task_id、pack_id均唯一，复合FK(pack_id,task_id)确保引用同任务打包，复合唯一索引与Prisma一对一关系一致。BEFORE INSERT触发器锁任务并校验CHECKED/版本/两合法明细/无OPEN；打包人必须领取人，出库引用的打包版本须匹配。CHECK约束任务版本3、缺货版本0–100、两行数量2/1和包裹数1–20；两表禁止更新/删除。

应用与数据库均以任务锁防竞争，两份凭据各自与业务审计同事务；晚审计失败不留下孤立凭据。每任务最多一份，原键幂等比较保存的完整请求内容；不同人员不能恢复他人原键。需先迁移再部署读取新关系的服务；回退关闭演练写入并保留事实，不提供删表或历史清除脚本，不可让旧写服务绕过新阶段继续作业。

## 2026-11-02 合成配送分配事实

迁移202611020001_delivery_assignments新增delivery_lab_assignments，已应用本机yumi_dev/yumi_test，Prisma Client已生成。dispatch_id唯一FK合成出库，骑手/分配人FK员工，保存姓名快照、原键与时间；按rider_id建索引。通过dispatch→pack→task推导仓库，不增加独立可漂移仓库字段，无真实订单、库存或配送表写入，不回填旧记录。

BEFORE INSERT触发器锁对应合成任务，检查已核对且无未决缺货；要求目标骑手账号启用、RIDER角色及同仓范围。staff、staff_roles和staff_warehouses资格记录加共享锁，撤权/停用与分配提交串行化；应用也执行同样资格检查以返回可读409。每份合成出库最多一条，UPDATE/DELETE由不可变事实触发器拒绝。

应用分配与业务审计同事务，晚失败不留孤立事实；用已保存actor_id/key/rider_id判断精确原请求重放，不覆盖、不改派。读取时重算资格，撤权不会清除历史，骑手查询在服务端附加本人条件，详情和分页锚点不能越权。

需先迁移/生成客户端再部署新服务；旧任务/打包/出库/正式订单模型与状态不变，旧代码忽略新增关系。回退须关闭演练写入、保留分配事实；不提供删表/删历史回退，不允许忽略分配凭据的旧写服务继续交接。

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

新增迁移 `202611020014_redemption_picking_work`：redemption_allocations增加(id,order_id)唯一来源；redemption_picking_work通过(task_id,order_id)与(allocation_id,order_id)复合外键绑定同单，包含任务版本、CHECK/SHORTAGE/DAMAGE/RESOLVE/COMPLETE、完整/异常件数、原issue_id、员工、请求和时间。issue_id唯一自关联保证一次处置，(task_id,version)唯一；事实禁止UPDATE/DELETE。

任务CLAIMED允许在原owner/claimed_at不变下逐次递增版本，完整完成变CHECKED，CHECKED终态本轮不允许重新打开。BEFORE触发器校验当前版本/状态、原分配件数、员工角色/仓库和归属、前序事实连续、未决原异常、全项最新CHECK；延迟约束保证每次任务版本匹配不可变事实。旧CREATED/CLAIMED/CANCELED凭据与Outbox配平保护保留并兼容CHECKED。

沿用本仓授权/仓库共享锁→商品及库存锁→订单→Outbox→任务，所有动作、版本、事实、业务审计、幂等结果同事务；报告异常不锁外部系统、不移动积分/任何层实物账。核对/处置/完成在审计后以真实时钟再次核验效期和预占。迁移仅在随机临时schema重放，未应用业务主库。先迁移后部署匹配API、Worker及双端；有CHECKED或work事实后不得盲退P4a（不识别CHECKED且旧状态约束不兼容）。停止写开关并保留兼容读取及取消保护，不删除事实、不通过回退自动退分释放。


## 2026-11-02 P4c原预占打包与真实幂等出库

领取人逐项原批次/库位完整装包、本仓负责人/仓管核验实物出库已实现，本地验证见[P4c记录](../verification/P4C-REDEMPTION-PACKING-2026-11-02.md)。打包只写不可变凭据；出库同事务写唯一出库凭据、每项原预占消费指针、库位/批次/仓库on_hand与reserved等量扣减及主/位置流水、审计和幂等结果。冻结、盘点、失效来源、停用库位、过期、数量/完整性不符均阻断，晚失败全部回滚。出库不再扣积分、不退积分、不释放累计限兑/总配额；兑换单仍ACTIVE，履约由真实事实展示PACKED_WAIT_SHIP或SHIPPED_WAIT_HANDOFF。消费者不能直接取消已开始履约的单。仍为本机默认关闭的开发能力，未操作业务主库或生产，未接骑手配送、售后或协调取消；P4/P5未整体验收。下一项P4d真实兑换骑手分配与接货，后续继续配送、异常、售后及经营上线门禁。领取人停用接续/重派、已领取消及打包后异常恢复仍是上线前必需能力。

新增迁移202611020015_redemption_packing，仅随机临时schema重放。redemption_allocations新增consume_ledger_id，唯一且通过(id,warehouse,sku,lot)外键关联stock_ledger；release和consume互斥、原分配快照不可变，仅允许未结算→一次释放或消费，终态不可覆盖/清空。现金order_allocations沿用原触发器，不受本次替换影响。

redemption_packs（task/order唯一、完成拣货版本、包裹数、员工/请求/时间），redemption_pack_lines（同单分配复合来源、每分配唯一及原数量），redemption_shipments（task/order/pack唯一、完成拣货版本、员工/请求/时间），全部不可变。pack/task/order及packline/allocation/order、shipment/pack/task/order复合外键阻止错单错仓；SQL检查当前CHECKED及完成事实、全项最新CHECK和精确装包数量、领取人/当前本仓角色，不能仅插一张空打包或出库事实。

出库每个原allocation产生唯一REDEMPTION_SHIP:<allocationId>员工主流水，delta_on_hand=delta_reserved=-quantity、delta_blocked=0；恰一条同原库位位置流水，数量/员工/请求须与出库事实一致。延迟约束要求出库对应全部原分配消费且未释放；消费必须有出库事实，带该动作前缀的孤立流水也拒绝。各层库存与主/位置流水原有配平约束继续执行。

锁序保持授权/仓库→商品→库存→兑换单→Outbox→任务；阶段由订单和任务锁串行，原拣货版本不改变，打包/出库唯一事实分别推进阶段。出库、指针、各层计数/流水、审计、幂等结果同事务；审计后重查授权和真实时钟效期，晚失败全回滚。原单ACTIVE及配额、扣积分事实保留，不误作现金销售/退款或取消释放。出库后的历史读取只对未消费分配要求预占，仍可显示当前源资格告警。

须迁移后部署匹配API/Worker/双端。存在消费事实后不得盲退旧SDK/API：旧读取不认识消费指针，会把已出库误读为预占中/待打包；旧SQL更新模型也不兼容新增消费列。关闭作业/Worker写入并保留兼容查询及取消保护，不删除库存事实、不通过回滚把消费改成取消释放。业务主库、生产及现有.env未修改。


## 2026-11-03 P4d真实兑换骑手分配与本人接货

已出库的真实兑换单接入本仓负责人/仓管分配、被分配骑手精确核对包裹及原装包逐项件数后接货，本地验证见[P4d记录](../verification/P4D-REDEMPTION-DELIVERY-2026-11-03.md)。分配/接货为独立不可变事实，引用原shipment/pack/allocation；不再变库存、积分或配额，不接合成演练。骑手只读本人分配单；列表不返回顾客地址，授权详情才解密原订单地址，403/404等失权或范围变化清空旧详情。原分配人及骑手当前角色/仓库资格、货品效期和原出库完整性变化会阻断新交接；这些为保守开发校验，不等同于经营应急规则已确认。消费者与仓库页同步分配/已接货状态，明确尚未开始配送。沿用本机REDEMPTION_PICKING_DEV_ENABLED默认0及生产/远程拒启，业务主库、现有.env和生产未改，未进行真实人员实物交接。下一项P4e真实配送开始与送达；改派/撤权接续、异常处置、协调取消、售后与P5仍待交付，商城未上线。

新增迁移202611030001_redemption_delivery，仅随机临时schema重放：redemption_shipments新增(id,order_id)唯一来源；redemption_assignments按shipment/order唯一，冻结分配人/骑手id及名称、请求和时间；redemption_handoffs按assignment/shipment/order唯一，记录本人、包裹数/请求/时间；redemption_handoff_lines绑定同单原allocation及原数量。shipment/order、assignment/shipment/order、handoff/order和allocation/order复合外键阻止错单错出库。分配、接货及逐项凭据禁止UPDATE/DELETE，不覆盖原打包或出库数据。

SQL校验当前ACTIVE的原出库、CHECKED原拣货完成事实、本仓有效管理分配人及RIDER本人；接货人必须等于assignment.rider_id。延迟约束要求包裹数及所有原pack_lines与handoff_lines双向一一匹配，不允许空接货、漏项、额外项或不完整数量。应用复用原出库/消费配平证明与保守资格校验，原库存/积分事实不变。

事务先锁当前会话/角色/本仓授权、分配人和骑手当前资格，再按共享商品/库存→兑换单→拣货任务→shipment顺序锁定重读；分配/接货事实、审计和幂等结果同事务。角色和人员共享锁保证撤权串行；末尾按真实时钟再次核验会话/批次，慢审计造成过期同样回滚。已完成的历史交接不因日后人员停用而改删，后续处置/改派另交付。

无新环境变量、无依赖升级；沿用本机作业写开关默认关闭、生产/远程拒启。先迁移后部署匹配API/Worker和三端，旧客户端不识别新表/履约枚举，不能盲退导致已接货误显示等待接货。停写并保留兼容查询和取消保护，不删凭据、不再次扣库存或通过退分清空交接。业务主库/生产/现有.env未修改。


## 2026-11-03 P4e兑换配送阶段事实

新增迁移`202611030002_redemption_journey`，仅随机临时schema重放。`redemption_journey_facts`：id、handoff_id/order_id、kind START/COMPLETE、start_id、actor_id、request_id、created_at（PG clock_timestamp）。同handoff/kind唯一，全部禁止UPDATE/DELETE。handoff/order复合外键绑定原接货；start/handoff/order复合自外键禁止借用其他订单或其他交接的开始凭据。START必须start_id为空，COMPLETE必须非空且引用同接货的START，来源触发器还检查原骑手一致、当前启用RIDER/仓库授权、原管理分配人资格及ACTIVE/CHECKED原出库。SQL锁原接货，唯一约束裁决并发，只追加真实阶段事实。

应用锁序沿用当前会话/角色/本仓授权及骑手/分配人资格共享锁→商品→库存→兑换单→拣货任务→shipment，锁后重读原出库/接货/阶段；阶段事实、审计、幂等结果同事务。末尾以真实时钟复核会话和源资格，慢审计导致会话/批次到期同样回滚。阶段表不写收货人姓名/电话、照片或任意用户文案，不保存客户端声明时间，不改变库存、位置、积分、原出库消费及配额。送达为骑手声明，未新增顾客确认事实。主单仍ACTIVE、原任务仍CHECKED，最终阶段由事实派生，不因日后撤权删除历史。

保守源资格与原分配人当前资格继续阻断新动作；经营应急/撤权接续未确认也未交付。沿用本机作业写开关默认0、生产/远程拒启，无新依赖或环境变量。先迁移再部署匹配API/Worker和三端；旧版读取不含journey会把配送中/已送达误显示待开始，不能盲退。停止写入并保留兼容查询/取消保护，保留不可变事实，不通过删表或退分伪造回滚。业务主库、现有.env和生产未改。详见[P4e验证](../verification/P4E-REDEMPTION-JOURNEY-2026-11-03.md)。


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

## 2026-11-04 E4f冷备恢复验证

本轮没有schema/迁移变更。独立PG17.11全迁移和合成交易经停库完整文件备份恢复到另一个新目录；110张表逐行排序内容摘要和行数一致，包含积分、库存/批次/库位、预占消费释放、运单历史归属、反馈和原键。恢复原键后除认证会话活动时间外全部业务行内容不变。错误密钥读取拒绝，单独内存合成密钥副本可恢复原文；不代表外部密钥托管或生产备份通过。操作和限制见[本地恢复说明](../operations/POINTS-EXPRESS-LOCAL-RECOVERY.md)，[记录](../verification/E4F-LOCAL-EXPRESS-RECOVERY-2026-11-04.md)。


## 2026-11-05 E5售后申请、隔离保管与退积分

新增202611050001_redemption_returns及202611050002_return_receipt_fields，不改写已应用迁移。redemption_returns固定原订单/原用户、正整数件数、加密原因、请求和时间；redemption_return_events追加APPROVE/REJECT/CANCEL/RECEIVE/REFUND、员工、退货要求、实际件数/状况/隔离位置、加密说明、唯一积分流水、请求及实际时钟。主申请和事件均禁止UPDATE/DELETE，(return_id,kind)唯一。状态从事实派生，没有可随意修改的退款状态或积分额字段。

SQL锁原订单，检查本人ACTIVE/EXPRESS已发货来源；未被REJECT/CANCEL的申请件数总和不得超过原单。APPROVE/REJECT/CANCEL互斥；验收/退款先批准，须退货时完整验收后才能退款；验收件数等于本申请件数。事件外键绑定唯一原申请；员工须当前启用SUPER_ADMIN及本仓范围。补充约束显式要求RECEIVE的quantity/condition/location非NULL且合法，不能依赖SQL CHECK的UNKNOWN通过行为；拒绝空/部分验收或空隔离位置。

REFUND对应唯一points_ledger，action_key=RETURN_REFUND:<申请ID>、user_id为原用户、delta=原points_price×申请quantity、actor为同一负责人；流水也受延迟约束，孤立前缀正向流水无法提交。沿用原账户/流水配平；不修改原扣分和消费流水、原库存/预占/订单/运单/累计限兑，不发放新预算或恢复总配额。原正向员工流水来源约束保持，底层redemption_id/action为NULL，由退款事件关联申请和原单；查询投影原兑换单与AFTER_SALES_RETURN种类，不误作取消。

应用统一先锁原积分账户→原订单，再追加请求/决定/验收/原额退款；申请间和所有阶段竞争串行。退款同事务更新原账户余额/版本、正向流水、不可变事实、审计和幂等结果；失败全部回滚。余额技术保护上限10^15，quantity与points_price沿用原单范围。决定/退款后当前角色/仓库共享锁与真实时钟会话再验，消费者申请插入后也复查会话，不能用前置授权绕过处理中失效。

RECEIVE是独立退货隔离保管台账，记录整项实物及位置，不冒充正常收货或可售库位库存：货品须隔离，运营查看此台账核对保管实物；之后质量判定、再入库或销毁须另有明确动作/授权，不根据退款回填旧allocation或自动销售。退货包裹状况不确定原批次时，也不得伪造原库位库存。

本轮在已备份的本地yumi_dev应用两项新增迁移，共58个；迁移前原110张表原有列内容全部校验一致。无实际顾客退款或真实实物入库。新增6类18个演示SKU通过CatalogService创建并真实收货记账，不重置旧库存，重跑全库存摘要一致。无新增依赖/实际.env改动，无生产部署。必须先迁移再部署匹配API/三端；新积分查询需要售后表，旧版将退款误显示普通调整，不能盲退或删表清事实；停写保留兼容查询与历史。

## 2026-11-05 多商品积分结算兼容说明

本轮没有数据库迁移（仍58项）。购物车是按 API 环境及账号隔离的本机草稿，保存 rewardId/整数件数，未登录草稿仅主动导入，不持有可信价格/余额/库存。订单确认原请求及结果也保存在本机，清理已购买件数和消费标记使用一次本机存储写入，防止恢复时再次扣减草稿；直接兑换不清理购物车。

复用 `redemption_quotes` 的不可变逐商品快照与120秒效期、`redemption_orders` 逐商品订单及全部原 PostgreSQL 约束。整次请求的原报价ID数组与完整订单ID数组存于 `idempotency_records`，与所有子订单、积分账本、预占/分配、事件和 outbox 同事务提交，不引入第二套余额或库存真相。批量先锁本人积分账户，再按排序锁全量商品、地址/政策、全量SKU元数据及库存，再调用原创建事务逻辑；服务最终统一复查效期。非本人、重复商品/规格和不一致地址禁止组装兑换。

一次购物车确认是原子结算批次，不是新的合并履约实体，商品订单继续独立发货、取消及售后；原始扣分、取消退款、退货退款及配额语义不变。未来现金/混合支付如需引入新的结算实体与状态机，应单独设计迁移与对账，不能把现有积分记录当作现金支付凭据。

## 2026-11-05 取消兑换配额（第59项迁移）

`202611050003_remove_redemption_quotas` 仅删除 `redemption_quota_check`、`reward_quota_check` 及其专用函数 `verify_redemption_quota()`。历史 reward_products 的 per_user_limit/total_quota 列及数值保留，现有数据无变更；原字段形状检查继续兼容旧客户端，但不限制有效订单累计数量。订单、积分账本、库存预占/分配、outbox、审计、售后的一致性和幂等约束保持。

本地开发库先生成可读pg_dump备份及全表摘要，应用后112张原有业务表行数与逐行摘要一致。已有订单、报价、地址和余额无重写。取消后不能直接恢复旧配额触发器：新订单可能已合法超过历史配额，回退需先专门核验并确定新限额，禁止通过删除订单或修改账本来适配旧规则。

## 2026-11-05 微信真实接入准备

本轮没有迁移，仍59项。WECHAT身份与开发身份继续分离，真实用户首次登录零积分、不迁移开发账户或订单；新检查CLI不连接数据库。测试使用随机临时schema及合成上游，本地业务库只读汇总验证，不生成真实微信用户。构建清单新增公开wechatAppId用于一致性核验，旧清单须重编译，与数据库和会话令牌无关。


## 2026-11-05 售后待办与事实核对

无数据库模型或迁移变更，仍59项迁移。首发检查在同一个RepeatableRead只读快照中按原订单warehouse_id统计redemption_returns及其不可变事件，和售后列表共用状态过滤条件；不新增可漂移的状态投影。新增差异统计逐申请核对来源用户/有效已发货快递单、审核/驳回/撤销互斥、需退货的完整隔离验收、事件先后、有效申请总件数及REFUND与RETURN_REFUND动作键积分流水的对应关系、用户、操作人和原价金额；一申请多种差异仍只计一次。该核对不是全量积分账户或仓库账实审计，也不覆盖无法归属本仓的孤立外部记录。统计不读取加密正文，无修复或写入副作用，失败不显示旧统计为零差异。


## 2026-11-05 积分账号购物车模型

迁移 `202611050004_reward_carts` 新增reward_carts（user_id外键主键、version、items JSONB数组）与reward_cart_audits（每账号/版本唯一、REPLACE/MERGE/CHECKOUT动作、request_id、时间），审计不可修改或删除。Prisma模型RewardCart/RewardCartAudit同步；不复用原现金SKU购物车表，JSON引用无商品外键以便保留失效项供用户移除，不保存客户端商品名、价格、地址或凭据。API严格校验UUID、去重、件数、容量；数据库限制数组类型和最多20项。

写操作先核验并锁定本人有效会话/账号，创建或锁定本人购物车行，以版本防止跨设备丢更新。通用idempotency_records按用户REWARD_CART作用域保存请求摘要和结果，重放先核对摘要、事务末再次核验会话真实有效期；版本、购物车、审计与幂等记录一起提交。客户端原请求按API/账号隔离存储；游客导入有单一原账号绑定的未决记录，本机扣减与完成标记一次写入防止重复清理。

购物车下单沿用原积分交易锁序，成功前在原订单事务中锁购物车并减去已购数量，版本/审计同事务；失败回滚订单、积分、库存预占、购物车和请求记录。直接兑换默认不扣减，旧请求兼容。迁移仅新增空表，不自动把设备草稿写进数据库；本地开发库备份后迁移至60项，112张原业务表数据摘要一致，新增账号购物车为空。真实/生产库未操作。


## 2026-11-05 不可变快递收货事实

迁移 `202611050005_express_receipts` 新增redemption_express_receipts：shipment_id外键主键确保每份快递发货仅一份确认，user_id外键、request_id和confirmed_at；Prisma模型RedemptionExpressReceipt及原发货/消费者反向关系同步。不可变触发器拒绝改删，来源触发器校验本人启用用户、ACTIVE快递单、已发货Outbox和确认不早于发货时间。记录自身保存消费者及请求审计来源，不伪造员工businessAudit操作者。

服务端先在事务内核验/锁定会话和用户，再按本人订单锁串行化重复确认；原订单与发货事实只读，操作门禁保持。通用幂等记录按用户/订单收货作用域记录原请求及结果；事务末以真实时钟复核会话有效期，事实及幂等结果一起提交或回滚。确认不触碰积分、库存、订单版本/主状态，不影响后续按件售后。

历史发货不回填确认时间。开发库私有备份后应用第61项迁移，114张原业务表完整行摘要和数量一致，新收货表为空；无真实收货确认、退款或生产变更。临时schema测试覆盖非法来源、不可变、防重复及晚期失败/过期回滚。


## 2026-11-06 订单搜索查询边界

无模型、迁移或历史数据变更，仍61项迁移。在已有本人订单where条件中增加对快照title/order_no的字面、不区分大小写部分匹配，Prisma参数化查询；本人、状态、履约条件与关键词共同限定查询和游标验证。未增加搜索词持久化、缓存或搜索历史表，服务端访问日志沿用路由模板，不输出查询参数。前端仅内存保留当前账号已提交条件，隐藏时清除可见文本，身份核验后恢复，同一组件换号清理；不影响订单、积分、库存、收货或售后数据。


## 2026-11-06 消费者售后进度查询

无模型、索引、迁移或历史数据修改，仍61项迁移。汇总按redemption_returns及原订单双重消费者归属读取；按既有不可变审核/取消/验收/退积分事件推导六种状态，与后台共用状态筛选条件，不新增可任意修改状态字段。读取原订单快照标题、订单号和积分价，原因密文不解密，事件只选择kind/requiresReturn。RepeatableRead事务保持游标核验与页面读取一致，事务首尾核验消费者有效身份。只读汇总不触及积分、库存或审计写入；原按件申请与退积分事实约束保持。
