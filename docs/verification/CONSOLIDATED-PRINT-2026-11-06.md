# 多订单汇总配货打印 · 2026-11-06

## 本次范围

运营后台「积分兑换订单」勾选2–20笔订单后可选择「汇总配货打印」。汇总同一顾客、相同原收件信息、相同运行模式的有效待发货快递订单，按SKU和历史标题/规格/单位累加数量；保留原订单号、时间、数量、积分和备注。地址簿变更不替换原订单快照。

本切片为只读备货核对：没有建立合包记录、统一运单、批量导入或自动快递接口，不改变订单、积分、库存、分配或任务。现有单张/逐单批量打印保持原行为。真正合包和统一运单发货仍为后续任务。

## 功能验证

实际使用Node24.22.1、现有精确依赖、自动建立并清理的PostgreSQL隔离schema；未导入业务数据库、未改密钥、未执行新迁移。

- `node --env-file=.env --import tsx --test --test-concurrency=1 tests/redemption-consolidated-print.integration.test.ts`：最终5项通过。验证数量/积分汇总、原订单顺序、重复读取无业务写入、参数/权限/CSRF/仓范围、缺单整批拒绝、取消/发货后重新打印拒绝、同顾客不同地址及不同顾客相同地址隔离、不同SKU不误合并，以及原本地配送排除。
- 原`redemption-print.integration.test.ts`3项及`redemption-express-shipping.integration.test.ts`8项共11项通过；包含取消/发货并发、库存约束、幂等恢复及事务回滚。合计16项，不重复计入重跑次数。
- 测试出现既有pg adapter并发query弃用提示，当前无失败；没有升级依赖。
- 服务端构建、后台/移动作业端构建、全仓typecheck/lint通过；OpenAPI已导出。格式和diff检查通过。

初次新增用例曾尝试直接改订单executionMode，被既有不可变触发器拒绝；已删除该不符合真实操作路径的测试，未绕过或删除触发器。混运行模式拒绝有服务端实现，尚未构造跨运行模式真实订单组合的专门集成案例。

## 界面验证

运行`YUMI_LIVE_UI=1 YUMI_PLAYWRIGHT_PATH=... node --env-file=.env --import tsx scripts/ui/verify-consolidated-print.mjs`，实际React工作台、Chrome及隔离API完成：未选择禁用、勾选、错误/重试、汇总/原单明细、桌面/390px手机、A4导出、打印前重验，以及取消后旧预览清空且不调用打印。共6张浏览器截图，实际查看桌面、手机及打印样式；另将浏览器生成PDF转PNG检查实际A4分页（合成两单1页）。打印调用由浏览器测试桩记录，没有连接物理打印机。

- [选择订单](UI-CONSOLIDATED-PRINT-SELECTED-2026-11-06.png)
- [读取错误](UI-CONSOLIDATED-PRINT-ERROR-2026-11-06.png)
- [桌面预览](UI-CONSOLIDATED-PRINT-DESKTOP-2026-11-06.png)
- [手机预览](UI-CONSOLIDATED-PRINT-MOBILE-2026-11-06.png)
- [打印样式](UI-CONSOLIDATED-PRINT-A4-2026-11-06.png)
- [实际A4第一页](UI-CONSOLIDATED-PRINT-A4-PAGE-2026-11-06.png)
- [取消后清空旧预览](UI-CONSOLIDATED-PRINT-STALE-REJECTED-2026-11-06.png)

截图均合成数据、本地产物，不包含真实顾客信息。UI与物理打印/实物核对/生产验收分别记录，不能由自动化通过推定实物验收。

## 兼容性和本地交付

API0.79.0新增POST `/api/v1/admin/redemptions/consolidated-print-preview`；旧打印响应不附加汇总字段。无迁移（仍62项）。服务端按订单排序共享锁，串行于取消/发货；全批验证成功后才返回解密地址，响应no-store，权限在事务前后重验。

本地API更新后live/ready均200，在线OpenAPI0.79.0包含新接口。后台构建需先执行`pnpm --filter @yumi/web-ui build`再构建admin-web/ops-mobile（它们消费公共包dist）；本次已纠正旧公共包产物，核对5173/5174实际加载的脚本包含新接口。文档同步PRD/API/数据设计/总计划/开发计划/商城剩余清单。未部署生产，未进行真实微信、开发者工具、真机、真实打印机及实物发货验收。
