# Skills、插件与官方资料调研

初次调研：2026-10-25；安装更新：2026-10-26。已通过skill-installer查询官方目录，并在用户授权后安装playwright、security-best-practices、security-threat-model、gh-fix-ci。没有连接外部账号或向设计平台上传素材。安装状态与运行条件见[环境初检](../roadmap/ENVIRONMENT-CHECK-2026-10-26.md)。

## 1. 区分三类工具

- Skill：约定AI执行任务的步骤与检查方法，不会凭空提供微信商户、服务器或账户访问。
- 插件/连接器：提供Figma、GitHub等外部系统访问，需对应连接与权限。
- 工程依赖：Taro、Nest、MySQL、测试框架等，是项目实际运行/验证的软件，不能用安装skill替代。

目录脚本的installed标记只比较用户skills目录，不覆盖本会话已加载的系统/插件技能。例如 openai-docs/pdf 即使目录返回false，也不能简单说本会话没有。下表按当前会话目录和官方查询分别记录。

## 2. 优先考虑的官方技能

| 技能 | 当前状态 | 适用阶段 / 作用 | 限制 |
|---|---|---|---|
| skill-installer | 本会话可用，本轮已使用 | 查询官方技能、后续按需安装 | 目录清单不代表技能已安装或适合Windows |
| plugin-management | 本会话可用，本轮已使用 | 搜索设计/项目外部连接 | 插件推荐不等于账户已连接 |
| [playwright](https://github.com/openai/skills/tree/main/skills/.curated/playwright) | 2026-10-26已安装，下一轮可用 | 后台/仓库/骑手H5的真实浏览器交互检查 | 偏CLI交互；已验证Git Bash可解析npx，CLI/浏览器尚未实跑；不能代替微信真机 |
| [figma](https://github.com/openai/skills/tree/main/skills/.curated/figma) | 官方目录可安装，未安装 | 读取设计节点/变量/素材并协助实现 | 需要Figma连接和可访问设计节点，当前仅有PNG |
| figma-create-design-system-rules / figma-implement-design | 官方目录可安装，未安装 | 后续设计系统和设计到代码候选 | 本轮只核实目录存在，未实测完整流程 |
| [security-best-practices](https://github.com/openai/skills/tree/main/skills/.curated/security-best-practices) | 2026-10-26已安装，下一轮可用 | 代码出现后，明确发起安全审查时使用 | 支持JS/TS等，有明确触发边界；不是通用架构技能 |
| [security-threat-model](https://github.com/openai/skills/tree/main/skills/.curated/security-threat-model) | 2026-10-26已安装，下一轮可用 | 发布前专项威胁建模 | 需要代码和真实边界、明确专项请求；当前空项目不伪造代码级报告 |
| gh-fix-ci / gh-address-comments | gh-fix-ci已安装，后者未安装 | 建GitHub仓库后处理CI失败和评审 | 本机gh尚未检测到，GitHub授权与实际失败上下文未验证 |
| sentry | 官方目录可安装，未安装 | 有错误监控服务后查询问题 | 非首版必装，需服务账号与运行数据 |

上表能力基于[官方技能目录](https://github.com/openai/skills/tree/main/skills/.curated)；具体执行前读取对应SKILL并核对依赖。技能安装和文件存在不表示执行了浏览器测试、Figma实现、安全审查或CI检查。

目前无需为了开始编码一次安装全部技能。优先级：开始后台/作业端验证时选择浏览器技能；需要可编辑设计协作时选择Figma；形成业务代码后做安全专项；CI出现问题再增加对应工具。

## 3. 已有但本轮不必调用的能力

| 本会话能力 | 合适用途 | 当前处理 |
|---|---|---|
| imagegen | 品牌插画、横幅和图像资产 | 本轮评审已有PNG，不需重新生成；真实商品/证照仍由实际资料提供 |
| computer-use | 微信开发者工具及本机应用操作 | 到真机与开发工具阶段再按需使用 |
| visualize | 交互讲解和模拟 | 文档先用Mermaid与表格，当前不额外搭展示工具 |
| documents/pdf/presentations | 对外方案/报告 | 研发真相来源保留Markdown，不额外导出多套文档 |
| sites | 网页原型或托管网站 | 不作为微信支付与仓储交易后端的默认部署方式 |
| spreadsheets | 后续商品导入、经营分析 | 当前不引入，待实际数据文件出现 |

本次查询没有发现可据此验证的官方Taro/Nest/微信支付专用技能组合。技术实现直接依据相应官方文档与接口验证；不以“全栈万能skill”替代架构和测试。

## 4. 设计插件发现结果

插件目录返回：

- Figma：未安装。用于可编辑图层、设计系统及设计协作。目录显示近期已推荐，本轮不重复弹出推荐或自动连接。
- Product Design：未安装。可用于早期方案、界面流程评审和原型；与Figma需求部分重叠，不必同时引入。

当前可以直接基于现有图和代码组件继续，不以连接设计账号作为开发前置阻碍。需要可编辑设计稿时优先选择一种工具；PNG无法自动保证转成正确的组件与交互。

## 5. 主要技术来源与核验结论

| 来源 | 本次可核验内容 | 项目使用方式 |
|---|---|---|
| [Taro安装](https://docs.taro.zone/docs/GETTING-STARTED)、[React18](https://docs.taro.zone/docs/react-18) | 4.x文档、React路线、Windows工具要求 | 先最小编译与真机，按所选包锁版本 |
| [Nest迁移指南](https://docs.nestjs.com/migration-guide)、[CLI说明](https://docs.nestjs.com/cli/overview) | 新版本运行/CLI生成器的Node与TS门槛不同 | 不只满足最低运行版本；Node24兼容补丁版为候选 |
| [Prisma主入口](https://docs.prisma.io/docs/orm)、[7系列](https://docs.prisma.io/docs/orm/v7) | 打开页面显示8系列处于RC，MySQL需使用支持它的7系列；与部分搜索摘要表述不同 | 以实际打开的版本说明为准；避免latest并完成MySQL适配/事务验证 |
| [微信支付官方Go SDK](https://github.com/wechatpay-apiv3/wechatpay-go)、[退款源码](https://github.com/wechatpay-apiv3/wechatpay-go/blob/main/services/refunddomestic/api_refunds.go) | 官方APIv3参考实现、验签/通知处理及退款接口结构 | 仅作协议/安全参考，不因为服务端是TS就把Go包当可直接安装依赖 |
| [工信部APP备案通知](https://www.miit.gov.cn/jgsj/xgj/wjfb/art/2023/art_dd783a581c9644a4aee10afa582811db.html) | 含小程序分发场景的备案管理通知 | 备案资料及平台当前流程前置核对 |
| [腾讯云CVM](https://cloud.tencent.com/product/cvm)、[价格计算器](https://buy.cloud.tencent.com/pricing/cvm/calculator?devPayMode=monthly&imageType=linux) | 规格与计费维度、价格随配置变化 | 预算为工程估计，购买前含续费重新报价 |

官方技术页面随时间更新，上述为调研时的观察；本轮没有运行版本兼容性实验。依赖最终选择必须以包元数据、对应版本文档与本项目实测为准，不能沿用搜索摘要中混杂的新旧配置。

## 6. 未完成的外部核验

本次直接打开微信开发者隐私、code2Session和部分微信支付页面失败；搜索也未提供可直接读取的对应内容。因此将下列项保留为S0/S5上线依赖，不声称全部已核验：

- 当前账号类目、隐私敏感接口申请、最新授权流程和小程序审核要求。
- 真实商户的签名/平台公钥或证书模式、回调应答细节、绑定权限、支付/退款限制及账单文件。
- 具体经营城市与品类的经营资格、对外售后条款、隐私保留期限。

下一阶段应在负责人实际官方后台与可访问官方文档中逐项确认，再实施真实支付与发布；没有资质不阻碍本地商品、仓库和作业端开发，但不能绕过真实渠道验收。
