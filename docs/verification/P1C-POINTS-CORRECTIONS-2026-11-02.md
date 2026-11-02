# P1c 积分误发扣减、冲正与来源追溯 · 2026-11-02

分支：积分商城。状态：本地实现与隔离验证通过；未上线、未扣减真实用户积分。P1的账户、正向发放与关联误发纠错已具备本地开发闭环，微信工具/真机、经营规则和生产验收仍未通过。

## 本轮边界和经营规则

后台新增“积分误发冲正”导航、来源选择、申请列表及独立申请/审批详情。仅从本仓已批准入账的发放记录发起部分或全额冲正，不提供无来源扣余额、处罚、透支或自动追缴接口。来源可按用户名称搜索、游标续页，选项显示原发放积分、剩余可冲正数及业务凭据，选中后独立摘要展示，普通操作者无需输入UUID。

申请直接进入SUBMITTED，另一名负责人批准/驳回，仅申请人可撤销。累计“待审批+已批准”冲正数量不得超过原发放；申请时占用来源额度但不冻结账户余额，批准时重验余额。驳回/撤销释放来源额度，已批准持续占用；不允许重复冲正已经纠正的积分。

余额不足返回POINTS_INSUFFICIENT，申请仍待审批、版本和余额不变，不扣成负数、不自动扣后续到账积分。负责人可在核查余额及凭据后主动重试，也可驳回或由申请人撤销。余额不足后的重试是人工动作，不承诺未来自动成功。发放暂停时仍允许处理已入账误发的独立审批冲正；冲正不恢复原发放每日预算。

本切片的扣减仅用于关联原发放的误发纠错。普通无来源人工扣减未纳入首发，也不自动生成任何现实欠款结论。

## 数据、事务与权限

新增迁移202611020010_points_corrections及Prisma模型：points_corrections，原发放(id,warehouse_id,user_id)复合唯一约束，复合外键保证同用户/同仓来源；申请人/审批人外键，来源/范围索引。SQL沿用合法迁移、独立审批、终态不可改删保护，并增加来源不可改、累计额度及批准负流水凭据的延迟约束。

锁序：事务内重验员工/会话/角色/仓库→同仓发放规则advisory锁→原发放行→冲正申请→积分账户。与正向发放保持同仓串行协议；批准余额、唯一CORRECTION:<申请ID>负流水、终态、审计和幂等结果同事务提交。重复原键返回原成功结果，变更摘要冲突；审计等晚期失败全部回滚。原发放及正流水保持原样。

权限复用points.write，运营/负责人可申请，另一负责人可批准/驳回。仓库范围、来源资格和当前有效员工会话在服务端裁决，前端按钮只反映资格。拒绝客户端指定userId或任意status；目标用户由原发放推导。

模型与迁移仅在随机临时schema重放验证，本轮未应用开发/测试主schema或生产迁移。部署须先迁移再运行新API，因为流水查询会关联新表；无需历史积分回填，也不改历史流水。回退应保留事实并暂停新增发放/冲正，不通过删除负流水恢复积分。已批准错误冲正的补偿应另走有凭据的正向发放申请，不编辑旧扣减。

## API与小程序

实际OpenAPI0.40.0已从代码导出。接口前缀/api/v1；员工Cookie、Origin/CSRF、写操作Idempotency-Key及现有错误包裹继续适用。

| 接口 | 行为 |
| --- | --- |
| GET /admin/points/corrections | cursor可选，20条UUID升序申请列表及原发放积分/凭据，不声称按时间倒序 |
| GET /admin/points/corrections/sources | keyword按用户名称、cursor分页，只返回本仓已入账来源及remainingAmount；零额度选项不可选 |
| POST /admin/points/corrections/store/create | grantId、amount十进制字符串、reason、reference；原子检查来源额度并建申请 |
| POST /admin/points/corrections/:id/approve | version、reason；独立审批并原子扣减 |
| POST /admin/points/corrections/:id/reject | version、reason；独立驳回并释放申请占用 |
| POST /admin/points/corrections/:id/cancel | version、reason；本人撤销并释放占用 |

新增错误CORRECTION_SOURCE_INVALID、CORRECTION_LIMIT_EXCEEDED、POINTS_INSUFFICIENT；沿用VERSION_CONFLICT/INDEPENDENT_REVIEW_REQUIRED/IDEMPOTENCY_CONFLICT等。金额技术范围1–10亿整数积分，不代表正式经营授权。

本人及后台积分流水增量返回entryKind（GRANT/GRANT_REVERSAL/ADJUSTMENT）、sourceAmount、sourceCreatedAt、relatedEntryId。relatedEntryId关联原正流水，所有连接均限定同一用户。小程序与后台展示“误发冲正·原发放积分/北京时间”，不把内部业务凭据或员工身份暴露给顾客。原流水与负流水均保留。小程序本轮为同源码浏览器预览，非原生微信验收。

## 页面与验证

沿用现有品牌绿和列表/独立表单交互，对照既有ui视觉参考延续样式。复用审批组件但按角色和业务独立导航；发放和冲正组件实例使用不同key，避免切换时复用另一业务的请求/状态。补充原来源续页及查询期间禁止提交，关闭表单使迟到的来源查询失效。

实际检查（Node24.22.1/pnpm10.28.2，无依赖升级）：

- Prisma生成、全工作区构建（含微信weapp）、typecheck、lint及OpenAPI导出通过。
- 8项真实PostgreSQL集成通过（2项新增组合场景+6项回归）：来源额度并发、防自审/越权、撤销释放、同键并发只扣一次、摘要冲突、终态和来源不可改删；余额不足保持待审批、审计晚期失败回滚、原键恢复、预算保持原值及流水来源关联。
- 实际API/临时PG浏览器通过双员工申请/审批；余额5时冲正10被拒绝，合成恢复余额后主动批准；提交成功响应丢失时使用原键恢复，只扣10。后台来源详情、小程序余额20及负流水/原发放30来源验证通过。
- 28张本地截图，包含发放、原查询分页/弱网/账号切换回归，以及冲正空态、申请、余额不足、未知结果恢复、成功与来源详情；无页面横向溢出及运行错误。已实际查看桌面申请、手机余额不足和小程序来源页面。

测试中的消费-25及恢复+25、数据库场景的余额消耗均为临时schema合成夹具，用于制造余额竞争前提，不代表商品兑换已经实现。沿用P1a大列表夹具（仅临时schema解除A/B subject限制）；业务库规则未变。脚本结束清理临时schema，截图按现有约定本地忽略。

重跑：保持本机PG与已有.env的TEST_DATABASE_URL，设置锁定Node24路径、YUMI_LIVE_UI=1、YUMI_PLAYWRIGHT_PATH为现有Playwright，执行npm run verify:points:corrections；数据库测试npm run test:points。

截图：[桌面申请](UI-POINTS-CORRECTIONS-CORRECTION-CREATE-DESKTOP-2026-11-02.png)、[余额不足](UI-POINTS-CORRECTIONS-CORRECTION-INSUFFICIENT-MOBILE-2026-11-02.png)、[原键恢复](UI-POINTS-CORRECTIONS-CORRECTION-UNKNOWN-MOBILE-2026-11-02.png)、[来源详情](UI-POINTS-CORRECTIONS-CORRECTION-SOURCE-DETAIL-2026-11-02.png)、[小程序负流水与来源预览](UI-POINTS-CORRECTIONS-MINI-CORRECTION-SOURCE-2026-11-02.png)。

## 后续与未验证

下一项按计划进入P2：后台兑换商品管理和小程序积分商城/详情，复用真实SKU和库存，不提前开放兑换下单。

仍未验证：微信工具/真机、真实身份/网络、生产部署/恢复、跨自然日预算切换、超过20条原发放的来源选择UI与更多并发撤权交错。真实经营预算、发分依据及售后规则仍待配置/验收，不将P1本地闭环当成积分商城上线通过。
