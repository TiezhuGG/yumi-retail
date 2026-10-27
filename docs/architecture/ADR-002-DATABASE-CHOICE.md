# ADR-002｜PostgreSQL 选型评估

日期：2026-10-26。状态：已采纳。用户明确确认将数据库改为PostgreSQL，使用本机Docker Desktop。原始MySQL资料归档不改；当前实施结果以S0验证报告为准。

## 已采纳的决策

对于本项目从零开始、需要订单/库存/退款约束、仓储与配送状态、后台任务和经营查询的情况，建议选择 PostgreSQL。MySQL8.4也能可靠完成首版；本建议依据是建模表达与后续维护便利，不是未经压测的性能排名，也不是换库就能保证不超卖。

目前只有设计文档，没有业务表、应用代码或真实数据，所以此时调整主要是更新规范和初始化方案，不需要真实业务数据搬迁。开始写迁移后应稳定选择，避免来回切换。

## 与本项目直接相关的比较

| 关注点 | PostgreSQL的价值 | 本项目判断 |
|---|---|---|
| 事务与行锁 | 支持条件更新、行锁、隔离级别 | 两者都能实现可靠交易；必须写正确事务并实测 |
| 有条件的唯一性 | 可用部分唯一索引只约束有效记录 | 适合每单仅一个有效取消请求、有效任务等约束 |
| 历史快照与附加资料 | jsonb支持JSON存储与相应索引 | 可存商品快照、任务元数据；金额/状态仍用关系字段 |
| 任务领取 | FOR UPDATE SKIP LOCKED适合队列表多消费者 | 支持轻量Worker方案；这不是PostgreSQL独有的卖点 |
| 统计查询 | 支持SQL聚合、窗口等分析方式 | 便于经营查询，但首版不因此建设数据仓库 |
| 团队与云服务 | 需核实托管规格、备份、监控和成本 | 尚无既有MySQL运维包袱，PostgreSQL可作为新起点 |

部分唯一索引见[官方说明](https://www.postgresql.org/docs/current/indexes-partial.html)，jsonb见[官方文档](https://www.postgresql.org/docs/current/datatype-json.html)。官方明确提示SKIP LOCKED适用于队列式访问而不适合一般一致性查询，见[SELECT说明](https://www.postgresql.org/docs/current/sql-select.html)。不能在商品库存分配时随意跳过被锁库存，再把结果当成最终缺货事实。

## 版本与ORM

优先考虑目标国内托管云已支持的PostgreSQL17或18稳定分支，使用所选分支受支持的补丁版本；开发、CI与生产主版本一致。精确版本要核对云可用性、驱动、扩展和实际迁移，再写入VERSION-MATRIX。支持周期见[官方版本策略](https://www.postgresql.org/support/versioning/)。

Nest与Taro方向无需因换库改变。ORM仍优先验证受支持的Prisma稳定版本及匹配驱动；[Prisma7文档](https://docs.prisma.io/docs/orm/v7)给出了PostgreSQL适配路线。主入口目前说明8系列仍为RC，见[主文档](https://docs.prisma.io/docs/orm)；本项目不因改PostgreSQL就默认上RC或直接安装latest。

## 实施清单

1. AGENTS、总纲、架构、数据库、部署、研发计划、状态记录统一切换，原始来源归档不改。
2. 数据库provider、连接格式、Compose、CI数据库服务、环境样例、迁移和种子数据同步调整。
3. DATETIME改为合适的timestamptz；UTC存取、北京时间营业/效期语义不变。INT/BIGINT保留范围检查，不依赖MySQL UNSIGNED；需要时明确CHECK。
4. JSON快照按用途选jsonb；内部主键可identity，外部不透明ID不变。不能将BIGINT直接转成不安全的JS number。
5. 重新核对文本排序/大小写与唯一编码规则、NULL唯一性、upsert、锁语法、RETURNING和驱动受影响行数语义；不要只替换数据库名字。
6. CHECK、部分唯一索引等若所选ORM声明方式不完整，使用受审查的版本化SQL迁移维护，不因ORM限制省掉约束。
7. 备份改为对应托管PostgreSQL备份/WAL/PITR路线，核验连接池、vacuum、磁盘和锁等待监控，重新核算费用。
8. 所有库存与交易集成测试改用真实PostgreSQL；不同时维护两套数据库后端，不使用SQLite替代并发验收。

## 不改变的业务保证

金额整数分、数量整数件；订单/库存/流水同事务；稳定业务号与幂等；退款额度占用；支付查单关单；任务租约与补偿；骑手数据权限；退款不自动回库。这些规则不会因数据库选型自动成立或消失。

PostgreSQL默认Read Committed仍可能出现需要应用处理的竞争，见[隔离级别](https://www.postgresql.org/docs/current/transaction-iso.html)。按固定顺序取锁、条件写、唯一约束与有限重试仍必须实现。

## 采纳的验收

确认选型→统一文档→锁定候选版本→本地真实数据库→Nest/Prisma迁移与CRUD→事务回滚→最后1件50意图争抢→重复业务键→多Worker租约恢复。上述通过后记录实际结果；本轮已进入实施与验证，不以设计文档存在代替通过证据。
