# C2 微信付款身份安全绑定（2026-11-06）

本轮边界：补齐现金支付路线的服务端付款身份来源，验证身份隔离、旧账号补齐、加密配置与回滚；不执行真实微信或资金操作。下一项为C3渠道下单与持久化恢复。

## 实际完成

- 新增专用AES-256-GCM绑定与第62项加法迁移202611060001_wechat_payment_payers。原始OpenID仅来自服务端已核验的微信登录，随机IV加密并通过AAD绑定顾客、AppID、原身份哈希和密钥标识；解密后再次核对身份哈希。地址与付款人密钥不可复用。
- 微信登录在同一事务中保存/刷新绑定、签发会话并写成功审计。同账号并发登录只保留一条绑定并递增版本；晚审计失败时用户、绑定和会话一起回滚，已领取code保持不可重用。
- 缺省不配置密钥时保留原哈希登录链路；旧账号通过新的已核验微信登录补齐，顾客编号、昵称、积分及订单归属不变。没有明文回填、前端代填或把哈希当OpenID的降级。
- 内部paymentPayer只能从当前会话本人绑定读取，复核服务端会话、启用、身份版本、AppID和数据库时钟到期；开发身份、其他AppID、撤销/停用和身份失效被拒绝。数据库等待期间会话到期也不能返回身份。没有公开原始身份、密文或解密接口。
- 可选WECHAT_PAYER_KEY_ID/WECHAT_PAYER_ENCRYPTION_KEY成对校验，缺一项/格式不符/复用地址密钥时启动拒绝。更换密钥需统一部署新标识及新密钥，旧绑定等待重新微信登录重加密；未知版本要求重新登录，错误密钥与损坏密文拒绝读取。没有历史密钥自动回退，真实密钥保管/灾备尚未验收。
- 后台接入检查新增付款人加密状态，总计13项；只显示MISSING/INVALID/CONFIGURED及说明，不返回密钥或标识。OpenAPI0.71.0已导出，原登录响应与支付禁用契约保持；消费者不增加页面、简介或按钮。

## 实际验证

- 22项测试通过：8项纯加密/配置检查，14项真实PostgreSQL登录、绑定和后台检查。全部使用合成身份、随机测试密钥及自动清理的隔离schema。
- 覆盖密文随机性、认证标签/封装损坏、跨顾客/AppID/subject移植、密钥版本不符及错误密钥、缺配置兼容、旧账号补齐、并发登录单条绑定、审计回滚新建及已有绑定、服务端来源/版本约束、开发身份拒绝、撤销/停用、已认证身份版本改变以及读取等待时会话到期。
- 实际后台React与隔离API/PG完成8个浏览器截图场景：桌面、手机、付款人密钥格式已配置、经营暂停、经营未配、加载、失败重试、无授权仓库。权限受限员工无入口，无横向溢出，实际查看桌面和手机全页。
- “已配置”截图只替换隔离服务的脱敏配置检查结果，不伪造付款成功或外部平台应答；真实绑定由上述独立PG案例验证。普通UI调用仍经过真实API和权限检查；错误/无仓库边界采用脚本明确标记的受控响应。
- 全项目构建及类型检查、根测试类型检查、相关ESLint/Prettier、git diff --check通过；本地weapp产物及三个导入根目录检查通过。没有以浏览器/编译结果替代微信开发者工具或真机验收。
- 本机yumi_dev迁移前生成私有完整备份及逐表指纹，pg_restore归档目录可读；迁移后原115张业务表行数及内容摘要完全一致，累计62项迁移，新绑定表0行。未更改实际.env、密钥或真实账号，未清理既有商品、积分、订单和库存。
- 本机开发API核实进程工作目录/命令/日志归属后重启，live/ready均200，实际服务OpenAPI版本0.71.0；支付仍关闭。

复现：先构建API依赖，再以项目要求的Node版本运行：

```bash
node --env-file=.env --import tsx --test --test-concurrency=1 tests/wechat-payer-private.test.ts tests/wechat-payer.integration.test.ts tests/wechat-login.integration.test.ts tests/payment-config.test.ts tests/payment-readiness.integration.test.ts
```

本机执行日志在.local/payer-tests.log、payer-typecheck.log、payer-tests-typecheck.log、payer-build-all.log、payer-ui.log、payer-lint.log、payer-format-check.log、payer-mini-verify.log；备份/比较记录在.local/backups/payer-before-2026-11-06.dump、yumi-dev-before-payer-2026-11-06.json及.local/payer-migration-report.json。这些本地私有文件不提交。

UI截图：[桌面](UI-PAYMENT-READINESS-DESKTOP-2026-11-06.png)、[手机](UI-PAYMENT-READINESS-MOBILE-2026-11-06.png)、[付款人配置状态](UI-PAYMENT-READINESS-PAYER-CONFIGURED-2026-11-06.png)。其余状态同目录以UI-PAYMENT-READINESS为前缀。

## 尚未验证或交付

小程序账号与服务器尚未准备，真实code2Session、实际密钥托管恢复、商户归属、HTTPS、微信工具与真机未验收。真实HTTP下单、持久化支付尝试/prepay恢复、wx.requestPayment、真实通知/查单入账、关单竞争和退款仍按C3至C5推进。PAYMENT_MODE仅允许disabled；本轮不能发起真实支付，也不代表商城已满足上线条件。
