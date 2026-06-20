# `IsubBiller` 优化方案 / 状态追踪

> 配套 `biller-special-review.md`：把审查里的每条问题映射到「已修 / 待办」，记录**实际采用的修法**(有几条与审查的建议不同，如实标注)与待办项的具体计划。
> 当前验证基线(2026-06-19)：`typecheck 0 · Move 72/72 · unit 96/0 · biller-smoke 35 · store-smoke 27 · service-smoke 12` 全绿。
> 处理口径:先修「**会严重影响运行**」的(A2 flush 隔离 / A5 并发 / B4 心跳),再按价值排其余。**没有一条触及资金正确性**(链上 `charge_seq`+cap 守住)。

---

## 0. 状态快照

| 项 | 主题 | 状态 | 备注 |
|---|---|---|---|
| run-loop | 可中断 sleep / async onTick 隔离 / close 入 finally | ✅ 已修 | sleep 监听 abort;onTick await+独立 try;try/finally 关锁 |
| High-1 | recoverOrphan 同-seq 重复计数 | ✅ 已修 | **每 seq 只恢复最后一条**(非审查建议的 submitId;更简、无迁移) |
| High-2(原 Med-3) | SQL 锁心跳自过期 → 脑裂 | ✅ 已修 | renewLock 所有权保护 + 守卫 release(评审上调为 High) |
| Med-1 | biller.run 终态锁空转 | ✅ 已修 | init 提前抛 + 抛锁终态 + 退避 |
| Med-2 | `void flush()` 崩进程 | ✅ 已修 | 两处 `.catch(log)` |
| Med-4 | engines.node 下限 | ✅ 已修 | `>=22.5.0` |
| **A2(运行严重半)** | flush 无故障隔离 | ✅ 已修 | `mapWithConcurrency + 每 mandate .catch`(对齐 keeper K-1) |
| **A5(运行严重半)** | flush 无并发上限 | ✅ 已修 | `BillerPolicy.concurrency`(默认 8)工作池 |
| **B4** | 心跳频率绑死 pollMs | ✅ 已修 | 独立 `setInterval(renewLock, leaseRenewMs)`(默认 40s) |
| A1 | memBillerStore 无锁、接口不强制 | ⏳ 待办 | 脚枪;正确生产用 sqlBillerStore |
| A2(契约半) | recordMeteredUsage 不校验 mandateId | ⏳ 待办 | 托管路径已被 service.session 前置校验 |
| A3 | inflight Map 内存泄漏 | ⏳ 待办 | 两行修,最高性价比 |
| A4 | readJournal 全量 O(N) | ⏳ 待办 | 规模 perf |
| A5(分页半) | unbilled / mandatesWithUnbilled 无上限 | ⏳ 待办 | 深层规模 |
| B1 | console.error 硬编码 | ⏳ 待办 | 库代码 anti-pattern |
| B2 | BillerEvent 缺关键事件 | ⏳ 待办 | 观测 |
| B3 | `digest='recovered'` 字面值 | ⏳ 待办 | 下游消费者 |
| B5 | 退避不被 renew 成功消解 | ⏳ 待办 | B4 后部分消解 |
| C1–C7 | DX / 文档 / 死代码 | ⏳ 待办 | 见下 |
| D1–D4 | 未来扩展风险 | ⏳ 待办 | 功能扩展时再处理 |

---

## 1. 已修复(实际方案)

- **run-loop 三件套**：`sleep(ms, signal)` 监听 abort 立即 resolve;`onTick` 改 `await` 并裹独立 `try/catch`(async sink 的 reject 不逃逸成 unhandledRejection、不污染 backoff);循环裹 `try/finally`，`close()` 总执行。
- **High-1**：`recoverOrphan` 收敛为「每个未结清 seq 只恢复**最后一条** submit」。依据:任一更早的同-seq submit 落账都会推进 `charge_seq`、逼下一条用更高 seq,且 settle 每次顶端先 recoverOrphan → 故同-seq 多条里只有最后一条可能落账。**比审查建议的「per-submit 唯一 id」更简,无需新列/迁移**;正确性依赖单-biller 不变式(由锁保证,见 High-2)。
- **High-2**：`makeLock` 加 `renewLock()`(所有权保护 `WHERE holder=?`,丢锁抛 `IsubError('lock')`),`releaseLock` 同样加 `WHERE holder=?`(不误删新持有者)。
- **A2(运行严重半)**：`flush()` = `mapWithConcurrency(ids, concurrency, id => flushOne(id).catch(→ 失败 FlushResult + charge.failed))`。一个读不出/已 close 的 mandate 只落自身零扣款 + 一条 `charge.failed`,不连累整批,不被当批失败永久重试。
- **A5(运行严重半)**：新增 `mapWithConcurrency` 工作池,`BillerPolicy.concurrency`(默认 8)。
- **B4**：`run()` 用**独立计时器** `setInterval(renewLock, leaseRenewMs)`(`BillerPolicy.leaseRenewMs` 默认 40_000 = 120s 租约 TTL 的 1/3),与 pollMs/退避解耦;续约发现被取代 → 置 `lost` → 循环终态退出。移除了「每 tick renew」。
- 测试:`testRecoverOrphanSameSeq` / `testBillerRunLifecycle` / `testFlushIsolation` / `testFlushConcurrency` / `testBillerHeartbeat`(unit);`store-smoke` 加 SQL 锁所有权;`service-smoke` 经 start/stop 实跑改后的 run。

---

## 2. 待办优化方案(按优先级)

### P1 — 低成本、明确收益
- **A3 inflight 内存清理**(两行):
  ```ts
  next.finally(() => { if (this.inflight.get(mandateId) === next) this.inflight.delete(mandateId); });
  ```
  防长跑进程按「不同 mandate 数」缓慢膨胀。零语义影响。
- **A1 requireLock 启动校验**:`BillerPolicy.requireLock?: boolean`(生产传 `true`);`run()` 启动时若 `true` 且 store 缺 `acquireLock/renewLock/releaseLock` 任一 → 抛 `IsubError('config')`。**默认 false**(不破坏单实例/测试用 memBillerStore + run)。+ `memBillerStore` JSDoc 顶部警告「多实例部署禁用」。
- **B1 + B2 事件化**:`BillerEvent` 增 `run.degraded` / `run.sink_failed` / `lock.lost` / `orphan.recovered` / `orphan.unrecoverable`;`run()` 与 settle 的 `console.error` 改发事件(服务端可接 pino/winston、测试可断言)。
- **B3 orphan 事件拆分**:恢复路径发独立 `orphan.recovered`,让 `charge.succeeded.digest` 永远是真链 digest(去掉 `'recovered'` 字面值,避免下游 `digest.startsWith('0x')`/主键出错)。

### P2 — 规模扩展性(账本变大前做)
- **A4 by-mandate journal 读取**:`BillerStore` 加 `readJournalFor(mandateId, sinceSeq?)`;`recoverOrphan` 改用它。SQL 加 `(merchant_id, mandate_id, seq)` 复合索引;`memBillerStore` 用 `Map<mandateId, JournalEntry[]>` 加速。消除每笔结算 O(全租户 journal) 的全表扫。
- **A5 分页 / 背压**:`unbilled(mandateId, { limit })` 按 atMs 升序限条;`flush({ limit, concurrency })` 限单 tick mandate 数(超出下 tick 续);`unbilled` 达 limit 时发 `usage.backlog` 而非误报 `rate_limited`。(并发上限已做;这里补「单 mandate / 单 tick 的体量上限」。)
- **B5 退避并入心跳健康信号**:B4 解耦后续约已独立;可在心跳成功时把 `backoffMs` 归零(renew 成功间接证明 store/网络健康),加快恢复。

### P3 — DX / 文档 / 死代码(C 类)
- **C1** 删 dead const `E_BAD_SEQ`(或加显式 `if (code === 20)` 分支)。
- **C2** JSDoc 写清 `pollMs` 是「间隔」非「频率」。
- **C3** `carryReason` 优先级:`per_charge_too_small`(配置死路)应先于 `rate_limited`(暂时);补 `not_before_yet` 类别。
- **C4** JSDoc 写明 `maxRetries` 在链读昂贵时的代价;考虑 `interAttemptDelayMs`。
- **C5** 拆 `settle()` → `settleOnce()`;`memBillerStore` 挪到 `store-mem-biller.ts`。
- **C6** 拆 `flushAll({limit,concurrency})` 与 `flushOne(mandateId)` 两个明确入口(避免生产误用无参 flush —— 并发上限已挡住最坏情况,但语义仍宜分清)。
- **C7** 导出 `BillerEvent` 类型守卫 helper。

### P4 — 未来扩展(功能浮现时,D 类)
- **D1** `setRateCard(card)`(运行期改价目;settle 全程只读冻结的 `record.amount`,**改价安全**,发 `payg.repriced`)。
- **D2** 主从切换(leadership handoff)e2e 测试:A 提交 submit→kill A→B 起→验证 B 的 recoverOrphan 行为(当前只测了单实例锁)。
- **D3** `JournalEntry.v`(schema 版本)为将来字段迁移留路径。
- **D4** 多代币:文档明示「一个 biller 实例只服务一种 `<T>`,同一 store 不可被不同 `<T>` 的 biller 共享」。

---

## 3. 建议下一批
**P1 全做**(A3 两行 + A1 requireLock + B1/B2/B3 事件化)—— 成本低、补齐「可观测性 + 误用防护」,把 special-review 的 A/B 段基本清空。P2(A4/A5 分页)在接近规模拐点前做。C/D 随手或按需。
