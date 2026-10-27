# S1员工认证与工程规范交付

日期：2026-10-27，Windows本机Docker Desktop/PostgreSQL。范围在实现前限定为员工登录、退出、会话恢复/失效、固定角色、仓库数据范围、基础页面、真实接口文档及代码规范。交易、支付与配送动作不在本轮范围。

## 实际完成

- 新增7张员工/仓库基础表，开发和测试库迁移成功；保留S0迁移和validation_数据。开发随机账号可重复seed，不重置既有密码/库存，生产及非本地开发库拒绝seed。
- Cookie持久化会话、scrypt密码摘要、来源/CSRF校验、数据库登录限流、认证审计；每次重新读取停用状态、auth_version、角色和仓库范围。密码、原始Cookie不进入访问日志。
- 后台与移动作业端共用真实登录、退出、会话恢复和授权仓库组件。浏览器分别打开5173/5174，确认中文标题、账号/密码字段与登录按钮；未使用真实账号在浏览器提交，HTTP认证由集成测试验证。
- OpenAPI仅列8个实际路径（含两个健康路径、仓库集合/单条），包含请求/响应与错误结构；开发Swagger可打开，生产关闭。
- 锁定Swagger12.0.4、ESLint9.39.1、typescript-eslint8.72.1、Prettier3.7.4；其余S0依赖不升级。首次统一格式触及既有源码与配置，无业务重写。CI增加Lint、格式、S1测试与seed，未远程执行。

## 实际检查

| 检查 | 结果 |
|---|---|
| dev/test两库 migrate deploy | 成功，无待执行迁移 |
| Prisma migrate diff：真实开发库→schema | No difference detected，退出码0（SQL CHECK仍由显式迁移维护） |
| setup:local、db:seed | 成功，既有.env保留，凭据不打印 |
| S1真实PostgreSQL+Nest HTTP | 12项通过，0失败 |
| S0真实数据库回归 | 6项通过，0失败；50意图争抢最后一件仅1成功，20同意图重试只预占1次 |
| 全工作区生产构建、typecheck | 通过，含小程序、后台、移动端、API、Worker及共享包 |
| ESLint、Prettier检查 | 通过 |
| 小程序产物检查 | 通过；不替代开发者工具/真机 |
| OpenAPI导出与HTTP访问 | 通过，未实现订单等接口不列入可用契约 |
| 浏览器页面 | 后台与移动作业端未登录页加载检查通过；完整浏览器登录/E2E待验收 |

S1用例覆盖严格输入/统一错误、错误与未知账号、摘要会话/最小资料、CSRF/来源/退出撤销、登录来源、角色与跨仓拒绝、过期/停用/版本失效、权限即时更新、第二实例复用会话、跨实例登录限流、Swagger/生产配置、审计与日志脱敏。生产配置模式也实际启动HTTP，验证文档端点404及Cookie的Secure属性；这不代替真实HTTPS部署。证据见[S1-EVIDENCE.json](S1-EVIDENCE.json)。

初次发现Swagger JSON路径重复前缀导致404，已修正并回归。Windows沙箱下tsx的uv_os_get_passwd报ENOMEM、esbuild读取父目录Access denied；获准沙箱外运行后同机通过，不要求系统重装。安装使用npm镜像临时参数，项目默认registry未改，锁文件固定。

## 本机演示

先启动Docker Desktop，在项目PowerShell执行：

```powershell
npm.cmd run setup:local
npm.cmd run db:up
npm.cmd run db:init
npm.cmd run db:generate
npm.cmd run db:migrate
npm.cmd run db:migrate:test
npm.cmd run db:seed
npm.cmd run build
```

分别在三个终端运行`npm.cmd run dev:api`、`npm.cmd run dev:admin`、`npm.cmd run dev:ops`。访问`http://127.0.0.1:5173`和`http://127.0.0.1:5174`。在本机编辑器读取忽略的.env中LOCAL_ADMIN_* / LOCAL_WAREHOUSE_* / LOCAL_RIDER_*，不要复制到聊天、日志或提交。管理员/仓管可看演示仓，骑手不展示仓库管理权限；刷新恢复会话，退出后须重新登录。不要混用localhost和127.0.0.1，Cookie按主机隔离。

接口文档`http://127.0.0.1:3000/api/v1/docs`；生成静态契约`npm.cmd run openapi:export`。自动复现依次运行`lint`、`format:check`、`typecheck`、`test:s0`、`test:s1`、`verify:mini`（完整命令均为`npm.cmd run <名称>`）。测试只写本机yumi_test，清理自己创建的测试记录，不重置开发库。

若手动复制.env.example，需填本地密码后再seed；setup只补缺失项，不覆盖已有值或已有员工密码。需要改密时不能简单改.env冒充数据库密码已更新。

## 兼容性、未验证与接续

此次新增表和共享包，消费者会话尚未实现；当前API全局员工守卫只适用于现有员工路由，未来消费者入口需独立鉴权。staff.read只支持最多100条只读，不是员工管理完成。rider.tasks.self仅预留权限，不代表配送任务可用。

尚未验证：浏览器有效账号提交/完整E2E、移动真机、微信工具/真机、真实微信登录、真实支付/退款、生产HTTPS代理及Cookie、负载容量与依赖安全审查、远程CI、备份恢复。生产须补员工开户/改密/撤权运营流程、限流代理策略、会话/限流/审计保留清理。当前仅认证审计，完整业务审计、任务补偿待后续切片。

下一任务：先明确商品分类/SKU、收货单/入库账本与可售规则的最小模型及验收，再实现“后台建商品→收货入库→小程序读真实可售商品”。不把S0验证库存当正式交易库存；经营参数仍需负责人确认。
