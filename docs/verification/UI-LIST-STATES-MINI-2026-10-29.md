# 首页、目录与库存状态收尾及微信编译

日期：2026-10-29。承接收货UI，边界为已有首页、商品/分类/库存的加载、空、错误及角色入口一致性，并编译现有微信小程序。不增加商品维护业务，不改变库存/权限规则。

## 本轮交付

商品、分类、库存、首页收货数据分别使用带请求序号和URL保护的分页读取。收货失败不再阻断库存，商品失败不再遮住仓储作业。每个列表提供加载、错误重试、真实空态；加载或失败时首页指标显示“加载中”或“暂不可用”，不显示虚假的零待办。数量仅表示已载入数据，不能当作全库经营统计；分页仍使用原API游标。

仓库加载/失败重试/无授权仓库单独显示，切换仓库后旧请求不能覆盖新仓数据。切换页面在绘制前清除上一页筛选和反馈。商品资料加载失败不妨碍查看库存；未载入名称的库存继续保留在搜索结果，提供资料重试/继续加载入口。库存“无盘点/核对暂停”只说明这两种账面限制，不表示可售。

工作区将实际允许的页面传给快捷入口，导航和跳转统一检查。移动仓管首页不再跳进未开放的商品管理页面；PICKER库存页没有收货入口，移动PICKER保留库存/库位两个查询入口。服务端鉴权不变。

商品/分类保存失败显示红色错误并保留输入，提交期间禁止修改字段。创建已获成功响应后立即关闭新建窗口；后续列表读取失败会明确提示“已保存，列表刷新失败”，避免再次创建。未知网络响应仍沿用既有同窗口意图键重试，跨重载恢复不在本次范围。

API契约、PRD业务规则、数据库表/迁移均无变化。锁文件和微信工程配置不变；只补装锁定的构建依赖，并忽略此次生成的SWC平台缓存，未删除已有缓存文件。

## 功能检查（本轮实际运行）

- 共享web-ui构建/类型检查，admin-web及ops-mobile两端构建/类型检查通过；修改代码及验证脚本ESLint/Prettier、git diff检查通过。
- 新脚本 `scripts/ui/verify-list-states.cjs`：各列表加载/空/失败、重试、首页失败不显示零、收货失败但库存可用、延迟旧仓响应、跨页筛选重置、创建成功但刷新失败、后台只读PICKER、移动仓管/PICKER及320/375/414宽度。合成响应，无pageerror，不作为数据库业务验收。
- 回归收货、库位、盘点、隔离报损/纠错四个UI脚本通过；回归截图写入 `/tmp/yumi-list-regression/docs/verification`，未覆盖历史交付截图。
- 新脚本 `scripts/ui/verify-list-states-live.cjs` 登录本地仓管，真实API读取 **3个商品、1个分类、3条库存**，逐行比对实物/预占/不可售与页面一致。未执行商品或库存写入；仅创建登录会话。仅允许本机yumi_dev，凭据读取忽略的.env，不写入截图或报告。
- 本轮没有改动交易/库存服务，没有重跑历史PostgreSQL交易集成套件，也不把历史通过数量算成本轮结果。真实页面读请求使用既有本地API/PostgreSQL；继续使用Docker Engine，未变更数据库容器/镜像。

## UI查看与截图

对照 `ui/board1` 的工作台、商品和分类列表方向，保留统一侧栏、筛选、状态标记与独立窗口；商品图继续标明包装示意。实际查看桌面错误/空态、真实商品列表、手机库存及PICKER查询页面，错误使用红色且带重试。手机库存以卡片展开实物/预占/不可售，无页面横向溢出。

| 页面 | 证据 |
|---|---|
| 首页错误不冒充零待办 | [桌面](UI-LISTS-OVERVIEW-ERROR-2026-10-29.png) / [移动仓管入口](UI-LISTS-OPS-OVERVIEW-2026-10-29.png) |
| 商品 | [真实API列表](UI-LISTS-LIVE-PRODUCTS-2026-10-29.png) / [加载](UI-LISTS-PRODUCTS-SLOW-2026-10-29.png) / [空](UI-LISTS-PRODUCTS-EMPTY-2026-10-29.png) / [错误](UI-LISTS-PRODUCTS-ERROR-2026-10-29.png) / [筛选无结果](UI-LISTS-PRODUCTS-FILTER-EMPTY-2026-10-29.png) |
| 分类 | [加载](UI-LISTS-CATEGORIES-SLOW-2026-10-29.png) / [空](UI-LISTS-CATEGORIES-EMPTY-2026-10-29.png) / [错误](UI-LISTS-CATEGORIES-ERROR-2026-10-29.png) |
| 库存 | [真实API手机](UI-LISTS-LIVE-STOCK-2026-10-29.png) / [加载](UI-LISTS-STOCK-SLOW-2026-10-29.png) / [空](UI-LISTS-STOCK-EMPTY-2026-10-29.png) / [手机错误](UI-LISTS-STOCK-MOBILE-ERROR-2026-10-29.png) / [恢复](UI-LISTS-STOCK-MOBILE-2026-10-29.png) |
| 仓库及权限 | [仓库失败](UI-LISTS-WAREHOUSE-ERROR-2026-10-29.png) / [无授权仓库](UI-LISTS-WAREHOUSE-EMPTY-2026-10-29.png) / [移动PICKER](UI-LISTS-OPS-PICKER-2026-10-29.png) |

运行API/admin/ops后可直接审阅，后台 http://127.0.0.1:5173/ ，移动作业 http://127.0.0.1:5174/ 。新浏览器脚本从项目根目录执行，外部Playwright安装路径可通过 `YUMI_PLAYWRIGHT_PATH` 指定。正常页面始终使用真实API，只有验证脚本拦截合成响应。

## 微信小程序编译

本轮已执行并通过：

```sh
pnpm --filter @yumi/consumer-mini... install --frozen-lockfile --store-dir /tmp/yumi-pnpm-store
npm run build:mini
npm run verify:mini
pnpm --filter @yumi/consumer-mini typecheck
```

Taro **4.3.1** / webpack5，编译目标 **weapp**，编译器报告成功（5.11秒）。输出 `apps/consumer-mini/dist/`，包含app.js/app.json、首页及商品详情JS/WXML；三个工程导入根路径校验通过。编译前后根目录与子工程project.config.json SHA256一致，保留负责人已有AppID/设置；没有变更任何微信工程配置。根目录导入项目即可使用此次产物。

实际Node **24.22.0**，与项目要求24.22.1相差一个补丁，pnpm给出engine警告；此环境下上述编译/检查实际通过，未据此重写版本矩阵。pnpm提示忽略了部分依赖安装脚本（含Taro CLI/core-js），未无差别启用，现有构建通过。Taro仅提示可启用持久缓存，无编译错误。

默认API地址仍为 `http://127.0.0.1:3000/api/v1`，适用于本机开发；真机的地址/合法域名和连接需另验。本轮未操作微信开发者工具、未上传微信版本、未做真机/支付验收；此前工具模拟器记录属于历史证据，不能替代本轮重编译后的检查。

## 下一项与待验收

本轮代码和截图已具备负责人审阅条件，完整UI尚未产品确认。下一项为微信开发者工具导入本次产物、模拟器联通及真机检查，并汇总后台/移动角色UI审阅；不能仅凭编译通过恢复新增商品维护业务。真实支付、实体触控/键盘、全业务闭环及生产发布未验收。
