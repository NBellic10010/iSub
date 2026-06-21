# iSub × x402/AP2 接入架构决定(Architecture Decision)

> 角色:lead engineer 定稿。综合 IMPEDANCE / ADAPTER / DECISION / SETTLEMENT 四份设计稿,逐条吸收 Reviewer 1(break-check)与 Reviewer 2(correctness)的 high/medium 评审,并已对照 source 复核所有承重事实。代码与英文术语保留英文。

---

## 1. 直接回答两个问题

**(a) AP2/x402 会不会破坏现有扣计费接口?**
> 不破坏 billing **逻辑**(200/402/403 三态、accrue-then-batch-settle、`charge_seq` 幂等、`recoverOrphan`、price-freeze、single-biller lock 全部一行不改),但"`service.ts`/`biller.ts`/`client.ts` 100% byte-for-byte untouched"这句**是站不住的、必须收回**——adapter 按设计要落地,至少需要在 `IsubService` 上**新增 4 个不改变任何现有 caller 行为的 public 方法/拓宽 1 个返回类型**(下文 §4/§5 点名)。

**(b) 另起一套接口,还是适配现有?**
> 适配现有:新建**独立 adapter 模块** `@isub/sdk/x402` + `@isub/sdk/ap2`,作为 `mcp.ts`/`gateway.ts` 的 sibling 去 wrap 现有 core;**绝不**另起第二套 settlement 栈(那等于复制整个 money-correctness core,是显式 anti-goal)。

---

## 2. 冲突点清单(impedance)——真冲突 vs 仅翻译

按对现有接口的压力排序。每条点名受影响的现有 symbol,并标注「真冲突 / 翻译 / 评审揭穿的隐藏真冲突」。

| # | 冲突 | 受影响 symbol | 性质 |
|---|---|---|---|
| 1 | x402 同步 per-call settle vs iSub accrue-then-batch-flush | `IsubService.use`/`useMetered` 返回契约;`IsubBiller.flush` | **真冲突(语义)** |
| 2 | x402 必须 proof-mandatory,但 `agentAuth` 是 per-service 单一 flag | `ServicePolicy.agentAuth`(service.ts:84) | **真冲突**,且 reviewer 证明原"专用 instance"解法**有 double-charge 隐患** |
| 3 | flush digest 取不到 / verify 无副作用入口 / 缺 `spendable` / 缺 `coinType` | `service.flush`(:262 `Promise<unknown>`)、`verifyProof`/`session`/`authorizeCall`(全 private)、无 `spendable()`、`MandateState`(types.ts:37-67 无 `coinType`) | **真冲突(access boundary)——被 Reviewer 1 揭穿,原四稿全部漏掉** |
| 4 | x402 `upto` 金额源 vs RateCard frozen price | `useMetered`/`recordMeteredUsage`/`priceUsageMulti` | 翻译 + 正确性陷阱 |
| 5 | X-PAYMENT proof vs agent PoP `CallProof` | `CallProof`、`proofFromFields`、`callMessage` | 翻译,**但非"纯 transport encoding"——见下** |
| 6 | AP2 Intent/Cart Mandate vs on-chain Mandate / `consent.ts` | `consent.ts`、`bindMessage`/`callMessage`、on-chain `Mandate` | 翻译,clean fit,一条 derivation rule |

### 2.1 真冲突 #1——同步性(核心)
x402 要求 HTTP 响应**确认 on-chain 已支付**(facilitator `/settle` 返回 execution response);iSub `use()` 在 `recordUsage` 后**立即返回 200**(service.ts:108-118 已复核),`charge_metered` 推迟到 `biller.run` 的 window loop 或 threshold flush。这不是 data-shape 问题,是**钱何时落账**的语义错配——`use()` 的返回值里那一刻链上什么都没发生,无法据此填 execution response。这是唯一需要小心工程化的真冲突,解法见 §4。

### 2.2 真冲突 #2——`agentAuth` 粒度(原四稿低估)
已复核 service.ts:84 `this.agentAuth = policy.agentAuth ?? 'off'`、:173 `if (this.agentAuth === 'off') return true`、gateway.ts:69-78 每租户构造**一个** `IsubService`。x402 caller 必须 `enforce`,legacy caller 留 `off`,同一 instance 表达不了。
**Reviewer 2 的 high 命中:** 原四稿的"为 x402 face 跑一个专用 `agentAuth:'enforce'` 的 `IsubService`"是**错的**——service.ts:85 构造函数永远 `new IsubBiller(...)`,无法注入/共享 biller。第二个 `IsubService` = 第二个 `IsubBiller` 打同一批 mandate,直接违反 single-biller-per-mandate(biller.ts:399-400 `recoverOrphan` 所依赖);`inflight` single-flight(biller.ts:168)是 per-instance,`memBillerStore`(无 lock)下两 biller 读同一 `chargeSeq`、各自 journal append 同 seq、双双落账 = G1 双扣。**这是被"config split not code split"话术掩盖的真 double-charge 面。** 修正解法见 §4/§5。

### 2.3 真冲突 #3——access boundary(Reviewer 1 全部 high,四稿全漏)
所有四稿都建立在"通过 public surface 就能拿到 digest / 做 verify / 取 spendable / 取 coinType",**经 source 复核全部不成立**:
- **digest 取不到:** `service.flush`(:262)与 `gateway.flush`(:118)都是 `Promise<unknown>`、注释"for tests / manual flush";typed `FlushResult[]`(含 `digest?`)只在 `biller.flush` 上,而 `this.biller` 是 **private**(service.ts:63 已复核)。同步 confirm 拿不到 digest。
- **verify 无入口:** `verifyProof`/`authorizeCall`/`session` 全 private(service.ts:172/182/203);唯一 public serve 路径 `use()` **必然 accrue**(:108),不能支撑幂等、可投机的 `/verify`;`status()`(:162)只回 cached state、不验 proof。
- **spendable 取不到、且是 chain read:** `spendableNow` 需 live `accountBalance`(biller.ts:152/160 已复核),`biller.spendable()` 内部 `getAccount`;`IsubService` 无 public `spendable()`。402 challenge 的 `maxAmountRequired` 要它 = 在 challenge 路径上引入了 core 刻意回避的 per-call chain read(D2,service.ts:233-247)。
- **`coinType` 不在 mandate 上:** `MandateState`(types.ts:37-67 已复核)**无 `coinType` 字段**;它只在 `IsubConfig.coinType`(types.ts:8),`IsubService` 从不接收它。ADAPTER §2a 写 `asset: m.coinType` "FROM the mandate"是**事实错误**。

### 2.4 翻译 #5——X-PAYMENT 不是"纯 transport encoding"(Reviewer 1 medium)
agent 的签名是对 iSub 专有串 `callMessage()`(`isub-call-v1\nmandate=…\nusage=…\nmerchant=…\npayload=…\nnot_after=…`,service.ts:198 复核)做 Sui personal-message 签名。`proofFromFields` 只重打包字段、**不重新推导被签内容**。所以"unify"只在 **agent 是 iSub-aware、愿意签 iSub 的 `callMessage`** 时成立;通用 x402 钱包签的是 x402 `PaymentPayload`,**过不了 `verifyCallProof`**。诚实结论:iSub 在此**定义一个 custom x402 scheme**(scheme 本就是"a logical way of moving money",允许自定义),要求 agent 签 iSub callMessage——而非声称"零新验证代码即可吃通用 x402"。

### 2.5 翻译 #4/#6(无隐藏冲突)
- #4:`exact` 走 `recordUsage(amount)`(扁平、无双定价);`upto` 走 `useMetered`,**仅当 RateCard 是 402 challenge 与实际 charge 的唯一价源**(`maxAmountRequired` 必须 = `priceUsageMulti(card, maxItems)`)。
- #6:Intent Mandate ← on-chain Mandate + `consent.ts`(VC 信封,`CONSENT_VERSION='isub-consent-v1'` 可共存)+ subscriber 签的 `AgentCert`(bindMessage);Cart Mandate ← per-call `CallProof`(callMessage)。唯一 derivation rule:`PaymentRequirements` 必须**从 on-chain mandate 推导**(`payTo=mandate.merchant`、`maxAmountRequired ≤ spendableNow`),不得用 adapter-side state,否则破坏 non-custody(gateway.ts:5-10;service.ts:214 拒 `merchant !== payoutAddress`)。

---

## 3. 推荐架构(adapter)——ports-and-adapters

core(`IsubService`+`IsubBiller`+`IsubClient`)= hexagon;x402/AP2 = 与 mcp/gateway 并列的两张 protocol face。

```
   mcp.ts   gateway.ts   @isub/sdk/x402(NEW)   @isub/sdk/ap2(NEW)
      │          │              │                    │
      └──────────┴── PORT: MeteredService.use/useMetered ──┘   (mcp.ts:35-38)
                         │
        ┌────────────────▼─────────────────┐
        │  DOMAIN CORE(逻辑 100% 不动)     │
        │  IsubService→IsubBiller→BillerChain│
        └──┬──────────┬──────────┬──────────┘
   BillerChain#1  BillerStore#2  onEvent#4   + CallProof/proofFromFields#3
```

逐项映射到现有 symbol:

| 标准关注点 | 绑定的现有 symbol | 是否需新增 public 入口 |
|---|---|---|
| 402 challenge / X-PAYMENT retry transport | gateway `startsWith` dispatcher 新增 `/x402/*` 路由 | 否(新路由,旧路由不动) |
| `/verify`(caps+PoP+budget,**无副作用、无 accrue**) | `session()`+`authorizeCall`/`verifyProof` 逻辑 | **是:新增 public `verify()`** |
| `/settle`(accrue + 可选 in-band digest) | `recordUsage`/`useMetered` + `flush(mandateId)` | **是:拓宽 `flush` 返回为 `FlushResult[]`** |
| `PaymentRequirements.maxAmountRequired` | `spendableNow`(biller.ts:152) | **是:新增 public `spendable()`** |
| `PaymentRequirements.asset` | `IsubConfig.coinType`(types.ts:8) | **否,但必须 out-of-band 注入**(见 §5) |
| X-PAYMENT proof | `proofFromFields`+`verifyCallProof` | 否(iSub scheme,§2.4) |
| Intent/Cart Mandate(VC) | `consent.ts`、`bindMessage`/`callMessage` | 否 |
| 结算回执 / execution response 异步尾 | `onEvent: BillerEvent`(service.ts:78) | 否 |

**新模块以 subpath export 落地**(`"./x402"`、`"./ap2"`),server-only / isomorphic,与 mcp/gateway 同构。**路由顺序陷阱:** `startsWith` 前缀匹配,更具体的 `/x402/verify`、`/x402/settle` 必须先于裸 `/x402`(gateway.ts:148-149 的 `/usage-metered` 先于 `/usage` 先例)。

### 一条 x402 请求端到端流(scheme=exact)

```
1. agent → GET /resource(无 X-PAYMENT)
2. x402Middleware:
     svc.verify(mandateId, amount, usageId)  ← 新增 public、只读、不 accrue
       → session() 首见 on-chain 校验(service.ts:212,之后 cached)
       → maxAmountRequired = svc.spendable(mandateId)  ← 新增 public(此处承认 x402 face 引入 per-call chain read)
       → payTo = mandate.merchant;asset = 注入的 coinType
     → 402 + PaymentRequirements
3. agent 对 iSub callMessage(mandate,usage,merchant,payloadOf(undefined,maxAmountRequired),notAfter) 签名
   → 重发 GET /resource + X-PAYMENT
4. /verify:X-PAYMENT → {agentSig,agentSigNotAfter,agentCert} → proofFromFields → svc.verify(..., proof)
     → session.serviceable(402?) + authorizeCall/verifyProof(403?),全程不写状态
5. /settle(exact):
     svc.use(mandateId, amount=maxAmountRequired, usageId, proof)  ← accrue,usageId dedup
     const [r] = await svc.flush(mandateId)  ← 拓宽返回为 FlushResult[]
        → recoverOrphan 对账(exactly-once)→ chargeMetered(signer,{...,seq}) → {digest}
        → 同一 biller 实例 / 同一 flushOne single-flight + lock,不另开 charge 路径
     onEvent(charge.succeeded) → 回执落 projection 表
6. → 200 + execution response { settlement:'final', digest } 写入 X-PAYMENT-RESPONSE
```

agent 全程不签 on-chain 交易(iSub 命题保留);它签的 PoP `callMessage` = AP2 Cart Mandate。

---

## 4. 结算语义决定(hybrid)

**采用 hybrid:`/verify` 纯 gate 不落账;`/settle` 默认 provisional(accrue + cap-guaranteed 回执),仅当 client 在 payload 显式 `settlement:"final"` 时退化为 inline `flush(mandateId)` 出 in-band digest。**

### `/verify`(provisional 与 final 都用)
只做 caps(从 mandate 推 `PaymentRequirements`)+ PoP(`proofFromFields`→`verifyProof`)+ budget 三态闸,**零状态变更**。
> **Reviewer 2 medium(verify 副作用):** 现状 `session()` 首见会 cache Session(service.ts:225),`verifyProof` 会抬 `boundVer`/`boundNotAfter`(:189-194)——一次投机 verify 可能抬 `boundVer` 而误拒后续合法低版 cert,或暖一个 stale serviceable session。**修正:** 新增的 public `verify()` 必须走 **read-only dry-run**:复用 `session()` 的只读校验,但**不得**在未成功 settle 时持久化 `boundVer` 的抬升(对 cert 校验在临时副本上做,确认后才在 settle 路径提交)。

### `/settle`
- **default = provisional(Option 1):** `recordUsage`/`useMetered` 后立即回回执,链上推迟到 flush。保住 hot-path no-chain-read 与批量经济。
- **on-demand = final(Option 2):** client 要真 digest 时,`recordUsage` 后 `await flush(mandateId)` 单 mandate 出 digest。

### 如何不破坏现有四大不变量
- **`charge_seq` 幂等 / `recoverOrphan`:** inline flush **走同一 `biller.flush`**(经拓宽返回的 public `flush`),因此吃同一 `flushOne` single-flight + cross-instance lock;`/settle?final` 与 background `run()` 不会对同 mandate 双提交。crash 后 client 用**同 usageId** 重试 `/settle`:ingest dedup 返回 false(不重复 accrue),后续 flush 的 `recoverOrphan` 按 journal 的 usageIds 判定上次是否落账——要么回收 digest,要么重新 settle,**两路都不双扣**。x402 的 retry 语义因此白嫖 iSub 的 crash-recovery。
- **price-freeze:** `exact` 走 `recordUsage(amount=maxAmountRequired)` 规避双定价;`upto` 仅当 RateCard 为唯一价源时走 `useMetered`。
- **PoP usageId 防重放:** 把 x402 nonce **直接绑成 iSub `usageId`**——`callMessage` 已把 `usage` 纳入签名信封,replay 的 X-PAYMENT 带 replay 的 usageId,`store.recordUsage` dedup 返回 false。`/settle` 在协议边界即幂等。
  > **Reviewer 2 medium(per-store replay):** dedup 在 `BillerStore`(biller.ts:506-513)。若误用两个 store / 进程重启后 `recordUsage` 返回 false 却无回执可回——**修正:回执 projection 表设为强制、按 usageId 主键、每租户共享一个 store**,replay 与重启后都能回原回执。
  > **Reviewer 2 medium(exact 金额绑定):** `use()` 的 PoP 验的是 `payloadOf(undefined, amount)`(service.ts:103)。若 `maxAmountRequired` 与 agent 实际签的 amount 不一致 → 403。**修正:权威金额 = 402 challenge 的 `maxAmountRequired`;agent 必须签 `payloadOf(undefined, maxAmountRequired)`;`/settle` 拒绝 proof 金额 ≠ charged 金额。**

### provisional 回执的诚实信任权衡(Reviewer 2 high——必须改措辞)
原稿"cap-guaranteed to settle"**过强**。已复核:gate 只查 `session.remaining`(service.ts:106/147),**对 `spendableNow` 在 flush 时复核的 rate_cap/window、`max_per_charge`、account balance 是盲的**(biller.ts:152-161)。一条记录可被 accrue + 发回执却被无限期 carry 为 `rate_limited`/`insufficient_balance`/`per_charge_too_small`。更糟:`per_charge_too_small`、`rate_limited` 的 carry **不翻 serviceability**(`applyEvent` 只对 `insufficient_balance`/`budget_exhausted`/`not_billable`+abortCode 4 翻,service.ts:240-246)——于是**超 `max_per_charge` 的记录每次都被 served 且发永远 settle 不了的回执 = 永久 served-but-never-charged**。

**修正(落到 adapter,不改 billing 逻辑):**
1. 在发回执前,用新增 public `svc.spendable(mandateId)` 把 accrued amount 与 spendable 对比;**超出则 402(返回 `max=spendable`)或标 `deferred`,不发"保证落账"的回执**。
2. 回执措辞从"cap-guaranteed to settle"改为诚实版:**"at-most-once, within mandate caps, timing NOT guaranteed"**。
3. 诚实披露 provisional 的残余信任:settlement timing risk(并发 usage 可能在 accrue 与 flush 间耗尽 budget,`remaining` 是乐观本地估值非链上预留)、liveness risk(keeper 不跑则 accrued 不结算)、它是 **resource server 的承诺、不是链的证明**。**默认 provisional 仅用于 first-party / known-operator 微计费;不信任 operator 或高额单笔的 client 必须用 `settlement:"final"` 强制 inline-flush digest。**

### X-PAYMENT-RESPONSE 内容
- provisional:`{settlement:"provisional", usageId, mandateId, payTo, asset, amountAccrued, guarantee:"at-most-once-within-caps", expectedSettlementBy, receiptId, settlementDigest:null}`
- final:`{settlement:"final", ..., amountSettled, settlementDigest, chargeSeq, guarantee:"on-chain"}`
- provisional → final 的确认走 `onEvent`(`charge.succeeded`)异步回填,另开 `GET /x402/receipt/{usageId}` 回实落 digest。

---

## 5. 落地分层 + 不动清单

### 新增模块(new files)
- `/Users/tatar/Desktop/iSub/sdk/src/x402.ts` —— middleware + facilitator(`/verify`、`/settle`),消费 `MeteredService` slice + 新增 `verify()`/`spendable()` + 拓宽的 `flush()` + `onEvent`。
- `/Users/tatar/Desktop/iSub/sdk/src/ap2.ts` —— VC adapter,wrap `consentMessage`/`buildConsent`/`verifyConsentSignature` + `bindMessage`/`callMessage`。
- `package.json` 新增两个 `exports`:`"./x402"`、`"./ap2"`。
- 回执 projection 表:`db.ts` `SCHEMA` 加 `CREATE TABLE IF NOT EXISTS`(`idx_*` 非热路径先例)+ `sql-store.ts` factory 函数,按 usageId 主键、每租户一个共享 store(强制)。

### 复用的现有 symbol(import,不改)
`recordUsage`/`recordMeteredUsage`/`flush`/`spendableNow`/`run`、`BillerChain`/`BillerStore`/`onEvent`、`proofFromFields`/`callMessage`/`verifyCallProof`、`consentMessage`/`buildConsent`/`verifyConsentSignature`/`bindMessage`、`MeteredService` slice、gateway `startsWith` dispatcher。

### 必须做的 core 改动(诚实清单——收回"零改动")
对 `IsubService` 的改动**全部是 additive,不改任何现有 caller 行为、不动 billing 逻辑**,smokes/keeper/mcp/gateway 全部照过(`proof?` optional、`agentAuth` 默认 `off`):
1. **新增 public `verify(mandateId, amount|items, usageId, proof?)`** —— 跑 `session()`+`authorizeCall`,**不** `recordUsage`,返回三态;dry-run 不持久化 `boundVer` 抬升。
2. **新增 public `spendable(mandateId): Promise<bigint>`** —— 暴露 `biller.spendable`;**明确承认** x402 face 在 challenge 路径引入 per-call chain read,隔离在 x402 adapter,mcp/gateway 热路径仍守 no-chain-read。
3. **拓宽 `flush(mandateId?)` 返回** `Promise<unknown>` → `Promise<FlushResult[]>` 并 re-export `FlushResult`(低风险 widening);`gateway.flush` 同步拓宽。
4. **`coinType` 注入:** 不改 `MandateState`/`parseMandate`;由 merchant 的 `IsubConfig.coinType` **out-of-band 注入** adapter(per-deployment,不是 per-mandate,合理)。明确不声称"asset 来自 mandate"。
5. **`agentAuth` per-route:** **不**用第二个 `IsubService`(=第二个 biller=双扣)。两选一,优先 (a):
   - **(a) 把 `agentAuth` 提升为 per-call use()/verify() 参数**(可覆盖 service 默认),x402 路由传 `'enforce'`,legacy 留 `'off'`——单 biller、单 lock、零双扣面。这是唯一安全的最小 core 改动。
   - (b) 若坚持实例隔离,必须让两个 face **共享同一个注入的 `IsubBiller`/store/lock**(需给 `IsubService` 加 biller 注入构造参数);**绝不**在 multi-service 部署用无锁的 `memBillerStore`。

### 保证不动的文件 / 调用方
- `biller.ts`、`client.ts` —— 一行不改。
- `service.ts` 的 billing 逻辑:`use`/`useMetered` 200/402/403 闸、session 校验、`recordUsage`、`recoverOrphan`、single-biller lock —— 不改(只**新增** `verify`/`spendable`、**拓宽** `flush` 返回、`agentAuth` 升 per-call 入参)。
- `mcp.ts`、`gateway.ts` 现有路由(`/usage`、`/usage-metered`、`/status`)与现有 caller(smokes、keeper)—— 行为不变。
- `agent-auth.ts`、`consent.ts` —— 原样复用。

---

## 6. 诚实风险(reviewer 高危点 + 缓解)

| 风险 | 来源 | 缓解 |
|---|---|---|
| **双扣面:第二个 `IsubService` = 第二个 biller** 打同一 mandate,违反 single-biller(recoverOrphan 依赖),无锁 store 下双双落账 | R2 high | **不开第二 service**:`agentAuth` 升 per-call(首选)或注入共享 biller;multi-service 禁用 `memBillerStore` |
| **永久 served-but-never-charged:** 超 `max_per_charge`/`rate_cap` 的记录每次 served、发永不落账回执,carry 不翻 serviceability | R2 high | 发回执前 `spendable()` 对比超额则 402/`deferred`;回执措辞改 "at-most-once, within-caps, timing-not-guaranteed";建议把 `per_charge_too_small` 纳入 serviceable-false(可选,属 billing 逻辑增强,留作后续) |
| **"core 零改动"不实:** digest 取不到、verify 无副作用入口、缺 spendable、缺 coinType | R1 high×4 | 收回该承诺;改述为"**不改 billing 逻辑/三态契约/现有 caller 行为;新增 `verify()`+`spendable()`、拓宽 `flush` 返回、coinType out-of-band**" |
| **x402 互操作语义缺口:** 通用 x402 钱包签 PaymentPayload 过不了 iSub `callMessage` 验签 | R1 medium | 明确 iSub 定义一个 **custom x402 scheme**,要求 agent 签 iSub callMessage;不声称吃通用 x402 钱包 |
| **challenge 路径 per-call chain read 回归**(spendableNow 需 live balance) | R1 medium | 隔离在 x402 face 并显式承认;或用 cached `session.remaining` 近似(接受可能 stale/高估) |
| **同步性破契约/性能** | 四稿 + R1 | hybrid:默认 provisional 守批量经济;final 仅 on-demand,经同一 lock 的 inline flush |
| **金额源分歧:** `maxAmountRequired` vs PoP 签名 amount vs RateCard 价 | R2 medium | 权威 = 402 challenge 的 `maxAmountRequired`;agent 签 `payloadOf(undefined, maxAmountRequired)`;`/settle` 拒 proof 金额 ≠ charged;`upto` 仅 RateCard 唯一价源时启用 |
| **replay / 重启回执:** dedup 在 store,无回执表则重启后 dedup-false 却无可回 | R2 medium | 回执 projection 表强制、usageId 主键、每租户共享 store |
| **verify 副作用:** 投机 verify 抬 `boundVer`/暖 stale session | R2 medium | `verify()` 走 read-only dry-run,未成功 settle 不持久化 `boundVer` 抬升 |

**底线:** 接口逻辑不破,接口**表面需 additive 扩展**(诚实收回"零改动");建独立 adapter、绝不另起第二 settlement 栈;唯一两处必须工程化的真冲突——同步性(hybrid + 同锁 inline flush)与 `agentAuth` 粒度(升 per-call,**不开第二 biller**)——以及 provisional 回执的诚实信任披露。

**相关文件(绝对路径):** `/Users/tatar/Desktop/iSub/sdk/src/service.ts`、`/Users/tatar/Desktop/iSub/sdk/src/biller.ts`、`/Users/tatar/Desktop/iSub/sdk/src/client.ts`、`/Users/tatar/Desktop/iSub/sdk/src/types.ts`、`/Users/tatar/Desktop/iSub/sdk/src/gateway.ts`、`/Users/tatar/Desktop/iSub/sdk/src/mcp.ts`、`/Users/tatar/Desktop/iSub/sdk/src/agent-auth.ts`、`/Users/tatar/Desktop/iSub/sdk/src/consent.ts`、`/Users/tatar/Desktop/iSub/sdk/src/db.ts`、`/Users/tatar/Desktop/iSub/sdk/src/sql-store.ts`、`/Users/tatar/Desktop/iSub/sdk/package.json`。**新增:** `/Users/tatar/Desktop/iSub/sdk/src/x402.ts`、`/Users/tatar/Desktop/iSub/sdk/src/ap2.ts`。
