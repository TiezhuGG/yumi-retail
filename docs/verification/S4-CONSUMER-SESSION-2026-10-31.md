# S4 消费者会话基础（本机开发版）

日期：2026-10-31。承接游客购物车，当前切片交付开发身份、独立消费者会话和“我的”页面；不是完整S4，也不是微信登录。下一切片为账号购物车与游客幂等合并。

## 范围和验收案例

- 默认游客可以继续浏览、编辑同一份本机购物车；首页“我的”进入独立页面。页面采用既有绿白卡片、独立身份卡和服务区；未实现的微信登录、地址、订单、售后明确标注未开放。
- 显式本机开发构建提供预设开发顾客A/B，用于验证用户区分。服务端生成用户标识，不接收客户端userId/openid/角色；不是手机号或微信认证，不请求任何微信外部服务。
- 重新打开页面从本机令牌请求当前身份；未核验成功不显示已登录资料。网络未知保留令牌并提供重试，401才清除失效记录；保存失败不假称登录成功，并尝试撤销未保存的新会话。
- 当前会话退出后数据库撤销，旧令牌不可重放；其他设备会话不受影响。账号停用、auth_version变更及绝对到期下一请求失效。
- 本机记录损坏保留原值，明确确认才清除；“清除本机登录记录”与服务端退出不同，确认框解释会话仍待到期。退出、清除或切换开发身份不清空、不合并购物车。

## 服务端与本机边界

`CONSUMER_DEV_LOGIN_ENABLED=1`才开启开发适配器，默认关闭。启动检查拒绝production、非回环API_HOST和非本机yumi_dev/yumi_test数据库。请求必须来自直接回环连接，无Forwarded/X-Forwarded-*；有Origin时必须匹配允许来源，登录还要求X-Yumi-Dev-Login:1。不能通过反向代理或公网暴露开发适配器。

消费者仅用Authorization Bearer，不读员工Cookie；员工接口不接受消费者令牌。当前只有本人GET接口，额外查询userId拒绝；地址、订单等跨用户资源权限需在后续各切片继续测试，本轮不声称已经覆盖未实现资源。

随机32字节令牌，数据库仅存SHA-256摘要，客户端按API配置隔离保存token/expiresAt，不缓存身份资料；UI状态仅发布核验后的最小资料，不携带令牌。访问日志仍只有请求编号、方法、路由、状态、耗时；认证审计记录开发登录成功/停用拒绝、退出，不记录原始令牌或外部凭据。默认绝对会话8小时，可配置60–86400秒，属于技术默认；开发登录每直接IP每15分钟30次，计数存PG并跨实例生效。目前未做会话历史清理任务。

前端`TARO_APP_CONSUMER_DEV_LOGIN=1`也需显式设置；构建脚本拒绝device、生产环境和非127.0.0.1 HTTP地址，Taro配置还要求local构建目标。正式开发预览最终恢复默认关闭入口；构建产物清单记录consumerDevelopmentLogin值。不要把本机开发产物上传。

## 数据与兼容性

新增`202610310004_consumer_sessions`，仅增加consumer_users、consumer_sessions、consumer_login_throttles、consumer_auth_audits及约束/索引，不修改员工、商品、金额或库存表。当前provider/subject约束仅接受DEVELOPMENT/customer-a或customer-b；真实微信身份须另行扩展并按AppID+openid唯一，不把开发身份迁移为真实用户。

本机没有Docker Desktop，沿用default上下文的Docker Engine。本轮生成Prisma客户端、构建服务端，停止核对过的旧API后应用开发库迁移并重启；健康200、默认开发登录404。测试在yumi_test的一次性schema应用完整迁移后清理；未向yumi_test/public部署本次增量迁移。其他环境先迁移、生成客户端、构建再启新版服务，禁止通过清库升级。无新依赖，锁文件不变；本机Node24.22.0比既有精确目标24.22.1少一个补丁，pnpm有提示，本轮实际构建/测试通过，未擅改版本要求。

## 实际检查

- 9项真实PostgreSQL消费者HTTP集成测试：默认关闭/环境拒绝、严格字段、摘要会话/最小资料、A/B与员工隔离、当前会话退出/重放、到期/停用/版本、并发首次登录/跨实例、审计/OpenAPI、持久限流。
- 8项小程序会话状态测试：持久化与资料核验、网络未知/401、退出重试、保存失败补偿、损坏记录/清除失败、页面取消/迟到响应、重复点击/拒绝覆盖旧身份、非法API资料。
- 5项小程序构建边界测试（含新增开发身份开关）；购物车9、浏览8、分类3、详情5回归通过。
- 员工鉴权12项、商品收货67项真实PG回归通过；本轮没有重跑其余库存套件，不能把历史结果说成本次运行。
- 服务端构建、完整typecheck、lint、改动代码Prettier与git diff --check；weapp编译、4个页面及3个导入根检查通过。OpenAPI同步实现的3条消费者接口，不虚构/auth/wechat/session或/cart/merge。

## 功能与UI验收分开记录

`scripts/ui/verify-consumer-session-wechat.mjs`使用已授权模拟器和miniprogram-automator0.13.0，原生组件点击/重开页面；wx.request通过测试桥接转发到本机隔离真实API，实际建立/校验/撤销PG会话。503与延迟为明确夹具，重置确认取消/确定使用showModal结果夹具，未证明原生系统确认按钮操作。未放松域名校验；桥接绕过微信网络层，不能当作合法域名、wx.login或真机联通验收。

验证A/B身份、刷新恢复、退出失败保留/重试、加载、未知状态重试、auth_version失效清理、新会话保存失败撤销、损坏记录取消/确定。运行中只操作测试登录存储，先在内存备份并finally恢复；逐值确认购物车完全未变。测试API和一次性schema关闭/清理，无合成顾客写入开发业务库，无交易或库存写入；最终只读核对开发库消费者/会话均0、测试库consumer_*残留schema为0。测试桥接、存储及模态框mock在finally恢复，结束后关闭自动化并正常打开本项目。

截图按ui参考与既有绿白风格实际查看：

| 场景 | 截图 |
|---|---|
| 最终默认入口（隐藏开发身份） | [默认](WECHAT-CONSUMER-SESSION-DEFAULT-2026-10-31.png) |
| 游客/显式开发入口 | [游客](WECHAT-CONSUMER-SESSION-GUEST-2026-10-31.png) |
| 开发顾客会话 | [已登录](WECHAT-CONSUMER-SESSION-SIGNED-IN-2026-10-31.png) |
| 恢复核验中 | [加载](WECHAT-CONSUMER-SESSION-LOADING-2026-10-31.png) |
| 网络未知保留记录 | [错误](WECHAT-CONSUMER-SESSION-ERROR-2026-10-31.png) |
| 服务端身份版本失效 | [失效](WECHAT-CONSUMER-SESSION-EXPIRED-2026-10-31.png) |
| 损坏资料需明确清除 | [损坏](WECHAT-CONSUMER-SESSION-CORRUPT-2026-10-31.png) |

## 可复现入口与未验部分

正常`npm run dev:api`与`npm run build:mini`保持开发身份关闭。“我的”页面仍可浏览，微信登录按钮禁用。仅本机验证时，启动API使用`CONSUMER_DEV_LOGIN_ENABLED=1 npm run dev:api`；编译使用`TARO_APP_CONSUMER_DEV_LOGIN=1 npm run build:mini`，不要与旧API抢占3000端口。数据库先执行db:migrate。模拟器服务连接与自动化脚本按本机已授权端口9420运行，脚本必须YUMI_LIVE_UI=1且加载.env的TEST_DATABASE_URL；安装位置由YUMI_MINI_AUTOMATOR_PATH指定，不提交测试SDK。

真实微信code交换、AppID/openid、登录合并、账号购物车、地址、订单、支付均未实现；真机依赖合法HTTPS测试API。没有接入外部账号、生产部署、上传或真实交易。下一项账号购物车与游客幂等合并，需补所有权、版本竞争、幂等重放、失效/超量不静默丢失及对应UI。
