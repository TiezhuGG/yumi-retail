# 真实联调门禁与本机重建指南 · 2026-11-02

本指南区分本机技术准备与真实业务验收。`localChecksPassed=true`只表示该命令列出的本机检查通过；`canStartRealFulfillment`固定为false，不能用来批准接真实订单。现有履约、支付实验为隔离合成流程。

## 命令入口

| 命令 | 行为 |
| --- | --- |
| `npm run check:fulfillment:local` | 脱敏检查精确Node版本、默认关闭开关、本机绑定、开发/测试库URL边界及构建文件存在性；不联网、不写数据库 |
| `npm run check:fulfillment:database` | 只读连接本机yumi_dev/yumi_test，核对36项迁移名称及SHA256、未完成迁移、UTC及最新分配人门禁 |
| `npm run verify:fulfillment:rebuild` | 仅允许无查询参数的本机yumi_test URL；新建随机临时schema重放全部迁移，检查门禁后清理，不迁移开发库 |
| `npm run test:fulfillment:local` | 配置边界、输出脱敏和setup幂等测试 |
| `npm run test:fulfillment:rebuild` | 真实PG临时schema重建及独立哨兵保留检查 |
| `npm run preview:admin:local` / `npm run preview:ops:local` | 预览已构建产物，绑定127.0.0.1:5173/5174，API仅代理127.0.0.1:3000；不代表生产服务器 |

`--database --rehearse`可组合运行。URL拒绝远程主机、错误库名及所有查询参数（含host/schema重定向）；报告不输出连接串、密码、原始SQL或密钥。构建文件存在不证明构建新鲜度或进程健康。迁移演练不等于从备份恢复，也不等于对业务库执行migrate deploy。

## 本机实际状态

已使用现有PostgreSQL17.11 Windows二进制新建独立`.local/dev-pg-data`，仅监听127.0.0.1:55432，dev/test均UTC，36个Prisma迁移已应用且校验和一致。不是更换数据库，也未安装Docker。`.env`由setup:local生成并被Git忽略，无外部凭据；原不存在.env，未覆盖既有账号或数据库。额外旧隔离测试实例55439已停止。

执行原本机seed（以同一源码、编译数据库模块运行）生成1个明确演示仓库、3个本地员工，以及S0专用validationStock夹具；它不是可售商品库存。消费者、正式订单、库存流水、支付准备、合成拣货任务、经营规则及服务小区均0。没有填造真实小区、顾客、运费或真实商品。临时验收员工会话已撤销。

当前API3000、后台5173、作业5174可在本机访问。真实登录及默认关闭/无任务页面已在1440桌面和390手机验证。账号/密码请在本机忽略的.env中查看，不贴入聊天或日志。Worker未启动。地址加密密钥尚未生成，地址写入及其他未配置功能不能视为已准备好。下单、消费者开发登录、支付与合成演练均未启用。

## 可重复重建顺序

1. 沿用VERSION-MATRIX的Node24.22.1、pnpm10.28.2及锁文件，执行frozen-lockfile安装，禁止无差别升级latest。
2. `npm run setup:local`：仅创建/补齐忽略的本机配置，保留已有值。不要把现有数据目录当作新库初始化。既有凭据/地址密钥应先备份，不能用新随机值替换旧库的密钥。
3. 启动PostgreSQL17.11本机实例。Docker可用时沿用compose；当前已验证原生实例不依赖Docker。现有原生实例重启可执行：

```powershell
$pgBin = Join-Path $PWD '.local/pg-tools/node_modules/@embedded-postgres/windows-x64/native/bin'
Start-Process -FilePath (Join-Path $pgBin 'postgres.exe') -ArgumentList @('-D', (Join-Path $PWD '.local/dev-pg-data'), '-h', '127.0.0.1', '-p', '55432', '-c', 'timezone=UTC') -WindowStyle Hidden
```

原生二进制及数据目录仅本机忽略保存，克隆仓库不会自动获得。使用Compose重建前先停止相同端口的原生实例，勿覆盖或删除数据目录。

4. 用已有本机配置执行`db:init`、`db:generate`、`db:migrate`和`db:migrate:test`，确认仅指向yumi_dev/yumi_test，再运行检查和演练。迁移已应用时Prisma应报告无待应用迁移，不重新造业务数据。
5. 按需运行本机seed；它只用于明确标注的开发员工/演示仓库。需要地址写入时使用已有setup:address-key，保留/备份旧密钥；本轮没有启用该功能。
6. 构建API/Worker和两个Web端，再运行dev:api及本机built preview。当前沙箱中Vite开发依赖优化器读取父目录失败，built preview避开该限制，不宣称普通dev命令已修复。小程序.taro4.0用户目录写权限仍待处理。
7. 运行`check:fulfillment:database`和`verify:fulfillment:rebuild`并留存脱敏报告。默认配置不启用任何真实交易或演练写入。

Windows当前PATH未配置Node/npm时，可将应用附带Node目录及node_modules/.bin加到当前终端PATH，或使用完整Node路径运行上述脚本；不要为此改变全局版本或把凭据写进命令参数。

## 真实联调门禁

| 门禁 | 当前状态 | 下一份可审查证据 / 负责人提供内容 |
| --- | --- | --- |
| 经营资料 | 未验证，数据库为空 | 唯一小区/楼栋、真实商品/规格/实物库存、营业及配送安排、运费/起送/免运规则；只提供业务值 |
| 缺货/售后规则 | 待业务确认 | 缺货、破损、拒收、退回的实物和资金处理规则；合成处置不代表已退款或换货 |
| 微信/网络 | 未验证 | HTTPS测试API地址、合法域名及微信工具/真机联通证据；不需要在聊天提供密钥 |
| 支付实现 | 阻断 | 真实渠道下单、通知入账、查询/关闭/补偿的实现与受控联调；商户/主体/绑定仅提供开通状态 |
| 真实履约接入 | 阻断 | 真实已付订单到拣货/库存出库/本人配送的受控闭环；当前独立合成凭据不能替代 |
| 发布和恢复 | 未验证 | 明确授权的测试部署、备份恢复演练、安全检查及限定真实走单；本轮不连接外部账号或使用付费资源 |

所有未确认规则仍保持待确认。未取得上述证据，不把本机配置/迁移通过当成G2/G3或生产验收通过。下一项建议先收集负责人可提供的非敏感业务资料与测试API状态，再据实际依赖选择真实渠道或履约接入切片。
