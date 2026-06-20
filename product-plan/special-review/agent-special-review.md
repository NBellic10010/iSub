# `IsubAgent` 专项审查（agent-special-review）

> 范围：`sdk/src/agent.ts`（267 行，截至 2026-06-19）
> 关联代码：`exposure.ts::accountExposure`、`client.ts::authorizeFixed/authorizeMetered/quoteFromPlan`、`mcp.ts` 的 WALLET face
> 目的：审视这条「AI Agent 自治订阅」运行时在「资金安全 / 错误处理 / LLM 边界 / 持久化 / DX 一致性」五个维度的真实状态，对照同 SDK 内 `biller.ts` / `keeper.ts` 的工程姿势，找出差距与补救路径。

---

## TL;DR

- **核心叙事（model A 白名单 + terms-binding；model B 开放发现 + envelope-only）讲得清楚、注释诚实**。
- **但作为「让 AI 自治花钱」的 SDK 模块，工程严肃性明显落后于 `biller.ts`**：缺持久化 store seam、跨订阅预算无聚合校验、model B 主动放弃用户独立节流阀、入参/必填字段无 startup 校验。
- **最严重的两条结构性缺口**：
  - **D**：完全没有 `AgentStore` 接口——重启即失忆，`budgetStatus` 会撒谎说"atRisk=0"，agent 自己也不知道还订过什么。
  - **A2**：subscribe 入口**只校验单条**预算 cap，**不聚合现有 totalAuthorized vs envelope**——LLM reasoning 一次失误就能让真实敞口爆涨。
- **LLM 边界的人因防呆几乎为零**：`budget` 入参 throw 不友好，`ttlMs` 单位极易被 LLM 误读为天数。
- **建议升级路径**：在「资金安全」与「LLM 防呆」两条线上做一轮专项加固，把模块从「demo agent」推进到「可托付几十 SUI 的生产 agent」。

---

## 一、模块定位

- **角色**：iSub 面向「AI Agent 经济」的 demand-side 运行时——人类设 `SpendPolicy`，agent 自主调 `subscribe / use / unsubscribe`，护栏由「专属 account 余额 = 硬上限 + 白名单 + （可选）开放发现」三层组成。
- **两种信任模型**：
  - **Model A（默认）**：agent 只能订阅 `policy.allowed` 里的服务；`expected_*` 来自人类审核条目，链上 terms-binding 仍然有意义。
  - **Model B（opt-in `allowOpen`）**：agent 可订任意 plan；terms-binding 是自检 no-op，**仅靠 envelope 约束**。
- **对外形状**：`IsubAgent` 类（4 个动词：listServices / subscribe / unsubscribe / budgetStatus）+ `agentTools()` 描述符（1:1 映射 MCP / LangChain / OpenAI fn）。
- **依赖窄面**：仅 `IsubClient` + `IsubSigner` + 内部纯函数 `accountExposure`——dep-free、isomorphic。

---

## 二、设计闪光点（应当保留）

### 2.1 Model A vs B 的诚实拆分
- 模块顶部注释（1-16 行）明确写出两种模型的**保护边界差异**："Honest caveat: terms-binding can't protect this (no human reviewed the terms) — the cap is the guard."
- 返回值 `SubscribeResult.terms: 'approved' | 'unverified-open'` 把这个差异**通过 API 传递给 caller**，下游 LLM 可以基于这个 flag 决定要不要 escalate 给人。
- 在「让 agent 自由」与「让人类放心」之间用 opt-in 开关分割——这种诚实的姿势是 SDK 设计的范式。

### 2.2 Framework-agnostic 工具描述符
- `agentTools(agent)` 返回的 `AgentTool[]` 是纯 JSON-Schema + handler 对——既能直接喂 MCP server，也能套适配器塞 LangChain/OpenAI fn。
- 模块**零 MCP SDK 依赖**——保持 isomorphic，浏览器/Node/Edge 都跑得动。
- 注释明确"Amounts cross the LLM boundary as decimal STRINGS (bigint-safe)"——理解了 LLM 处理大整数会丢精度的陷阱。

### 2.3 Terms-binding 复用（model A）
- subscribe 内部把 `entry.price/intervalMs/merchant/keeper` 等**人类审核过的字段**透传到 `authorizeFixed/authorizeMetered` 的 `expected_*` 参数。
- 链上的 `ETermsMismatch` 真的能拦住「商家在用户审核后掉包 plan」这种攻击——是合约层 F-05/F-06 设计意图的正确兑现。

### 2.4 `IsubClient.quoteFromPlan` 已实现
- review 初稿担心 model B 的 `resolveOpen` 调用 `quoteFromPlan` 会 runtime miss。**已验证**：`client.ts:146-148` 存在（是 `getPlan` 的语义别名）。这不是 bug，只是命名上"quote"暗示"display-only"——可读性好。

---

## 三、现存问题（按严重度）

### A. 严重 —— 资金安全

#### A1. `watched` 是纯内存态，无持久化 → 重启即「失忆」（**真正的产品级缺口**）

```typescript
private readonly watched = new Map<string, AllowedService>();
```

进程重启后 watched 空：

- **`budgetStatus()` 默认只查 `watched.keys()`** —— 会报告 **`atRisk = 0`**，但链上其实可能还有十几个 active mandate 正在被扣。
- **LLM agent 自身的"我订过什么"记忆全丢** —— 它没法理性决定还能不能 subscribe。
- 调用方可以传 `extraMandateIds` 救场，但**重启后 host runtime 哪知道传什么**？

**对比**：同 SDK 的 `biller.ts` 有 `BillerStore` 接口、`keeper.ts` 有 `KeeperStore` 接口都做了完整持久化。agent.ts **完全没有 store seam**——结构上落后两档。

**安全失败模式**：丢失状态 → agent 误以为自己没在花钱 → 继续主动 subscribe → 真敞口爆炸。比 keeper 那种"丢失状态会少扣款"危险得多。

#### A2. 跨订阅 budget 完全无聚合校验 → 单订阅 cap 形同虚设

```typescript
if (args.budget > entry.maxTotalBudget) {
  return { ok: false, reason: `budget exceeds the human-approved cap for "${entry.name}" (${entry.maxTotalBudget})` };
}
```

这只是**单条**订阅的 cap。**没有跨订阅累加**：

- agent 可以**连开 10 个同一 service** 的订阅，每个都 = `maxTotalBudget`。
- 模块顶部注释说"the account balance + per-mandate caps"是 envelope——但代码里 subscribe **从不读 account balance、也不汇总现有 `watched` 的 totalAuthorized**。
- 唯一兜底是 account balance（"fund-and-forget"模式下被一次充满就完蛋）。

**失误场景**：人类设 `maxTotalBudget=10 SUI`，给 account 充 50 SUI 让 agent 跑一年。LLM 因 reasoning 偶发循环连调 5 次 subscribe → **真实敞口 50 SUI**（5 × 10），而人类以为最多 10。

**修法**：subscribe 进入时先 `await this.budgetStatus()`，检查 `totalAuthorized + args.budget > envelope`；超过 reject。

#### A3. Model B 完全丢弃「用户独立节流阀」保护

```typescript
private async resolveOpen(planId: string, budget: bigint): Promise<AllowedService> {
  const p = await this.isub.quoteFromPlan(planId);
  return {
    ...
    maxTotalBudget: budget,          // ← 用户传啥就授权啥，没有 SpendPolicy 级上限
    maxPerCharge: p.rateCap,          // ← 用商家自定义的 rateCap 当用户的 throttle
  };
}
```

两层退化：

1. **没有 model B 总开支上限**：`SpendPolicy` 没有给 model B 设独立预算 cap 的字段。
2. **`maxPerCharge = rateCap`**：合约里 `max_per_charge` 设计意图是「用户独立于商家的单笔节流阀」——但 model B 直接用商家定义的 `rateCap` 当 `maxPerCharge`，**等于放弃这个保护**。

> 模型 B 的 `expected_*` 参数（`expectedMerchant: entry.merchant`，其中 `entry.merchant = p.merchant`）也是**自检 no-op**——自己跟自己比永远 pass。链上的 terms-binding 在 model B 路径上**沦为装饰**。注释承认了"unverified-open"，但**没说清楚 terms-binding 已是 no-op**。

**修法**：`SpendPolicy` 加 `openModeCap?: { maxTotalBudget: bigint; maxPerCharge: bigint }`，让 model B 也有 envelope 而不只靠 balance。`resolveOpen` 优先用 `openModeCap` 而非 `p.rateCap`。

#### A4. `AllowedService` 必填字段无 startup 校验，全用 `!` 强断言

```typescript
expectedPrice: entry.price!,
expectedIntervalMs: entry.intervalMs!,
...
expectedRateCap: entry.rateCap!,
expectedKeeper: entry.keeper!,
```

- 用户配 Fixed 模式忘填 `price` → 运行时 `BigInt(undefined)` → `TypeError`，**在 LLM 调 subscribe 那一刻才爆**，而不是 agent 启动时。
- 跟 `biller.ts` 的 `assertValidRateCard` 对比明显：那边构造期严校，这边运行期才挂。

**修法**：constructor 里加 `assertValidPolicy(policy)`，按 `mode` 分别检查 Fixed/PAYG 必填字段；任一空缺立即 throw `IsubError('config', ...)`。

---

### B. 中等 —— 错误处理 / 接口契约

#### B1. catch 块吞 `IsubAbortError` 的结构化信息

```typescript
} catch (e) {
  return { ok: false, reason: e instanceof Error ? e.message : String(e) };
}
```

`IsubAbortError` 携带 `abortCode`（structured），但这里只取 `.message` 拼字符串。LLM 看到 `"Move abort ETermsMismatch (#23)"` 能不能推理出"应该 list_services 重新看看"？**全靠 LLM 智商**。

更可靠的姿势：

```typescript
return {
  ok: false,
  reason: '…',
  errorCode: 'terms_mismatch' | 'plan_inactive' | 'expired' | 'insufficient_balance' | 'over_cap' | ...,
};
```

LLM 能按 code 做更可靠的 retry/fallback 决策（比如 `terms_mismatch` → 先 `list_services` 看新条款 → 再 retry；`expired` → 直接放弃；`insufficient_balance` → 通知 host runtime 补款）。

#### B2. `unsubscribe` 对已是终态的 mandate 不清理 `watched`

`unsubscribe(m)`：mandate 已被链上 revoked（外部触发，或重复调用）→ `revoke` 撞 `ENotActive` → catch → 返回 `{ ok: false }`。

**`watched.delete(m)` 不会被执行** —— zombie 条目永远留在 watched 里，污染后续 `budgetStatus`（虽然链上读时会发现状态是 revoked，但 LLM 看到一堆 "remaining: 0" 的旧条目难免困惑）。

**修法**：catch 里识别终态 abort code（`ENotActive` / 已过期 等）也清掉 `watched`。

#### B3. `subscribe()` 不支持 `firstChargeAfterMs`（trial / 延迟首扣）

- 合约 `authorize_fixed/authorize_metered` 都有 `first_charge_after_ms`（试用窗）。
- `IsubClient` 暴露了。
- `IsubAgent.subscribe()` **没暴露**——agent 不能开"7 天试用"订阅。

**产品功能缺口**。

#### B4. `pause / resume / attach` 三个动作完全缺席

- 合约有 `pause/resume`，agent 用例（"周末停用，省钱"）明显成立。
- **`attach(mandateId, serviceName)`**：跨进程重启后，host runtime 需要一个口子把已有 mandate "认领"回 agent 视野——配合 A1 store seam 一起做。

#### B5. `listServices()` 不返回 model B 开关状态

LLM 看不到 `policy.allowOpen` 配置 —— 没法判断"open discovery is enabled"是不是真启用。

tool description 写了 "unless open discovery is enabled"，但**这是个 LLM 无法运行时验证的承诺**。

**修法**：返回结构加 `openDiscoveryEnabled: boolean`，或加一个独立的 `policy_info` 工具。

---

### C. LLM 边界特殊问题（agentTools 入参）

#### C1. `subscribe.budget` 是 string，但 LLM 容易传错格式

`description` 说 "in base units (decimal string)"，常见 LLM 错法：

| LLM 传值 | `BigInt(String(...))` 结果 |
|---|---|
| `"10.5"` | throw `SyntaxError: Cannot convert 10.5 to a BigInt` |
| `"5 SUI"` | throw |
| `"1e9"` | throw |
| `"10_000_000_000"`（含下划线） | throw |

handler 直接 `BigInt(String(a.budget))`，throw 冒泡到 MCP 层 → LLM 看到的是 stack trace 而非友好提示，会反复重试。

**修法**：handler 内独立 try/catch，把 parse 错转成有指导意义的 `{ ok: false, reason: 'budget must be an integer in base units, e.g. "10000000000" for 10 SUI (1 SUI = 10^9 base units)' }`。

#### C2. `ttlMs` 是数字毫秒，LLM 极易传天数

```typescript
ttlMs: { type: 'number', description: 'Optional subscription lifetime in ms; defaults to the policy default.' }
```

LLM reasoning："订一周 → ttlMs = 7" → mandate **7 毫秒后过期** → 几乎立即不可用。

**修法**：description 应改为 `"ms (e.g. 7 days = 604800000)"`，或干脆改成 ISO 8601 duration 字符串 `"P7D"`，handler 自己解析。

#### C3. "automatic" 一词的语义陷阱

```typescript
description: 'Charges are pulled automatically within the cap; cancel with unsubscribe when done.'
```

LLM 看到 "automatically" 容易理解为"我订了就不用管了"。实际上：

- Fixed：**任何人**可以触发 charge（permissionless）——但前提是 keeper 真在跑。
- PAYG：商家/keeper 主动来 chargeMetered。

如果商家挂了 / keeper 挂了，**根本不会自动扣**。这不是 agent 的错，但 LLM 不知道——可能基于"我订了 keeper 会来扣"的假设做后续决策。

文档至少应该提一句"requires the merchant's keeper to be running"。

#### C4. 同 service 重复订阅无去重

LLM 因 reasoning 失误连调两次 `subscribe('price-feed', '5000000000')` → 链上有两个独立 mandate，total budget = 2x cap，`watched` 里两个独立条目都进。

可能是 feature（真想要两条独立预算），但**默认行为应该是去重或警告**："you already have an active subscription to 'price-feed' (mandate 0x...)"。配合 A2（跨订阅累加）一起做。

---

### D. 持久化 —— 一项但严重

`agent.ts` **没有 `AgentStore` 接口**。对比同 SDK 里 biller/keeper 都有 store seam，agent 这块完全没做。

最小可用 API：

```typescript
export interface AgentStore {
  loadWatched(): Promise<Map<string, AllowedService>>;
  saveWatched(map: Map<string, AllowedService>): Promise<void>;
  acquireLock?(): Promise<void>;
  releaseLock?(): Promise<void>;
}
```

并在 `subscribe / unsubscribe` 写入时持久化。配合 B4 的 `attach` 工具，host runtime 可以"喂回" pre-existing mandate。

**强度上**：这是从「demo agent」走向「生产 agent」的必经一步。

---

### E. 文档 / 一致性

#### E1. 模式判断字符串混乱
- 内部用 enum：`entry.mode === ChargeMode.Fixed`
- 外部接口用字符串：`'fixed' | 'payg'`
- subscribe 返回时手动转换：`entry.mode === ChargeMode.Fixed ? 'fixed' : 'payg'`

每个 mode 比较点都得手转一次，容易漏。**修法**：引入 helper `modeToString(m: ChargeMode): 'fixed' | 'payg'` 集中。

#### E2. `accountExposure` 每次 `budgetStatus` 都打链
- 没有缓存。`budget_status` 工具被 LLM 当 "thinking step" 频繁调用时，RPC 量翻倍。
- 加个 100~500ms TTL 缓存就行（`Date.now()` 比较，简单）。

#### E3. `budget_status` 返回的 `remaining` 没说单位
- description 只说"What is at risk"。
- 与 budget/balance 一致是 base units，但 LLM 不会自动推理——可能误以为是 SUI。
- 把工具描述里所有 amount 字段补 `"in base units (e.g. MIST for SUI)"`。

#### E4. Model B 的 `expected_*` 自检性质未明示
- model B 的 `entry.merchant` / `entry.keeper` 来自 `quoteFromPlan` 自身——传给 authorize 当 expected 等于「自己跟自己比」。
- 注释说"unverified-open"，但没明确写**"terms-binding 在 model B 下是 no-op"**。
- 这种隐式承认会误导后来读代码的人以为 model B 仍受 terms-binding 保护。

---

## 四、建议路线图

按"修了立刻提升正确性 / 长期 backlog"分组：

### Sprint 1（资金安全闭环，2-3 天）—— 必修
1. **A1 + D**：加 `AgentStore` seam（最小：`mem` + `sql`/`file` 两个实现），持久化 `watched` —— agent 不能丢"自我认知"。
2. **A2**：subscribe 前 `await this.budgetStatus()` 累加 totalAuthorized，超 envelope reject。
3. **A3**：`SpendPolicy.openModeCap` 字段；`resolveOpen` 优先用 cap 而非 `p.rateCap`。
4. **A4**：constructor 加 `assertValidPolicy`。

### Sprint 2（LLM 防呆 + 错误结构化，1-2 天）—— 强烈建议
5. **B1**：`SubscribeResult.errorCode` 结构化，LLM 能 reliably 决策。
6. **C1 + C2**：subscribe handler 加 budget/ttlMs 友好解析。
7. **B2**：unsubscribe catch 里识别终态清理 watched。

### Sprint 3（功能完整性，2-3 天）—— Nice to have
8. **B3**：subscribe 暴露 `firstChargeAfterMs`。
9. **B4**：`pause / resume / attach` 三个动作 + 对应 agentTools。
10. **B5**：`listServices()` 返回 `openDiscoveryEnabled` + model B 是否开放。
11. **C3**：tool description 说清 "automatic 取决于 keeper"。
12. **C4**：subscribe 默认去重 + 警告。

### Sprint 4（DX 收尾，1 天）
13. **E1**：`modeToString` helper。
14. **E2**：`budgetStatus` 加 TTL 缓存。
15. **E3**：所有 amount 字段补单位。
16. **E4**：注释明确 model B terms-binding no-op 性质。

---

## 五、附录：建议补丁（关键三处的 diff 草案）

### 5.1 `AgentStore` seam（A1 + D + B4）

```diff
+export interface AgentStore {
+  loadWatched(): Promise<Map<string, AllowedService>>;
+  saveWatched(map: Map<string, AllowedService>): Promise<void>;
+}
+
+export function memAgentStore(): AgentStore {
+  let m = new Map<string, AllowedService>();
+  return {
+    loadWatched: async () => new Map(m),
+    saveWatched: async (x) => { m = new Map(x); },
+  };
+}
+
 export class IsubAgent {
-  private readonly watched = new Map<string, AllowedService>();
+  private watched = new Map<string, AllowedService>();
+  private readonly store?: AgentStore;
+  private initialized = false;
 
   constructor(
     private readonly isub: IsubClient,
     private readonly signer: IsubSigner,
     private readonly policy: SpendPolicy,
+    opts: { store?: AgentStore; now?: () => number } = {},
-    private readonly now: () => number = Date.now,
-  ) {}
+  ) {
+    this.store = opts.store;
+    this.now = opts.now ?? Date.now;
+    assertValidPolicy(policy); // A4
+  }
+
+  private async init(): Promise<void> {
+    if (this.initialized) return;
+    if (this.store) this.watched = await this.store.loadWatched();
+    this.initialized = true;
+  }
+
+  /** B4: external host can re-attach a known mandate after restart. */
+  async attach(mandateId: string, serviceName: string): Promise<{ ok: boolean; reason?: string }> {
+    await this.init();
+    const entry = this.policy.allowed.find((s) => s.name === serviceName || s.planId === serviceName);
+    if (!entry) return { ok: false, reason: `unknown service ${serviceName}` };
+    this.watched.set(mandateId, entry);
+    await this.store?.saveWatched(this.watched);
+    return { ok: true };
+  }
```

`subscribe / unsubscribe` 内部每次成功后追加 `await this.store?.saveWatched(this.watched);`。

### 5.2 跨订阅 budget envelope 校验（A2）

```diff
   async subscribe(args: { service: string; budget: bigint; ttlMs?: number }): Promise<SubscribeResult> {
+    await this.init();
     if (args.budget <= 0n) return { ok: false, reason: 'budget must be positive' };
 
     const approved = ...;
     let entry: AllowedService;
     let terms: 'approved' | 'unverified-open';
     if (approved) {
       entry = approved;
       terms = 'approved';
       if (args.budget > entry.maxTotalBudget) {
         return { ok: false, reason: `budget exceeds the human-approved cap for "${entry.name}" (${entry.maxTotalBudget})`, errorCode: 'over_cap' };
       }
     } else if (this.policy.allowOpen) { ... }
     else { ... }
 
+    // A2: envelope check — totalAuthorized + this budget must not exceed account balance.
+    const status = await this.budgetStatus();
+    if (status.totalAuthorized + args.budget > status.balance) {
+      return {
+        ok: false,
+        reason: `over envelope: balance ${status.balance}, already authorized ${status.totalAuthorized}, requested ${args.budget}`,
+        errorCode: 'over_envelope',
+      };
+    }
+
+    // C4: dedup warning (same service, still-active mandate)
+    const dup = [...this.watched.entries()].find(([, e]) => e.name === entry.name);
+    if (dup) {
+      // optional: hard reject vs return { ok: false, errorCode: 'duplicate' }; or just log
+    }
+
     const expiryMs = ...;
     ...
   }
```

### 5.3 Model B envelope（A3）

```diff
 export interface SpendPolicy {
   accountId: string;
   allowed: AllowedService[];
   allowOpen?: boolean;
   defaultTtlMs?: number;
+  /** Model B (`allowOpen`): caps applied to OPEN-discovered plans. Required when `allowOpen=true`. */
+  openModeCap?: {
+    maxTotalBudget: bigint;
+    maxPerCharge: bigint;
+  };
 }
 
 private async resolveOpen(planId: string, budget: bigint): Promise<AllowedService> {
   const p = await this.isub.quoteFromPlan(planId);
+  const cap = this.policy.openModeCap;
+  if (!cap) throw new IsubError('config', 'allowOpen=true requires openModeCap');
+  if (budget > cap.maxTotalBudget) {
+    throw new IsubError('usage', `open-mode budget ${budget} exceeds openModeCap.maxTotalBudget ${cap.maxTotalBudget}`);
+  }
   return {
     ...
-    maxTotalBudget: budget,
-    maxPerCharge: p.rateCap,
+    maxTotalBudget: budget,
+    maxPerCharge: cap.maxPerCharge,  // user's independent throttle, NOT merchant's rateCap
   };
 }
```

---

## 六、综合评分

| 维度 | 评级 | 一句话 |
|---|---|---|
| 资金安全 | **C+** | 单订阅 cap 严格，但跨订阅无聚合 + 无持久化 + model B 主动放弃节流阀 → fund-and-forget 模式下真实敞口可能远超人类预期 |
| 错误处理 | **B** | catch 不会让 agent 崩，但 abortCode 结构化信息被丢，LLM 难做可靠决策 |
| LLM 边界 | **B−** | tool schema 严谨、bigint-safe，但 budget/ttl 入参对 LLM 不够防呆，几个 description 暗示模糊 |
| 持久化 | **D** | 完全无 store seam —— 跟同 SDK 其他模块（biller/keeper）的姿势严重不一致 |
| 文档与注释 | **A−** | 注释好，model A vs B 的取舍诚实标注；但 model B 的 terms-binding no-op 性质没明示 |

**综合：B−**。整个模块更像一个**"展示 iSub agent 能力"的 demo runtime**，而不是一个"生产可托付几十 SUI 让 AI 自主决策"的 SDK。`biller.ts` 经过多轮迭代到 A 级，`agent.ts` 在叙事上同样核心却显得停留在 v1 阶段——值得做一轮专项加固（Sprint 1 是必修门槛）。

> 与 `biller.ts` 对比：biller 的 G1 不变式（每条 usage 至多计费一次）有 `BillerStore` 持久化 + lease lock + reconcile 三件套合力守住；agent 的等价不变式（"agent 跨重启不可遗忘已签授权 + 总敞口不可超 envelope"）目前**没有任何机制守住**——这正是 Sprint 1 要补的洞。

---

*Last updated: 2026-06-20*
