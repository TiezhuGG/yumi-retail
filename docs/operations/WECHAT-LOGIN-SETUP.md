# 真实微信登录接入步骤

当前负责人确认：小程序账号和服务器均未准备。代码已有真实微信协议实现，但未连接真实微信平台。先准备资源，再配置并联调；本手册不创建账号、购买服务器或发布生产。

## 1. 准备自己的小程序

在[微信公众平台](https://mp.weixin.qq.com/)按平台当前指引注册小程序并取得它自己的 AppID、AppSecret。使用的是这个小程序的 AppID；当前工程 `touristappid` 只用于本机编译，不能据此验收真实登录。注册、主体资质、类目、费用及域名备案等以平台和服务商当前要求为准，本项目未代办或核验。

AppID是公开工程配置。AppSecret只放在服务器私有环境文件或密钥服务中，不进入小程序、Git、截图或聊天。新建真实账号后，开发顾客A/B的积分、地址和订单不会自动迁移，微信新账户起始积分为0。

## 2. 准备HTTPS测试API

准备已授权的服务器、PostgreSQL和独立环境，部署匹配版本的API并提供可达的HTTPS入口。在小程序平台配置该API所需的合法请求域名并配置隐私声明。真机不能使用本机127.0.0.1地址。后台Origin、Cookie、CSRF、密钥和备份按现有部署手册配置。

已有[受控环境模板](points-express.controlled.env.example)可作为配置工作表。**第一次只联调登录时，将其中 `POINTS_EXPRESS_MODE` 设置为 `off`**，保留正式提交/作业开关为0，不填写受控交易白名单也能先验证登录。至少需要以下真实配置：

```dotenv
WECHAT_LOGIN_ENABLED=1
WECHAT_APP_ID=
WECHAT_APP_SECRET=
CONSUMER_DEV_LOGIN_ENABLED=0
ORDER_DEV_SUBMIT_ENABLED=0
REDEMPTION_DEV_SUBMIT_ENABLED=0
REDEMPTION_PICKING_DEV_ENABLED=0
POINTS_EXPRESS_MODE=off
POINTS_EXPRESS_SUBMIT_ENABLED=0
POINTS_EXPRESS_OPERATIONS_ENABLED=0
PAYMENT_MODE=disabled
```

空项必须在私有文件填写；这不是可直接启动的完整环境，还需数据库、仓库、加密密钥和后台Origin等基础配置。这里只配置真实微信身份，正式积分兑换另按[受控配置手册](POINTS-EXPRESS-CONTROLLED-ENVIRONMENT.md)启用，避免把“登录成功”等同于“已经可以正式兑换”。

## 3. 同步工程AppID并编译

将根目录 `project.config.json`、`apps/consumer-mini/project.config.json` 的 `appid` 同步为自己的同一个小程序AppID。然后使用公开AppID和真实API地址构建；以下文字须先替换，AppSecret不参与编译：

```bash
TARO_APP_WECHAT_APP_ID='自己的小程序AppID' \
TARO_APP_API_BASE_URL='https://自己的实际API域名/api/v1' \
pnpm build:mini:device
```

真机构建现在会在清理旧产物前拒绝游客/占位AppID、不同源工程AppID和指定AppID不一致。输出工程与源工程不匹配时不生成有效构建清单。清单额外记录公开 `wechatAppId`；旧清单须重新编译，数据库账号、订单和会话不受影响。

```bash
pnpm verify:mini:device
pnpm check:wechat:login
```

第二条默认读取工作区私有 `.env`；检查其他已授权环境时可在仓库根目录运行 `node --env-file=/私有路径/wechat.env scripts/check-wechat-login.mjs`。检查只读文件/环境，不请求微信、不连接数据库、不输出AppID/AppSecret或完整URL。退出码1表示仍缺配置，`configurationReady=true`也仅表示静态匹配；真实网络、合法域名、工具和真机仍须验收，`canLaunch=false`不会被配置自动改成true。

## 4. 工具和真机联调

使用匹配AppID的微信开发者工具打开当前工程，确认其导入根目录指向 `apps/consumer-mini/dist`，再进行真机测试：

1. 进入微信登录页，点击登录；客户端从Taro.login获取新code，只把code发送到本系统API；服务端固定请求微信code2Session后签发本系统会话。
2. 检查首次账号创建、再次登录同一账号、重启后恢复、退出及过期重新登录；不同微信账号只能读取自己的积分、地址和订单。
3. 断网、微信凭证失效或响应丢失后，点击“重新微信登录”必须重新取code；不能复用旧code来恢复token。离开页面的晚响应不应覆盖当前账号。
4. 检查新微信账号积分为0；需要测试兑换时，由运营申请、另一授权负责人审核真实测试积分，不能自动复制开发账号余额。
5. 记录脱敏验收证据，不记录code、token、OpenID、session_key、完整微信请求URL或密钥。隐私指引及登录入口也必须用自己的小程序配置验证。

当前实现的“微信顾客”是本系统默认显示名，不是读取到的微信昵称；头像、手机号绑定及昵称修改属于后续资料功能，不影响基础身份登录。

## 5. 登录通过后再开启受控积分兑换

先核实真实商品、实物库存、积分发放规则、快递范围/费用及售后规则。用后台实际查询到的微信用户建立受控名单，再切换 `POINTS_EXPRESS_MODE=controlled`；按原手册先配置、再分别开启提交与作业开关。注册账号和服务器准备好以后可继续这一环节，目前没有任何真实登录或部署验收结论。

协议参考：[Taro官方登录文档](https://docs.taro.zone/docs/3.x/apis/open-api/login/)、[微信登录流程](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html)、[微信code2Session](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)。本轮可检索到Taro文档；微信官方页面未能通过浏览工具读取，因此不声称已核验平台当前注册/审核细则或错误码全集，最终以账号实际平台文档与联调为准。
