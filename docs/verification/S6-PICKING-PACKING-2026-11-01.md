# S6 合成打包完整性与幂等出库 · 2026-11-01

本轮完成合成任务的打包前完整性核验、领取人精确数量确认、负责人/仓管一次性合成出库、不可变凭据和未知结果原键恢复。后台与移动作业页面连接实际API，仍沿用现有绿白风格。仅为隔离演练，不执行真实库存出库或骑手交接。

## 任务边界与验收案例

- 两行全部核对且无OPEN缺货才能打包；装包数量必须单包装2包、3包装1组。仅领取人可确认，包裹数1–20仅为开发保护范围，未确认为经营规则。
- 每任务最多一份打包凭据，负责人/仓管引用匹配凭据确认最多一次合成出库。任务进度仍CHECKED，打包/出库阶段由独立事实展示；没有修改、撤销、再次出库或骑手指派入口。
- 所有写入校验角色、当前仓库、Origin/CSRF、严格字段与版本。锁同一任务，原人员/键/内容重试只返回原结果；换键重复阶段或改内容拒绝。原打包请求在出库后仍能恢复。
- 凭据和审计同事务，晚失败全部回滚；数据库补充完整性、领取人、数量、版本、同任务打包外键和不可变约束。
- 未关联真实订单/SKU/库存/支付/骑手。默认PICKING_LAB_ENABLED=0，生产及暴露绑定拒启；真实订单资格、库存与预占不变。

## 模型、接口、兼容性

新增202611010011_picking_dispatch，开发库yumi_dev与测试库yumi_test均已应用，Prisma Client已生成。新增picking_lab_packs与picking_lab_dispatches；旧任务不补造凭据，原状态/版本和缺货逻辑保持。需要先迁移再部署读取新关系的服务；回退关闭演练写入、保留历史，不提供删除事实的回退脚本。

OpenAPI0.30.0已从实际应用导出：POST任务pack及dispatch，GET/写回增加packingReadiness和可空pack/dispatch投影。新出库权限picking-lab.ship只赋予SUPER_ADMIN、WAREHOUSE_MANAGER；picker仍只能本人打包。接口、PRD、数据设计和UI说明已同步。

## 实际功能验证

最终完整一轮33项全部通过：新增8项真实PostgreSQL，既有拣货演练8、缺货9、真实订单准备7，合计32项PG，另1项配置检查。首次测试快照曾误用库存模型和排序字段，修正测试读取后重新完整运行，未放松业务约束。

| 范围 | 实际结果 |
| --- | --- |
| 完整性 | READY/未完成/未决缺货不能生成凭据，精确数量/旧版本拒绝 |
| 权限与输入 | 非领取人不能打包，picker不能出库，仓管可出库；CSRF/分仓/未知任务/多余字段/整数与范围检查通过 |
| 幂等与并发 | 同键竞争只一份打包/出库和对应审计，新键竞争一成功一409；已出库后原打包请求仍恢复；改内容、换人员、重复阶段拒绝 |
| 事务与DB | 两阶段审计失败各自回滚且原键可重试；DB拒绝未完成/错领取人/旧快照、凭据更新和删除 |
| 真实业务边界 | 完整演练前后真实订单、预占、库存余额/流水及支付准备快照完全一致；默认关闭两路写入503 |
| UI与真实API | 未完成禁用、错误数量保留输入、打包已提交但断网、侧栏切换/刷新后原请求恢复；出库已提交但503、最终凭据和原键恢复；加载/读取503与重试恢复 |
| 桌面/手机 | 1440与390宽度，无横向溢出；实际移动作业角色布局，10张功能截图与2张本机默认关闭截图；人工查看桌面数量错误、手机待出库和完成状态并对照ui/board1 |
| 构建与静态 | 全工作区build通过，包含API/Worker/共享包/后台/移动作业/weapp；最终间距调整后共享UI与两Web端重建；typecheck、lint、format:check、git diff --check通过 |
| 小程序 | weapp编译及9页面/三个导入根产物校验通过；本轮未重新执行微信开发者工具、微信真实网络或真机检查 |

复跑入口：`npm run test:picking-packing`；完整回归为node测试运行器顺序执行picking-packing、picking-lab、picking-shortage、picking-readiness和picking-lab-config。UI脚本`scripts/ui/verify-picking-packing.mjs`需显式YUMI_LIVE_UI=1及本机Playwright路径；启动私有测试API/Vite，所有数据在可清理schema内，故障注入只作用于浏览器响应。

沿用Docker Engine/PostgreSQL17.11与锁定依赖。Node24.22.0与声明24.22.1既有差异未改；pg单连接并发query弃用警告仍存在，未升级依赖。

## 独立UI证据

在原详情增加独立打包/出库卡片，以规格和数量操作，操作人/时间只读展示；不要求用户输入内部UUID、版本或请求键。主状态与凭据同步，提交中禁用控件，请求结束仍未知才显示恢复提示。刷新看到凭据不代替原键确认，切换侧栏仍可继续恢复。

- [未完成禁用](UI-PICKING-PACKING-INCOMPLETE-DESKTOP-2026-11-01.png)、[装包数量拒绝](UI-PICKING-PACKING-QUANTITY-ERROR-DESKTOP-2026-11-01.png)
- [打包结果未知](UI-PICKING-PACKING-PACK-UNKNOWN-DESKTOP-2026-11-01.png)、[领取人只读打包凭据](UI-PICKING-PACKING-PACKED-MOBILE-2026-11-01.png)
- [仓管待出库](UI-PICKING-PACKING-DISPATCH-READY-MOBILE-2026-11-01.png)、[出库已提交但响应未知](UI-PICKING-PACKING-DISPATCH-UNKNOWN-DESKTOP-2026-11-01.png)
- [桌面完成](UI-PICKING-PACKING-COMPLETED-DESKTOP-2026-11-01.png)、[手机完成](UI-PICKING-PACKING-COMPLETED-MOBILE-2026-11-01.png)
- [详情加载](UI-PICKING-PACKING-LOADING-MOBILE-2026-11-01.png)、[读取失败](UI-PICKING-PACKING-READ-ERROR-MOBILE-2026-11-01.png)
- [本机后台默认关闭](UI-PICKING-PACKING-LIVE-DISABLED-DESKTOP-2026-11-01.png)、[本机移动作业默认关闭](UI-PICKING-PACKING-LIVE-DISABLED-MOBILE-2026-11-01.png)

## 本机状态与未验证部分

API3000、后台5173、移动作业5174已加载新版。健康200；授权演练列表200/empty/enabled=false，匿名401，未知详情404；创建/上报/处理/打包/出库503。演练任务/事件/缺货/缺货事件/打包/出库全部0；正式订单/规则/范围及支付实验数据仍0，测试schema0。store仍UNCONFIGURED、下单关闭，自动查询Worker关闭。.env和Worker未改；验收独立员工会话已撤销。

S6整体未验收，真实支付、实物出库、骑手交接/配送及生产均未开放。下一项：合成骑手任务分配与交接资格基础，继续隔离真实订单/库存；真实交易仍需已确认经营规则与渠道联调、HTTPS和微信真机验收。
