# 合成骑手接货与重复交接保护 · 2026-11-02

本轮补齐上一轮未验证实现，修复控制器误插入的重复接货服务方法。本人接货API、精确包裹数核对、不可变凭据、重复交接保护及原键恢复已完成本地功能验证。真实订单、库存、支付及实物交接保持隔离。

## 实际验证

- 12项配送PG测试全部通过（原分配7项、本轮接货5项）；相关拣货8、打包8、缺货9项均通过，共37项真实PostgreSQL用例。接货覆盖本人/他人/仓管权限、严格字段/整数、精确包裹数、同键并发恢复、新键竞争、数量改动冲突、数据库不可变/错数量/撤权保护、审计晚失败回滚、默认关闭与正式订单/库存/预占/账本/支付快照不变。
- 默认关闭/生产拒启配置检查通过1项。本环境tsx因Windows沙箱userInfo调用失败，PG测试采用Node24原生类型转换；配置测试对已构建config.js运行相同断言通过。首轮混合命令为35通过1个配置文件加载失败，不能称该轮全绿；配置及新增2项随后分别通过。
- 服务端构建、全工作区typecheck、lint及diff --check通过。后台和移动端使用Vite --configLoader runner构建通过，避开默认配置打包器对用户父目录的沙箱访问限制。weapp构建尝试因无权创建用户目录.taro4.0失败，本轮未通过小程序构建或微信工具/真机验收。
- 实际API自动导出OpenAPI0.32.0；新增accept接口和handoff返回字段。
- 浏览器连接实际API及临时PG schema，验证空/加载/错误/重试、分配及接货提交成功后响应中断、刷新后原body恢复、仅一份凭据、骑手本人列表及账号停用。1440桌面/390手机无横向溢出。14张截图，人工查看已接货桌面和手机布局，沿用绿白卡片及现有导航。

## 环境与迁移

已找到应用附带Node24.22.1，按pnpm10.28.2和frozen-lockfile恢复依赖，未改锁文件或项目版本。仅在忽略的.local安装测试工具：PostgreSQL17.11 Windows本地二进制（包17.11.0-beta.19）与Playwright1.56.1；没有Docker安装、外部账号、付费资源或生产变更。临时PG仅监听127.0.0.1:55439，测试数据库yumi_test设置UTC，与原容器UTC要求一致；临时schema按夹具清理。Windows默认时区曾导致地址夹具失败，设UTC后恢复。

迁移202611020002_delivery_handoffs已在真实PG临时schema内反复应用并验证。未建立/迁移本机正式开发库，无.env或默认演练开关修改。部署前仍须迁移目标数据库、生成Prisma Client及重建服务；回退关闭演练并保留接货事实。本轮不声称原API3000/后台5173/作业5174已运行新版。

## UI证据

- [手机核对表单](UI-DELIVERY-HANDOFF-RIDER-DETAIL-MOBILE-2026-11-02.png)
- [接货提交后响应未知](UI-DELIVERY-HANDOFF-ACCEPT-UNKNOWN-MOBILE-2026-11-02.png)
- [手机恢复凭据](UI-DELIVERY-HANDOFF-ACCEPTED-MOBILE-2026-11-02.png)
- [桌面恢复凭据](UI-DELIVERY-HANDOFF-ACCEPTED-DESKTOP-2026-11-02.png)
- [资格阻断](UI-DELIVERY-HANDOFF-BLOCKED-MOBILE-2026-11-02.png)

复跑UI：scripts/ui/verify-delivery-handoff.mjs，需YUMI_LIVE_UI=1、TEST_DATABASE_URL、YUMI_PLAYWRIGHT_PATH及Windows下YUMI_CHROME_PATH；默认使用原Linux Chrome路径。测试工具和密钥不提交。原请求恢复限当前进程页面/导航，整页重载后可读取已成功凭据，不声称跨浏览器持久化草稿。

真实支付、实物交接、配送/送达、微信真机及生产仍未验收，S6/S7整体不标记通过。下一项：合成配送开始与送达的一次性凭据基础，继续按本人权限、原请求恢复及无真实库存扣减边界推进。

清理确认：失败浏览器启动遗留的1个临时schema已清理；最终临时schema为0，隔离PostgreSQL已停止。
