# `IsubBiller` 专项审查（biller-special-review）

> 范围：`sdk/src/biller.ts`（455 行，截至 2026-06-19）
> 配套接口：`store.ts::JournalEntry/KeeperStore`、`errors.ts::IsubError`
> 目的：审视这条 PAYG 结算管线在「资金正确性 / 并发与一致性 / 接口与扩展性 / 运维与可观测性 / 工程姿势」五个维度的真实状态，分清「已解决」/「还存在」/「未来风险」。

---

## TL;DR

- **核心资金正确性已经做得相当扎实**：G1 不变式（每条 usage 至多计费一次）由 `usageIds` membership reconcile + lease-based store lock + per-mandate single-flight 三件套合力守住；最新一轮把 amount-matched prefix 这条隐性 double-charge 路径彻底铲除，并在注释里明示 `usageIds` 为权威依据。
- **`run()` 经过三轮迭代到位**：fail-fast init、租约心跳、指数退避、可中断 sleep、async onTick 隔离、try/finally 关锁——之前提出的 7 项问题修了 6 项。
- **剩余风险集中在「运维姿势」和「规模扩展性」**：`inflight` Map 内存泄漏、`readJournal()` / `unbilled()` / `mandatesWithUnbilled()` 全量返回、`recordMeteredUsage` 无 mandate 校验、`console.error` 硬编码、`BillerEvent` 缺关键事件（`lock.lost` / `orphan.unrecoverable` / `run.degraded`）。
- **接口契约有几条隐式假设需要文档化**：「single-biller per mandate」依赖 store 的 `acquireLock+renewLock+releaseLock` 三件套全实现；`memBillerStore` 没实现锁——多实例使用会**静默**破坏 G1。

---

## 一、模块定位

- **角色**：服务端 / 商家侧 PAYG 结算管线。`./agent` 是需求侧（签发授权），`IsubBiller` 是供给侧（计量 + 拉款）。
- **管线**：`recordUsage`（按 usageId 幂等入库）→ 累积 →`flush`（per-mandate 单飞：clamp to spendable → 链上 `chargeMetered` → 剩余 carry）。
- **核心承诺（G1）**：每条 usage 至多被计费一次，即使跨丢 ack / 进程崩溃 / 链上–链下竞态。
- **依赖窄面**：仅 `BillerChain`（`IsubClient` 结构性满足）+ `BillerStore`（mem 用于测试，SQL 用于生产）→ 整条管线**不接链就能单元测试**。

---

## 二、设计闪光点（应当保留 / 推广）

### 2.1 G1 通过 reconcile + 单飞 + 单 biller 三件套合力守住
- `recoverOrphan()` 在**每次 settle 尝试顶端**跑，关掉「跨 flush 崩溃」和「循环内 ack 延迟」两个缺口。
- `usageIds`（membership）是权威依据，不再用 amount-matched prefix 重建——注释明示这是「the very bug this removed」。
- 多个 same-seq submit 收敛到「最后一个」：基于「任何更早的 submit 落账都会推进 chainSeq、迫使下一次 submit 用更高的 seq」这一推理，前提是单 biller 不变式由 store 锁强制。

### 2.2 「资金不变量唯一出口」模式
- `commitCharge` 是 markBilled + journal + emit + threshold 的唯一汇合点；任何 charge 成功都从这里穿过。
- `settle` 内部的错误码分类清晰：
  - `EOverRateCap / EOverBudget / EOverPerCharge` → 链上 rollback，重读缩 batch
  - `EInsufficient` → 直接 carry 退出
  - `EBadChargeSeq` 或瞬态 → **不**重新派 seq，让下次 `recoverOrphan` 兜
- `commitCharge` 失败被刻意**不捕获**：「the charge LANDED but wasn't recorded → an orphan the next attempt's recoverOrphan repairs」——这种「让幂等链路自己接住自己」的姿势是教科书级。

### 2.3 RateCard 一次冻结、永不回溯
- `recordMeteredUsage` 在 ingest 时通过 `priceUsageMulti` 算出 bigint 并冻结进 `UsageRow.amount`；`settle / recoverOrphan` 永远只读这个冻结值。
- 商家事后改价目表**绝不会**回溯重定价——这条保证支撑了「按 amount/usageId prefix-sum 对账」的正确性。
- 启动时 `assertValidRateCard(opts.rateCard)`——格式错的卡在构造期就抛，不留到 ingest。

### 2.4 lease-based store lock（最近一轮加入）
- `acquireLock + renewLock + releaseLock` 三件套：
  - 启动时 fail-fast 拿锁（contention 是 terminal，不重试）
  - 跑动时心跳 `renewLock`，被抢占即 `IsubError('lock')` → `run()` throw 退出
  - `close()` 在 `try/finally` 兜底释放，且 `if (!this.initialized)` 防误删别人的锁
- 这是从「咨询性启动锁」升级为「真正的 lease 语义」，与 G1 强相关——非常关键。

### 2.5 `run()` 的可中断 sleep + onTick 隔离
- `sleep(ms, signal)` 监听 abort、立即 resolve——优雅停机不再被 ≤ 60s 退避卡住。
- `onTick` 独立 `try { await ... } catch`——async sink 的 rejection 不会逃逸成 `unhandledRejection`，也不会污染 backoff 状态。

---

## 三、迭代历史（`run()` 三轮演进）

| 轮次 | 关键改动 | 解决问题 |
|---|---|---|
| v1（初版） | 朴素 `while + sleep + console.error` | — |
| v2（中间稿） | `init()` 提前抛、指数退避、`renewLock` 心跳、lock loss terminal | 锁竞争被当 flush 错重试 / 永久重试无退避 / 跑中锁被抢双计费 |
| v3（当前稿） | 可中断 `sleep(ms, signal)`、`await onTick` 独立 try/catch、`try/finally` 关锁 | 关停延迟 ≤ 60s / async sink rejection 逃逸 / 错误归因混乱 / `close()` 不被调用 |

**剩余一项未修**：`console.error` 硬编码（库代码 anti-pattern）。

---

## 四、现存问题（按严重度）

### A. 严重 —— 可能影响资金正确性 / 生产可用性

#### A1. `memBillerStore` 不实现锁，但接口未强制
- `BillerStore.acquireLock/renewLock/releaseLock` 都是 `?:` optional。`memBillerStore` 全部省略。
- 一旦用户把 `memBillerStore` 喂给 `run()` 的多实例部署，**所有 lease 语义静默失效**——`recoverOrphan` 的「last-submit-per-seq 收敛」推理也跟着失效，G1 失守。
- 构造期没有「`requireLock: true`」开关来要求 store 必须实现完整三件套。
- **建议**：
  - `BillerPolicy` 加 `requireLock?: boolean`（生产默认 `true`）；`run()` 启动时若 `true` 且任一锁方法缺失，立即抛 `IsubError('config')`。
  - 或在 `memBillerStore` 的 JSDoc 明显位置警告「never use with `run()` in any concurrent deployment」。

#### A2. `recordMeteredUsage` 不校验 `mandateId`
- 接受任意 `mandateId` 直接落库。
- 恶意/错误的调用方塞一堆 fake mandateId → 下次 `flush` 会去链上读这些不存在的 mandate（每个都 2 次 RPC），消耗 quota；也污染 `mandatesWithUnbilled()` 的返回。
- 这是「调用者必须可信」的契约假设，但代码里**完全没明示**。
- **建议**：注入 `KnownMandateProvider`（接口 `isKnown(mandateId): Promise<boolean>`），或在 ingest 时做缓存的链上 mandate 校验。最低限度：在文档里把这个契约假设钉死。

#### A3. `inflight` Map 永不清理 → 长跑进程内存泄漏
```typescript
private readonly inflight = new Map<string, Promise<unknown>>();

private flushOne(mandateId: string, nowMs: number): Promise<FlushResult> {
  const prev = this.inflight.get(mandateId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => this.settle(mandateId, nowMs));
  this.inflight.set(mandateId, next);     // ← 只 set 不 delete
  return next;
}
```
- 跑一个月、覆盖 100k 个 mandate 后，Map 里留 100k 个 resolved Promise（每个还引用 settle 闭包里的 chain/store/signer 等）。
- 不是泄漏到 OOM 那种致命，但**生产长跑进程会缓慢膨胀**——重启时机由 OOM/k8s memory limit 而不是业务驱动。
- **修法（两行）**：
  ```typescript
  next.finally(() => { if (this.inflight.get(mandateId) === next) this.inflight.delete(mandateId); });
  ```

#### A4. `BillerStore.readJournal()` 没有 by-mandate / by-seq 过滤 → 生产 O(N) 退化
- `recoverOrphan` 每次进来都 `readJournal()` **全表扫**：
  ```typescript
  const mine = (await this.store.readJournal()).filter((e) => e.mandateId === mandateId && e.seq != null);
  ```
- 单 biller 跑半年、几百万条 journal 时，每个 mandate 每次 settle 都全表扫一遍 → 链上扣 1 笔，链下扫 1M 行。
- **建议**：`BillerStore` 接口加 `readJournalFor(mandateId, sinceSeq?): Promise<JournalEntry[]>`。SQL store 加 `(mandateId, seq)` 复合索引。`memBillerStore` 用 nested Map 加速即可。

#### A5. `mandatesWithUnbilled()` / `unbilled(mandateId)` 没有分页和上限
- `flush()` 不带 `mandateId` 时拉「所有有 unbilled 的 mandate」一次性 `Promise.all` 全部并发 settle。
- 10k mandates → 单 tick 制造 ~30k 链 RPC 并发请求 → RPC 雷暴 / 限流 / 把 keeper 自己打挂。
- 单 mandate 累积 100k 条 usage（biller 停了几天）时 `unbilled()` 也是全量返回，`settle` 内部贪心循环遍历整列表。
- **建议**：
  - `flush({ concurrency, limit })`：批量并发上限 + 单批 mandate 数上限。
  - `unbilled(mandateId, opts?: { limit })`：按 atMs 升序限制条数。
  - 当 `unbilled` 返回长度 ≥ limit 时 settle 不要发 "rate_limited"，应发新事件 `usage.backlog`。

### B. 中等 —— 影响运维姿势 / 可观测性

#### B1. `console.error` 硬编码（库代码 anti-pattern）
- 两处：`run()` 的 onTick 失败、tick 失败。
- 服务端用 pino/winston/structured logging 无法接管；浏览器无 stderr；测试无法静默或断言。
- 模块自己已有 `BillerEvent` 总线，扩两条类型即可：
  ```typescript
  | { type: 'run.degraded'; at: number; error: string; nextRetryMs: number }
  | { type: 'run.sink_failed'; at: number; error: string }
  ```

#### B2. `BillerEvent` 缺关键事件
当前事件集：`charge.succeeded / failed / usage.carried / budget.threshold / budget.exhausted / mandate.expired`。

缺：
- `lock.lost` —— 租约被抢占（运维必须立刻知道，否则双 biller 已经在赛跑）。
- `orphan.recovered` —— 跟 `charge.succeeded { digest: 'recovered' }` 区分（见 B3）。
- `orphan.unrecoverable` —— legacy submit 无 `usageIds` 时降级写 fail journal，但**没有发事件**——除非有人盯库表，根本不会知道。
- `run.degraded` / `run.sink_failed`（替代 `console.error`）。
- `payg.repriced` —— `setRateCard()` 引入后需要（见 D1）。

#### B3. `charge.succeeded.digest = 'recovered'` 是字符串字面值
- orphan 恢复路径塞 `'recovered'` 进 `digest` 字段（设计上 digest 应是链上 tx digest）。
- 下游消费者用 `digest.startsWith('0x')` 或当主键存表会出错。
- **建议**：把 `BillerEvent` 拆出独立的 `orphan.recovered`，让 `charge.succeeded` 的 `digest` 永远是真链上 digest。或者加 `recovery: boolean` 字段，digest 可选。

#### B4. `renewLock` 心跳频率 = `pollMs`，但 store 的 lease TTL 是隐式契约
- `renewLock` 在每次 tick 顶端调用——心跳频率 = `pollMs`（成功路径）或 ≤ 60s（退避路径）。
- 如果 SQL store 设了 lease TTL = 30s 而用户 `pollMs = 60s`，**永远续不上**——biller 自以为在跑，其实租约早被回收。
- 当前没有任何文档/校验把「心跳频率 vs lease TTL」的关系写下来。
- **建议**：
  - 把心跳和 flush 解耦，独立 `setInterval(renewLock, leaseTTL / 3)`，让 backoff 不影响心跳。
  - 或在 `BillerPolicy` 里要求 `pollMs * 2 ≤ leaseTTL`，启动时 store 上报 TTL 给 biller 自检。

#### B5. 退避不能凭借「成功心跳」消解
- `backoffMs = 0` 只在 `flush()` 成功后才重置。
- 设想：链 RPC 抖了 5 次（退避到 ~60s），第 6 次只是 renewLock 成功、flush 还在重试 ——backoff 不会被 renewLock 的成功消解。
- 不是 bug，是**保守姿势**——但 `renewLock` 已经间接证明 store 健康，把它纳入 backoff 重置条件可以更快恢复。

### C. 低 —— DX / 文档 / 死代码

#### C1. `E_BAD_SEQ` 是 dead const
```typescript
const E_BAD_SEQ = 20;  // ← 定义了，但代码里没引用
```
注释 281 行提到了 `EBadChargeSeq`，但实际 `if` 分支没显式比较，让它走 default 路径——也对（recoverOrphan 兜），但显式更清楚。**建议**：要么删掉 const，要么加显式 `if (code === E_BAD_SEQ) { ... }` 分支。

#### C2. `pollMs` 语义没文档清楚
- 当前实际语义：「两次 flush 之间的间隔」（不是「每 pollMs 一次 flush」频率）。
- 如果 flush 自身耗时 5s 而 pollMs=1s，实际节奏是 6s/次。
- 这没错，但**用户常按「频率」理解**——`BillerPolicy.pollMs` 或 `run()` 的 JSDoc 应明确写「**间隔**（不是频率），用 setInterval 风格请自行实现」。

#### C3. `carryReason` 优先级
```typescript
if (m.spentTotal >= m.totalBudget) return 'budget_exhausted';
if (now < m.windowStartMs + m.rateWindowMs && m.windowSpent >= m.rateCap) return 'rate_limited';
if (balance < firstRecord || balance === 0n) return 'insufficient_balance';
if (firstRecord > m.maxPerCharge) return 'per_charge_too_small';
return 'rate_limited';
```
- 同时满足多个时按上面顺序返回第一个。
- 语义上 `per_charge_too_small`（配置死路）应优先于 `rate_limited`（暂时性）：前者**永远**结不了账，后者只是这一窗满了。
- 也缺 `not_before_yet`（首扣窗未到）类别——目前会落到 `rate_limited` 兜底，监控里看不到「不是限速、是首扣窗没到」。

#### C4. `BillerPolicy.maxRetries` 默认 5 的隐藏代价
- 一次 settle 最坏：5 次 `recoverOrphan`（每次至少 1 次链读 + 1 次 journal 全扫）+ 5 次 chain `chargeMetered`。
- 高并发 + 短退避场景下能制造 RPC 雷暴。
- **建议**：在 JSDoc 写明「retries are CHEAP only when chain reads are CHEAP」；考虑加 `interAttemptDelayMs`。

#### C5. 单文件 455 行，`settle()` 单方法 ~80 行
- 可拆出 `settleOnce(attempt, nowMs, signer-side context)` 让重试循环只剩流程骨架。
- `memBillerStore` 可以挪到 `store-mem-biller.ts` 让用户更清楚「mem 仅用于测试」。

#### C6. `flush()` 的「无参数」语义混合
- `flush()` 不带参数 = 拉所有有 unbilled 的 mandate；
- `flush(mandateId)` = 只这一个 mandate。

后者跳过 `mandatesWithUnbilled()`，跑得快；但前者在大流量下是炸弹（见 A5）。两种语义同一个 API 容易让用户在生产用错前者。**建议**：拆 `flushAll({ limit, concurrency })` 和 `flushOne(mandateId)` 两个明确入口。

#### C7. `BillerEvent` 缺类型守卫 helper
- 用户写 `switch (e.type)` 时要手动 narrow。
- **建议**：导出 `is<T extends BillerEvent['type']>(e, type): e is Extract<BillerEvent, { type: T }>` 之类 helper。

### D. 未来风险（功能扩展时浮现）

#### D1. RateCard 中途更换无 setter
- `rateCard` 是 `private readonly`，构造期一次定。
- 商家改价必须**重启进程**——但实际上 settle 全程只用 `record.amount`（已冻结），跟 rateCard 当前值无关。
- **可以安全**加 `setRateCard(card)` 方法（自动 `assertValidRateCard` 校验 + 发 `payg.repriced` 事件），不影响 G1。

#### D2. 单 mandate 跨 biller 实例迁移（rolling restart / leader handover）
- 当前 lease 语义保证「同一时刻只有一个 biller 在跑某 mandate」，但**切换瞬间**的 journal/store 一致性靠 SQL 事务隔离。
- 切换时如果 leader A 正在 `appendJournal(submit)` 后、`chargeMetered` 中、`commitCharge` 前被抢占，B 接手后会立即 `recoverOrphan` 检测到 orphan——✓ 路径正确。
- 但**没有 e2e 测试验证过这条路**（unit.ts K 系列测的是单实例锁，没测主从切换）。
- **建议**：加一个「leadership handoff」专项测：A 提交 submit、kill A、B 起来、验证 B 的 `recoverOrphan` 行为正确。

#### D3. `BillerStore` 缺 schema 版本
- `JournalEntry` 没 schema/版本字段。
- 未来要 deprecate 老字段（比如 `amount`）或加新字段（如 `walletAddr`）时，老 journal 不带这些字段，没有显式的 migration 路径。
- **建议**：journal 行加 `v: number`（schema version），store 读时按 v 走不同解析。

#### D4. 多代币（`<T>`）
- `BillerChain.chargeMetered` 不带 coin type 参数，依赖 `IsubClient` 构造时定的 `cfg.coinType`。
- 一个 biller 实例只能服务一种 `<T>` 的 mandate。
- 多代币场景需要每种代币一个 biller 实例 + 一个 store namespace——但当前接口没有 namespace 概念（`mandatesWithUnbilled()` 也不带过滤）。
- **建议**：`BillerStore` 隐含按 biller 实例隔离；接口文档明示「同一 store 不能被多个不同 `<T>` 的 biller 共享」。

---

## 五、建议路线图

按交付价值排序：

### Sprint 1（资金正确性闭环）—— 1~2 天
1. **A1**: `BillerPolicy.requireLock` 启动校验。
2. **A2**: `recordMeteredUsage` 加 mandate 校验注入点 + 文档化契约假设。
3. **A3**: `inflight` Map cleanup（一行 `finally`）。
4. **D2**: 加 leadership handoff e2e 测试用例。

### Sprint 2（可观测性 + 运维姿势）—— 1~2 天
1. **B1 + B2**: 砍掉 `console.error`，新增 `run.degraded / run.sink_failed / lock.lost / orphan.recovered / orphan.unrecoverable` 五个事件。
2. **B3**: orphan 路径单独发事件，`charge.succeeded.digest` 强类型为真链 digest。
3. **B4**: `renewLock` 心跳从 flush 解耦，启动期校验 `pollMs * 2 ≤ leaseTTL`。

### Sprint 3（规模扩展性）—— 3~5 天
1. **A4**: `BillerStore.readJournalFor(mandateId, sinceSeq?)` 接口 + SQL 复合索引 + mem 实现。
2. **A5**: `flushAll({ limit, concurrency })` / `flushOne(mandateId)` 拆分；`unbilled(mandateId, { limit })` 上限。
3. **C2 + C4**: 文档化 `pollMs` 语义与 `maxRetries` 代价。

### Sprint 4（DX 收尾）—— 1 天
1. **C1**: 清理 dead const。
2. **C3**: 调整 `carryReason` 优先级 + 增 `not_before_yet`。
3. **C7**: 导出事件类型守卫。
4. **D1**: `setRateCard()` + 文档「safe to call live」。
5. **D3**: `JournalEntry.v` schema 版本。

---

## 六、附录 A：建议补丁（关键三处的 diff 草案）

### A.1 `inflight` 内存清理

```diff
 private flushOne(mandateId: string, nowMs: number): Promise<FlushResult> {
   const prev = this.inflight.get(mandateId) ?? Promise.resolve();
   const next = prev.catch(() => undefined).then(() => this.settle(mandateId, nowMs));
   this.inflight.set(mandateId, next);
+  next.finally(() => {
+    // Only clear if we're still the tail (another flushOne may have chained on us already).
+    if (this.inflight.get(mandateId) === next) this.inflight.delete(mandateId);
+  });
   return next;
 }
```

### A.2 砍掉 `console.error`，事件化

```diff
 export type BillerEvent =
   | { type: 'charge.succeeded'; mandateId: string; at: number; amount: bigint; digest: string; seq: number }
   | { type: 'charge.failed'; mandateId: string; at: number; error: string; deterministic: boolean; abortCode: number | null }
   | { type: 'usage.carried'; mandateId: string; at: number; amount: bigint; reason: CarryReason }
   | { type: 'budget.threshold'; mandateId: string; at: number; pct: number }
   | { type: 'budget.exhausted'; mandateId: string; at: number }
-  | { type: 'mandate.expired'; mandateId: string; at: number };
+  | { type: 'mandate.expired'; mandateId: string; at: number }
+  | { type: 'orphan.recovered'; mandateId: string; at: number; amount: bigint; seq: number }
+  | { type: 'orphan.unrecoverable'; mandateId: string; at: number; seq: number; reason: string }
+  | { type: 'lock.lost'; at: number; error: string }
+  | { type: 'run.degraded'; at: number; error: string; nextRetryMs: number }
+  | { type: 'run.sink_failed'; at: number; error: string };
```

`run()` 内部：
```diff
-      console.error('biller: onTick listener threw (ignored):', e instanceof Error ? e.message : e);
+      this.emit({ type: 'run.sink_failed', at: Date.now(), error: e instanceof Error ? e.message : String(e) });
 ...
-      console.error(`biller: tick failed (retry in ${backoffMs}ms):`, e instanceof Error ? e.message : e);
+      this.emit({ type: 'run.degraded', at: Date.now(), error: e instanceof Error ? e.message : String(e), nextRetryMs: backoffMs });
 ...
       if (e instanceof IsubError && e.code === 'lock') {
+        this.emit({ type: 'lock.lost', at: Date.now(), error: e.message });
         throw e;
       }
```

### A.3 `requireLock` 启动校验

```diff
 export interface BillerPolicy {
   thresholdPct?: number;
   maxRetries?: number;
+  /** Refuse to run() if the store doesn't implement the full lease (acquire+renew+release).
+   *  Default true in production (set false ONLY for single-instance dev/test). */
+  requireLock?: boolean;
 }
 ...
 async run(opts: ...) {
+  if (this.requireLock && (!this.store.acquireLock || !this.store.renewLock || !this.store.releaseLock)) {
+    throw new IsubError('config', 'BillerStore must implement acquireLock/renewLock/releaseLock for run() under requireLock=true');
+  }
   await this.init();
   try {
     ...
   } finally {
     await this.close();
   }
 }
```

---

## 七、综合评分

| 维度 | 评级 | 一句话 |
|---|---|---|
| 资金正确性（G1） | **A** | reconcile + 单飞 + 单 biller 三件套到位；最近一轮拔掉了 amount-matched prefix 这条 double-charge 隐患 |
| 错误处理 | **A−** | abort code 分类清晰；commit 失败让幂等链路自接；缺 `lock.lost` / `orphan.unrecoverable` 事件 |
| 并发与一致性 | **A−** | per-mandate single-flight + lease lock，思路完整；`memBillerStore` 不强制锁是隐患 |
| 运维姿势 | **B+** | `run()` 经三轮迭代基本到位；`console.error` 是最后一块没拆的硬伤；缺监控事件 |
| 规模扩展性 | **B** | `readJournal()` / `unbilled()` / `mandatesWithUnbilled()` 全量返回是生产坑；`inflight` Map 不清理 |
| 接口与契约 | **B+** | `BillerStore / BillerChain` 窄面切得干净；少数隐式假设需文档化（lease TTL、mandate 已知性） |
| 文档与注释 | **A** | 注释密度高、解释 why 不是 what；只缺几条隐式契约 |

**综合：A−**。核心正确性已经达到 Sui 生态里少数项目的深度；剩下的工作集中在「让长跑进程不退化」与「把已经支撑正确性的不变量明确写进接口契约」。

---

*Last updated: 2026-06-19*
