# S5 支付结果与订单关闭竞争隔离判定 · 2026-11-01

接续5dd7ca0通知持久化任务。本轮加强真实未支付订单的关闭重读保护，建立支付结果合并/关闭判定纯函数，并交付管理员12场景验证页。没有渠道调用、支付入账、退款、真实回调或数据库状态放宽。

## 实现与验收边界

releaseUnpaidOrder在当前事务内自行FOR UPDATE锁定并重读真实订单，校验用户、仓库和支付快照；不信任调用者旧status。只有真实行AWAITING_PAYMENT+NOT_STARTED允许释放，已取消返回，不重写分配/流水/事件或支付准备关闭记录。6个调用者并发持有同一旧快照时，后续调用看到已取消，只有首次有效释放。消费者取消和超时worker继续使用相同函数，库存/支付准备/事件仍同事务。

paymentCloseDecision是保护性预案，mergePaymentEvidence只合并已验证/已匹配后将来才可使用的证据，均无数据库或渠道副作用。本轮不存在证据接收接口或结果持久化：

| 输入/证据 | 处理预案 | 直接本地释放 |
|---|---|---|
| 待支付+未发起，NONE | RELEASE_LOCAL | 允许当前本地取消函数执行 |
| 待支付+支付中，NONE | REQUEST_CHANNEL_CLOSE | 禁止 |
| UNKNOWN | QUERY_CHANNEL或矛盾快照核查 | 禁止 |
| 支付中+CLOSED | RECONCILE_CLOSE，需后续事务核对 | 禁止 |
| 支付中+SUCCEEDED | RECONCILE_PAYMENT，需后续事务核对 | 禁止 |
| 已取消+SUCCEEDED | REVIEW_LATE_PAYMENT | 禁止，不自动重开或退款 |
| 已支付 | NOOP_PAID或矛盾证据核查 | 禁止 |
| 成功/关闭冲突、未知枚举或不一致快照 | REVIEW_CONFLICT | 禁止 |

合并对NONE/UNKNOWN/CLOSED/SUCCEEDED/CONFLICT满足交换、结合、幂等；未知不降级已知，成功与关闭不论先后均变为粘滞冲突。它不证明某个渠道结果可信，也不替代金额、归属、订单/支付尝试匹配或数据库锁。未来适配器须先持久化支付已发起状态再调用渠道，并在同一支付尝试的锁内持久化证据。当前数据库仍拒绝PENDING/PAID，实验中的支付中/已支付只是纯输入；正式关闭确认后的释放、成功入账、查单和补偿未实现。

## API、UI与运行边界

新增GET /api/v1/admin/payment-close-lab?warehouseId=UUID与POST /run（body仅{}）。只返回12场景说明和本次实际判定结果，无订单状态输入。payment-readiness.read默认仅SUPER_ADMIN，检查启用仓库和范围；POST需要Origin/CSRF。复用PAYMENT_NOTIFICATION_LAB_ENABLED，默认0，生产/公开绑定/非本机开发测试库拒启。默认运行503。API0.18.0，实际OpenAPI已导出。

后台独立“支付关闭验证”沿用既有绿白布局，实际查看桌面/手机及错误截图；12项判定非固定成功文本，检查失败会返回FAILED。加载、运行、清除旧结果、重试、默认禁用和角色入口均按实际API验证。页面不写订单、预占、通知记录或审计，没有密钥/订单号/内部状态表单。

## 实际检查

| 检查 | 结果 |
|---|---|
| 新增真实PostgreSQL测试 | 6/6：权限/CSRF/严格输入及实验无写入、6并发旧快照关闭一次、伪造已取消快照仍重读、身份/仓库/未知支付快照阻断、超时与取消竞争/PAID写入拒绝、默认关闭及撤权 |
| 订单10+支付准备8相关PG回归 | 18/18；同次共24/24通过，包含晚期回滚及账本配平 |
| 纯判定测试 | 6/6：证据代数性质、完整状态矩阵、未知/关闭确认、到达顺序、迟到成功、非法输入 |
| 浏览器实际源码+一次性PG API | 12项判定、1440px桌面/390px手机、运行/错误重试/禁用/角色导航通过；0订单/支付准备 |
| 全工作区build | 通过，含微信weapp、后台/H5、API及Worker |
| 微信产物 | 9页面、3导入根检查通过；未重复原生开发者工具/真机验收 |
| typecheck、ESLint、Prettier、git diff --check | 通过 |
| 本机实际API与5173 | 默认关闭、匿名401、管理员说明12项、授权POST503，页面可用 |

没有重跑历史全量测试，不将历史数量计为此次执行。浏览器暂挂和503是受控边缘状态；页面运行的是确定性纯判定，不能称作真实支付成功与关闭网络并发验收。真实PG并发只覆盖当前允许的未发起支付取消/超时及重复调用保护。

## 截图

| 截图 | 状态 |
|---|---|
| [未运行桌面](UI-PAYMENT-CLOSE-IDLE-DESKTOP-2026-11-01.png) | 场景和隔离边界 |
| [通过桌面](UI-PAYMENT-CLOSE-PASSED-DESKTOP-2026-11-01.png) | 12项实际判定 |
| [通过手机](UI-PAYMENT-CLOSE-PASSED-MOBILE-2026-11-01.png) | 单列与长文换行 |
| [运行中](UI-PAYMENT-CLOSE-RUNNING-2026-11-01.png) | 防重复点击、旧结果清除 |
| [错误重试](UI-PAYMENT-CLOSE-ERROR-2026-11-01.png) | 无旧通过结果，重试恢复 |
| [关闭展示](UI-PAYMENT-CLOSE-DISABLED-2026-11-01.png) | 受控关闭状态 |
| [本机默认关闭](UI-PAYMENT-CLOSE-LIVE-DISABLED-2026-11-01.png) | 实际部署未启用实验 |

复现界面脚本scripts/ui/verify-payment-close.mjs，需显式YUMI_LIVE_UI=1和本机Playwright路径；使用一次性测试schema，不对运行库生成订单。测试命令npm run test:payment-close-policy、npm run test:payment-close。

## 兼容性、本机交付与接续

无新增迁移、依赖或既有行更改。Node24.22.0与工程声明24.22.1的既有差异未改变；沿用Docker Engine/本机PostgreSQL环境。核实本项目旧API/Worker/后台后重启加载最终构建。实际.env和默认隔离开关未改，真实支付继续disabled；订单/报价规则/配送范围/合成通知记录仍0，store保持UNCONFIGURED且下单关闭，测试schema残留0。独立验收会话结束已撤销。

本机后台http://127.0.0.1:5173/ → 支付关闭验证。PRD、API、数据、UI和接续文档同步。没有Git提交、小程序上传、生产部署、商户连接、实际支付/退款或真机支付验收。

下一项为支付尝试与未知结果持久化的隔离基础，继续保持真实渠道禁用；本轮不声称已完成真实支付竞争与补偿闭环。
