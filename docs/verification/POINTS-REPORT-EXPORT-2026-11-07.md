# 积分报表导出 · 2026-11-07

## 交付内容

后台「积分报表与对账」新增入账明细和每日汇总CSV下载。下载前显示已查询生效的北京时间日期、积分类型及内容范围；未提交的日期输入不会改变当前导出条件。明细按当前类型导出全部匹配记录，不受20行列表分页影响，最多5000行，超限整批拒绝，不截断。每日汇总含全部类型；全历史差异视图的明细导出禁用，不能混作期间流水。

文件含UTF-8 BOM、完整表头和CSV转义，空数据只生成表头。文本公式式前缀/控制字符加单引号，超过15位整数以文本保留，保留所有原始数字，不经浮点转换。明细包含原业务依据、昵称、应记/实记及核对状态，不含收件资料、微信身份、会话、全局余额或未归属流水。

服务端按当前角色/会话/经营仓重新查询；同RepeatableRead事务使用原报表的规范业务来源/入账与差异判定，生成最小审计。审计或事务末权限失败不返回文件，不写积分、库存、订单或幂等。新请求重新生成并记审计；再次下载当前已生成文件不再调用API，关闭/刷新清理内存文件。审计指生成文件，不保证用户已保存到磁盘。

## 功能验证

使用Node24.22.1及锁定依赖。以下18项最终通过：

```sh
node --env-file=.env --import tsx --test --test-concurrency=1 tests/points-report-csv.test.ts tests/points-report-export.integration.test.ts tests/points-report.integration.test.ts
```

- 3项纯CSV：BOM/引号/分隔符转义，公式式文字与控制字符防护，北京时间，超过15位整数原始位数，正常负整数和空表头。
- 9项真实PG导出：五类/实际日期/类型/空文件，全部分页数据，范围/CSRF/角色/仓权限，外仓业务排除，积分/库存/订单/幂等不变，审计字段最小化；超限无部分文件或审计；迟发会话失效/审计失败回滚且不返回CSV。
- 6项原报表真实PG回归：归属/应记/实记/余额核对、北京时间边界、分页和整数精度、受控损坏检测不修复、外仓隔离及权限继续通过。

均使用自动清理的隔离schema和合成顾客；业务来源通过实际发放/审批、兑换/取消、售后原积分退回及冲正接口建立，未导出真实顾客数据。时间边界和受控损坏测试只在明确校验过的隔离schema中暂时更改数据/触发器，finally恢复，未改业务库约束。上限测试在隔离服务中将内部上限临时降为5验证limit+1整批拒绝并恢复5000，不声称做过5001笔生产容量压测。

测试有既有pg adapter并发query弃用提示，无失败，未升级依赖。全仓typecheck/lint、服务端/公共UI/后台/移动作业端构建和Prettier/diff检查通过。API0.82.0、OpenAPI已导出，无迁移（仍63项）。

## 界面及实际文件验证

```sh
YUMI_LIVE_UI=1 YUMI_PLAYWRIGHT_PATH=... node --env-file=.env --import tsx scripts/ui/verify-points-report-export.mjs
```

实际React工作台+隔离API/PG+Chrome通过，10张截图。真实触发下载并读取文件：列表只显示20行，CSV含全部29行及全部后续业务依据；类型筛选只导出1行；每日汇总含全部类型（383增加/250扣减/133净变动）；空文件仅表头；再次下载内容相同且不再写审计。还验证已生效筛选与未提交日期区分、桌面/390px手机、加载、服务失败不下载、重试、差异视图禁用及空状态，检查导出前后账户与流水保持不变。

首轮浏览器脚本误将默认近30天视为当天，已改为读取页面实际应用的日期断言，未修改产品查询默认值。最终实际查看桌面范围、手机和空结果；弹窗截图按实际视口采集，避免整页长报表缩小弹窗。

- [范围确认 · 桌面](UI-POINTS-REPORT-EXPORT-SCOPE-DESKTOP-2026-11-07.png)
- [范围确认 · 手机](UI-POINTS-REPORT-EXPORT-SCOPE-MOBILE-2026-11-07.png)
- [生成中](UI-POINTS-REPORT-EXPORT-LOADING-2026-11-07.png)
- [错误重试](UI-POINTS-REPORT-EXPORT-ERROR-2026-11-07.png)
- [完整明细文件](UI-POINTS-REPORT-EXPORT-LEDGER-SUCCESS-2026-11-07.png)
- [筛选范围](UI-POINTS-REPORT-EXPORT-FILTERED-2026-11-07.png)
- [每日全部类型范围](UI-POINTS-REPORT-EXPORT-DAILY-SCOPE-2026-11-07.png)
- [每日文件](UI-POINTS-REPORT-EXPORT-DAILY-SUCCESS-2026-11-07.png)
- [差异范围不混用](UI-POINTS-REPORT-EXPORT-ISSUES-SCOPE-2026-11-07.png)
- [空结果 · 手机](UI-POINTS-REPORT-EXPORT-EMPTY-MOBILE-2026-11-07.png)

## 本地交付及未验范围

新增POST `/api/v1/admin/points/report/export`，旧GET报表协议不变。PRD/API/数据设计/总计划/开发计划/商城清单同步。本地API更新0.82.0，live/ready均200、在线OpenAPI已注册导出；5173后台及5174作业预览均200，实际脚本包含新导出接口。先构建公共UI包再构建后台/作业，避免旧dist引用。

无新迁移、经营开关、外部账号、付费资源或生产部署。没有XLSX、差异/全局账户导出、文件服务端归档和自动调账。CSV原始内容与下载行为已验，未在Excel/WPS实机打开、未作真实经营数据/生产容量/微信工具/真机验收。文件导出不代表对账整体完成或差异已修复。
