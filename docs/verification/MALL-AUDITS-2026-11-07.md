# 商城操作记录 · 2026-11-07

## 交付内容与边界

新增后台“商城操作记录”，真实API连接business_audits，支持北京时间含起止日1–366天、7类操作、操作人当前名称字面搜索、20条分页及独立详情。28项白名单覆盖兑换商品维护、积分发放/冲正、人工发货/合包/批量、售后处理、顾客管理、导出及经营配置；消费者动作、登录及基础商品/库存操作未接入，不代表完整全系统审计。

详情展示本仓订单关联和验证后的导出生成范围；不返回原始details/reason、内部备注、售后内容、手机/地址/运单字段。操作人与关联资料为当前名称，明确区别于历史快照。文件记录不存正文，不提供重新下载。未知/外仓/无仓/非白名单记录不可访问。查询不写审计、积分、库存或订单。

API0.83.0，无新增迁移，仍63项；不修改经营参数、账号权限配置或支付开关。

## 实际验证

- PostgreSQL操作记录专项9项通过，并在最后的畸形导出kind防护修改后全部复跑通过；原积分报表导出回归9项通过，共18项不同检查。
- 覆盖真实商品/积分/退回/发货来源、加密备注与停用原因隐藏、导出元数据验证、合包及批量成员解析、同时间戳完整分页、新增记录隔离、字面搜索、北京时间边界、跨仓及无仓404、事务末会话失效、消费者/仓库角色与撤权拒绝。分页、非法元数据和跨仓场景使用隔离库合成审计事实，不修改本地业务库。
- Chrome实际React后台与隔离API/PostgreSQL联调通过，12张截图；覆盖加载、桌面、390px手机卡片/分页、错误后清空及重试、空筛选、备注详情脱敏、详情错误与重试、导出范围、手机详情和撤权清空。查询前后积分账户/流水与审计数量不变。
- 全工作区及根测试TypeScript检查、ESLint、服务端构建、公共UI构建、后台/移动作业端构建通过；OpenAPI同步导出。相关源码Prettier及git diff --check通过。

未完成真实经营数据规模、生产、微信开发者工具/真机或实物验收。本轮无小程序改动，不将浏览器检查视为真机验收。测试期间pg客户端提示并发query弃用警告，测试全部通过；未升级数据库依赖。

本地API已重启至新构建，live/ready均200、数据库已连接，新路由匿名访问401；导出的OpenAPI为0.83.0且含两个新接口。5173/5174实际加载的JS均包含新页面接口。本地未启用公开Swagger地址，通过导出合同及实际路由验证。

## 界面记录

- [LOADING](UI-MALL-AUDITS-LOADING-2026-11-07.png)
- [DESKTOP](UI-MALL-AUDITS-DESKTOP-2026-11-07.png)
- [MOBILE](UI-MALL-AUDITS-MOBILE-2026-11-07.png)
- [CARD-MOBILE](UI-MALL-AUDITS-CARD-MOBILE-2026-11-07.png)
- [PAGINATION-MOBILE](UI-MALL-AUDITS-PAGINATION-MOBILE-2026-11-07.png)
- [ERROR](UI-MALL-AUDITS-ERROR-2026-11-07.png)
- [EMPTY](UI-MALL-AUDITS-EMPTY-2026-11-07.png)
- [CUSTOMER-DETAIL](UI-MALL-AUDITS-CUSTOMER-DETAIL-2026-11-07.png)
- [DETAIL-ERROR](UI-MALL-AUDITS-DETAIL-ERROR-2026-11-07.png)
- [EXPORT-DETAIL](UI-MALL-AUDITS-EXPORT-DETAIL-2026-11-07.png)
- [DETAIL-MOBILE](UI-MALL-AUDITS-DETAIL-MOBILE-2026-11-07.png)
- [PERMISSION](UI-MALL-AUDITS-PERMISSION-2026-11-07.png)
