# 玉米百货 · 项目工作入口

更新：2026-10-27。S0自动技术验证通过；S1员工认证、仓库权限、接口文档与代码规范基础已实现。正式交易、仓储和骑手业务、真机与真实支付验收尚未完成。

已确认：单小区、单仓、自营配送；首版暂无生鲜；包含轻量仓库系统与骑手配送端；由项目负责人和 Codex 协作研发，优先性价比与交易可靠性。

## 从这里开始

| 文档 | 用途 |
|---|---|
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

微信开发者工具导入`apps/consumer-mini`目录，配置指向dist；touristappid仅作编译演示，正式AppID和真机仍需核验。后端源码修改后重启相应命令，会先编译服务端；当前无热重载。

## 当前交付边界

文档是业务设计基线，现有代码包含工程骨架、S0探针和S1员工认证基础。仓库、员工、角色、仓库范围及会话已迁移；商品入库闭环、生产服务器、支付联调与微信审核尚未完成。经营参数仍按PRD区分确认值和开发样例，UI图片为参考素材。

原始资料已原样归档：[原始研发清单](docs/references/yumi-original.md)、[UI 图目录](docs/references/ui)。原始文件未修改。

本地演示先执行`npm run setup:local`、`npm run db:migrate`、`npm run db:seed`，分别启动API、admin、ops。开发账号和随机密码仅在本机忽略的`.env`中，读取`LOCAL_ADMIN_*`、`LOCAL_WAREHOUSE_*`、`LOCAL_RIDER_*`，不要发到聊天或提交。接口文档：`http://127.0.0.1:3000/api/v1/docs`。执行`npm run build`后可运行`lint`、`format:check`、`typecheck`、`test:s0`、`test:s1`。

接续先读验证报告和当前状态，推进“后台建商品→收货入库→小程序读取真实可售商品”；真机、经营参数等门禁保持待验收。
