# 商品与收货入库切片交付

日期2026-10-27，本机Windows、Docker Desktop、PostgreSQL17.11。实施前范围见[切片边界](../roadmap/CATALOG-INBOUND-SLICE.md)。未新增/升级依赖，S1锁文件摘要保持8f3840630f8452b4c2ebeee79109c2c41b2537e15cd8aacf7251612420fde952。

## 实际交付

- 真实categories/products/skus、收货单与行、汇总库存/收货批次、库存流水、业务审计、幂等结果共10表；S0验证表和历史迁移保留。开发和测试库均应用202610270002_catalog_inbound。
- 分类/SPU/SKU创建、商品专用上/下架、收货DRAFT→APPROVED→POSTED，后台和移动作业端显示商品、收货及库存总览。当前表单每次录入1规格/1收货行，API分别支持20规格/50行。
- 写操作执行会话、Origin/CSRF、权限和仓库范围；事务内按SKU排序处理库存，过账原子写单据状态/余额/批次/流水/审计/幂等结果。重复同键复用结果、换键过同单拒绝；失败全部回滚。流水与审计数据库触发器拒绝修改/删除。
- 收货读取独立receipt.read；拣货员只能stock.read读取数量，不能借此看到采购成本。已通过实际HTTP用例验证。
- 匿名商品列表、关键词搜索、分类过滤及SKU详情；公开仓由PUBLIC_WAREHOUSE_ID限定，库存按安全量与未到期批次求可售，无成本/员工/来源泄漏。小程序已接真实API、空态/加载/失败重试/缺货和详情路由，无购物车支付按钮。
- db:seed:catalog通过实际业务服务创建3个合成商品及收货过账：450分10件、590分8件、1680分6件；连续运行两次成功，不重复加库存、不覆盖已有商品状态。

## 实际验证

| 检查 | 实际结果 |
|---|---|
| S2正式库存PostgreSQL集成 | 10通过，0失败 |
| S1认证/权限回归 | 12通过，0失败 |
| S0事务/最后一件/幂等回归 | 6通过，0失败 |
| 全工作区构建 | 通过，含新增小程序详情页及Web页面 |
| 类型、ESLint、Prettier | 通过 |
| 微信产物检查 | 列表、详情两个路由的JS/WXML和app配置通过；不代表工具/真机验收 |
| dev/test迁移 | 成功；模型与真实开发库diff无差异 |
| OpenAPI导出 | 实际代码契约0.2.0，含新接口输入/响应/错误 |
| 浏览器真实操作 | 一次性测试账号登录→分类→450分商品→上架→收货10件→审核→过账成功；移动作业端显示已入库/实物10件，公开API返回available=10；后台刷新恢复会话 |
| 远程CI | 已加入test:s2及样例seed，未推送/远程执行 |

测试证据见[S2-EVIDENCE.json](S2-EVIDENCE.json)。10项覆盖分类深度/非法输入/创建幂等、草稿隐藏和正常入库、20同键重试与10不同键争抢同单、跨实例重放/变更内容冲突、8单同SKU并发累计16件、多SKU后行失败全回滚并原键恢复、效期必填和过账复查、到期/安全库存/停用/下架过滤、跨仓/骑手/CSRF/旧版本拒绝、公开分页/搜索/固定仓和数据库CHECK/复合外键/不可改事实。

测试隔离：仅允许本机yumi_test；每轮创建s2_<随机ID>临时schema，执行全部迁移，测试后仅DROP该专用schema，不清理共享public或开发库，不绕过流水触发器。浏览器同样使用yumi_test一次性schema及合成账号，验收后关闭并删除；没有借用开发员工凭据。

发现并修复：复合外键的嵌套创建不可再次传warehouseId；Prisma空update的upsert在首次并发建余额时会竞争，已改为PostgreSQL INSERT ON CONFLICT DO NOTHING及原子增量UPDATE。增加详情页后同步更新了产物验证脚本。首次失败不计为通过，最终回归全部通过。

## 本地演示

已有依赖环境在项目PowerShell执行（首次安装见S0报告）：

```powershell
npm.cmd run setup:local
npm.cmd run db:up
npm.cmd run db:init
npm.cmd run db:generate
npm.cmd run db:migrate
npm.cmd run db:migrate:test
npm.cmd run db:seed
npm.cmd run db:seed:catalog
npm.cmd run build
```

分别启动`npm.cmd run dev:api`、`npm.cmd run dev:admin`、`npm.cmd run dev:ops`。访问后台5173/移动端5174；本机.env的LOCAL_ADMIN_*和LOCAL_WAREHOUSE_*是开发账号，勿粘贴到聊天/日志/提交。管理员可建分类/商品和上下架；仓管可收货/审核/过账、看库存；骑手无仓库作业权限。

手动新建商品：分类→填SKU编码/售价整数分→存草稿→上架；新建收货：来源、规格、批次、数量、单件成本→存草稿→审核→确认入库。公开`http://127.0.0.1:3000/api/v1/products`应看到可售数量增加，重复同单过账不能再次加库存。库存总览展示实物，实际可售另含效期和安全库存校验。

自动复现：先build，再运行lint、format:check、typecheck、test:s0、test:s1、test:s2、verify:mini（均为npm.cmd run命令）。db:seed:catalog仅允许本机yumi_dev/public、非production、启用且已绑定演示仓的本地管理员；不会重置已有数据，样例成本不代表真实采购。

小程序默认本机API_BASE_URL为http://127.0.0.1:3000/api/v1，微信工具本地演示需核对请求设置；真机必须通过TARO_APP_API_BASE_URL在编译时指定可达HTTPS API并配置合法请求域名。手机127.0.0.1指手机自身。不要为了演示把开发数据库/API直接暴露公网，也不要将默认配置上传正式版本。

## 兼容性与剩余边界

迁移仅新增模型/约束/函数/触发器，旧应用回退时保留数据；已过账纠错须用后续逆向动作，不删除流水。当前固定DEFAULT货位，stock_lots直接承载数量；未来拆stock_positions必须迁移和核对余额。Prisma diff不等于验证所有SQL CHECK/触发器，后者已单独测试。

尚未实现：图片/条码/商品字段编辑及启停管理、多库位、移位、隔离、盘点报损、收货逆向纠错、到期自动处理/任务补偿、订单预占/支付/骑手业务。审核允许同一员工是开发默认，正式分权仍待确认；成本和到期截止策略须以实际经营核验。公开详情当前ID为SKU UUID，productId单列，未来接口演进不得静默改ID语义。

尚未验证：微信开发者工具加载/请求/模拟器、微信真机、真实微信登录/支付、移动真机与弱网完整E2E、生产HTTPS与合法域名、负载/依赖安全审查、远程CI和恢复演练。当前浏览器证据不能代替小程序验收，G1、完整S2/S3均不整体标记通过。

下一切片：批次/库位与库存核对，随后盘点报损/逆向纠错；并行补齐微信工具/真机和真实商品资料，再进入交易开发。
