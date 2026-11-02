# P1b 积分发放申请、独立审批与预算 · 2026-11-02

分支：积分商城。状态：本地实现与隔离验证通过，未上线；经营预算未配置，正式发放未开放。

## 交付边界

后台新增“积分发放审批”独立导航、申请列表、申请表单、审批详情和预算表单。运营/负责人可申请；另一名负责人可批准/驳回；仅申请人可撤销。申请直接提交为SUBMITTED，不提供可编辑草稿；与原设计草稿步骤的差别已明确，拒绝/撤销后重新申请，不修改旧事实。本切片只增加正向发放，扣减/冲正另为P1后续切片，P1整体仍未全部结束。

用户按名称搜索选择，不要求输入UUID。必填正整数积分、原因和业务凭据编号。处理必填说明。积分以十进制字符串传输，单笔技术范围1–10亿；此上限不是经营授权。未知结果锁住原意图并允许原键重试，确认成功后刷新。小程序复用本人余额/流水接口展示实际到账，发放功能文案同步更新。

## 规则与可靠性

- 预算按本仓配置，缺配置或enabled=false时拒绝批准入账。单笔上限、每日总发放预算均由负责人显式配置，预算不能低于单笔上限；规则变更须版本和审计原因。
- 按审批入账时间及Asia/Shanghai自然日计算已批准金额合计；驳回、撤销和未审批不占实际发放预算。减少预算不抹除已发历史，不自动清零；后续冲正也不得自动恢复原发放预算。
- 普通运营不能配置或批准。独立审批和撤销人约束同时存在服务端及SQL约束。员工启用/当前角色/本仓授权/有效会话、会话auth_version与有效期在事务内重读并加共享锁，避免审批中撤权被旧上下文绕过。
- 幂等键绑定员工/动作/资源/规范化请求；同键重放原结果，改内容冲突。预算配置锁→申请锁→账户锁；同仓发放串行校验预算，避免并发突破。
- 批准时同事务写积分余额、唯一GRANT:<申请ID>流水、申请终态、审计及幂等结果。审计失败全部回滚；重复批准不重发。
- 申请事实不可改；仅SUBMITTED→APPROVED/REJECTED/CANCELED，终态不可改删。延迟约束要求批准事实有同用户/积分/审批人的账本凭据，已有余额配平约束继续生效。业务数据与积分流水均不物理回退。

## API及模型

OpenAPI0.39.0已从代码导出。前缀/api/v1，员工Cookie、Origin、CSRF；POST需Idempotency-Key。写权限points.write授予OPERATIONS和SUPER_ADMIN，但配置/批准/驳回在服务端重新限制为SUPER_ADMIN，并要求本仓授权。

| 接口 | 输入及动作 |
| --- | --- |
| GET /admin/points/grants | cursor可选，20条UUID升序；规则及申请列表，不声称按时间倒序 |
| POST /admin/points/grants/store/create | userId、amount字符串、reason、reference；生成待审批申请 |
| POST /admin/points/grants/store/policy | version、enabled、singleLimit/dailyLimit字符串、reason |
| POST /admin/points/grants/:id/approve | version、reason；另一负责人批准并原子入账 |
| POST /admin/points/grants/:id/reject | version、reason；另一负责人驳回 |
| POST /admin/points/grants/:id/cancel | version、reason；申请人撤销 |

不开放通用status更新。常见错误403 INDEPENDENT_REVIEW_REQUIRED/FORBIDDEN，409 POINTS_GRANTS_PAUSED/POINTS_BUDGET_EXCEEDED/VERSION_CONFLICT/IDEMPOTENCY_CONFLICT/USER_UNAVAILABLE。

新增迁移202611020009_points_grants：points_grant_policies与points_grants、索引、终态保护和凭据约束。Prisma模型同步。只在随机临时测试schema重放；未对开发/生产库执行迁移，未发放真实积分。部署前需先应用P1a/P1b新增迁移，再启用匹配版本代码；旧应用回退应保留新表及流水，暂停新增发放，继续查询和后续纠错，不删事实。无默认经营规则种子。

## 实际验证

- Node24.22.1及pnpm10.28.2，无依赖升级。Prisma生成、全工作区构建（含微信weapp）、完整typecheck、lint与OpenAPI导出通过。
- 6项真实PostgreSQL集成测试通过：原账户隔离/配平/不可变回归，预算未配置拒绝、自审拒绝、运营无配置权限、同键并发批准唯一入账、修改摘要冲突、每日预算竞争只一个成功、驳回/撤销保护、晚期审计失败全回滚与原键恢复、CSRF/撤权和终态不可修改删除。
- 实际后台浏览器走通预算配置、提交、本人无审批按钮、第二负责人审批、响应丢失后原键恢复；核对一次到账30分。小程序同源码浏览器预览通过真实API查到顾客B的30分及流水。
- 22张截图，延续后台/小程序查询分页、空错态、账号切换及旧响应保护回归。脚本脚手架使用合成数据和临时schema，沿用P1a规模夹具限制说明；完成后全部清理。截图本地忽略，不提交。
- 实际查看申请桌面、审批手机和小程序到账截图；统一下拉框/多行输入样式后重验。

入口：保持本机PG启动及已有TEST_DATABASE_URL，锁定Node版本，设置YUMI_LIVE_UI=1和YUMI_PLAYWRIGHT_PATH为现有Playwright路径后运行npm run verify:points:grants。数据库测试npm run test:points。

截图：[申请表单](UI-POINTS-GRANTS-GRANT-CREATE-2026-11-02.png)、[手机审批](UI-POINTS-GRANTS-GRANT-REVIEW-MOBILE-2026-11-02.png)、[未知恢复](UI-POINTS-GRANTS-GRANT-UNKNOWN-RETRY-2026-11-02.png)、[小程序到账预览](UI-POINTS-GRANTS-MINI-GRANT-RECIPIENT-2026-11-02.png)。

## 未验证与下一步

微信工具/真机和真实微信身份仍未验，本轮小程序为同源码浏览器预览；真实经营预算、人员与发放依据待提供，跨自然日边界演练及完整生产回退未验。本轮不标记积分商城或P1整体完成。

下一项仍在P1内：发放纠错的独立审批扣减/冲正、余额不足处理及来源追溯，再进入P2兑换商品。首次经营开放前必须完成纠错能力与真实规则验收。保留当前未关联的微信项目配置和.pnpm-store变更。
