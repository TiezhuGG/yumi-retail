# 分类名称与启停交付

日期：2026-10-30。接续SKU售价与启停任务，按负责人授权沿用当前UI风格自主完成。本轮只维护分类名称和启停，不支持移动层级、改父分类、删除分类、排序或图片。

## 实际完成

后台 http://127.0.0.1:5173/ → 商品分类 → 维护分类。独立窗口GET当前分类、version及父分类，名称trim后1–80字。状态明确区分自身启用与父分类停用导致不可见；父分类不在当前列表分页中也能在窗口读取。未保存名称时不能启停；父分类停用时不能启用子分类。catalog.write可写，其余读角色没有维护入口，服务端独立鉴权。

分类停用只改变顾客目录可见性，保留子级自身enabled/version、商品PUBLISHED/version、SKU和库存。重新启用后原本符合条件的商品可立即恢复展示；不自动上下架商品。全部父子状态每次公开查询仍由服务端校验。收货按原SKU启用/效期规则，与分类可见性独立；需阻止收货时应停用SKU。这是本切片实施选择，未宣称正式运营规则已确认或上线。

商品创建选择器禁用自身不可用、父分类停用或父资料尚未载入的项；已有商品列表对分类不可用提示顾客不可见，资料不完整时提示待载入。商品创建、修改分类和上架增加共享分类锁，与分类维护按UUID排序锁定父/子串行；停用先完成则相关商品操作拒绝，商品操作先完成则随后停用隐藏它。分类动作不锁Product，避免反向锁顺序。

响应未知时冻结原名称、动作和幂等键重试；旧版本/父状态冲突保留输入，明确载入最新资料并替换。确认后关闭窗口、GET刷新列表；历史幂等结果不作为当前列表。确认成功但刷新失败单独提示核对。关闭窗口后没有持久化提交意图恢复；可重新读取当前分类核对，不能称为跨设备恢复。

## 模型、API与迁移

新增迁移 `202610300001_category_version`：categories增加version INTEGER NOT NULL DEFAULT 0及非负约束；原分类从0开始，无名称/状态/层级/商品/库存回填或删除。已停止核实后的本项目本机API，执行 `npm run db:migrate` 成功，再启动新版API；沿用现有Docker Engine和健康PostgreSQL容器，未重建/清空数据卷。

新增GET /admin/categories/:id；POST /admin/categories/:id/rename（version,name）、enable和disable（version）。读需catalog.read，写需catalog.write、会话、Origin/CSRF及UUID操作键。严格字段/UUID/版本/名称校验；404不存在、409 VERSION_CONFLICT / INVALID_TRANSITION / PARENT_DISABLED，幂等冲突409 IDEMPOTENCY_CONFLICT。分类维护只推进自身版本，父级变化不会推进子级版本；服务端每次重新校验父状态。

CATEGORY_RENAME / CATEGORY_ENABLE / CATEGORY_DISABLE审计resourceId为分类，reason记录旧→新版本及字段名/启用值，与版本/状态和首次幂等结果同事务提交；不提供完整名称前后值历史表。列表/创建Category增量返回version，CategoryDetail返回parent；旧HTTP读客户端可忽略额外字段。其他环境需先迁移、生成Prisma并构建再启动新服务，不能让新客户端运行在未迁移库；应用回退可保留增量列，不应删除审计。PRD、API、数据设计、UI说明及实际OpenAPI同步。

## 功能验证（实际运行）

- 真实PostgreSQL **31/31**：原25项商品/规格/收货回归和新增6项分类测试。覆盖默认/非负版本、详情父级、会话/只读/CSRF、严格字段与长度、归属不变、8并发同键一次审计、历史重放与当前状态区分、同键异内容拒绝、改名与停用版本竞争、父停用与子启用竞争4轮、停用与商品创建/上架竞争3轮、审计失败回滚与原键重试。
- 真实DB比较父级停用前后子分类、Product/SKU、收货行、汇总库存、批次、位置、流水完全一致；公开详情404且公开列表排除。已停用父分类不能新建子分类/商品或改入其子分类；明确保留仓库收货可继续。父恢复但子自身停用仍隐藏，子恢复后公开可见。
- 命令 `node --env-file=.env --import tsx tests/catalog-inbound.integration.test.ts`，输出 `.local/category-integration.log`；本机yumi_test隔离随机schema应用全部迁移，结束只清理自己的schema。
- `scripts/ui/verify-category-editor-live.cjs`：显式YUMI_LIVE_UI=1且限制本机yumi_dev/public。创建明确标记的合成父/子分类和商品；真实UI子分类改名→父停用隐藏商品→父启用恢复→子停用/启用隐藏恢复。API比较商品/SKU完整结构与原上架结果完全一致，整页库存API前后相同。最后商品UNPUBLISHED、合成父分类停用；父/子各version=3，审计/合成资料保留，原演示商品/分类未修改。结果 `.local/category-live.json` 无凭据。
- Prisma生成、服务端/worker、共享web-ui及后台/移动作业构建通过；全工作区 `npm run typecheck`（含小程序）通过，ESLint、修改代码及OpenAPI的Prettier、git diff --check通过；`npm run openapi:export`实际导出。既有Node24.22.0与声明24.22.1警告仍在，未换依赖或精确版本。

## UI验证（独立于功能验证）

重新查看ui/board1并对照当前分类列表/绿白窗口，实际查看桌面与375手机截图；按钮、输入、父级提醒保持统一间距，手机可滚动，无水平溢出。没有伪造商品数量/销量或实现未授权素材功能。

`scripts/ui/verify-category-editor.cjs`合成响应覆盖加载、错误重读、空列表、父分类独立读取/停用提示、名称冲突保留/显式载入、未知响应原操作重试、重放后GET当前值、启停、确认后刷新失败、只读无入口、320/375/414宽度及商品选择器禁用不可用分类。新增选择器检查曾因嵌套label精确文本定位超时；定位到option后，Playwright的通用isDisabled与原生option.disabled读数不一致，已核实实际DOM带disabled并改为检查原生属性。不是实际API故障。原商品编辑、SKU维护及列表状态脚本回归通过，截图置/tmp/yumi-category-regression，不覆盖历史证据。合成异常不冒充真实服务故障。

| 场景 | 截图 |
|---|---|
| 分类列表及维护入口 | [列表](UI-CATEGORY-LIST-2026-10-30.png) |
| 真实API桌面改名 | [桌面](UI-CATEGORY-LIVE-DESKTOP-2026-10-30.png) |
| 真实API手机父级停用提示 | [手机](UI-CATEGORY-LIVE-MOBILE-2026-10-30.png) |
| 加载 / 读取失败 / 空列表 | [加载](UI-CATEGORY-LOADING-2026-10-30.png)、[失败](UI-CATEGORY-ERROR-2026-10-30.png)、[空态](UI-CATEGORY-EMPTY-2026-10-30.png) |
| 冲突 / 未知响应 | [冲突](UI-CATEGORY-CONFLICT-2026-10-30.png)、[未知响应](UI-CATEGORY-UNKNOWN-2026-10-30.png) |
| 手机 / 父级未启用 | [布局](UI-CATEGORY-MOBILE-2026-10-30.png)、[父级停用](UI-CATEGORY-PARENT-DISABLED-2026-10-30.png) |

## 接续与未验证

下一项SKU规格说明维护，编码/单位含义及历史库存保持约束；条码等后续补齐。完整S2/G1仍未整体验收。本轮未重新进行微信开发者工具或实体手机检查，真机仍待合法HTTPS测试API；没有部署、上传、外部账号连接或真实交易/支付。H5与公开API验证不能代替微信真机验收。
