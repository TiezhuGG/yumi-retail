# 隔离/报损与收货纠错 UI 交付

日期：2026-10-28（Asia/Shanghai）。承接实物盘点UI，继续暂停新增业务。本轮不修改服务端规则、API契约、数据模型、迁移或依赖版本。

## 范围与验收案例

- 隔离记录与处置申请分开浏览；处置状态筛选明确仅筛选已载入记录，保留分页入口。
- 新建隔离、隔离详情与处置申请、处置单详情各有独立窗口；审批、实物核验、过账、取消集中在对应详情。
- 收货纠错默认展示单据列表；新建先选商品/批次/库位、核对原收货与额度，再提交申请；详情显示原单摘要及状态操作。
- 失败保留原因、数量与实物说明；同一失败意图重试保留幂等键。已获得成功响应后关闭新建表单，即使后续刷新失败，也不继续展示原新建提交入口。
- 两页提供加载、空、错误、重试与详情刷新；默认展示商品/批次/库位，资料未载入时明确说明，完整内部编号只在展开信息中出现。

UI验收案例：列表进入详情、新建/详情分离、状态筛选、申请人不可自审、审批后出现实物过账动作、失败输入保留、重复失败请求复用幂等键、加载/空/错误/恢复，以及320/375/414宽度无页面横向溢出。普通打开页面仍连接真实API，合成响应只存在于UI检查脚本。

## Docker与数据库实测

负责人最新要求：本机存在Docker Desktop则优先用，没有则用Docker Engine。本机没有Desktop安装目录/上下文，实际为Docker Engine **29.9.1**，不是此前Windows主机的Desktop环境。

锁定的bookworm镜像下载缓慢，本机已有同版PostgreSQL17.11缓存，故使用仅本机的 `.local/compose.engine.yaml` 覆盖镜像：

```text
postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3
```

容器实查：PostgreSQL **17.11 (Debian 17.11-1.pgdg13+2)**，Debian13/trixie，healthy，仅发布 `127.0.0.1:55432`。原 `compose.yaml` 的17.11-bookworm锁定未改；本轮不声称验证了完全相同的镜像基础系统。未访问或修改其他项目数据卷。

本机随机开发凭据由 `setup:local` 写入忽略的 `.env`，没有输出或提交。创建yumi_dev/yumi_test，Prisma7.10.1客户端生成、两库全部9条既有迁移通过。无新增迁移，无清库/重置；保留本轮合成业务单据和审计。

本机启动：

```bash
node scripts/setup-local.mjs
# 本机已有的缓存覆盖文件；其他机器默认使用项目compose.yaml的锁定镜像。
docker compose -f compose.yaml -f .local/compose.engine.yaml up -d --pull never --wait
npm run dev:api
npm run dev:admin
npm run dev:ops
```

API 3000、后台5173、移动作业5174。登录使用本机.env中的LOCAL员工配置，禁止粘贴到聊天或提交。

## 功能验证（本轮实际执行）

1. contracts/database/API/worker构建；共享web-ui构建；后台/移动作业类型检查及Vite构建通过。
2. 修改的TSX、脚本ESLint与Prettier、git diff检查通过；pnpm-lock.yaml未变。实际Node **24.22.0**，pnpm **10.28.2**；与原24.22.1矩阵的差异已记录。
3. 真实PostgreSQL集成 **23/23** 通过：隔离/报损11项、收货纠错12项。含独立审批、预占/隔离保护、额度、幂等竞争、版本冲突、越权、晚期回滚及不可变账本；测试使用yumi_test一次性schema。日志在本机 `.local/stock-task-integration.log`。没有把历史78项当成本轮全量回归。
4. 后台和移动作业端分别运行合成响应浏览器脚本，覆盖两页加载/空/失败、筛选、独立窗口、审批/过账入口、输入保留、自审隐藏及320/375/414布局，无浏览器pageerror。
5. **真实浏览器→API→PostgreSQL双员工闭环**：仓管登录并隔离2件、申请报损1件；另一位管理员审批并填写合成实物核验说明过账；仓管再申请原收货纠错1件，由管理员独立审批核验过账。申请人页面没有自审入口。结果由真实API回读，不是模拟响应：

| 时点 | 实物件数 | 不可售件数 |
|---|---:|---:|
| 合成纸巾初始 | 8 | 0 |
| 隔离2件、报损1件后 | 7 | 1 |
| 原收货纠错1件后 | 6 | 1 |

纠错后的原收货累计冲回1件、剩余额度7件、当前位置自由5件，隔离1件仍受保护。原单、处置单、逆向单与审计保留。所有资料为开发种子与标注UI验收的合成资料，没有真实实物处置或经营验收。

UI脚本：`scripts/ui/verify-stock-tasks.cjs`。可选环境变量沿用前次报告：`YUMI_PLAYWRIGHT_PATH`、`YUMI_CHROMIUM_PATH`、`YUMI_UI_URL`、`YUMI_UI_PREFIX`。真实流程脚本 `scripts/ui/verify-stock-tasks-live.cjs` 仅允许本机yumi_dev，须显式 `YUMI_LIVE_UI=1`；会创建新的合成单据并改变开发样例数量，不应当作无副作用的截图脚本。

## UI验收证据

已实际查看原 `ui/board2` 与桌面/手机列表、详情截图。沿用导航、筛选、详情与状态操作的方向，避免把新建和审批长表单堆在默认列表。

| 页面/状态 | 后台 | 移动作业 |
|---|---|---|
| 隔离列表 | [桌面](UI-DISPOSITION-LIST-2026-10-28.png) | [桌面](UI-OPS-DISPOSITION-LIST-2026-10-28.png) |
| 处置列表 | [手机](UI-DISPOSITION-MOBILE-2026-10-28.png) | [手机](UI-OPS-DISPOSITION-MOBILE-2026-10-28.png) |
| 报损详情/失败保留说明 | [手机](UI-DISPOSITION-DETAIL-MOBILE-2026-10-28.png) | [手机](UI-OPS-DISPOSITION-DETAIL-MOBILE-2026-10-28.png) |
| 纠错列表 | [桌面](UI-REVERSAL-LIST-2026-10-28.png) | [桌面](UI-OPS-REVERSAL-LIST-2026-10-28.png) |
| 纠错列表 | [手机](UI-REVERSAL-MOBILE-2026-10-28.png) | [手机](UI-OPS-REVERSAL-MOBILE-2026-10-28.png) |
| 纠错详情/失败保留说明 | [手机](UI-REVERSAL-DETAIL-MOBILE-2026-10-28.png) | [手机](UI-OPS-REVERSAL-DETAIL-MOBILE-2026-10-28.png) |
| 隔离/处置状态 | [加载](UI-DISPOSITION-SLOW-2026-10-28.png) / [空](UI-DISPOSITION-EMPTY-2026-10-28.png) / [失败](UI-DISPOSITION-ERROR-2026-10-28.png) | [加载](UI-OPS-DISPOSITION-SLOW-2026-10-28.png) / [空](UI-OPS-DISPOSITION-EMPTY-2026-10-28.png) / [失败](UI-OPS-DISPOSITION-ERROR-2026-10-28.png) |
| 纠错状态 | [加载](UI-REVERSAL-SLOW-2026-10-28.png) / [空](UI-REVERSAL-EMPTY-2026-10-28.png) / [失败](UI-REVERSAL-ERROR-2026-10-28.png) | [加载](UI-OPS-REVERSAL-SLOW-2026-10-28.png) / [空](UI-OPS-REVERSAL-EMPTY-2026-10-28.png) / [失败](UI-OPS-REVERSAL-ERROR-2026-10-28.png) |

真实API闭环：[报损已过账](UI-LIVE-DISPOSITION-POSTED-2026-10-28.png)、[纠错已过账](UI-LIVE-REVERSAL-POSTED-2026-10-28.png)。真实业务截图和合成接口状态截图分开记录。长详情在窗口内滚动，手机截图不能替代手机实机触控检查。

## 剩余边界与下一任务

本轮两页已具备可运行、可审阅UI和上述功能证据，**仍待负责人UI确认**，完整UI不标为完成。下一任务：库位/批次位置/移位/核对的列表、表单与详情分离，并补仓管/拣货角色任务路径和页面状态；商品资料维护暂缓。

未验证：完整78项回归、微信工具/真机、移动实体设备、全部弱网未知结果、真实货品/人员SOP、生产部署与生产支付。真实浏览器闭环覆盖报损与纠错，解除/取消在本轮服务端集成有覆盖，未另做真人物料处置或全部角色浏览器路径。基础系统为本机trixie缓存镜像，bookworm锁定镜像本轮未完成拉取验证。
