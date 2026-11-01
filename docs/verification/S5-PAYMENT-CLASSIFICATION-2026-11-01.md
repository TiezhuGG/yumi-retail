# S5 查询分类持久化与人工核查分流 · 2026-11-01

接续1614cf0。将上轮内存查询契约接入合成查询任务，交付不可变分类历史、退避/核查分流、相反已知证据保护及实际后台详情。真实渠道、真实订单支付状态及资金动作仍关闭。

## 完成范围与验收规则

查询契约及17个固定夹具移入数据库共享包，API和Worker共用一套分类核心；API保留原导出桥接，原验证页仍只在内存运行。自动Worker默认关闭，显式本机启用时采用固定NOTPAY场景；手动查询可选择固定场景，不能提供原文、URL、凭据或任意结果。场景使用专用合成身份和金额，不代表真实订单绑定。

查询在事务外执行，完成时按仓库→尝试→任务锁重读数据库时钟、任务归属和租约令牌。有效完成将classification、resultEvidence、next、scenario及关联尝试事件写入同一事务；任何晚期失败全部回滚。过期/被替换令牌不写分类或证据，重复完成不追加。

- RETRY建议保留UNKNOWN，沿用1秒/5秒退避、每轮3次上限；第三次仍可重试但任务EXHAUSTED，历史保留分类。
- REVIEW建议保留UNKNOWN并将任务置REVIEW。自动领取及原“重新安排”不能绕过，核查备注不恢复任务。
- 合成SUCCEEDED/CLOSED只更新实验尝试证据并将任务DONE，建议仍为事务核对，releaseAllowed=false，未入账、释放、退款或推进履约。
- 查询途中收到相反已知证据时，两种方向均合并CONFLICT并置REVIEW，不能丢弃矛盾证据。UNKNOWN不覆盖已知；已有已知结果而查询仍未知时仅停止任务，不追加一条降级证据。
- 历史/领取/停止事件无查询结果时四字段保持null，不补造过去事实。

## 数据、API及兼容性

增量迁移`202611010007_payment_query_classifications`增加四个可空事件字段、REVIEW状态及完成原因；SQL检查分类/证据/建议/状态组合、固定场景白名单及关联证据一致性，保留原不可变及版本链约束。新完成结果要求分类，部署时需停旧API/Worker后迁移并启动新构建，不能让旧Worker继续写迁移后完成事件。没有真实业务表迁移或回填；后退旧应用需要兼容处理，不能删新历史。

GET尝试列表增加queryScenarios，详情任务历史增加四字段。原POST `run-query-cycle`兼容空JSON并允许可选scenario（默认NOTPAY）；运行本仓下一条到期任务，可能是其他尝试，页面明确说明。processed=false表示无可提交任务。此入口是单轮触发，响应不明先刷新；完成幂等由租约令牌/事件唯一键保证，不将新一次触发冒充原键重放。

核查列表新增filter=REVIEW，备注可保存REVIEW快照；其他权限、CSRF、Origin、版本与游标保护不变。OpenAPI更新0.23.0，PRD/API/数据/UI设计及主路线同步。

## 实际检查

| 检查 | 结果 |
| --- | --- |
| 新增分类真实PostgreSQL集成 | 8项最终全部通过：场景/权限严格输入、重试持久化、核查停止与备注、已知合成事实、双向冲突、过期/旧租约、晚期失败回滚、历史不可变/新客户端恢复及竞争耗尽 |
| 原支付尝试/查询/核查备注PG回归 | 8+10+8=26项通过；新增8项与此26项共34个独立案例，分轮验证，不宣称单轮34全绿 |
| 历史结构升级 | 原查询迁移测试补充升级到最新结构，单独复跑1项通过，历史分类四字段保持null；计入原10项，不重复加数 |
| 纯逻辑 | 适配器契约6项及证据合并/关闭策略6项，共12项通过 |
| `npm run db:generate`、`npm run build:server` | 通过 |
| `npm run lint`、`npm run typecheck` | 最终通过 |
| `npm run build` | 全工作区、API/Worker、后台/作业端和weapp通过；最终页面说明与样式修改后再次构建共享UI及后台/作业端通过 |
| `node scripts/verify-mini-artifacts.mjs` | 9页面及三个导入根检查通过 |
| 本机两库迁移 | 开发库、测试库均应用0007迁移成功 |
| `scripts/ui/verify-payment-query-classification.mjs` | 最终同源码Chrome+一次性PG/API，10张桌面/手机截图，无横向溢出 |
| OpenAPI | 已从实际应用导出0.23.0 |

首次迁移的PL/pgSQL CASE条件缺括号已修正；夹具在事务迁移失败时不能正确清理的问题一并修复为先ROLLBACK。初次新增测试有一条将夹具已有2条库存流水误当新增，改为执行前后对比并复跑8项全部通过。失败迁移留下的9个随机测试schema已清除，最终测试schema为0。没有把这些失败计作通过。

Node24.22.0与声明24.22.1的既有差异仍保留，未升级依赖。沿用既有Docker Engine上的PostgreSQL，不重置数据库。

## UI单独验收

沿用当前绿白卡片。新增场景下拉为统一圆角控件；详情展示分类、查询证据、建议及任务状态。REVIEW红色提示停止自动查询，重新安排禁用；核查筛选可查看并追加备注。证据历史改用“已记录…”表述，避免把每次未知查询都误称为响应丢失。

真实源码页面与隔离API实际验证空态、限流重试、运行中、查询已落库但503响应丢失后的刷新恢复、核查停止、REVIEW筛选及备注、合成成功和默认关闭。503及延迟通过受控浏览器响应制造，数据库真实保存，不冒充真实渠道故障。检查过程中无真实订单或支付准备新增。

- [空态桌面](UI-PAYMENT-CLASSIFICATION-EMPTY-DESKTOP-2026-11-01.png)
- [重试分类桌面](UI-PAYMENT-CLASSIFICATION-RETRY-DESKTOP-2026-11-01.png)
- [运行中手机](UI-PAYMENT-CLASSIFICATION-RUNNING-MOBILE-2026-11-01.png)
- [响应丢失手机](UI-PAYMENT-CLASSIFICATION-LOST-RESPONSE-MOBILE-2026-11-01.png)
- [核查桌面](UI-PAYMENT-CLASSIFICATION-REVIEW-DESKTOP-2026-11-01.png)、[核查手机](UI-PAYMENT-CLASSIFICATION-REVIEW-MOBILE-2026-11-01.png)
- [核查备注](UI-PAYMENT-CLASSIFICATION-NOTE-DESKTOP-2026-11-01.png)
- [合成已知桌面](UI-PAYMENT-CLASSIFICATION-KNOWN-DESKTOP-2026-11-01.png)、[合成已知手机](UI-PAYMENT-CLASSIFICATION-KNOWN-MOBILE-2026-11-01.png)
- [受控默认关闭手机](UI-PAYMENT-CLASSIFICATION-DISABLED-MOBILE-2026-11-01.png)
- [实际本机默认关闭](UI-PAYMENT-CLASSIFICATION-LIVE-DISABLED-2026-11-01.png)

## 本机结果与未验证

本机API3000、后台5173及Worker已更新重启。健康200、匿名401、授权17场景可读但enabled=false、选择SUCCESS触发查询仍503；REVIEW筛选空列表，创建按钮禁用。真实经营状态UNCONFIGURED、下单关闭，订单/规则/范围/合成尝试/任务/备注均0；自动查询仍关闭、.env未改，验收会话已撤销。迁移仅实验表，无新增经营示例数据。

微信原生页面无改动，小程序已编译并检查产物；没有重新运行开发者工具/微信网络或真机，未接入真实商户支付、HTTP响应验签、公钥轮换、退款或真实对账。分类事实与查询尝试仍是独立合成系统，不能视为支付上线。

下一项：合成通知与支付尝试关联及证据一致性，连接通知去重与尝试证据链，验证重复/错绑/相反证据及对应详情，继续保持真实渠道关闭。

补充边界：REVIEW任务后来追加合成成功证据，也保留在“全部待核查”列表且needsReview=true，不能通过证据按钮清除核查要求；已补对应断言及原筛选回归。
