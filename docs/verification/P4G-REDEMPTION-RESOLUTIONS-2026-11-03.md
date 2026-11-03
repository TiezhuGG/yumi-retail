# P4g 配送异常处置与原骑手恢复 · 2026-11-03

分支：积分商城。已核对P4e/P4f既有实现，接续P4g；本地隔离验证通过，尚未上线。

## 边界与实现

本仓有效SUPER_ADMIN/WAREHOUSE_MANAGER填写最长300字处置说明，并确认异常已处理、包裹及原地址可由原骑手继续配送。确认是管理人员声明，不是系统独立实物核验。新增处置事实链接原异常，保留类型、原说明和历史阶段；原骑手从原阶段继续开始/送达，处置本身不生成配送阶段。

恢复前校验原出库、订单/任务、库存冻结及效期、原骑手与分配人当前资格，任何其他阻断均拒绝。骑手不能自行处置。库存、积分、个人/总配额、地址、骑手分配及兑换订单主状态不变。本轮不包含退回、取消、退分或改派。

新增迁移202611030004_redemption_delivery_resolutions，独立不可变RedemptionDeliveryResolution：exception_id唯一外键、管理人员及姓名快照、处置说明、请求号和数据库时间。原异常仍不可变。取代P4f每个接货仅一条异常的阶段限制：允许处置后新报异常，按原handoff锁串行化，同时最多一条未决，每条最多一条处置。START/COMPLETE的SQL门禁只阻断未决异常。

POST /api/v1/warehouse/warehouses/:warehouseId/redemption-delivery/:id/resolve，严格body为exceptionId、reason、continuationConfirmed:true，沿用员工Cookie、Origin/CSRF及Idempotency-Key。权限为本仓redemption-delivery.assign。处置、审计与幂等结果同事务，失败完整回滚。服务按人员→元数据→库存→订单→任务→出库锁序重读来源，写后再验资格。

员工详情增加exception.resolution和exceptionHistory，后台独立确认表单，骑手查看处置后继续。消费者只按当前未决标识显示通用异常提示；恢复后显示实际履约阶段，不泄露内部说明或人员。弱网未知结果保留原请求，重载后原键恢复。OpenAPI 0.49.0已由代码导出。

## 实际验证

Node 24.22.1、pnpm 10.28.2，使用现有依赖。

- 3项新真实PostgreSQL组合用例：原键重放一条处置、原异常保留、再次异常/处置/送达、消费者隐私及库存积分不变、SQL事实不可变；无权/未确认/错来源拒绝、冻结阻断、并发处置仅一方成功；晚期审计失败回滚、仍阻断骑手、原键恢复。
- 与3项P4f及13项P4e回归合计19项通过；未声称全量历史回归。最后新增缺失接货来源的409防护后，完整构建/类型检查/lint通过。
- 实际API/临时PG浏览器闭环通过，30张本地截图：分配/接货/异常及弱网回归、后台处置确认门禁、响应丢失与重载原键恢复、原骑手恢复和送达、消费者阶段同步。数据库核实一条异常、一条处置、两条配送阶段。已实际查看桌面处置历史和手机送达历史，布局可读，无横向溢出检查通过。
- Prisma生成、全工作区build（API、Worker、后台、H5、微信weapp）、typecheck、lint及OpenAPI导出通过。既有pg查询弃用及浏览器适配包体积提示仍存在，未升级依赖。

截图：[后台表单](UI-REDEMPTION-RESOLUTION-ADMIN-RESOLUTION-FORM-2026-11-03.png)、[处置响应丢失](UI-REDEMPTION-RESOLUTION-ADMIN-RESOLUTION-UNKNOWN-2026-11-03.png)、[后台处置记录](UI-REDEMPTION-RESOLUTION-ADMIN-RESOLVED-2026-11-03.png)、[原骑手恢复](UI-REDEMPTION-RESOLUTION-RIDER-RESUMED-2026-11-03.png)、[手机送达历史](UI-REDEMPTION-RESOLUTION-RIDER-COMPLETED-AFTER-RESOLUTION-2026-11-03.png)、[消费者](UI-REDEMPTION-RESOLUTION-MINI-RESOLVED-COMPLETE-2026-11-03.png)。截图本地忽略保存，不提交。

复跑：npm run test:redemption-resolutions；UI设置YUMI_LIVE_UI=1、现有YUMI_PLAYWRIGHT_PATH及本机YUMI_CHROME_PATH后npm run verify:redemption-resolutions:ui。随机临时schema结束清理。浏览器消费者同源码桥接预览不等于小程序开发者工具、合法域名或真机验收。

## 兼容及后续

仅随机临时测试schema重放迁移，未修改业务主库、现有.env或生产。沿用作业默认关闭及生产/远程拒启，不增环境开关。部署须先迁移再部署API及三端；旧P4f会将已处置历史仍看作异常，不可盲退、删除事实或重动库存积分。

下一项P4h：未接货分配撤回/改派及人员撤权接续；之后协调取消及售后。真实经营规则、微信/真机、实际实物和生产验收仍未通过，P4/P5未整体验收，商城未上线。
