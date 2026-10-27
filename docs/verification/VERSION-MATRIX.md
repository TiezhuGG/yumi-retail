# S0 实测版本矩阵

验收日期：2026-10-27（Asia/Shanghai）。这些是本机实际安装并通过本次检查的版本，不是自动选择的最新版本。精确传递依赖与完整性哈希以根目录pnpm-lock.yaml为准。

| 项目 | 实际版本 | 本次验证 |
|---|---|---|
| Node.js | 24.22.1，Windows x64 | 编译、API、数据库、测试 |
| npm | 11.19.1 | 引导固定pnpm、执行脚本 |
| pnpm | 10.28.2 | 全工作区安装与锁文件；本机11启动器未采用 |
| TypeScript | 6.0.3 | 全工作区及测试类型检查、服务端输出 |
| NestJS common/core/platform-express | 12.2.0 | 正式tsc编译后启动，HTTP健康检查与真实数据库连接 |
| Prisma CLI/Client/adapter-pg | 7.10.1 | 生成、迁移、CRUD、事务、约束和并发 |
| pg | 8.23.1 | PostgreSQL连接、数据库初始化 |
| PostgreSQL | 17.11，Debian bookworm，linux/amd64 | Docker Desktop真实实例，开发/测试双库 |
| Docker Desktop | 4.96.3（244472） | Linux引擎启动、Compose与容器健康 |
| Docker Engine/CLI | 29.9.2 | 容器、命名卷、本机端口绑定 |
| Docker Compose | 5.6.1 | 数据库创建与健康等待 |
| Taro核心与插件 | 4.3.1 | 微信小程序生产编译与产物检查 |
| React / React DOM | 18.3.1 | 小程序、后台与移动H5编译 |
| 后台/H5 Vite | 7.3.1 | 两个Web应用生产构建 |
| Taro插件的Vite peer | 4.5.14 | 与后台Vite隔离，满足插件声明；小程序实际走Webpack5 |
| Vite React插件 | 4.7.0 | 后台/H5构建 |
| Ant Design | 5.29.3 | 后台构建与类型检查 |
| Babel core / React preset | 7.29.7 / 7.28.5 | Taro React编译 |
| Less | 4.2.2 | 满足Taro编译依赖，不引入旧3系列 |
| tsx | 4.23.15 | 数据库种子和测试；不作为Nest装饰器运行时转译器 |

PostgreSQL镜像固定为：

```text
postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27
```

## 兼容性决策

2026-10-27 S1补充：@nestjs/swagger **12.0.4**、ESLint/@eslint/js **9.39.1**、typescript-eslint **8.72.1**、Prettier **3.7.4**；其余上述版本保持不变。Swagger的Nest12/TypeScript6 peer已核对，typescript-eslint支持TS<6.1；已编译及实际HTTP测试。安装观察与本轮锁文件摘要见[S1安装版本](S1-INSTALLED-VERSIONS.json)，S0历史证据不覆盖。新增共享包web-ui复用React18员工登录与权限展示。

- 本机已有pnpm11启动器无法解析其自动下载的@pnpm/exe，改用官方pnpm10.28.2 JS CLI；项目本地依赖也提供该版本，npm run脚本优先使用它，不修改全局环境。
- Taro4.3.1 React插件声明React18/Vite4 peer，因此小程序与后台分别安装Vite4/Vite7，不强制统一两个编译器。
- Taro工具链固定Webpack5.91.0。部分新传递依赖要求更高Webpack，本项目将terser-webpack-plugin固定5.3.10、schema-utils4系列固定4.3.2；均满足实际调用方的依赖范围。最终安装不再报告peer冲突。
- Babel React preset为Taro的可选peer，但本项目选择React，所以必须显式安装。
- Nest运行时试用tsx时出现装饰器调用错误，最终使用TypeScript编译为带正确装饰器元数据的JS，再用Node运行；类型检查与实际HTTP测试均通过。
- 部分旧工具链传递包仍有deprecated提示；本次只证明所列兼容性与业务探针通过，不代表完成依赖漏洞审查或生产发布审查。此项在后续工程治理与发布安全检查中跟进。

本机生成的完整安装观察可用`node scripts/record-versions.mjs`重建；不输出环境凭据。Docker/数据库观察需独立核对，不能只看package.json。
