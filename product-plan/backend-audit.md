# iSub 后端审计与可用性判定

*日期：2026-06-18 ｜ 方法：27-agent 审计 workflow —— 6 维度并行审计(读真实代码)+ 实跑测试套件 → 每条发现对抗性复核(是否真问题/链上是否已重扣/能否触发)→ 综合判定。*

> **更新 2026-06-18**:**全部 High + 系统级 Medium 已修复并验证**——High-1(recoverOrphan 同-seq)、原 Med-3 →**上调 High-2**(SQL 锁脑裂)、Med-1(biller.run 锁空转)、Med-2(`void flush` 崩进程)、Med-4(engines.node 下限)。验证:typecheck 0、unit 87/0、biller-smoke 35、store-smoke 27。**余 2 条 Medium 待办**:webhook 死表(偏运维,可带外恢复)、gateway 限流(反向代理可兜)——均非核心系统。

## 0. 一句话判定

**现在可用于单机房、非托管的 Fixed + PAYG 计费:零资金安全缺陷(合约是权威、所有离线套件全绿)、无 blocker;有 1 个已确认的链下记账 bug 和几个活性/运维硬化项,在"主网大规模真钱"之前需补。**

## 1. 可用性(分场景)

| 场景 | 判定 | 理由 |
|---|---|---|
| **Hackathon demo / 展示** | ✅ **可用** | 无任何阻断。Move 72/72、typecheck 干净、unit 83/0、biller-smoke 35/35、store-smoke 24/24 全绿且不需网络。非托管设计让资金受链保护、与链下 bug 无关;唯一的 high 只在"封顶 abort→同 seq 重发→丢 ack"的特定瞬态下触发,demo 碰不到。单机房正是 demo 拓扑。 |
| **Testnet 试点(友好用户、小额)** | ⚠️ **有条件可用** | 资金安全成立(合约重扣每个上限 + `charge_seq` 幂等;recoverOrphan 用精确 usageId 成员判定,smoke F/G/I 实证)。需做的是**运维条件**:① 钉 Node ≥22.5;② 给两处 `void biller.flush()` 加 `.catch()`,避免一个瞬态/锁拒绝**拖垮整个 gateway 进程(殃及所有租户)**;③ 严格单机房;④ recoverOrphan 的链下重复计数在罕见瞬态下会污染账面/对账——小额可容忍但要盯账。**都不威胁用户资金。** |
| **主网大规模真钱** | ❌ **暂不** | 差距是**链下健壮性/运维,不是资金托管**(资金仍非托管、受链上 cap 限)。必修:recoverOrphan 重复计数、biller.run 终态锁空转、未捕获 rejection 进程崩溃、SQL 锁心跳自过期;加上单机房残留(无多机房 HA)、webhook 仅内存投递、gateway 无限流——"规模化"还需外部代理 + HA 故事 + 打包/密钥硬化。 |

## 2. 确认为真的问题

### 🔴 High(2 条,链下记账/活性,**非资金损失**;**均已修复并验证 ✅**)

**High-1 · `recoverOrphan` 同-seq 重复计数** —— ✅ 已修([biller.ts](../iSub/sdk/src/biller.ts))
- 触发:封顶 abort(#8/#9/#24,seq 不变)→ 同-seq 重试 → 重试丢 ack 但其实落账 → recoverOrphan 用 `seq-1` 对同-seq 两条 submit 误判 → **链下账面/对账重复计数**(非双扣、非资金损失,链上 `charge_seq` 幂等挡死)。
- **修法(已实现)**:recoverOrphan **每个未结清 seq 只恢复最后一条 submit**——任一更早的同-seq submit 必定没落账(落账会推进 seq、逼下条到更高 seq;且 settle 每次先 recoverOrphan)。比"给 submit 加唯一 id"更简,**无需新列/迁移**。
- **回归测试**:封顶 abort→同-seq 丢 ack → 恰好恢复一次(无修复时 `charged===2`,修复后 `===1`)。正确性依赖单-biller 不变量 → 与 High-2 同批修。

**High-2 · SQL 锁心跳自过期 → 脑裂双 flush(原 Med-3,经评审上调)** —— ✅ 已修([sql-store.ts](../iSub/sdk/src/sql-store.ts))
- 触发:SQL 锁只在 acquire 写心跳、**运行期不刷新** → 健康实例 120s 后即被判 stale → 第二实例(滚动部署/重启没停干净/误启)随时接管 → 双 flush。**不是稳态边界,而是正常运行 2 分钟后就长期"可被接管"**。链上 `charge_seq` 防双扣,但**破坏 recoverOrphan 依赖的单-biller 不变量** + 持续烧 gas;连"单机房"在滚动部署时都不安全。
- **修法(已实现)**:`renewLock()` 所有权保护刷心跳、丢锁即抛 `IsubError('lock')`;`releaseLock` 加 `WHERE holder=?`(不误删新持有者);biller.run **每 tick renew**,抛锁被终态分支接住、干净让位。
- **回归测试**:renew 刷新成功 / 外部接管后 renew 抛错 / 守卫 release 不删外部行。

### 🟠 Medium(原 6 条 → 1 条上调 High、1 条已修;余 4 条待办)
- ~~biller.run 终态锁空转~~ —— ✅ **已修**(与 High 同批:run 循环前 `await init()` fail-fast、抛锁终态化、加指数退避、close() 加 `initialized` 守卫)。
- ~~SQL 锁心跳自过期~~ —— → **上调为 High-2,已修**(见上)。
- ~~`void biller.flush()` 未捕获 rejection 可崩整个 gateway~~ —— ✅ **已修**(两处 `void flush().catch(log)`,[service.ts](../iSub/sdk/src/service.ts):瞬态/锁拒绝不再变成崩进程的 unhandled rejection,窗口循环照常重试)。
- ~~`engines.node:'>=20'` 与 node:sqlite 实际下限矛盾~~ —— ✅ **已修**(`engines.node` 改 `>=22.5.0`,[package.json](../iSub/sdk/package.json):不合规 Node 启动期大声失败)。
- **webhook 死表**(仅内存投递、重启丢)([db.ts:71](../iSub/sdk/src/db.ts#L71))。**待办**(偏运维;可经 `GET /subscriptions`/链上对账带外恢复)。
- **gateway 无限流/防爆破**([gateway.ts:68](../iSub/sdk/src/gateway.ts#L68))。**待办**(反向代理可兜)。

### 🟡 Lows(纸割,零资金/活性影响)
service 内存预算闸对重试 usageId 重复扣减(保守地少服务,biller 仍去重正确)· IsubAbortError 丢了 abort 消息里的 digest · 文件 store 无 fsync(可从链重导)· payoutAddress 唯一性是未强制的不变量(仅运营自配错)· 缓存的租户 service 到重启才认 routing 轮换 · consent.ts 仅导出未在服务端门控(需调用方接入)· biller 未特判 EIntervalNotElapsed(被 spendableNow 挡,够不到)· 硬编码 abort 码字面量(`===4`/`=6`,可能与合约漂移)· package.json exports 指向裸 .ts(private 0.0.1,诚实守卫)· recoverOrphan 全 journal 扫描(性能)· 瘦客户端 status() 把非 404 错误体强转为 SubscriptionStatus。

## 3. 实测结果(全绿)
- **Move 合约 72/72**(terms-binding、charge_seq replay、max_per_charge、退款安全、资金守恒、keeper 绑定、版本)
- **SDK typecheck 干净**(证实统一 IsubError 重构跨所有 catch/instanceof 类型通过)
- **SDK unit 87/0**(含新增 **recoverOrphan 同-seq 回归**;pricing 舍入/u64/确定性、入账冻结扛改卡、consent L1b 防篡改/验签)
- **biller-smoke 35/35**(mem+SQL:lost-ack 恰好恢复一次、崩溃重启不双扣、乱序成员精确恢复、单飞、跨实例 SQL 锁、零扣款失败)
- **store-smoke 27/27**(含新增 **SQL 锁所有权:renew/守卫 release**;存储契约等价、单实例锁、多租户行隔离、api-key 认证)
- *网络 smoke(smoke/keeper/payg/agent/pricing/service/managed-e2e)按指令跳过(需 live RPC)——但 **pricing e2e 已于 localnet 11/11 + testnet 公开 11/11 实证**(本会话早些时候)。*

## 4. 什么是扎实的(公允地说)
- **非托管核心是真的**:合约对每笔扣款重扣 amount/rate-cap/window/max-per-charge/total-budget/balance/interval/expiry/status/账户绑定/terms-binding + `charge_seq` 幂等(72/72 覆盖)。
- 唯一真实的链下损失向量(重复计数恢复的孤儿)已**完全关闭**:常见路径靠精确 usageId 成员恢复(smoke F/G/I),同-seq 边界靠"每 seq 只恢复最后一条"(High-1 修复 + 回归测试)。
- PAYG 去重持久且正确(SQL `ON CONFLICT DO NOTHING` by (merchant_id, usage_id))。
- 多租户两层隔离(service 拒非本租户 mandate;每条 SQL `WHERE merchant_id=?`)。
- 新代码干净:pricing 整数且入账冻结(扛改卡)、db.migrate() PRAGMA 守卫幂等加性、provenance 仅审计用;IsubError 重构端到端完整。

## 5. 上生产前清单(按序)
1. **修 recoverOrphan**:per-submit 唯一 id(或每次 chainSeq 前进最多恢复一条)+ 回归测试([biller.ts:303-328](../iSub/sdk/src/biller.ts#L303))。
2. **两处 `void biller.flush()` 加 `.catch()`**([service.ts:93/127](../iSub/sdk/src/service.ts#L93))。
3. **biller.run 对齐 keeper**:循环前 `await init()`,把 `IsubError('lock')` 当终态 + backoff([biller.ts:353](../iSub/sdk/src/biller.ts#L353))。
4. **`engines.node` 改 `>=22.5.0`**([package.json:8](../iSub/sdk/package.json#L8))。
5. **运行期周期刷新 SQL 锁心跳**([sql-store.ts:99](../iSub/sdk/src/sql-store.ts#L99))。
6. **webhook 投递持久化** + gateway 加 per-IP 限流。多机房/规模化:行锁换 Postgres advisory lock + HA 故事(当前是已接受的单机房残留)。
