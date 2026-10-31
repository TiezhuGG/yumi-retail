# 商品多图与排序交付（本地开发版）

日期：2026-10-31。接续单主图交付，本轮边界为每商品有序图片集、主图选择/移除和消费者详情展示。最多6张是本轮实现的技术保护上限，不代表负责人另行确认的正式运营素材规范。沿用ui/board1、ui/mini1及当前绿白风格，无付费资源、外部账号或生产部署。

## 实际完成

后台 http://127.0.0.1:5173/ → 商品管理 → 商品行“图片”。独立窗口展示当前图片集及主图标记；一次添加一张、预览后提交，末尾追加；设为主图、前移/后移及移除先在窗口暂存，点击“保存顺序和移除”后一次提交，可撤销未保存调整。第一张为主图，移除第一张后下一张递补；保存空数组后恢复包装示意。添加和未保存排序互斥，避免丢失草稿；达到6张后需先保存移除才能添加。关闭前提示未保存排序会丢弃，关闭后刷新列表。

保留加载/空/错误重试、版本冲突显式载入最新、读取文件晚到保护、响应未知时冻结原操作并按相同请求体/键重试。成功或历史重放后重新读取权威图片集，不能用历史响应覆盖较新顺序；已提交但读取失败时锁定继续操作并提示刷新。读取图片失败提供重试。普通页面不输入UUID、版本、对象键。

消费者首页继续使用首图；详情用原生Swiper显示有序图片、当前计数和上一张/下一张，可左右滑动。单图无切换按钮；无图片或图片加载失败回退明确的包装示意。价格、规格、库存及上下架仍由原API提供，无购物车/支付功能扩展。

## API、规则与兼容性

- GET /api/v1/admin/products/:id/images：catalog.read、员工会话，返回 {product,images:[{id,url}]}；商品含当前版本/SKU，图片按当前顺序，仅含可读相对地址，不泄露对象目录/历史文件。
- POST /api/v1/admin/products/:id/add-image：catalog.write、会话/Origin/CSRF/UUID幂等键，严格 {version,image:{fileName,mime,base64}}；追加一张，非空，达到6张409 IMAGE_LIMIT；返回当前事务图片集。
- POST /api/v1/admin/products/:id/set-images：相同写权限和保护，严格 {version,imageIds:[UUID]}，最多6个且不重复。只能是本商品当前图片的有序子集；外商品、未知或历史已移除ID均400 INVALID_IMAGE_REFERENCE，空数组移除全部。版本冲突409。
- 公开目录/详情SaleSku新增imageUrls数组，空时[]；保留imageUrl作为首图或null，旧消费者仍可只读首图。主图URL不因纯排序撤销，移出的图片在后续新读取时404；已移除元数据/文件仍保留，不能通过重新提交旧ID恢复。
- 既有POST set-image结构和单图语义保持；多图下替换/移除只处理首图，其余保留，移除会递补，因此image:null在多图时不保证返回imageId=null。需要清空全套应使用set-images空数组。这是明确的多图兼容语义变化。
- 管理员可读当前草稿图片；公开图片须满足上架、分类/父分类启用、有启用SKU、公开仓启用，缺货仍沿用目录显示规则。图片处理限制沿用上轮：PNG/JPEG≤2MiB、静态16–4096边长且≤900万像素、重编码最长1200的PNG≤4MiB；每进程最多2个解码，JSON开发/测试3MiB、生产100KiB。未新增依赖。

## 数据、迁移与事务

202610310002_product_gallery新增product_images.sort_order可空列，0..5 CHECK及(product_id,sort_order)唯一索引。非空代表当前图片集；NULL是历史/未绑定素材。只将既有Product.image_id指向的本商品当前图片回填为0，历史对象不激活。Product.image_id继续作首图及复合归属外键；应用持商品行锁后先清空旧顺序再设置连续顺序，同时更新首图、版本、业务审计和幂等结果。

202610310003_audit_details新增business_audits.details可空JSONB。原因是完整多图顺序超过既有200字符reason容量；reason保留版本/数量摘要，details保存完整before/after有序ID数组，旧审计保留原值、details为空。两项迁移均已应用本机yumi_dev，测试在隔离schema执行全部迁移，另有旧主图回填专项验证。未清库或重建Engine数据卷，无库存/金额迁移。部署前必须先停旧写入、应用全部迁移并重启新版服务，旧版本写入不维护新顺序，不能混跑回滚。

新增文件仍写本地开发适配器，事务失败确认数据库无引用才删除；未知提交/清理结果保留待核对。移除保留元数据/文件，不自动垃圾回收。npm run verify:product-images只读盘点，无删除；本轮最终盘点10条元数据，missing/unreferenced均为空，3个合成商品均UNPUBLISHED且无当前图片；数据库与对象目录须配套备份，恢复演练未做。生产对象存储/预签名上传仍未实现，生产禁止启用本地适配器；本轮不代表生产图片能力完成。

## 功能验证（实际运行）

- PostgreSQL **58/58**，原51加7项。覆盖图片集读取权限、写权限/CSRF、严格请求/重复/超长/非法引用、数据库位置唯一及0..5约束、PNG/JPEG继承校验、添加/排序/删除/主图一致、当前和跨商品归属、公开分类范围、历史不恢复、6张上限及并发越界保护、同键并发只一条审计、同键改体冲突、历史重放不覆盖、与上架版本竞争、旧单图接口保留其余图片、晚期审计失败回滚顺序/版本/新增文件补偿和原键重试、现存主图迁移回填。新增断言核对details.before/after顺序完整。输出.local/gallery-integration.log。
- 首次运行定位到图片集GET的BigInt序列化和长顺序审计备注溢出，分别使用共享jsonValue及结构化details修复，最终全套通过。测试只清理本次自有schema及文件目录，开发数据不删。
- scripts/ui/verify-product-gallery-live.cjs在显式YUMI_LIVE_UI=1和本机yumi_dev/public限定下，真实后台登录、新建标记合成商品、PNG/JPEG添加、排序/设主图、上架、两图公开读取并核对PNG、移除首图递补/旧地址404、移除全部/空目录引用、下架通过。核对SKU资料和读取的库存API页前后不变，不执行入库/出库。两次运行均finally清空并下架新商品，保留合成资料/历史图片/审计；不改原演示商品。结果.local/product-gallery-live.json。
- 服务端/worker、共享web-ui、后台和移动作业构建，全工作区typecheck、ESLint、修改代码/OpenAPI的Prettier及git diff --check通过，实际OpenAPI导出通过。复验期间原后台5173服务停止导致一次连接拒绝，恢复后合成和真实页面检查均通过。
- 小程序weapp重新编译、产物/三个导入根校验通过，浏览重试4项回归通过。沿用锁定版本，无新依赖；既有Node实际24.22.0与声明24.22.1差异保留。

## UI验收（独立记录）

scripts/ui/verify-product-gallery.cjs合成状态验证通过：加载/详情失败重试/空集、非法文件、选择预览/取消、版本冲突冻结、未知结果按原体原键重试、历史响应后权威刷新、主图/前后移/移除/撤销、6张上限、已提交后读取失败锁定、坏图重试、只读角色与320/375/414无横向溢出。旧单主图三个UI验证入口已转调对应图片集验证，旧截图保留；原商品资料编辑窗口回归通过，截图另存/tmp/yumi-gallery-regression，未覆盖历史证据。已实际查看原图和桌面/手机截图，手机采用单列，长窗口可滚动；此项不由构建或DB测试代替。

| 场景 | 截图 |
|---|---|
| 真实桌面两图 / 手机主图切换 | [桌面](UI-PRODUCT-GALLERY-LIVE-DESKTOP-2026-10-31.png)、[手机](UI-PRODUCT-GALLERY-LIVE-MOBILE-2026-10-31.png) |
| 加载 / 读取失败 / 空图片集 | [加载](UI-PRODUCT-GALLERY-LOADING-2026-10-31.png)、[错误](UI-PRODUCT-GALLERY-ERROR-2026-10-31.png)、[空集](UI-PRODUCT-GALLERY-EMPTY-2026-10-31.png) |
| 冲突 / 未知 / 图片读取失败 | [冲突](UI-PRODUCT-GALLERY-CONFLICT-2026-10-31.png)、[未知](UI-PRODUCT-GALLERY-UNKNOWN-2026-10-31.png)、[坏图](UI-PRODUCT-GALLERY-READ-ERROR-2026-10-31.png) |
| 六张图片布局 | [桌面](UI-PRODUCT-GALLERY-DESKTOP-2026-10-31.png)、[手机](UI-PRODUCT-GALLERY-MOBILE-2026-10-31.png) |
| 微信详情第一页 / 第二页 | [第一页](WECHAT-PRODUCT-GALLERY-FIRST-2026-10-31.png)、[第二页](WECHAT-PRODUCT-GALLERY-SECOND-2026-10-31.png) |
| 微信缺图 / 空集回退 | [缺图](WECHAT-PRODUCT-GALLERY-FALLBACK-2026-10-31.png)、[空集](WECHAT-PRODUCT-GALLERY-EMPTY-2026-10-31.png) |

## 微信与剩余边界

已通过既有授权的本机微信开发者工具服务加载此次weapp，scripts/ui/verify-product-gallery-wechat.cjs实际验证两个原生图片显示、下一张/上一张、1/2→2/2→1/2计数、缺图/空集包装示意。图片来自实际API的本地PNG，目录wx.request使用标记的实际商品响应夹具；不等同微信完整目录网络、getImageInfo域名下载或真机通过。组件基于Swiper，未验证实体触屏滑动。色块为合成测试素材，不是真实商品摄影。

finally恢复wx.request mock、清空并下架合成商品、退出测试会话；工具临时9420端口关闭，工程普通模式重开，urlCheck保持true，用户原工具服务保留。真机仍待合法HTTPS测试API；生产对象存储、备份恢复、孤儿清理和真实素材另验。没有生产发布、真实支付或完整G1/S2验收。

下一切片：消费者商品详情规格切换，展示同商品可售规格及对应价格/库存；继续按当前风格自主完善。生产图片存储和真机保留独立门禁。
