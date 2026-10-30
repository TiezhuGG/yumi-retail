# 商品基本资料编辑交付

日期：2026-10-30。负责人最新要求：沿用已有UI风格，未完成界面由Codex按实际功能自主设计和调整，不再以逐页确认作为推进前提。本轮据此接续原商品资料维护计划，完成已有商品名称、分类、说明的编辑。此前UI复核改动及截图完整保留。

## 边界与行为

后台商品列表每个商品首个规格行提供“编辑资料”，catalog.write可用；先从独立GET读取当前资料和版本，再打开完整表单。可编辑名称、分类、说明，说明允许清空。分类来自真实目录，可继续分页；停用分类/停用父分类不能选作目标，未载入父分类时需继续加载资料。规格编码、规格、单位、售价、启用/效期标志及库存不在本次编辑范围，窗口内可展开只读查看。

草稿、已上架、已下架商品都可编辑基本资料；保留原状态。已上架保存后，后续公开查询使用新名称/分类/说明；尚无订单，本轮没有引入“历史名称快照”或宣称修改既有订单。收货详情原本就联查当前目录，仍展示原数量/成本/批次/效期事实。

窗口沿用现有绿/白配色、独立弹窗和手机纵向表单；不会让用户输入UUID、版本或操作键。无变化时保存禁用。旧版本冲突保留当前填写，停止继续提交，明确提供“载入最新资料（替换当前填写）”；不会自动覆盖用户输入或用新版本强制提交旧表单。

响应未确认时冻结本次内容，使用原内容/原幂等键重试。服务端确认该次操作后关闭窗口，重新读取当前列表；即使幂等重放返回历史结果，也不把历史资料乐观写成当前列表。确认保存但列表刷新失败，会明确说明已确认、请刷新列表，不留下重复提交入口。当前窗口之外关闭/重载会丢失重试键，可重新读取已知商品的当前版本再编辑；跨设备恢复原提交意图未提供。

## API与并发

新增，统一前缀 `/api/v1`：

| 接口 | 权限/输入 | 行为 |
|---|---|---|
| GET /admin/products/:id | catalog.read | 当前Product及完整SKU、version；错误UUID400、不存在404 |
| POST /admin/products/:id/update-details | catalog.write、Cookie/Origin/CSRF/UUID幂等键 | 严格接受version/categoryId/name/description；不接受status/skus/price等字段 |

名称trim后1–120字；说明必须为字符串、trim后0–2000字；version为0..2147483646整数，categoryId为UUID。完整替换这三个可变字段，不实现通用PATCH。目标分类及父分类需启用。

事务先锁Product，与上下架共用行锁并校验version，再共享锁目标分类/父分类并重读校验；成功推进Product.version一次。幂等按员工/动作/商品范围复用现有事务锁与首次结果，同键不同内容409 IDEMPOTENCY_CONFLICT；不同键相同旧版本竞争仅一个成功，另一个409 VERSION_CONFLICT。审计、版本/资料、幂等结果同事务提交，晚期失败全部回滚。

审计action `PRODUCT_UPDATE_DETAILS`，记录员工、商品、requestId，reason记录旧→新版本及变化字段名（不超过现有200字限制）。**未新增完整字段前后值历史表**。原审计不可修改/删除约束保持。未新增模型、列、索引或迁移；沿用现有Product.version和权限。API增量兼容既有创建/上下架/收货流程，SKU和库存版本不变。PRD/API/数据/UI说明及实际OpenAPI同步。

## 本轮功能验证

- 真实PostgreSQL **18/18**：既有11项收货/库存/详情测试与新增7项商品编辑测试。包括认证/只读拒绝/CSRF、上架商品公开元数据刷新但SKU/收货/汇总/批次/位置/流水原值不变、8并发同键只推进一次、历史重放与当前GET区分、编辑与编辑/上下架竞争、严格字段/长度/版本、分类及父分类启用、清空说明、晚期审计失败回滚及原键重试。
- 实际命令 `node --env-file=.env --import tsx tests/catalog-inbound.integration.test.ts`，在本机yumi_test一次性schema执行并清理；完整18项用例输出在 `.local/product-edit-integration.log`。本轮没有把历史78项算作全量回归。
- API/worker/contracts/database构建、共享web-ui构建、后台/移动类型检查与两端Vite构建、根测试类型、改动代码及脚本ESLint/Prettier、git diff检查通过；实际OpenAPI重新导出。精确版本/锁文件不变，Node24.22.0与项目24.22.1差异沿用说明。
- 合成浏览器 `scripts/ui/verify-product-editor.cjs` 通过：最新详情/加载/错误重试、冲突保留及明确重载、响应丢失冻结原内容并复用键、历史重放后列表取新资料、分类错误重试、说明清空、确认成功但刷新失败关闭窗口、只读无编辑入口、320/375/414宽度。
- 回归列表状态/既有创建、共享弹窗及收货UI脚本通过；截图写入 `/tmp/yumi-product-edit-regression/docs/verification`，不覆盖旧证据。它们是浏览器合成检查，不冒充数据库库存验证。

## 真实后台→API→数据库

使用本地开发管理员及明确标注的合成资料，通过真实编辑窗口：草稿版本0→1、上架1→2、已上架编辑2→3。公开SKU接口实际返回新名称及空说明，SKU保持719分/3包装/包，整页库存API前后相同；最后下架到UNPUBLISHED，公开详情404，避免混入顾客演示目录。只编辑目录，不创建/变更库存数量。

真实脚本 `scripts/ui/verify-product-editor-live.cjs` 只允许显式 `YUMI_LIVE_UI=1` 和本机yumi_dev/public；会创建一件合成商品并保留审计，不是只读截图脚本。初次尝试在API建草稿后未刷新预载列表，找不到编辑按钮；修正验证脚本刷新列表后完成第二次尝试。首次草稿和第二次已下架合成商品均保留，未删除审计或清库；没有修改原演示商品。实际结果 `.local/product-edit-live.json`：draftVersion=1、publishedVersion=2、editedVersion=3，SKU/stock unchanged=true、descriptionCleared=true、publicReflectedEdit=true。该文件无凭据。

## UI实际查看与证据

对照既有board1商品管理方向，实际查看了桌面真实编辑表单、后台375宽度真实表单和冲突提示；沿用现有组件，没有另建视觉系统。此处“手机”指后台响应式布局，不表示仓管获得catalog.write权限或微信真机通过。

| 场景 | 截图 |
|---|---|
| 真实桌面编辑 | [桌面](UI-PRODUCT-EDIT-LIVE-DESKTOP-2026-10-30.png) |
| 真实后台手机布局 | [375宽](UI-PRODUCT-EDIT-LIVE-MOBILE-2026-10-30.png) |
| 加载/读取失败 | [加载](UI-PRODUCT-EDIT-LOADING-2026-10-30.png) / [失败重试](UI-PRODUCT-EDIT-LOAD-ERROR-2026-10-30.png) |
| 冲突保留 | [冲突](UI-PRODUCT-EDIT-CONFLICT-2026-10-30.png) |
| 未知保存响应 | [原内容冻结与重试](UI-PRODUCT-EDIT-UNKNOWN-2026-10-30.png) |
| 合成手机表单 | [手机](UI-PRODUCT-EDIT-MOBILE-2026-10-30.png) |

按README启动，后台 http://127.0.0.1:5173/ →商品管理→编辑资料；权限仍由服务端校验。新API已在本地API进程重新加载。

## 后续范围

按负责人授权继续沿用统一风格完成UI，不以逐页确认阻断下一项。下一项按原目录维护计划推进SKU售价/启停或分类维护，保持历史库存和成本约束；本轮未提供规格/售价修改、分类/SKU启停、条码或图片上传。微信真机仍待HTTPS测试API；实体手机、真实订单支付/退款、生产部署本轮未验证。
