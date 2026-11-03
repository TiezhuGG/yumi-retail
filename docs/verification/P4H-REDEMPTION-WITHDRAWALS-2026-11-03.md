# P4h 未接货分配撤回与重新分配 · 2026-11-03

分支：积分商城。已核对P4g和入口计划。本轮范围为未接货分配撤回、重新分配及原骑手/分配人撤权后的现任管理接续；本地隔离验证，未上线。

## 功能及验收边界

本仓有效SUPER_ADMIN/WAREHOUSE_MANAGER填写最多300字原因，确认骑手尚未接货、全部包裹仍由仓库保管，撤回当前分配。确认是人员声明，不是系统独立实物核验。保留原分配、新增不可变撤回凭据，再选有效本仓骑手生成新分配；待分配期间不自动择人，始终不二次动库存、积分、限兑或主订单状态。

原骑手或原分配人停用/撤权/撤仓不阻止当前管理人员撤回；冻结等货品阻断不妨碍解除旧人员分配，但仍禁止重新分配/接货。新分配必须重新检查原出库、库存效期、冻结与有效骑手资格。接货成功后撤回入口消失，API和数据库均拒绝撤回；已接货人员接续和实物回交未实现，不能用本轮功能绕过保管责任。

旧骑手不能再查询、接货或用旧键重放失权动作；刷新遇到404清空已显示详情。仅管理查询提供分配与撤回历史，当前骑手不返回旧历史。消费者/仓库订单按当前有效分配显示状态，消费者不收到内部撤回原因或人员资料。

## 模型、接口与兼容

新增迁移202611030005_redemption_assignment_withdrawals及RedemptionAssignmentWithdrawal：唯一assignment_id、管理人员/姓名快照、原因、request_id和数据库时间，禁止修改删除。原assignment保持不可变，shipment/order不再唯一，保留原复合外键并建立索引。SQL触发器锁原shipment，保护一条有效分配、已接货不能撤回、撤回凭据不能接货。撤回/接货与应用原订单、任务、shipment锁序互斥，不能都成功。

POST /api/v1/warehouse/warehouses/:warehouseId/redemption-delivery/:id/withdraw，body仅assignmentId、reason、warehouseCustodyConfirmed:true，沿用员工Cookie、Origin/CSRF、本仓redemption-delivery.assign及原键。输入400、无权403、变化/已接货409、关闭503；撤回/审计/幂等同事务。再次分配仍用既有/assign；未撤回前不能覆盖。管理读取增加assignmentHistory，OpenAPI 0.50.0由代码导出。

Prisma shipment.assignment改assignments集合；兑换订单/拣货/配送查询统一只取未撤回记录表示当前阶段。迁移先于新API/Worker/页面部署，原分配和接货无需回填。旧版单条关联代码不能正确理解多分配，存在撤回记录后禁止盲退旧版、删除事实或恢复旧唯一约束；应停写并保留新查询/保护。

## 实际检查

Node24.22.1、pnpm10.28.2、现有PG和Chrome，未安装升级依赖。

- 4项新增真实PG组合用例全部通过：重复请求一条撤回/摘要冲突、旧骑手列表详情及接货隔离、新骑手新凭据接货、接货后拒绝撤回、消费者阶段、库存积分订单配额无副作用与不可变事实；旧骑手及原分配人同时停用后由现任仓管撤回、冻结仍阻断新分配；骑手无权、确认/额外字段/来源错误及撤回与接货竞争；并发撤回/重新分配、SQL拒绝旧接货、晚期审计失败回滚及原键恢复。
- 相关P4d/e/f/g共32项真实PG回归通过。初次组合运行34/36，通过调整测试旧单条唯一查询以及停用管理员后的测试读取账号，失败两项分别定向复验通过，另完整重跑4项新专项全通过。共36个不同用例已验证，不声称最后一次单命令36/36或全历史回归。
- 实际API/随机临时schema浏览器18张截图：加载/空/骑手读取503重试、分配弱网原键恢复、撤回说明及确认门禁、撤回成功响应丢失与重载原键核实、旧骑手404清详情、后台完整历史、新骑手精确接货及接货后无撤回入口、消费者阶段同步；页面错误与横向溢出断言通过。复选框布局实际查看后修正并整套复跑。
- Prisma生成、全工作区build（含weapp/后台/H5/API/Worker）、typecheck、lint、OpenAPI导出通过；既有pg查询弃用及预览适配包体积提示未处理。

截图：[撤回表单](UI-REDEMPTION-WITHDRAWAL-ADMIN-WITHDRAW-FORM-2026-11-03.png)、[响应丢失](UI-REDEMPTION-WITHDRAWAL-ADMIN-WITHDRAW-UNKNOWN-2026-11-03.png)、[撤回历史](UI-REDEMPTION-WITHDRAWAL-ADMIN-WITHDRAWN-2026-11-03.png)、[旧骑手失权清理](UI-REDEMPTION-WITHDRAWAL-OLD-RIDER-ACCESS-REMOVED-2026-11-03.png)、[重新分配](UI-REDEMPTION-WITHDRAWAL-ADMIN-REASSIGNED-2026-11-03.png)、[新骑手接货](UI-REDEMPTION-WITHDRAWAL-NEW-RIDER-RECEIVED-2026-11-03.png)、[消费者](UI-REDEMPTION-WITHDRAWAL-MINI-NEW-RIDER-RECEIVED-2026-11-03.png)。截图本地保留并忽略。

复跑npm run test:redemption-withdrawals；UI设置YUMI_LIVE_UI=1、现有YUMI_PLAYWRIGHT_PATH及Windows YUMI_CHROME_PATH后npm run verify:redemption-withdrawals:ui。仅临时schema，结束清理；未改业务主库、.env或生产。沿用作业默认关闭和生产/远程拒启。小程序同源码浏览器桥接不等于微信开发者工具、合法域名或真机验收。

下一项P4i：已接货人员撤权后的实物回交与接续；仓库领取人停用接续、协调取消、售后和正式经营门禁仍待交付。真实人员实物、微信/真机和生产未验，P4/P5未整体验收，商城尚未上线。
