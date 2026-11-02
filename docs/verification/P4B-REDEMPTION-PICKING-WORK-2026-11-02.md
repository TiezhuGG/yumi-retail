# P4b 兑换真实预占核对与异常阻断 · 2026-11-02

分支：积分商城。状态：本地实现及隔离 PostgreSQL / 实际浏览器验证通过，未上线。边界为领取人按真实预占分配核对、缺货/破损上报、仓管确认原需求备齐、重新核对及完成拣货。CHECKED表示拣货核对完成、等待打包，不表示出库或配送；P4与P5尚未整体验收。

## 功能规则和验收案例

- 使用已扣积分兑换单的原 redemption_allocations，按名称/规格、批次、库位显示，不要求员工填写内部编号；未接入合成 picking_lab。核对必须等于该分配完整整数件数，不允许部分件数冒充完整核对；同单多批次必须全部核对。
- 核对、上报和完成仅任务当前领取人可执行，SUPER_ADMIN / WAREHOUSE_MANAGER / PICKER须保持有效会话、角色和本仓授权。负责人/仓管只能通过管理动作处置异常，不能代替别人的领取核对。普通拣货员、骑手或非本仓人员不能越权处置。
- 领取人可上报SHORTAGE或DAMAGE，件数1..原分配件数。只要一件异常，此分配整项阻断，旧CHECK保留历史但不再有效。此项未决时拒绝重复上报或核对，不自动换批、扣库存、退积分或释放预占；冻结/过期时仍允许记录实际异常。
- 负责人/仓管按当前任务版本、原异常及原分配完整件数确认“原预占需求已备齐”。只允许原批次/原库位已恢复可用的确认，服务端不能替代实物判断；未决异常不会被删除，处置后仍须领取人重新核对。该开发流程不等同于经营规则已确认；调账/换批/重派/协调取消尚未交付。
- 全部分配最新事实为CHECK，且当前商品、仓库、预占、库存冻结/盘点、库位及批次效期均合格，才可由领取人完成，CLAIMED→CHECKED。任何漏项、数量不符、未决异常或资格变化均拒绝完成；审计期间批次到期也回滚。CHECKED本轮不可重新打开，打包及后续阶段异常流程另交付。
- CLAIMED / CHECKED均禁止消费者直接取消。消费者与后台订单同步PICKED_WAIT_PACK及明确“尚未出库或配送”提示，不伪造出库结果。实物库存、预占、积分、订单配额在本轮四类作业动作中不发生移动。

## 数据、锁及兼容

新增迁移 `202611020014_redemption_picking_work`，未改旧迁移。仅随机临时schema重放，业务主库与生产均未应用。

redemption_picking_work是不可变事实表：任务/同单分配复合外键、任务版本、动作、件数、原issue_id、员工、请求和时间；(task_id,version)唯一，issue_id唯一自关联禁止二次处置。SQL触发器限制任务原归属及领取时间不变、版本连续和前序事实存在、合法员工/仓库、原分配完整件数、未决原异常与全部最新CHECK；延迟约束要求任务新版本匹配不可变凭据。原任务CREATED/CLAIMED/CANCELED及Outbox事件一致性保护保留并扩展CHECKED。

锁顺序沿用授权及仓库共享锁→商品与库存→订单→Outbox→任务，任务版本串行化不同分配的并发操作。动作、版本、事实、审计、幂等结果同事务；事务内重查权限，完成审计后按真实时钟重查资格。并发核对/上报或完成/上报只有一方可用当前版本成功，另一方刷新；不允许用旧完成覆盖新异常。

沿用 REDEMPTION_PICKING_DEV_ENABLED=0，Worker开关默认0，生产/远程拒启，无新依赖或环境配置修改。先迁移再部署匹配API/Worker/双端。已有CHECKED或工作事实后不得盲退P4a；旧状态约束和消费者展示不兼容。关闭写开关并保留兼容读取/取消保护，不能删除事实或通过回退自动退分释放。

## API与页面

OpenAPI 0.44.0已导出。基路径 `/api/v1/warehouse/warehouses/:warehouseId/redemption-picking`，新增POST `/:id/check`、`/:id/report`、`/:id/resolve`、`/:id/complete`。严格请求字段及整数、员工Cookie、Origin/CSRF、Idempotency-Key和当前任务版本；check/report/complete使用redemption-picking.work，resolve使用redemption-picking.resolve。完整请求体及错误码见[API设计](../api/API-DESIGN-V1.md)。读取增加CHECKED筛选、逐项checked/issue、work.complete/canComplete和历史事实。

后台与仓库H5使用实际API、原批次库位选择及独立数量表单；异常未决/待重核/已完成状态分别显示。历史按北京时间展示动作、原批次/库位、件数和执行身份，保留已处置异常。未知结果保存原账号/仓库/订单、动作、完整原始输入和键，重载仍使用原请求核实；不能改数量后以旧键假装新动作。

## 实际功能检查

使用锁定Node24.22.1、pnpm10.28.2，无依赖升级：

- 新增 `tests/redemption-picking-work.integration.test.ts` 10项真实PG全部通过：精确数量/原分配及原键去重；异常令旧核对失效/处置重核；角色/归属/CSRF/严格输入；核对与上报、完成与上报竞争；冻结时核对阻断且可上报；SQL禁止改删事实/漏事实/漏核对完成；四类动作晚审计失败回滚和原键恢复；完成期间批次过期回滚；真实入库形成多批次、部分缺货整项阻断及完整件数重核；事务内撤权与已撤权原键重放保护。
- 既有 `redemption-picking.integration.test.ts` 12项通过，包含Worker实际子进程开关/重启、租约、领取/取消竞争、预占资格、晚失败和权限。
- 相关45项PG通过：redemptions 12、points 8、rewards 6、orders 10、checkout 9。合计67项PG（10新增+57回归），全部使用隔离数据/临时schema。
- 4项本机安全配置检查通过；Prisma生成、全工作区构建（API/Worker/后台/H5/微信weapp）、完整typecheck、lint、git diff --check通过；微信产物及三个导入根校验通过，OpenAPI版本/新动作路径导出核对通过。

日志有当前锁定Prisma/pg适配器的查询串行弃用提示，未升级依赖或声称未来版本兼容。UI测试桥接包约998KB的构建体积提示来自验收适配器；实际后台/H5生产包约444KB，构建通过。

## 实际UI检查

`scripts/ui/verify-redemption-picking.mjs` 使用实际React/Taro页面源码、真实API和随机PG schema，27张截图通过，无页面运行错误或横向溢出。保留17个任务/领取/消费者取消场景，并新增10个核对/异常场景。手机上报、后台原需求备齐、领取人重核到完成；上报及完成均注入“请求已提交、响应丢失”，重载同键核实且数据库只有一次事实。页面仍覆盖空、加载、503读取重试、创建失败和恢复。

已实际查看后台异常处置、手机未决阻断、消费者待打包及手机完成后历史截图。修正后台批次/库位/效期/处置表单拥挤，将批次信息与表单分区；手机保持单列和可触控按钮。截图本地保留并忽略，负责人可审查；不替代负责人UI确认或真实实物作业验收。

- [后台异常处置](UI-REDEMPTION-PICKING-ADMIN-ISSUE-2026-11-02.png)
- [手机未决阻断](UI-REDEMPTION-PICKING-OPS-ISSUE-BLOCKED-2026-11-02.png)
- [上报未知结果](UI-REDEMPTION-PICKING-OPS-REPORT-UNKNOWN-2026-11-02.png)
- [后台处置后待重核](UI-REDEMPTION-PICKING-ADMIN-RESOLVED-2026-11-02.png)
- [手机重核要求](UI-REDEMPTION-PICKING-OPS-RECHECK-REQUIRED-2026-11-02.png)
- [完成未知结果](UI-REDEMPTION-PICKING-OPS-COMPLETE-UNKNOWN-2026-11-02.png)
- [手机完成及历史](UI-REDEMPTION-PICKING-OPS-CHECKED-2026-11-02.png)
- [后台待打包](UI-REDEMPTION-PICKING-ADMIN-CHECKED-2026-11-02.png)
- [消费者待打包](UI-REDEMPTION-PICKING-MINI-CHECKED-2026-11-02.png)

小程序采用Taro同源码浏览器桥接，H5以390px手机布局检查；未使用微信开发者工具或真机，不能当作微信真机验收。

## 复现与后续

使用现有本机TEST_DATABASE_URL及锁定Node，勿输出凭据：`npm run test:redemption-picking-work`；`npm run test:redemption-picking`；相关交易测试；`npm run verify:redemption-picking:ui`需YUMI_LIVE_UI=1、已有Playwright路径和本机Chrome路径。UI脚本创建临时API和预览，结束清理，不改业务主库或已有.env。

下一项P4c：打包前完整性、实际出库的幂等凭据及库存扣减配平。协调取消、领取人停用后的接续/重派、打包后异常、骑手真实履约、售后退分、规模负载与P5仍待交付。正式经营参数、真实微信身份/工具/真机、真实仓库人员与商品、生产部署/备份恢复均未验收，商城未上线。
