# 条码精确查询与收货选品交付

日期：2026-10-31。接续条码绑定维护，交付按完整条码读取收货候选和每行明确选入。沿用现有绿白收货窗口，不加入扫码设备/摄像头、自动加数量、自动填成本或自动审核/入库。

## 实际完成与边界

后台 http://127.0.0.1:5173/ → 收货入库 → 新建收货单 → 每行“按条码查找商品”。查询展示名称、规格、单位/编码与启用状态，明确核对后“选入本行”，不会查询即替换手动选择。仅替换当前行skuId，保留批次、数量、成本及效期；如与实物不符需人工修正。回车只查询，不保存表单。

完整匹配保留前导零，不依赖商品列表当前分页；结果按id补入草稿选择器，可以继续填写未载入页的商品。停用规格和已在其他行的SKU有提示且不能选入，不自动合并数量。目录列表错误保留重试，同时不阻断已明确查询到的有效候选。未找到、网络失败、输入变化/移除行后的晚到响应不覆盖草稿；保存中/响应未知继续受原表单冻结约束。

查询代表读取时的绑定，没有条码租约或历史映射锁定。确认选择之后按SKU身份保存，条码后续清空/改绑不自动换掉草稿，使用者仍需核对名称/实物。创建收货及过账继续服务端校验仓库权限、SKU启用、效期、行唯一、数量和成本。商品草稿/下架及分类停用不改变原仓库收货语义，规格本身停用才阻止收货。

## API与数据

新增GET /api/v1/warehouse/warehouses/:warehouseId/skus/by-barcode?barcode=完整文本，需要catalog.read及receipt.write、员工会话、本仓授权且仓库启用。只接收barcode参数，trim后1–64位ASCII数字；空/缺省/无效/额外参数400，未登录401，角色或仓库403，无绑定404 BARCODE_NOT_FOUND。返回Sku及商品name，含enabled/expiryManaged，停用SKU返回200供说明但不可选入。没有采购成本、库存量或其他仓数据；销售价格不预填为成本。

优先校验仓库，再用现有barcode唯一索引findUnique精确读取，不受目录分页或公开上架/分类筛选影响。只读GET不需要CSRF/幂等键，不写业务审计/幂等、单据或库存（权限拒绝仍沿用认证审计）。本轮无DDL、新迁移、依赖或权限项，既有接口结构和收货事务保持；此前分类/条码迁移仍是运行前置。PRD、API、数据、UI说明及实际OpenAPI同步。本机API核实身份后重启加载新路由。

## 功能验证（实际运行）

- 真实PostgreSQL **45/45**：原42项加3项查询集成。覆盖认证/骑手/拣货角色拒绝、无权仓库/停用仓库、完整匹配/前导零/trim/空值/额外参数、草稿/分类停用仍可收货候选、停用SKU显示与收货拒绝、GET业务数据无变化、清空404/重新绑定后查到新SKU；查得SKU按原收货流程创建/审核/入库2件，仅该SKU库存增加，原SKU不写。
- 命令 `node --env-file=.env --import tsx tests/catalog-inbound.integration.test.ts`，输出 `.local/lookup-integration.log`；本机yumi_test隔离随机schema，应用全部迁移并运行，结束只清理该schema。开发库与现有Engine/PostgreSQL数据卷未重建。
- `scripts/ui/verify-receipt-barcode-live.cjs` 显式YUMI_LIVE_UI=1且限制本机yumi_dev/public。API创建明确标记合成商品和条码，通过真实页面查询→明确选入→创建DRAFT收货单；实际API核对SKU、数量2、单位成本29分、原目录售价719分未被误用。保存草稿不增加库存，整页库存API前后相同。未审核/过账，最后清空合成条码，保留DRAFT商品/收货单及审计，不修改原演示资料。结果 `.local/receipt-barcode-live.json` 无凭据。真实API流程未刻意制造目录分页；未载入页场景由合成UI单独验证。
- 服务端/worker、共享web-ui、后台与移动作业构建，全工作区typecheck（含小程序）、全仓ESLint、修改代码/OpenAPI的Prettier及git diff --check通过；实际OpenAPI导出成功。精确依赖未调整，既有Node24.22.0与声明24.22.1警告保持。

## UI验证（单独记录）

对照既有绿白商品/收货风格，查看桌面及手机截图；每行查询/候选/选择与原字段同组，固定保存入口保留，手机窗口可滚动，320/375/414无水平溢出。不是硬件扫码或微信真机验收。

`scripts/ui/verify-receipt-barcode.cjs` 合成响应通过：目录空页仍查到候选、回车只查询而非保存、明确选择、保留批次/7件/0.29元、未找到/网络错误/停用/重复不可选入、输入变化后旧请求返回被丢弃、移除重复行、保存payload为正确SKU及29分、保存失败草稿保留和320/375/414。原`scripts/ui/verify-receipts.cjs`回归通过，包括多行/成本/北京时间、审核/入库核验、弱网原意图重试、仓库切换保护、只读和手机布局；回归截图置/tmp/yumi-receipt-lookup-regression，不覆盖旧证据。合成故障不冒充真实API故障。

| 场景 | 截图 |
|---|---|
| 真实API桌面查询 | [桌面](UI-RECEIPT-BARCODE-LIVE-DESKTOP-2026-10-31.png) |
| 真实API手机选入 | [手机](UI-RECEIPT-BARCODE-LIVE-MOBILE-2026-10-31.png) |
| 候选与未载入页 | [桌面候选](UI-RECEIPT-BARCODE-DESKTOP-2026-10-31.png) |
| 加载 / 网络错误 / 未找到 | [加载](UI-RECEIPT-BARCODE-LOADING-2026-10-31.png)、[错误](UI-RECEIPT-BARCODE-ERROR-2026-10-31.png)、[未找到](UI-RECEIPT-BARCODE-NOT-FOUND-2026-10-31.png) |
| 停用 / 手机布局 | [停用](UI-RECEIPT-BARCODE-DISABLED-2026-10-31.png)、[布局](UI-RECEIPT-BARCODE-MOBILE-2026-10-31.png) |

## 接续与未验证

下一项商品图片管理，先交付本地可审查版本；图片/存储规范按原架构细化。硬件扫码、真实条码规范及校验位仍待核验。微信真机仍缺合法HTTPS测试API，本轮未重新运行开发者工具或实体手机，小程序仅类型检查。无生产部署、付费资源、外部账号连接或真实支付；完整S2/G1不整体验收。
