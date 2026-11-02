# 合成配送开始与送达凭据 · 2026-11-02

本轮完成本人合成配送开始、合成送达、逐阶段不可变凭据和原请求恢复。延续独立列表/详情、绿白卡片与手机角色入口；所有界面连接实际API。真实订单、顾客、库存、支付及实物配送保持隔离。

## 范围及规则

- 仅已分配骑手本人可写；新增delivery-lab.work只授予RIDER，仓管/负责人可读取本仓进度，不能代骑手完成。未分配/他人任务404，未授权仓库403，严格UUID/字段及CSRF检查。
- 显式POST /delivery-lab/:id/start和/complete（warehouseId查询参数），请求仅key(UUID)。必须先合成接货才能开始，先开始才能合成送达；不能通过通用状态接口跳步。每阶段最多一份事实。
- 同阶段原键恢复结果，换键409。完成后仍可恢复原开始请求；恢复只读取原凭据，不回退阶段或重复审计。账号/角色/本仓权限撤销后，后续写入受当前鉴权限制。
- 首次写入锁原合成任务，锁定并重验启用骑手、RIDER、本仓范围及出库快照/未决缺货；原凭据、审计同事务。数据库同样校验阶段前置及资格，拒绝事实更新删除。
- 骑手需显式勾选合成动作确认，前一阶段结果未知时只恢复原请求；界面没有顾客签收、定位、照片、联系资料或真实送达声明。普通页面不输入UUID/请求键。

## 模型、API和部署

新增202611020003_delivery_journey、delivery_lab_journey_facts（UUID、assignment_id FK、START/COMPLETE、原键、创建时间，assignment_id+kind唯一）。骑手及姓名来自不可变分配；历史分配/接货不补造阶段事实。DTO新增journey.start/completion可空凭据{id,createdAt}，不暴露原键。OpenAPI0.33.0从实际应用自动导出。

迁移在本机PostgreSQL17.11临时schema反复执行通过，Prisma Client已生成。没有应用到正式开发库、没有修改.env或开启默认实验；部署须先迁移目标数据库、生成Client并重建服务。回退应先关闭演练，保留阶段事实，不运行会忽略已有送达凭据的旧服务继续作业。

## 实际功能检查

- 配送PG16项全部通过，其中新增阶段测试4项，涵盖阶段顺序/权限/CSRF/输入、同键并发/不同键竞争及完成后原开始恢复、DB不可变及撤权保护、默认关闭、两阶段审计晚失败回滚、完整流程前后正式订单/库存/预占/流水/支付快照不变。
- 打包PG回归8项全部通过；共24项真实PostgreSQL用例。配置默认关闭与生产拒启1项通过（沿用上轮对编译config.js执行相同断言的本地副本）。Node24.22.1原生类型转换运行PG测试，未使用无法在此沙箱调用userInfo的tsx。
- 服务端构建、全工作区typecheck通过。共享UI、后台/H5构建通过；Web使用Vite --configLoader runner避开沙箱父目录读取限制。lint、修改文件Prettier检查、git diff --check通过。
- 未重复运行小程序构建：上轮用户目录.taro4.0写入限制仍未解决；本轮无微信开发者工具/真实网络或真机验证。
- 浏览器使用实际API与PG临时schema，完成开始和送达两次提交成功/中断响应、刷新后原body重试、数据库仅两份阶段事实，以及列表、角色隔离、加载/错误/空态回归。1440桌面/390手机无横向溢出，生成19张截图；人工查看完成态桌面/手机布局，并移除成功读取后无内容的接货表单卡片。

## UI证据及复跑

- [待开始手机](UI-DELIVERY-JOURNEY-ACCEPTED-MOBILE-2026-11-02.png)
- [开始结果未知](UI-DELIVERY-JOURNEY-START-UNKNOWN-MOBILE-2026-11-02.png)、[配送中](UI-DELIVERY-JOURNEY-START-MOBILE-2026-11-02.png)
- [送达结果未知](UI-DELIVERY-JOURNEY-COMPLETE-UNKNOWN-MOBILE-2026-11-02.png)、[完成手机](UI-DELIVERY-JOURNEY-COMPLETE-MOBILE-2026-11-02.png)
- [完成桌面](UI-DELIVERY-JOURNEY-COMPLETED-DESKTOP-2026-11-02.png)

scripts/ui/verify-delivery-journey.mjs需本地显式YUMI_LIVE_UI=1、TEST_DATABASE_URL、Playwright路径和Chrome路径；同上轮.local测试工具，未改项目依赖/锁文件。PG测试tests/delivery-lab.integration.test.ts和tests/picking-packing.integration.test.ts。页面原请求草稿限当前浏览器进程内导航/刷新详情恢复，不承诺整页重载后的草稿持久化；已成功凭据可重新读取。

## 未验收与下一项

没有真实配送、顾客签收、微信真机、真实支付或生产验收；S6/S7整体不标记通过。本机正式API3000/后台5173/作业5174未部署新版，截图来自可复跑隔离验证页面。下一项：合成配送异常上报与未决异常阻断基础；改派、退款、退回入库规则不由本轮假定。

收尾确认：临时schema为0，隔离PG已停止；业务开发库及默认演练开关未改。
