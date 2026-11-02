# 合成异常处置与恢复配送 · 2026-11-02

本轮完成本仓负责人/仓管确认合成异常已处理、生成不可变处置凭据并允许原骑手从原阶段继续。原异常及阶段凭据保留，不自动开始或送达；每份分配仍最多报告一次异常。本轮不是实物处理、退款、换货、退回或改派。

POST /api/v1/delivery-lab/:id/resolve-exception?warehouseId=…仅接受key(UUID)、exceptionId(UUID)，需delivery-lab.read+assign及CSRF，当前仓库授权。前端直接引用已读取异常，无UUID普通输入；需显式勾选确认。同人/键/异常恢复成功，换人或新键409，异常不匹配409、骑手处置403、默认关闭503。首次提交锁原任务并校验原快照和当前骑手资格，数据库锁定复核处置人员启用状态、负责人/仓管角色、本仓范围；处置与审计同事务。

新增迁移202611020005_delivery_resolutions及delivery_lab_resolutions，exception_id唯一FK、assignment_id FK、处置人/姓名/键/时间，不可更新删除；DB校验异常与分配匹配，阶段门禁只阻断无处置凭据的异常。DTO在exception下新增可空resolution{id,actorName,createdAt}，不暴露原键。OpenAPI0.35.0实际自动导出。旧异常不补造处置。迁移仅真实PG临时schema验证；正式开发库未部署，部署须先迁移/生成Client/重建；回退关闭演练并保留凭据。

实际验证：20项真实PostgreSQL配送用例全部通过（原18+新增2），涵盖骑手无处置权、错异常/额外字段、同键并发一事实一审计、换人/新键冲突、DB不可变/非管理角色拒绝、未自动推进、接货后及配送中恢复、送达后原处置恢复、审计晚失败回滚、默认关闭、正式订单/库存/预占/流水/支付快照不变。服务端/共享UI/后台/H5构建、全工作区类型、lint、代码格式和diff检查通过。沿用Node24.22.1原生类型转换、Vite runner，未升级依赖或改锁文件。

浏览器实际API/PG验证：处置成功后中断响应、刷新详情后原body重试、单份处置凭据、切换骑手恢复并本人送达；空/错/加载/权限回归通过。桌面1440及手机390无横向溢出；23张本地截图，人工复核处置详情与恢复操作。确认框尺寸作小幅修正。截图按既有.gitignore仅本地保留，可用scripts/ui/verify-delivery-resolution.mjs和上轮同样的本地测试参数重建，不提交Git。

- [处置结果未知](UI-DELIVERY-RESOLUTION-RESOLVE-UNKNOWN-DESKTOP-2026-11-02.png)
- [处置凭据](UI-DELIVERY-RESOLUTION-RESOLVED-DESKTOP-2026-11-02.png)
- [骑手恢复](UI-DELIVERY-RESOLUTION-RIDER-RESUMED-MOBILE-2026-11-02.png)
- [骑手完成](UI-DELIVERY-RESOLUTION-RIDER-COMPLETED-MOBILE-2026-11-02.png)

默认演练开关未改，业务端口未部署新版。真实交接、真实配送、微信工具/真机、支付和生产仍未验收，小程序构建本轮未重跑，S6/S7整体不标记通过。原键草稿仅当前浏览器进程内导航/详情刷新恢复，不承诺整页重载持久化。下一项：合成配送异常清单筛选与待处置概览，便于仓管发现未决任务；多轮异常、实物及退款规则另行确认。
