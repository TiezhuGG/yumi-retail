# 批量运单导入 · 2026-11-07

## 本次范围

后台「积分兑换订单→批量运单导入」提供空白或已选待发货订单模板，固定四列：订单号、快递公司代码、快递公司名称、运单号。仅UTF-8 CSV，最多20单/32KB；标准公司名称可留空，OTHER需填写。支持BOM/CRLF、引号及逗号转义；拒绝错误表头/列数/编码、字段换行/控制字符、重复订单/运单和不合格快递资料。订单号及运单按文本填写。

预检按当前授权仓匹配原兑换单号，核对状态、原预占、库存、批次、库位、作业开关及历史运单占用，问题按行列出；任一问题则不返回部分收件资料、不允许部分提交。全部通过后逐单展示原收件信息/备注、商品和批次/库位/数量及对应运单，需确认已逐单核对实物和真实运单且已交给快递。

确认时重新验证全部版本/状态/权限/库存效期，原运单、出库/库位流水、逐单审计、整批审计与幂等结果同事务提交，任一失败整批回滚。不同顾客、不同SKU可在一批分别发货；同运单重复不会自动合包，应修正文件或使用既有合包入口。旧发货/更正/收货/售后路径保持，不重扣积分。

结果未知时按操作者/授权仓隔离保留原键及最小请求参数（订单/版本/运单，无CSV或收件信息）；刷新后可核实，原成功请求不重复出库。401/403、5xx、网络异常保留原请求；明确业务拒绝清空预览后重检。前端不保存上传文件或文件名，不将预检视为库存锁定或未来发货授权。

## 实际功能检查

Node24.22.1、现有精确依赖，无安装或升级。以下最终组合共44项通过（4项纯解析+40项真实PostgreSQL集成），重跑不重复计数：

```sh
node --env-file=.env --import tsx --test --test-concurrency=1 tests/waybill-csv.test.ts tests/waybill-import.integration.test.ts tests/express-parcels.integration.test.ts tests/redemption-express-shipping.integration.test.ts tests/redemption-express-corrections.integration.test.ts
```

- CSV解析4项：BOM/CRLF/引号逗号转义；损坏表头/列/引号、换行/控制字符/公式订单身份；重复/超量/过大；模板只带原单号不虚构运单。
- 批量导入13项真实PG：预检只读；逐单原预占消费/积分保持；同键重放、内容变化与新键防重；缺单/取消/参数/版本/实物声明/角色/CSRF/当前仓；库存冻结和迟发审计失败整批回滚；与单单/合包/另一批次/取消竞争；中途会话/批次效期失效；暂停后的原请求恢复仍验权限；不同顾客/不同SKU分别出库、不碰未选预占；原始和更正历史运单占用不能复用。
- 合包13项、原单发货8项、运单更正6项回归通过；既有数据库库存/库位平衡、不可变事实、历史运单排他触发器均继续执行。

全部使用自动建立并清理的隔离schema、合成顾客、真实收货与库存服务，未向经营数据库写入订单/运单/发货/退款。测试出现既有pg adapter并发query弃用提示，当前无失败。首轮暂停测试曾将已发货订单的新键409误期望为503，已改为另建待发货订单验证暂停503，未放松服务端状态保护。

服务端、公共UI、后台、移动作业端构建及全仓typecheck/lint、Prettier/diff检查通过；OpenAPI导出0.81.0。后台先构建`@yumi/web-ui`再构建admin-web/ops-mobile，防止旧公共包dist残留。无新迁移（仍63项）。

## 实际界面检查

```sh
YUMI_LIVE_UI=1 YUMI_PLAYWRIGHT_PATH=... node --env-file=.env --import tsx scripts/ui/verify-waybill-import.mjs
```

实际React工作台、隔离API/PG及Chrome通过：模板真实下载读取、原订单号正确填入、CSV真实上传、无效UTF-8/表头提示、加载、库存阻断、桌面/390px手机与底部确认区、未勾实物确认禁用、服务端提交后丢失响应、刷新保留原键恢复、原订单已发货详情。共12张截图；实际查看桌面、手机底部和阻断状态，无横向溢出。手机列表批量操作区改为两列，文件选择按钮沿用界面风格。

- [空状态](UI-WAYBILL-IMPORT-EMPTY-2026-11-07.png)
- [编码错误](UI-WAYBILL-IMPORT-ENCODING-ERROR-2026-11-07.png)
- [格式错误](UI-WAYBILL-IMPORT-CSV-ERROR-2026-11-07.png)
- [加载](UI-WAYBILL-IMPORT-LOADING-2026-11-07.png)
- [桌面核对](UI-WAYBILL-IMPORT-READY-DESKTOP-2026-11-07.png)
- [手机核对](UI-WAYBILL-IMPORT-READY-MOBILE-2026-11-07.png)
- [手机底部确认与两列操作](UI-WAYBILL-IMPORT-FORM-MOBILE-2026-11-07.png)
- [库存阻断](UI-WAYBILL-IMPORT-BLOCKED-2026-11-07.png)
- [结果未知](UI-WAYBILL-IMPORT-UNKNOWN-2026-11-07.png)
- [刷新恢复](UI-WAYBILL-IMPORT-RESTORED-MOBILE-2026-11-07.png)
- [成功](UI-WAYBILL-IMPORT-SUCCESS-2026-11-07.png)
- [已发货](UI-WAYBILL-IMPORT-SHIPPED-2026-11-07.png)

## 兼容性和本地交付

新增POST `/api/v1/admin/redemptions/waybill-import/preview`和`/confirm`。单单、合包等旧接口参数/响应不变；服务器复用原库存结算方法和幂等权限钩子，原迁移/密钥/经营开关未改变。已同步PRD/API/数据设计/总计划/开发计划/商城剩余清单。

本地API更新至0.81.0，live/ready均200，在线OpenAPI包含两个新接口；5173后台和5174作业端均200，实际资源包含waybill-import/preview和confirm。没有生产部署、付费资源或外部快递连接。

尚未实现XLSX/GBK导入、自动电子面单、快递接口、自动运输轨迹。实物装箱/交接、真实经营规则、微信开发者工具/真机及生产验收未完成；本地合成发货验证不能替代真实交接。
