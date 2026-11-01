# S5 支付渠道适配器契约与失败分类 · 2026-11-01

本轮完成内部查询契约、单次超时执行器和后台“渠道契约验证”独立页面。17种固定合成场景使用实际共享核心运行，展示分类、证据及后续建议；不调用真实渠道，不保存运行结果，不变更订单、库存或资金。承接上一轮补偿核查，范围止于内存分类契约，尚未接入查询Worker或持久化。

## 行为边界与验收

- 预期绑定包含appId、商户号、商户订单号、整数分金额及CNY币种；执行器冻结副本，适配器不能更改预期绑定。仅调用一次query，默认3000ms，允许1–10000整数毫秒；超时先确定TIMEOUT再发送AbortSignal，不采纳迟到成功，无内部重试。
- 13类结果：TIMEOUT、TRANSPORT、RATE_LIMIT、SERVER_ERROR、NOT_FOUND、REJECTED、INVALID_RESPONSE、UNVERIFIED、BINDING_MISMATCH、PENDING、SUCCEEDED、CLOSED、UNSUPPORTED_STATE。除严格匹配且认证的成功/关闭，其余证据均UNKNOWN；全部releaseAllowed=false。
- 超时、网络、限流、服务端异常及未支付/支付中建议RETRY；不存在、拒绝、格式/认证/绑定异常及未知交易状态建议REVIEW；成功/关闭仅建议RECONCILE，不能直接入账或释放。重试/核查为下一步建议，尚未成为数据库任务动作。
- authenticated是内部适配器的责任边界，合成布尔值不等同密码学验签。未来HTTP实现必须先完成原始响应字节的密码学认证，才能提供该事实；目前没有HTTP实现、真实密钥读取、外部地址配置或公网上报入口。
- 原始响应、错误消息、敏感头不会返回。固定场景不接受客户端提供原文、URL、密钥或支付状态。

错误码参照[微信支付小程序商户订单号查询官方文档](https://pay.wechatpay.cn/doc/v3/merchant/4012791900)。官方说明RULE_LIMIT为频率限制、ORDER_NOT_EXIST应核对创建记录、SYSTEM_ERROR以原参数重试。本项目进一步保守地将订单不存在保留UNKNOWN并转核查；该处理是本项目策略，并非渠道“确认未扣款”。未认证的错误响应也不自动重试，转核查。

## API、权限与兼容性

GET `/api/v1/admin/payment-adapter-lab?warehouseId=…`读取启用状态及17场景；POST同路径`/run`仅接受空JSON，需Cookie、授权仓库、payment-readiness.read及Origin/CSRF。默认GET enabled=false、POST503 PAYMENT_ADAPTER_LAB_DISABLED。沿用既有本机实验开关及生产/远端DB拒启校验。OpenAPI增量更新至0.22.0；无数据库迁移或历史数据回填。

真实订单仍保持原状态限制；查询Worker仍按既有固定合成UNKNOWN路径运行，本轮没有接线或改变其行为。测试确认订单、预占流水、尝试、任务、备注、通知记录及业务审计均不因运行验证新增。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| `npm run build:server` | 通过 |
| `node --import tsx --test tests/payment-query-adapter.test.ts` | 6项通过，包含17场景、逐字段绑定、未经认证/畸形响应、超时与迟到成功、同步中止拒绝、异常脱敏、无内部重试和冻结绑定 |
| PostgreSQL：adapter-lab + attempt-lab + query-lab三个集成文件 | 20项通过（新增2、原尝试8、查询10）；后续补充无写入/GET列表断言后单独复跑新增2项通过，合计仍为20个独立案例 |
| `npm run typecheck` / `npm run lint` | 通过 |
| `npm run build` | API、Worker、共享包、后台、作业端与weapp全部通过；卡片排版调整后单独重建后台/作业端通过 |
| `node scripts/verify-mini-artifacts.mjs` | 9页面及三个导入根产物检查通过 |
| `node --env-file=.env scripts/export-openapi.mjs` | 已导出新接口及结果字段 |
| 同源码Chrome + 一次性PG/API | 17场景实际结果、1440桌面/390手机、运行中清除旧结果、503错误及重试、关闭禁用、普通角色不显示入口；布局调整后复跑通过，无横向溢出 |

浏览器脚本：`scripts/ui/verify-payment-adapter-lab.mjs`，需显式YUMI_LIVE_UI=1、非生产环境和本机Playwright路径。503、运行延迟与隔离页禁用说明通过受控响应验证，正式本机默认关闭另行检查，不伪称真实渠道故障。UI测试只创建临时数据库schema并清理。

Node本机24.22.0与声明24.22.1的既有差异仍在，pnpm10.28.2等锁定依赖不变。裸系统pnpm启动器遇只读engine-store锁后，改用仓库已锁定的`node node_modules/pnpm/bin/pnpm.cjs`成功构建，无重新安装或升级。

## 界面验证

实际查看桌面与手机通过结果、手机错误状态截图：沿用绿色主操作、白色卡片及独立导航；桌面双列、手机单列、分类文本换行，错误后旧成功结果被清空。

- [运行前桌面](UI-PAYMENT-ADAPTER-IDLE-DESKTOP-2026-11-01.png)
- [通过桌面](UI-PAYMENT-ADAPTER-PASSED-DESKTOP-2026-11-01.png)
- [通过手机](UI-PAYMENT-ADAPTER-PASSED-MOBILE-2026-11-01.png)
- [运行中](UI-PAYMENT-ADAPTER-RUNNING-2026-11-01.png)
- [错误与重试](UI-PAYMENT-ADAPTER-ERROR-2026-11-01.png)
- [受控关闭手机](UI-PAYMENT-ADAPTER-DISABLED-2026-11-01.png)
- [本机默认关闭](UI-PAYMENT-ADAPTER-LIVE-DISABLED-2026-11-01.png)

## 本机状态与未验证项

已重启本机API3000及后台5173；健康200、匿名访问401、授权读取17场景且enabled=false、运行503、按钮禁用。查询Worker开关仍关闭，经营状态UNCONFIGURED且下单关闭；订单/经营规则/范围/合成尝试/任务/备注均0，临时测试schema0，验收员工会话已撤销。未改.env，未写示例经营数据，未执行生产部署或真实支付。

本轮编译微信小程序，无原生页面改动；没有重新执行微信开发者工具、微信网络、真机、真实商户/支付/退款验收。真实渠道HTTP、响应验签、公钥轮换、分类持久化、资金对账与订单入账仍待后续交付。

下一项：查询分类结果持久化与任务处理策略的隔离接入，优先验证租约过期拦截、重试与核查分流、事务回滚及对应详情界面，继续保持真实渠道关闭。
