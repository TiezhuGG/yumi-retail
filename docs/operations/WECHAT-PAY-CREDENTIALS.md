# 微信支付私有凭据与HTTPS请求层（C3a，2026-11-06）

当前只完成内部加载/轮换和JSAPI请求层，未接入运行中的订单业务，不会启动时自动读取凭据或发起请求。PAYMENT_MODE仍只允许disabled。持久化支付尝试、未知结果恢复、取消库存保护及真实平台/真机验收未完成；本手册不能作为启用支付的步骤。

## 私有凭据包

未来经授权准备真实商户材料后，将凭据包放在仓库和Web静态目录之外、由服务账号所有的私有目录。目录权限0700，包内所有文件0600、同属运行账号、普通文件且只允许一个硬链接。路径必须绝对且已解析，无目录或文件符号链接。父目录也须由可信运维管理，不能允许其他账号替换凭据目录。Linux文件权限是当前实现边界，其他系统尚未验收。

固定文件manifest.json，其余文件名由清单指定，只接受同目录的简单文件名。清单必须恰含以下字段，不允许附加字段；下面是合成结构示意，所有身份、通知地址和时间须按实际环境核实后替换，不能直接用于真实支付：

```json
{
  "version": 1,
  "revision": 1,
  "appId": "wx1111111111111111",
  "merchantId": "1900000109",
  "notifyUrl": "https://payments.yumi-demo.com/api/v1/wechat/notify",
  "privateKeyFile": "merchant.pem",
  "certificateFile": "certificate.pem",
  "platformKeys": [
    {
      "id": "PUB_KEY_ID_SYNTHETIC_1",
      "publicKeyFile": "platform.pem",
      "notBefore": "2026-11-06T00:00:00.000Z",
      "notAfter": "2026-11-07T00:00:00.000Z"
    }
  ]
}
```

- 商户私钥：单一未加密PKCS#8 PEM（BEGIN PRIVATE KEY），RSA2048/65537。未加密表示进程依赖操作系统私有文件保护，并不代表可放入普通配置库；加密PEM、密钥服务/HSM尚未实现。
- 商户证书：单一X.509 PEM，当前必须有效、非CA，CN等于预期商户号，公钥匹配私钥；签名证书序列号从证书读取。这里只校验本地一致性，不核验商户开户、证书签发链或AppID交易权限。
- 微信支付公钥：单一SPKI PEM（BEGIN PUBLIC KEY），RSA2048/65537，按已核实的PUB_KEY_ID绑定；1至4个、不重复。当前实现公钥模式，不自动下载或信任应答中的未知公钥，不支持平台证书包自动更新。
- notBefore/notAfter是运维明确配置的本地信任窗口，必须为带毫秒的UTC时间，不是本程序推断出的官方公钥有效期。加载及每次使用至少一个公钥有效，应答使用的公钥也必须在收到应答时有效。
- 单文件上限32KiB。拒绝越目录、符号/硬链接、FIFO、权限过宽、异常PEM和读取期间的文件变化。加载错误不输出原值、文件内容、系统异常或路径。

AppID、商户号、通知地址须与调用方预期完全一致，通知地址仍遵守固定HTTPS公网域名规则。公钥和证书的真实来源需人工/商户平台验收，不能只凭本地格式检查宣布可信。

## 离线检查

仅在已授权的服务器私有环境文件配置WECHAT_PAY_CREDENTIALS_DIR、WECHAT_PAY_APP_ID、WECHAT_PAY_MCH_ID、WECHAT_PAY_NOTIFY_URL及同一WECHAT_APP_ID，再执行：

```bash
pnpm check:wechat-pay-credentials
```

命令先构建服务端，明确调用离线加载器；不连接微信或数据库。成功仅输出CREDENTIALS_VALID_OFFLINE与credentialsLoaded=true，canStartPayment/networkChecked始终false。未配置目录输出CREDENTIALS_NOT_CONFIGURED并退出1；其他错误输出CREDENTIALS_INVALID并退出1。不打印身份、通知地址、私有目录、密钥或完整异常。检查不会改变PAYMENT_MODE，也不会建立支付尝试。

## 轮换和失败处理

完整准备新的私有包，revision使用更大的正整数，保留需要覆盖在途请求的旧公钥及合理信任窗口，再由可信运维原子替换目录并显式reload。不要原地改动正在读取的包。新包所有检查通过后才切换；失败则阻断新的请求，修复并成功reload后恢复。已发出请求保留其原商户私钥、公钥集合和版本快照，不能混用轮换后的私钥签名；证书和公钥在应答时仍须有效。

同revision仅允许完全相同内容，拒绝内容替换及较低revision。该防回退是进程内检查，重启后无持久化基线；受控发布/跨进程版本治理和灾备需后续实现与验收。不同实例应统一管理已授权凭据版本，本实现没有公开重载、上传或密钥管理API。

HTTPS请求只到https://api.mch.weixin.qq.com:443/v3/pay/transactions/jsapi，POST、TLS1.2以上、证书/主机名验证开启。默认5秒总时限覆盖DNS/TLS/所有响应字节，原始包体最多64KiB，头部最多16KiB；拒绝重定向、压缩、重复微信签名头、截断和无效签名。测试依赖可将连接送往本机合成HTTPS服务，应用配置没有替换地址、CA或关闭TLS验证的选项。

请求层不自动重试。NOT_DISPATCHED表示凭据/订单前置检查未通过；开始交给传输层后的错误均归RESULT_UNKNOWN，包括HTTP错误、断连、超时和验签失败。未知不能等同支付失败/关单成功，也不能触发库存释放。内部成功结果仍只是经验证的预支付调起参数，不是入账证据。

后续C3b必须先持久化原订单支付尝试并建立取消/预占释放保护，再在数据库事务外发请求，最后核对原尝试并持久化结果，才可把参数给客户端。崩溃/超时须从原尝试恢复，不能通过换订单号或新尝试绕开未知结果。当前运行中API不注册请求层，不能跳过这些条件调用真实支付。

## 官方协议依据

2026-11-06核对微信官方[JSAPI下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791856)、[微信支付公钥验签](https://pay.wechatpay.cn/doc/v3/merchant/4013053249)、[参数及密钥标识说明](https://pay.wechatpay.cn/doc/v3/merchant/4013070756)。本项目的权限、文件大小、时限、轮换及未知结果策略属于本地实现约束，不冒充微信平台强制要求或真实联通结论。
