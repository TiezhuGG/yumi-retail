# E4d 微信身份接入 · 2026-11-03

分支：积分商城。交付服务端微信凭证适配器、本系统账号/会话、默认关闭配置、小程序真实登录调用入口及能力检查。**全部本轮身份演练为合成适配器或传输模拟；没有连接真实微信、启用真实凭据或生产交易。**

## 行为与兼容


新增GET /api/v1/consumer/auth/methods（只返回微信与开发登录是否开放）和POST /consumer/auth/wechat-session（严格body仅code，1至128位字母/数字/下划线/连字符），no-store。小程序账户页按服务端能力显示开放/暂停/加载/读取失败，微信登录由Taro.login获取新code后发送服务端，不读取头像、昵称或手机号，不要求客户端填写用户编号/OpenID/UnionID，不将临时code存储到本机。已有本机会话须恢复或退出后切换；隐藏/离开取消晚响应，丢弃未使用会话时尽力撤销，登录记录仅保存本系统不透明token与expiresAt，状态不公开token。

服务端固定HTTPS api.weixin.qq.com/sns/jscode2session，参数为配置AppID/AppSecret、临时code及authorization_code，不接受客户端指定地址或凭据；禁止重定向，5秒超时、最多16KiB响应，不自动重试同code。只提取合法OpenID，校验session_key格式后丢弃session_key/unionid；不持久化或返回这些原始值，不记录微信完整URL、响应errmsg、code或密钥。失效/已用code返回401、平台限频429、网络/服务/异常响应503，并使用固定脱敏错误。Taro官方登录文档说明了客户端取code再由服务端换取身份的流程，微信官方API页面本轮浏览不可达，真实平台响应仍需受控联调验证。

配置新增WECHAT_LOGIN_ENABLED（默认0）、WECHAT_APP_ID、WECHAT_APP_SECRET（仅服务端）。启用时缺失或格式无效拒绝启动；只修改.env.example，不改实际.env或填写真实凭据。正式身份可独立于开发身份配置，但不开放正式兑换/出库门禁；开发身份仍拒绝生产、远程数据库及非回环请求。测试替身仅createApplication显式注入，且须test+本机yumi_test+随机临时schema；生产/普通schema拒绝，正常构建无环境变量可切成模拟微信。后台首发检查区分适配器是否配置与真实账号/HTTPS/真机仍未验收，canLaunch仍false。

微信账号provider=WECHAT，subject=SHA256(AppID+分隔符+OpenID)，额外wechatAppId固定来源；原DEVELOPMENT主体与资料保留，未自动合并积分、购物车、地址或订单。不同AppID的相同OpenID映射到不同本系统用户，配置AppID变化后旧账号会话不可用。生成32字节随机token，数据库只保存token哈希；会话继续校验有效期、用户enabled、authVersion，微信会话还校验当前微信登录开关与AppID；退出仅撤销当前会话。通用显示名“微信顾客”不伪造昵称，新账号无自动赠分或历史账务迁入。

微信登录以服务端socket地址哈希进行每分钟60次数据库限流，不信任客户端Forwarded/X-Forwarded-For。反向代理下可能共享同一桶，正式部署须单独验证可信代理和限流容量，不能直接放宽为信任任意请求头。AppID+code哈希在网络调用前原子占用10分钟，重复/并发只一次调用上游；过期哈希每次登录最多清理100条。网络未知、上游失败或晚期事务回滚均需要重新Taro.login取新code，不用原code恢复令牌，不在幂等表缓存原始token。数据库事务内并发upsert同一身份、签发会话及最小审计，失败不留下半个新账号/会话，已停用账号只留拒绝审计。

迁移202611030011_wechat_consumer_identity兼容原账号：扩展provider/subject约束与WECHAT_LOGIN审计动作，新增consumer_users.wechat_app_id及consumer_wechat_login_codes哈希临时凭证表，身份来源不可变触发器禁止改写provider/subject/AppID/ID/创建时间。保留原provider+subject唯一键和原subject约束名，兼容测试扩展脚本。无开发账号迁移、无真实数据回填。OpenAPI0.58.0由代码导出，user.provider增加WECHAT；需先迁移，再配套API与小程序，旧客户端不认识新provider需升级，不能删除身份/会话事实或改回开发身份回退。

本轮28项真实PG（微信4/旧会话9/快递地址4/发货8/首发检查3）及10项逻辑（微信协议和小程序流程2/旧会话8）通过；微信4项增强跨AppID后再次通过，11张同源码浏览器截图通过。适配器替身及传输模拟全部合成、未向真实微信发送凭据或连接账号；不能写成真实微信、开发工具或真机通过。生产交易门禁、HTTPS/合法域名、真实AppID工程匹配、真实联调/真机、备份恢复和实际快递仍待完成，下一项独立正式兑换/快递门禁与受控测试环境准备。


## 验证记录

- Node24.22.1、pnpm10.28.2。微信4项真实PG+旧会话9项，及协议/小程序2项+旧小程序会话8项，共23项通过；增强跨AppID后与地址4/出库8/首发3项共19项再次通过（重复4项不重复计数），因此唯一28项PG和10项逻辑通过。覆盖并发同OpenID映射/独立会话、不同AppID与开发账号隔离、本人地址越权拒绝、会话退出/版本/停用、code防重/限流/客户端伪造字段、默认关闭/错误配置/测试替身隔离、晚期审计失败回滚及新code恢复、HTTPS固定目标/重定向/超时信号/限长与错误脱敏、浏览器状态不泄露code/token和隐藏取消。旧测试原将WECHAT当非法来源，已改UNKNOWN；地址验收补齐该接口要求的原键，不放宽服务端验证。
- 实际API、随机PG、Taro同源码浏览器适配、React StrictMode和Chrome：方法加载/503重试、默认关闭、可登录游客、wx.login获取失败、上游code失效、成功响应丢失后新code重试、同一用户一次建号/登录恢复、退出、隐藏时取消晚code。11张截图，页面错误/横向溢出断言通过；实际查看游客/微信账号页面，保持绿色主按钮，售后入口连接真实兑换订单页。截图顶部明确标注合成适配器与非真实微信联调。
- Prisma生成、全工作区构建（API/Worker/后台/H5/weapp）、typecheck、lint、OpenAPI0.58.0导出通过。小程序本地构建清单与迁移重放结果见后续补充；未使用示例域名冒充device验收。初次沙箱内tsx因系统userInfo访问受限，授权本地重跑通过；未变更依赖。pg弃用提示与包体积提示保留。
- 源码和文档无真实用户、凭据或OpenID；新增配置仅.env.example，实际.env不变。没有真实上游请求、外部账号连接、付费资源或生产部署。默认关闭及旧开发身份生产拒启保持。

## 页面与复跑

最终本地小程序构建、三个工程导入根和完整文件清单校验通过；55个迁移在新临时schema重放生成110张表后清理。发布检查记录API0.58.0、miniBuild=LOCAL_OUTPUT_ONLY、localChecksPassed=true、canLaunch=false。未修改业务主库或将local构建当作device验收。

[游客登录](UI-E4D-WECHAT-MINI-GUEST-2026-11-03.png)、[暂停](UI-E4D-WECHAT-MINI-DISABLED-2026-11-03.png)、[加载](UI-E4D-WECHAT-MINI-LOADING-2026-11-03.png)、[方式失败](UI-E4D-WECHAT-MINI-METHODS-ERROR-2026-11-03.png)、[取code失败](UI-E4D-WECHAT-MINI-CODE-ERROR-2026-11-03.png)、[凭证失效](UI-E4D-WECHAT-MINI-INVALID-2026-11-03.png)、[响应丢失](UI-E4D-WECHAT-MINI-UNKNOWN-2026-11-03.png)、[合成微信账号](UI-E4D-WECHAT-MINI-AUTHENTICATED-2026-11-03.png)、[恢复](UI-E4D-WECHAT-MINI-RESTORED-2026-11-03.png)、[退出](UI-E4D-WECHAT-MINI-LOGGED-OUT-2026-11-03.png)、[隐藏取消](UI-E4D-WECHAT-MINI-HIDDEN-CANCEL-2026-11-03.png)。截图本地忽略。

npm run test:wechat-login运行4项PG/2项逻辑，旧会话test:consumer-session/test:mini-session按需回归；UI设置YUMI_LIVE_UI=1、现有YUMI_PLAYWRIGHT_PATH与YUMI_CHROME_PATH后npm run verify:wechat-login:ui。

## 协议资料与未验证部分

采用[Taro官方登录文档](https://docs.taro.zone/en/docs/3.x/apis/open-api/login/)所述客户端code→服务端换取身份流程。已尝试[微信code2Session官方页面](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)和[wx.login官方页面](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html)，浏览工具未能读取，不声称已核实该账号的平台细则或最新错误码全集。传输模拟验证固定请求协议和脱敏边界，不能替代真实微信联调。

下一项独立正式兑换/快递门禁与受控测试环境准备；真实AppID/密钥、HTTPS/合法域名、工具/真机、实物快递和备份恢复仍待验，商城未上线。
