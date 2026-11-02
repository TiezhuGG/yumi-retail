# P4c 原预占完整装包与幂等出库 · 2026-11-02

分支：积分商城。状态：本地实现、隔离 PostgreSQL 和实际页面验证通过，未上线。此次在P4b已完成拣货基础上，实现领取人完整装包、本仓负责人/仓管核验实物出库，以及原预占消费与库存流水配平。不接合成拣货演练，不连接现金支付，不表示骑手已接货或配送。

## 业务边界和验收案例

- 仅当前CHECKED任务且原领取人仍具本仓有效作业权限，才能提交打包。按原预占分配逐项输入装包件数，必须完整匹配原批次/库位和数量，不能漏项、换项、重复项或部分出库。包裹数1..100、单次最多1000个分配为开发技术保护上限，不等同于已确认经营参数。
- 打包仅写不可变打包和逐项装包凭据，不扣第二次积分、不改变实物或预占。打包来源、完成拣货版本、员工、请求和时间保留。已打包不可修改或用新键再次打包。
- 出库须本仓SUPER_ADMIN/WAREHOUSE_MANAGER；普通PICKER、骑手、非授权仓员工不能出库。输入匹配本单当前打包凭据、同一完成拣货版本及physicalConfirmed:true。界面明确要求核验包裹和原预占实物，未确认前按钮禁用；服务端仍校验。未新增打包人和出库人必须不同的业务规则，若领取人兼有管理角色可执行两动作。
- 打包与出库再次核验仓库/商品/分类/规格、盘点冻结、完整预占、库位启用、批次效期及现有核对事实；不以自由可售库存代替本人预占。审计期间批次过期、会话过期或失权导致整个事务回滚。
- 出库消费原预占：每个allocation的库位、批次和仓库on_hand与reserved等量扣减，blocked不变；同事务写唯一消费指针、员工主流水和原库位位置流水、唯一出库凭据、业务审计及幂等结果。一次全量出库，不支持部分/替换批次或库位，不消费其他单的预占。
- 出库不再扣积分、不自动退款或释放累计限兑/总配额。兑换单保持ACTIVE表示仍有效的兑换交易，履约进度由不可变事实派生。已开始履约仍禁止消费者直接取消；出库后的售后另实现。
- 后台/仓库H5显示待打包、已打包待出库、已出库待骑手接货及凭据；消费者同步PACKED_WAIT_SHIP、SHIPPED_WAIT_HANDOFF，明确尚未开始配送。后台兑换订单原预占凭据显示“已出库消耗预占”，修正旧“预占中”文案。

## 数据、锁与迁移兼容

新增迁移202611020015_redemption_packing，未修改旧迁移；仅随机临时schema重放，未应用业务主库或生产。

新增redemption_packs、redemption_pack_lines、redemption_shipments及Prisma模型，所有凭据不可UPDATE/DELETE，任务/订单/打包唯一，复合来源外键绑定同单原分配。任务原state保持CHECKED及完成版本不变；阶段由唯一pack/shipment事实推进，顶层state派生PACKED/SHIPPED。CHECKED筛选仅包括尚未打包者，不把所有已出库任务误算待打包。

redemption_allocations新增唯一consume_ledger_id，复合外键指向同仓/SKU/批次主流水；release和consume互斥，只有第一次释放或消费可改变原分配，消费后不可清空、覆盖或再次释放。现金order_allocations的原触发器未更改。

SQL保护校验当前完成任务及事实、原领取人或本仓管理角色、完整装包和全项最新CHECK。延迟约束要求每张出库凭据具备全部原分配的消费、匹配REDEMPTION_SHIP:<allocationId>主流水（−on_hand、−reserved、blocked=0）、原库位唯一位置流水以及相同出库员工/请求。没有出库的消费、有出库但没消费、空打包和孤立出库前缀流水均拒绝；原各层库存/主/位置流水配平约束继续生效。

锁序保持授权/仓库共享锁→商品→库存→兑换单→Outbox→任务。阶段通过订单和任务锁串行，版本/打包来源校验与唯一凭据共同阻止竞争重复出库。动作、各层数量/流水、消费指针、审计及幂等同事务；处理末尾重新核验有效会话与真实时钟下的资格。读取历史出库时，待预占量按未消费分配计算，避免已正确消费后出现虚假的预占不足。

沿用REDEMPTION_PICKING_DEV_ENABLED=0及Worker默认关闭、生产/远程拒启，无依赖升级、无.env修改。先迁移后部署匹配API/Worker/双端。有新凭据或消费事实后不得盲退旧SDK/API；旧读取得不到消费状态，会误显示“预占中”或“待打包”。停写后保留兼容读取与取消保护，不删除流水，不通过回退把出库改成退分释放。

## API与界面

OpenAPI0.45.0已从实现导出，新增：

- POST `/api/v1/warehouse/warehouses/:warehouseId/redemption-picking/:id/pack`：{version,packageCount,lines:[{allocationId,quantity}]}，redemption-picking.work且必须原领取人。
- POST同基路径`/:id/ship`：{version,packId,physicalConfirmed:true}，新增redemption-picking.ship，仅本仓负责人/仓管。
- GET列表新增PACKED/SHIPPED互斥筛选；列表/详情packing提供资格条件、打包包裹数/逐项件数及出库时间/执行人。canPack/canShip不替代服务端员工权限，普通界面不要求输入UUID/版本/请求键。
- 消费者/后台fulfillmentState新增PACKED_WAIT_SHIP、SHIPPED_WAIT_HANDOFF；后台allocation新增consumed，reserved保留“历史存在预占凭据”兼容含义，显示时优先判断已消费。

严格字段/整数、员工Cookie、Origin/CSRF、原键、当前来源/版本、事务内授权均适用。原键恢复同一结果，改体409，新键重复阶段409；未知网络/5xx保存完整原始输入和键，重载仍可核实。具体契约及错误码见[API设计](../api/API-DESIGN-V1.md)和[数据设计](../database/DATABASE-V1.md)。

## 实际功能检查

使用锁定Node24.22.1、pnpm10.28.2及本机PostgreSQL，全部数据为临时schema中的合成身份、实际收货服务入账库存和实际兑换API创建的订单。

新增 `tests/redemption-packing.integration.test.ts` 12项全部通过：

1. 装包精确件数、漏项/错项/重复项/非整数拒绝，打包本身不动积分或库存，原键/改体/新键重复保护。
2. 真实出库各层库存与原分配流水、原键恢复及历史读取、消费者状态/取消阻断、Worker不重复处理、互斥阶段筛选、积分和配额保持。
3. 竞争打包、两名管理人员竞争出库及消费者取消竞争仅一次出库，不退款或重复扣库存。
4. 领取人、管理角色、骑手、其他仓及CSRF、physicalConfirmed、严格请求字段保护。
5. 冻结、规格停用、库位停用、批次过期阻断打包/出库且不留部分修改。
6. 打包/出库的晚审计失败，凭据和全部库存回滚，修复后原键各成功一次。
7. 出库审计期间批次到期，所有层数量/流水和出库凭据回滚。
8. SQL拒绝空装包、改删凭据、无库存消费的出库及清空消费指针。
9. 外层授权后事务内撤仓阻断，恢复后原键成功，随后失权拒绝重放。
10. 作业写入关闭时拒绝打包/出库且库存不变。
11. 真实多批次入库形成两个原分配，拒绝漏项装包；出库与另一顾客提交预占竞争后只消费本单6件，保留对方1件预占；已出库仍占用累计限兑。
12. 出库审计期间会话到期，库存、消费指针与出库凭据全部回滚。

67项既有真实PG回归全部通过：P4a任务/领取12、P4b核对/异常10、兑换12、积分8、兑换商品6、现金订单10、现金报价9。总计79项PG（12新增+67回归）。迁移全部从历史重放，测试清理临时schema，未改业务数据。

4项本机安全配置检查、Prisma生成、全工作区构建（API/Worker/后台/H5/微信weapp）、完整typecheck、lint、微信产物和三个导入根检查、git diff --check均通过；导出OpenAPI0.45.0并核对pack/ship路径。当前锁定Prisma/pg日志仍有查询串行弃用提示，未升级依赖或声称未来版本兼容。验收桥接包约1005KB的体积提示来自测试适配器；实际后台/H5生产包约447KB，构建通过。

## 实际UI检查与截图

`scripts/ui/verify-redemption-picking.mjs` 使用实际React/Taro源码、真实API、随机PG schema和本机浏览器。38张截图通过（原27场景+11个打包出库场景），保留空/加载/503重试、任务失败及恢复、领取/核对/异常处置、消费者领取前取消；新增装包数量不符禁用、冻结禁用、领取人完整装包、管理人员实物确认、已打包/已出库三端状态及后台已消费凭据。

打包和出库均注入“请求已经提交、响应丢失”，重载后原请求恢复；数据库最终只有一个pack、一个shipment及一次原预占消费。普通拣货员界面没有管理出库操作。无页面运行错误或横向溢出。已实际查看手机装包表单、后台出库、消费者待接货及后台消费凭据截图，延续现有UI风格；待负责人审阅，不等同于真实仓库人员实物作业验收。

- [手机装包表单](UI-REDEMPTION-PICKING-OPS-PACK-FORM-2026-11-02.png)
- [冻结阻断](UI-REDEMPTION-PICKING-OPS-PACK-BLOCKED-2026-11-02.png)
- [打包未知结果](UI-REDEMPTION-PICKING-OPS-PACK-UNKNOWN-2026-11-02.png)
- [手机已打包](UI-REDEMPTION-PICKING-OPS-PACKED-2026-11-02.png)
- [后台待出库](UI-REDEMPTION-PICKING-ADMIN-PACKED-2026-11-02.png)
- [出库未知结果](UI-REDEMPTION-PICKING-ADMIN-SHIP-UNKNOWN-2026-11-02.png)
- [后台已出库](UI-REDEMPTION-PICKING-ADMIN-SHIPPED-2026-11-02.png)
- [手机已出库](UI-REDEMPTION-PICKING-OPS-SHIPPED-2026-11-02.png)
- [消费者待骑手接货](UI-REDEMPTION-PICKING-MINI-SHIPPED-2026-11-02.png)
- [后台预占已消费](UI-REDEMPTION-PICKING-ADMIN-ORDER-CONSUMED-2026-11-02.png)

截图本地保留并忽略。小程序采用同源码浏览器适配，移动作业端为390px手机H5，未使用微信开发者工具或真机，不能替代微信原生、真实实物或生产验收。

## 复现与未验证

使用现有本机TEST_DATABASE_URL与锁定Node，勿输出凭据：`npm run test:redemption-packing`；`npm run test:redemption-picking`、`npm run test:redemption-picking-work`及相关交易测试；`npm run verify:redemption-picking:ui`需YUMI_LIVE_UI=1、已有Playwright与Chrome路径。脚本创建可运行临时API/预览，结束后清理，无需迁移业务主库。

下一项P4d：真实兑换出库来源的骑手分配与接货。后续配送、异常恢复、协调取消、领取人停用接续/重派、售后退分、规模负载及P5仍待交付。真实经营规则、微信工具/真机、真实商品和人员实物核验、生产部署/备份恢复均未验收；作业/Worker默认关闭，未上线。
