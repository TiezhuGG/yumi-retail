# 玉米百货 · 项目工作入口

2026-10-28最新调整：负责人要求暂停新增业务，优先解决与原图不一致、长表单堆叠及面向用户的交互问题。当前UI是流程验证界面，尚未产品验收；见[UI偏差与调整方向](docs/design/UI-ALIGNMENT-2026-10-28.md)。微信根目录导入路径已修复，并在开发者工具模拟器看到商品页。

更新：2026-10-28。商品收货、库位/移位/核对、实物盘点、数量隔离/解除/报损及收货逆向纠错已实现；78项真实PostgreSQL集成测试通过。小程序已编译，微信工具/真机和交易配送尚未验收。

已确认：单小区、单仓、自营配送；首版暂无生鲜；包含轻量仓库系统与骑手配送端；由项目负责人和 Codex 协作研发，优先性价比与交易可靠性。

## 从这里开始

| 文档 | 用途 |
|---|---|
| [收货纠错报告](docs/verification/S2-RECEIPT-REVERSAL-2026-10-28.md) | 本轮纠错边界、检查结果、迁移和演示步骤 |
| [隔离报损报告](docs/verification/S2-STOCK-DISPOSITION-2026-10-28.md) | 本轮边界、迁移、检查结果及演示步骤 |
| [实物盘点报告](docs/verification/S2-STOCK-COUNT-2026-10-28.md) | 最新盘点边界、真实检查、演示步骤与迁移影响 |
| [库位与库存核对报告](docs/verification/S2-LOCATIONS-RECONCILIATION-2026-10-27.md) | 最新迁移、移位/差异暂停验证、演示步骤和剩余边界 |
| [商品入库切片报告](docs/verification/S2-CATALOG-INBOUND-2026-10-27.md) | 本轮真实测试、浏览器闭环、演示命令及未验证项 |
| [S1认证基础交付报告](docs/verification/S1-FOUNDATION-2026-10-27.md) | 本轮范围、测试结果、登录演示和剩余边界 |
| [S0验证报告](docs/verification/S0-REPORT-2026-10-27.md) | 实际检查、并发证据、完整复现步骤和未验证项 |
| [版本矩阵](docs/verification/VERSION-MATRIX.md) | 已通过的精确版本与兼容性决策 |
| [开发开工指南](docs/roadmap/START-HERE.md) | 现在能做什么、哪些准备需要补齐 |
| [Codex交互模板](docs/roadmap/CODEX-WORKFLOW.md) | 可复制的开工、切片、接续、报错提示词 |
| [数据库选型评估](docs/architecture/ADR-002-DATABASE-CHOICE.md) | PostgreSQL建议、取舍及采纳后的调整 |
| [本地工具与技能初检](docs/roadmap/ENVIRONMENT-CHECK-2026-10-26.md) | 实际检测结果、已安装技能与验证缺口 |
| [开发总纲](docs/00-MASTER-PLAN.md) | 总体范围、系统组成、交付路线和决策 |
| [现有文档与 UI 评审](docs/review/REVIEW-V1.md) | 逐张图的问题、保留项和修改项 |
| [产品需求](docs/product/PRD-V1.md) | 下单、仓储、骑手、退款的业务规则 |
| [页面与设计规范](docs/design/UI-SPEC-V1.md) | 页面编号、交互、异常状态和设计变量 |
| [技术架构](docs/architecture/ARCHITECTURE-V1.md) | 技术选型、模块边界和一致性设计 |
| [API 设计](docs/api/API-DESIGN-V1.md) | 接口清单、权限、金额和幂等约定 |
| [数据库设计](docs/database/DATABASE-V1.md) | 实体、字段、索引、约束及事务示例 |
| [服务器与上线运营](docs/operations/DEPLOYMENT-AND-LAUNCH.md) | 环境、预算、监控、备份、资质和运营 SOP |
| [开发任务计划](docs/roadmap/DEVELOPMENT-PLAN.md) | 依赖、任务、阶段验收和下一步 |
| [决策与当前状态](docs/roadmap/DECISIONS-AND-STATUS.md) | 已确认、待确认、已完成与尚未验证 |
| [技能调研与官方资料](docs/research/SKILLS-AND-SOURCES.md) | 已有能力、可选技能、来源和核验局限 |

## 启动入口

先启动Docker Desktop，首次初始化按S0报告中的完整命令执行；本机使用`npm exec --yes --package=pnpm@10.28.2 -- pnpm install --frozen-lockfile`引导固定包管理器，避开原pnpm11启动器问题。

| 命令 | 默认入口 / 用途 |
|---|---|
| `npm run dev:api` | 127.0.0.1:3000，健康接口`/api/v1/health/ready` |
| `npm run dev:admin` | 127.0.0.1:5173，后台开发首页 |
| `npm run dev:ops` | 127.0.0.1:5174，移动作业工程首页 |
| `npm run dev:worker` | 数据库健康探针，业务任务未实现 |
| `npm run db:stop` | 停止项目数据库，保留数据卷 |

微信开发者工具现可导入仓库根目录（配置指向apps/consumer-mini/dist/），也可导入apps/consumer-mini（指向dist/）。根目录保留负责人配置的AppID，子工程touristappid仅作编译演示；账号能力和真机另验。首次导入先执行npm run build:mini。后端源码修改后重启相应命令，会先编译服务端；当前无热重载。

## 当前交付边界

文档是业务设计基线。已实现员工权限、商品收货、普通库位、批次位置、同仓移位、账本核对、单SKU实物盘点、原库位数量隔离/解除/报损及收货逆向纠错，S0探针表保持隔离。实体隔离区移位、商品资料维护、交易配送、生产部署及微信验收仍待完成。经营参数仍区分确认值与开发样例。

原始资料已原样归档：[原始研发清单](docs/references/yumi-original.md)、[UI 图目录](docs/references/ui)。原始文件未修改。

本地演示先执行`npm run setup:local`、`npm run db:migrate`、`npm run db:seed`，分别启动API、admin、ops。开发账号和随机密码仅在本机忽略的`.env`中，读取`LOCAL_ADMIN_*`、`LOCAL_WAREHOUSE_*`、`LOCAL_RIDER_*`，不要发到聊天或提交。接口文档：`http://127.0.0.1:3000/api/v1/docs`。执行`npm run build`后可运行`lint`、`format:check`、`typecheck`、`test:s0`、`test:s1`。

可追加`npm run db:seed:catalog`生成3个合成商品及入库数据（450/590/1680分）；重复执行不重复入库。启动后可查看`http://127.0.0.1:3000/api/v1/products`；新增`npm run test:s2`验证正式入库模型，测试在yumi_test的一次性schema隔离运行。

小程序本机默认请求`http://127.0.0.1:3000/api/v1`。真机须配置`TARO_APP_API_BASE_URL`并重新编译，配置可达的HTTPS API和合法请求域名；手机的127.0.0.1不是开发电脑。不得把演示配置上传生产。

新增`npm run test:inventory`验证迁移、移位与核对。迁移前停止旧API/Worker写入，再执行db:migrate/db:migrate:test并重启新版服务；旧数据不一致时迁移会停止，不能跳过检查或清库。界面在收货工作台下方提供库位、位置流水、同仓移位和核对报告。

新增`npm run test:counts`验证盘点；仓库工作台的“实物盘点”可开始冻结、由发起人提交全部位置实盘数、由另一员工审批再过账，也可带原因终止。先按报告启动新版API，迁移后禁止混跑旧服务。

接续先读最新报告和当前状态，推进商品资料维护（字段编辑、分类/SKU启停及条码）；并行完成微信工具/真机联通。G1与完整S2仍不整体标记完成。

新增`npm run test:dispositions`验证隔离/解除/报损。仓库工作台提供立即隔离、独立审批、实物核验过账与带原因取消；隔离保留原库位。详见最新报告；草稿不预扣额度，取消申请不恢复可售。

新增`npm run test:reversals`验证收货逆向纠错；工作台按原批次位置申请、另一员工审批、核验实物后过账，原收货单/流水保留。每次1位置，跨位置分单；见最新报告。
