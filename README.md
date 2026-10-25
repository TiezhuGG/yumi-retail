# 玉米百货 · 项目工作入口

更新：2026-10-25。当前阶段：方案与任务基线；尚未初始化应用或验证真实交易。

已确认：单小区、单仓、自营配送；首版暂无生鲜；包含轻量仓库系统与骑手配送端；由项目负责人和 Codex 协作研发，优先性价比与交易可靠性。

## 从这里开始

| 文档 | 用途 |
|---|---|
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

## 本轮交付边界

这些文件是可继续细化的设计基线，不代表代码、生产服务器、支付联调或微信审核已经完成。业务上尚未确认的参数在 PRD 中单独列出。UI 图片是参考素材，不是经过验证的需求或可编辑设计文件。

原始资料已原样归档：[原始研发清单](docs/references/yumi-original.md)、[UI 图目录](docs/references/ui)。原始文件未修改。

建议阅读顺序：总纲 → 评审 → PRD → 开发计划。下一轮从阶段 S0 的规则冻结与版本兼容性验证开始，每次交付一个可以演示、测试和验收的业务切片。
