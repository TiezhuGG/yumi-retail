# P4i 整单完整完好回交与配送接续 · 2026-11-03

分支：积分商城。已核对P4h及入口计划，接续已接货保管责任链；本地隔离实现，未上线。

## 边界与行为

当前已接货、尚未送达的单，由本仓有效负责人/仓管实际接收原骑手回交的整单包裹，按原包裹数及每条原批次/库位分配的完整件数核对，必填原因。分别声明“全部原实物完整完好已接收”和“已核验原地址及异常情况允许重新安排配送”。两项确认是管理人员声明，不是系统独立实物核验，不代表正式经营规则已确认。

回交终止原配送尝试及旧骑手访问/操作资格；管理人员再选有效本仓骑手，新骑手必须使用新分配逐项接货，重新开始、送达。原骑手/分配人停用、撤权或撤仓后，由现任管理人员接续，不要求失权人员恢复角色。库存冻结等不妨碍保管核验，但仍阻断新分配和交接。

仅整单完整完好回交，不支持部分、破损、已送达或无法核验原地址/异常可重新配送的回交。原分配、接货、配送阶段、异常及处置永久保留；原异常随原配送终止进入回交历史，不删除或伪造允许原骑手继续的resolution。消费者只同步回交标识及当前配送阶段，不收到内部原因和人员。回交不是库存入库或售后退货，不二次扣减/回补库存、不扣退积分，不改变主订单/地址/限兑配额。

## 模型及接口

新增迁移202611030006_redemption_custody_returns，RedemptionCustodyReturn/Line记录唯一原接货及shipment/order复合来源、当前管理人员姓名快照、原因、包裹/逐项数量、请求号和数据库时间；禁止UPDATE/DELETE，延迟SQL约束核验所有原装包行和包裹数。

解除原handoff的shipment/order唯一及handoff_line的allocation唯一，同一assignment仍仅一次接货，多个尝试保留各自事实而共用一次真实库存消费。统一有效分配为无withdrawal且无已回交handoff；SQL行锁保护一条当前保管关系，回交与送达互斥，已结束的handoff不能追加START/COMPLETE、异常或原骑手继续型处置。原未接货撤回按当前assignment检查，历史回交不妨碍后续撤回。

POST /api/v1/warehouse/warehouses/:warehouseId/redemption-delivery/:id/return-custody；严格body为handoffId、reason（必填最多300字）、packageCount、lines[{allocationId,quantity}]、intactCustodyConfirmed:true、redispatchConfirmed:true。员工Cookie/Origin/CSRF、本仓redemption-delivery.assign及Idempotency-Key。输入/缺确认400、无权403、错当前来源/已回交/送达/数量不符409、关闭503；回交、逐项事实、审计及幂等结果同事务。

员工管理查询增加returnHistory和assignmentHistory.returned，包括原骑手、曾否出发、接收人、原因、时间与原异常；骑手不返回其他尝试的内部历史。消费者仅增加deliveryReturnRecorded、回交提示和重新分配文案。OpenAPI 0.51.0从代码导出。所有API、页面均沿用作业默认关闭及生产/远程拒启。

迁移先于匹配API/Worker和三端部署。原记录无需回填；新事实存在后，旧版不能识别当前保管关系，禁止盲退、删除事实或恢复旧唯一约束。仅随机临时schema重放，未修改业务主库、现有.env或生产。

## 实际验证

Node24.22.1、pnpm10.28.2、本机PostgreSQL和Chrome，使用现有依赖。

- 最终版5项真实PG专项通过：完整回交保留原START/异常，新骑手新接货后完整配送，旧骑手失权/旧键拒绝、消费者隐私及库存/积分/订单/预占快照不变；原骑手及分配人停用后的管理接续，冻结仍阻断新分配；无权/跨仓/错来源/缺确认/重复行/数量不符，SQL完整性及旧尝试禁追加；回交与送达只提交一种结果；晚期审计失败回滚与原键恢复、并发回交唯一、多轮回交及中间未接货撤回。
- P4d/e/f/g/h相关36项真实PG与本轮5项组合运行共41项全部通过（331.5秒），增加双确认后又完整复跑本轮5项全通过；不声称全历史回归。
- 实际API/临时PG浏览器闭环20张截图：空/503重试、分配成功响应丢失原键恢复、原骑手接货开始及异常、管理完整数量和双确认门禁、回交响应丢失/重载原键恢复、旧骑手刷新404清除地址、新骑手重新接货开始送达、后台保管/原异常历史及消费者回交和送达提示。页面错误及横向溢出断言通过，实际查看桌面回交历史与手机消费者回交截图。
- 初轮专项发现测试仍用已停用管理员读取，以及并发用例假定指定请求必胜；改为有效骑手读取、分别验证原键恢复和竞争任一方成功后复跑通过。浏览器初轮旧异常alert提前满足等待，已改为等待旧联系人实际隐藏，再整套通过；未以等待代替清除旧数据。
- Prisma生成、全工作区build（含weapp/后台/H5/API/Worker）、typecheck、lint及OpenAPI导出全部通过，改动代码Prettier检查和git diff --check通过。既有pg并发查询弃用和预览适配包体积提示未更换依赖处理。

截图：[回交表单](UI-REDEMPTION-RETURN-ADMIN-RETURN-FORM-2026-11-03.png)、[数量不符](UI-REDEMPTION-RETURN-ADMIN-RETURN-COUNT-MISMATCH-2026-11-03.png)、[响应丢失](UI-REDEMPTION-RETURN-ADMIN-RETURN-UNKNOWN-2026-11-03.png)、[回交与原异常历史](UI-REDEMPTION-RETURN-ADMIN-RETURNED-2026-11-03.png)、[旧骑手失权](UI-REDEMPTION-RETURN-OLD-RIDER-ACCESS-REMOVED-2026-11-03.png)、[新骑手送达](UI-REDEMPTION-RETURN-NEW-RIDER-COMPLETED-2026-11-03.png)、[消费者回交](UI-REDEMPTION-RETURN-MINI-RETURNED-2026-11-03.png)、[消费者送达](UI-REDEMPTION-RETURN-MINI-COMPLETED-2026-11-03.png)。截图本地保留并忽略，不提交。

复跑npm run test:redemption-returns；UI设置YUMI_LIVE_UI=1、现有YUMI_PLAYWRIGHT_PATH及本机YUMI_CHROME_PATH后npm run verify:redemption-returns:ui。测试随机临时schema结束清理；小程序同源码浏览器桥接不等于微信开发者工具、合法域名或真机验收。

下一项P4j：仓库领取人停用后的接续与重核。部分/破损回交、协调取消、售后及正式经营门禁仍需继续。真实人员实物、微信/真机和生产未验，P4/P5未整体验收，商城未上线。
