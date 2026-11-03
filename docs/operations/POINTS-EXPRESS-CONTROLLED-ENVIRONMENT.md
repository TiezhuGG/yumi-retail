# 积分快递受控环境配置与验收

2026-11-03，API0.59.0。本轮只实现并在本地验证独立门禁，未部署或开放实际环境。配置工作表见[不含凭据的模板](points-express.controlled.env.example)。模板空项会导致启动失败，不能直接当可部署配置。

## 模式与身份

| 模式 | 新兑换身份/范围 | 快递作业范围 |
|---|---|---|
| off | 正式兑换关闭；原开发功能仍由原DEV开关控制且只在本机隔离环境使用开发身份 | 原开发开关只处理DEVELOPMENT单 |
| controlled | 仅当前AppID微信账号、指定1至50个不重复本系统用户ID；只支持EXPRESS | 仅CONTROLLED单，受独立作业开关控制 |
| production | 仅当前AppID微信账号、只支持EXPRESS；仅NODE_ENV=production且不得留受控账号名单 | 仅PRODUCTION单，受独立作业开关控制 |

POINTS_EXPRESS_MODE默认off；POINTS_EXPRESS_SUBMIT_ENABLED和POINTS_EXPRESS_OPERATIONS_ENABLED默认0，分别控制新报价/新兑换和快递发货/纠错/反馈新动作。开关配置不代表上线授权或设备、实物、恢复验收已经通过。门禁按进程配置生效，调整需要匹配进程重启/替换；暂停新请求不承诺撤回已经受理的在途事务，停止旧进程前应等待在途请求结束并核对结果。

消费者访问条件通过GET /consumer/redemption-access读取；返回模式、当前能否继续及原因，不返回账号名单。报价和提交再次由服务端校验，不依赖页面隐藏按钮。公开商品的redemptionEnabled表示总体开放状态，不代表某个账号有资格。暂停/移出名单后，已成功原请求仍可核实；已受理订单仍可查询、按原取消规则取消，作业资格不追溯名单变化，作业只看本单模式和当前作业开关。关闭作业后仍可核实已成功原键，不发起新的出库、纠错或反馈。

订单executionMode由服务端报价写入，DEVELOPMENT/CONTROLLED/PRODUCTION一经创建不可改；不能把控制单改成正式单或把开发单交给正式作业流程。模式切换后的原报价拒绝新创建，应重新核验；原成功创建请求不被切换丢弃。打印、后台详情和消费者详情展示来源模式。原小区骑手与现金支付流程不被正式积分快递门禁启用。

## 环境前置条件

正式模式须关闭CONSUMER_DEV_LOGIN_ENABLED、ORDER_DEV_SUBMIT_ENABLED、REDEMPTION_DEV_SUBMIT_ENABLED、REDEMPTION_PICKING_DEV_ENABLED、拣货/支付演练以及原后台开发Worker等开关，不允许混用；WECHAT_LOGIN_ENABLED=1、有效服务端AppID/AppSecret、仓库和地址加密密钥必须配置。POINTS_EXPRESS_API_ORIGIN为声明的HTTPS API origin，不含路径、查询、账号或片段；声明不等于证书/域名/连通性已经验证。

实际受控测试部署使用NODE_ENV=production、POINTS_EXPRESS_MODE=controlled、隔离数据库及独立密钥；正式和受控环境不得连接yumi_dev/yumi_test或自定义schema URL。NODE_ENV=test仅为本机yumi_test随机临时schema的自动化合成验证保留，不是远程测试部署方式。生产模式额外要求NODE_ENV=production且受控名单为空。PAYMENT_MODE保持disabled，积分首发不依赖真实现金支付。

本轮合成测试的HTTPS origin只验证配置形状，服务仍跑在本机HTTP，没有进行真实TLS或DNS验证。测试账号由仅临时schema的夹具建立，不是微信平台已联通的账号，也没有给真实用户发放积分。

## 配置与只读预检

1. 负责人先准备已授权的隔离测试服务器/数据库/HTTPS入口、合法请求域名、匹配小程序工程AppID、实际可用商品和运营账号。服务端凭据在受控配置中填入，不放入TARO_APP_*、Git、聊天、截图或日志。
2. 创建真实微信测试账号后，在后台合法查询对应本系统账号ID，并将限定的账号填入POINTS_EXPRESS_ALLOWED_USER_IDS；普通用户不输入内部ID，不通过复制开发账号/改数据库主体迁移积分和订单。配好仓库、真实寄送范围/商家运费承担、商品/配额、真实积分发放审批及库存来源。
3. 使用模板时两写开关先为0。配置完整后，在目标运行环境通过npm run check:points-express:config只读预检；或构建后用Node加载受控环境变量文件运行scripts/check-points-express-config.mjs。工具不联网、不连接数据库、不打印URL、密钥、origin、仓库或消费者ID，不会开启开关。configurationValid=true只表示形状/隔离规则通过，canLaunch=false、networkChecked=false保持。
4. 原check:express:release和verify:express:migrations继续仅用于本地安全默认配置；现在要求正式模式off且正式写开关关闭。不要拿本地报告检查远程库或执行主库迁移。
5. 完成必要授权与备份/恢复验收后，按[首发手册](POINTS-EXPRESS-LAUNCH-RUNBOOK.md)在受控窗口迁移并发布匹配API/Worker/后台/小程序。模板不是自动部署脚本，本轮未执行这些动作。

## 真实受控联调案例（全部待执行）

- 通过真实微信code登录，核实AppID/项目配置与主体、账号归属、退出/过期/换账号清理；开发登录应不可达。验证HTTPS、合法域名、后台安全Cookie/Origin/CSRF和可信代理限流，不能因本地HTTP用例通过跳过。
- 先保持新兑换与作业暂停，指定账号/非指定账号均不能新建；开放新兑换后只有指定微信账号可生成快递报价/订单，非名单账号、开发身份、旧本地模式被拒绝。
- 生成报价后暂停提交、移出名单、切换模式，验证服务端阻断且积分/预占不变；成功请求响应丢失后原键恢复，既有未发单取消一次退分/释放预占和配额。
- 打开作业后只处理CONTROLLED订单，按原预占批次/库位核实全部实物、真实地址/运费/承运可达性，实际交快递后确认发货；校验一次性库存消费、无重复扣分、打印页显示受控订单。开发/其他模式单即使同仓也不可发货。
- 暂停作业后新发货/纠错/反馈/回复被拒绝，成功原键仍可核实；恢复后原待办按原事实继续，发货与取消竞争只成功一边。反馈只是沟通记录，不执行退款、退货或补寄。
- 实际打印机、真机弱网/切后台、原键/失权清理、备份恢复与密钥恢复逐项留脱敏证据。核对当班未完成单、异常、告警和值守；只读首发页的配置卡片不代替验收签字。

## 停止与接续

需停止新兑换时关闭POINTS_EXPRESS_SUBMIT_ENABLED；需停止出库及新反馈处理时再关闭POINTS_EXPRESS_OPERATIONS_ENABLED。环境MODE保持与已受理订单一致以便后续继续处理，不删除订单模式、更正历史、运单归属或反馈事件，不回滚备份抹去新交易。模式不匹配时先回到正确隔离环境处理原单，不能改模式字段绕过。

下一步进入真实受控环境联调与人工验收；仍依赖实际HTTPS测试地址、受控配置的微信凭据、测试账号/商品和可用设备。未准备这些条件时可继续完善本地恢复演练，不能声称已生产上线。
