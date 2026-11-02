# P1a 积分账户界面验证与交互收尾 · 2026-11-02

分支：积分商城。状态：后台与小程序同源码浏览器验收通过；微信开发者工具与真机未验。P1整体仍待发放审批切片完成。

## 本轮边界与结果

完成上轮P1a遗留的实际UI检查，并修正检查中发现的问题：

- 后台采用独立搜索表单、账户列表与流水详情，沿用ui/board1的品牌绿、白色表格及清晰导航；桌面1440与手机390均检查无页面横向溢出。
- 搜索草稿与已提交条件分离，修改输入但未查询时，加载下一页继续使用原条件。账户列表23条与流水25条均通过跨页检查。
- 分页失败保留已加载记录，重试原请求游标，不退回第一页或重复追加；详情增加刷新入口。
- 员工失去经营仓库授权后再次读取，清除已加载的账户/流水及详情，服务端仍拒绝访问。
- 小程序参考ui/mini1并沿用现有“我的”样式；登录、重试和分页按钮至少44px高，流水显示北京时间。
- 小程序由顾客A切换至B清除旧流水；退出后迟到响应不能重新显示A的余额。修正旧游客态可能遮挡登录读取错误的问题，页面卸载使旧请求结果失效。
- 修正上轮积分测试夹具中遗留的无效ServiceAreaDetail类型引用；完整根目录类型检查现已通过。
- 小程序产物检查清单补入积分页的路由、JS和WXML，防止新页面已编译却在入口检查阶段误报失败。

本轮无API规则、OpenAPI版本或数据库迁移变化；现有积分查询仍为只读，没有发分/兑换入口，没有对开发或生产数据库应用迁移。

## 实际验证

使用本机已有Node24.22.1与pnpm10.28.2，未安装或升级依赖：

| 检查 | 实际结果 |
| --- | --- |
| npm run build | API/Worker/后台/作业端/微信weapp均通过 |
| npm run build:mini | 最终源码weapp编译、三个微信导入根及构建清单通过 |
| npm run typecheck | 全工作区及根测试类型检查通过 |
| npm run lint | 通过 |
| tests/points.integration.test.ts | 3项真实PostgreSQL测试通过 |
| scripts/ui/verify-points.mjs | 实际API与临时PG schema的浏览器交互通过，16张截图 |
| 视觉复核 | 实际查看后台桌面/手机与小程序余额/错误截图，并按结果调整 |

浏览器覆盖：账户与流水分页、续页失败重试、未提交搜索词隔离、筛选空态、详情空态、加载与503错误、权限撤销清除旧数据；小程序游客跳转、余额与流水、加载、失败恢复、账号切换与迟到响应丢弃。控制台无页面运行错误。

小程序浏览器预览只替换Taro组件/生命周期/存储/请求桥接，页面使用实际源码，请求连接真实API与PostgreSQL；不等于微信网络、原生组件或真机验收。

隔离夹具说明：现有开发消费者模型只允许A/B两个subject。账户列表跨20条分页测试仅在随机address_ui_临时schema中移除subject枚举CHECK，插入23个明确标记的合成只读账户；A/B登录与小程序权限检查仍走原接口，未放宽源迁移或业务库约束。积分流水通过临时schema事务写入并配平，属于合成验证数据，不代表运营发放审批已经完成。脚本结束清理整个临时schema。

## 截图审阅

截图本地保留且按现有约定忽略，不加入Git。

- [后台账户列表·桌面](UI-POINTS-ADMIN-LIST-DESKTOP-2026-11-02.png)
- [后台账户列表·手机](UI-POINTS-ADMIN-LIST-MOBILE-2026-11-02.png)
- [后台明细·手机](UI-POINTS-ADMIN-LEDGER-MOBILE-2026-11-02.png)
- [后台分页错误](UI-POINTS-ADMIN-PAGE-ERROR-2026-11-02.png)
- [后台权限撤销](UI-POINTS-ADMIN-REVOKED-SCOPE-2026-11-02.png)
- [小程序源码预览·余额](UI-POINTS-MINI-BALANCE-2026-11-02.png)
- [小程序源码预览·错误重试](UI-POINTS-MINI-ERROR-2026-11-02.png)
- [小程序源码预览·另一账号空态](UI-POINTS-MINI-OTHER-ACCOUNT-EMPTY-2026-11-02.png)

## 重跑与接续

先使用锁定Node版本并保持本机PostgreSQL启动，已有.env中的TEST_DATABASE_URL须为127.0.0.1/yumi_test。运行：

```powershell
$env:Path='C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;'+$env:Path
$env:YUMI_LIVE_UI='1'
$env:YUMI_PLAYWRIGHT_PATH=Join-Path $PWD '.local/tools/node_modules/playwright'
npm run verify:points:ui
```

脚本启动本机5188预览、随机端口API和Chrome，测试后关闭并清理。若环境未提供Playwright，配置其现有路径，不自动安装latest。可选YUMI_CHROME_PATH指向现有Chrome。

本机微信自动化9420端口未连接；微信工具与真机仍须单独记录，不阻塞下一项内部开发。下一项P1b：积分发放申请/独立审批、单笔与每日预算、幂等入账、权限及并发验证，并配套后台页面；继续保持真实运营默认关闭。P1b完成后再进入P2兑换商品。

未动进入本轮时已有的project.config.json、project.private.config.json及.pnpm-store/变更；不将它们归入本轮积分功能交付。
