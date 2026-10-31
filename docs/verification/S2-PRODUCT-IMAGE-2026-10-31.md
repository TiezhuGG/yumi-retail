# 商品主图管理交付（本地开发版）

日期：2026-10-31。接续收货条码查询，边界为每个商品一张主图的上传、替换、移除，以及后台和消费者首页/详情显示。沿用 ui/board1、ui/mini1 和既有绿白视觉。多图、排序、SKU独立图片、生产对象存储不在本轮完成范围。

## 实际功能与数据

后台 http://127.0.0.1:5173/ → 商品管理 → 商品行“主图”。独立窗口读取最新资料，选择后先预览再保存；取消选择保留原图。上传、替换和移除都使用Product.version、员工权限、CSRF、幂等键及事务审计。旧版本需显式载入最新资料；结果未知时冻结原文件、请求体和键，按原意图重试。成功后刷新权威列表，刷新失败明确提示。

仅PNG/JPEG，原文件不超过2MiB，扩展名/MIME/文件头一致且真实解码成功；单页、宽高16–4096、总像素不超过900万。sharp旋转并缩至最长边1200，不放大，重编码PNG且输出不超过4MiB，原始文件不落盘。每个API进程最多两个并行解码，忙时503。开发/测试JSON上限3MiB，生产保持100KiB；超限413、损坏JSON400。文件名不能包含路径或控制字符，内部对象键由服务端生成。

新增product_images元数据表及Product.image_id可空列，复合外键保证主图属于该商品；现有商品默认无图。迁移202610310001_product_images已应用本机开发库，测试在独立随机schema应用全部迁移。库存、成本、SKU身份、售价和上下架状态不因改图变化。商品/规格契约新增可空imageId/imageUrl，兼容无图数据；实际OpenAPI同步。

元数据在PostgreSQL，图片在忽略目录.local/product-images（开发/测试可用PRODUCT_IMAGE_LOCAL_DIR配置）；无数据库图片二进制。生产拒绝配置本地适配器，图片写入返回503 IMAGE_STORAGE_UNAVAILABLE，待接正式对象存储。现阶段使用有界base64请求，原架构预签名上传意图流程仍待实现。

文件写入后在同一数据库事务绑定、递增版本和审计。事务失败先确认数据库没有该对象引用才补偿删除；无法确认提交结果时保留文件。替换/移除保留历史元数据及对象，但旧URL立即404。崩溃可能遗留孤儿对象，npm run verify:product-images仅只读比较元数据/目录，不自动删除；并行写入期间需人工复核。数据库与图片目录需配套备份，恢复演练未做。

## API

- POST /api/v1/admin/products/:id/set-image：catalog.write、员工会话、Origin/CSRF、UUID幂等键；严格请求 {version,image:{fileName,mime,base64}}，image:null为解除主图；返回完整商品及SKU。相同键不同意图409，历史重放不重新绑定图片。
- GET /api/v1/admin/products/:id/image/:imageId：catalog.read，当前绑定且同商品才可读取，草稿可预览。
- GET /api/v1/product-images/:id/:imageId：当前绑定、商品上架、分类及父分类启用、有启用SKU、公开仓启用才可读；缺货仍沿用目录显示规则。PNG二进制；错误为JSON，no-store/nosniff。不存在/历史/不可公开均404。
- 公开商品目录新增可空相对imageUrl，小程序按API源地址拼接，读取失败回退已有包装示意，不虚构商品摄影。

## 功能验收

真实PostgreSQL商品收货集成51/51（原45+6）：权限/CSRF/严格输入、伪装SVG和损坏图片、尺寸/字节/JSON边界、JPEG重编码、当前绑定/归属/公开范围、复合外键、同键并发、版本竞争、历史重放、库存和成本不变、审计晚期失败回滚及文件补偿、生产配置拒绝本地适配器。输出.local/image-integration.log。仅清理测试自有schema及目录，现有Engine/PostgreSQL数据卷未重建。

服务端/worker、共享UI、后台/移动作业构建，全工作区typecheck、ESLint、修改代码与OpenAPI的Prettier、git diff --check通过；实际OpenAPI导出通过。小程序weapp编译及产物检查通过，浏览重试4项回归通过。Node实际24.22.0与声明24.22.1的既有差异保留。

scripts/ui/verify-product-images-live.cjs在显式YUMI_LIVE_UI=1及本机开发库限定下通过真实API/浏览器创建合成草稿→上传PNG→上架公开读取→替换JPEG→移除→下架；核对旧URL404、目录引用和库存不变。保留标记合成资料和审计，最终UNPUBLISHED、imageId=null，不修改原演示商品。纯红/纯蓝为测试夹具，不能当作真实商品照片。库存API前后相同。文件库存最终4条元数据，missing及unreferenced均为空。

## UI验收

scripts/ui/verify-product-images.cjs合成状态验证：加载、详情错误重试、空图、非法文件、预览/取消、版本冲突、结果未知按原体原键重试、成功后读取最新绑定、移除、图片读取失败回退、只读及320/375/414布局。原商品资料编辑UI回归通过。实际查看桌面及手机截图，手机长窗口可滚动；编译通过不替代这些检查。

| 场景 | 证据 |
|---|---|
| 真实后台预览 | [桌面](UI-PRODUCT-IMAGE-LIVE-DESKTOP-2026-10-31.png)、[手机](UI-PRODUCT-IMAGE-LIVE-MOBILE-2026-10-31.png) |
| 加载 / 空图 / 失败 | [加载](UI-PRODUCT-IMAGE-LOADING-2026-10-31.png)、[空图](UI-PRODUCT-IMAGE-EMPTY-2026-10-31.png)、[错误](UI-PRODUCT-IMAGE-ERROR-2026-10-31.png) |
| 冲突 / 未知 / 回退 | [冲突](UI-PRODUCT-IMAGE-CONFLICT-2026-10-31.png)、[未知](UI-PRODUCT-IMAGE-UNKNOWN-2026-10-31.png)、[回退](UI-PRODUCT-IMAGE-READ-ERROR-2026-10-31.png) |
| 微信原生组件 | [首页](WECHAT-PRODUCT-IMAGE-HOME-2026-10-31.png)、[详情](WECHAT-PRODUCT-IMAGE-DETAIL-2026-10-31.png)、[缺失回退](WECHAT-PRODUCT-IMAGE-FALLBACK-2026-10-31.png) |

微信开发者工具已载入此次weapp。scripts/ui/verify-product-images-wechat.cjs通过：目录wx.request使用明确标记的实际API商品响应夹具，原生Image组件显示真实后端PNG，失效URL回退包装示意。getImageInfo探测明确失败：url not in domain list；不能算完整目录请求联通、合法域名下载或真机验收。首次探测异常后改为捕获并记录此限制，最终组件验证通过；请求mock已恢复，合成商品均移除主图并下架，临时自动化端口9420已关闭、工程以普通模式重开。urlCheck保持true，既有工具服务保留。真机仍缺合法HTTPS测试API。

## 接续

下一切片：商品多图与排序，继续沿用现有视觉及本地可审查边界。正式对象存储、预签名上传、孤儿对象清理/恢复演练、真实摄影资料、微信完整网络及真机另验。无生产部署、付费资源、外部账号连接、真实支付或上线验收，完整S2/G1不整体勾选。
