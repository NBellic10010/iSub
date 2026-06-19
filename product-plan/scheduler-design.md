# iSub Scheduler 设计（架构 A 落地 / 架构 B roadmap）

> 像 Stripe Subscription Schedules 一样处理 **分阶段定价 / 试用 / 预约升降级 / proration**，
> 但守住非托管铁律。本文是 A 的施工规格 + B 的路线图。

## 0. 决策与状态

| | 选择 | 状态 |
|---|---|---|
| **架构 A** —— 纯链下 Schedule 编排器，合约不动 | ✅ **现在做** | 设计冻结中；step 0 已完成 |
| **架构 B** —— 把 phase 价目向量预签进 Mandate，合约改 | 📋 **roadmap** | 等"无用户动作的涨价"成为真需求再上 |

二者不互斥：**A 的编排器（phase 时间表、转换调度、降级退差额、PAYG 换卡）就是 B 的地基**。
B 只把"涨价"那一步从「到点重签」换成「signup 预签全表」。先 A 不浪费。

## 1. 非托管铁律（贯穿全篇的约束）

> **签名是天花板：商家只能拉更少、永不更多，除非有新签名。每一次涨价 = 一次 consent 事件。**

由此推出 A 的四类转换怎么落：

| 转换 | 拉得更多还是更少？ | 要不要新签名 | A 的实现原语 |
|---|---|---|---|
| **试用 → 付费** | 一次签死（首扣延迟） | ❌ 一次签 | `authorize_fixed(first_charge_after_ms)` + keeper 到点首扣 |
| **降级**（标准 → 便宜） | 更少 | ❌ 免签 | 每期 `charge(高价)` 后 `refund(差额)` → 净拉低价 |
| **升级**（便宜 → 贵） | 更多 | ✅ **必须新签** | `await consent` → 新 `authorize_fixed(高价)` + `revoke` 旧 |
| **PAYG 改费率** | 仍在签名 caps 内 | ❌ 免签 | biller 换 `RateCard`，链上 mandate 不动 |

唯一 A 做不到的：**无用户动作的静默涨价**。A 把那次签名放在「转换时」；要放在「signup 时」就得上 B。

## 2. step 0（已完成）：keeper not_before 修复 —— 试用的前置

试用靠 `not_before_ms`（合约 `charge()` line ~354 闸住首扣）。但 keeper 旧的到期判断只看
interval watermark：authorize 时 `last_charged_ms = now − interval_ms`，于是
`lastChargedMs + intervalMs == signup`，从 signup 起每个 tick 都判"到期" → 提交一笔注定
`EIntervalNotElapsed` 的 charge，**整段试用每 tick 烧一次 gas + 刷一行 journal**。

修复（`sdk/src/keeper.ts`）：最早可扣时点取两者较大值——

```ts
const dueAtMs   = m.lastChargedMs + m.intervalMs;
const earliestMs = dueAtMs > m.notBeforeMs ? dueAtMs : m.notBeforeMs; // max(interval, not_before)
if (now < earliestMs + BigInt(this.dueMarginMs)) { skip 'not due yet'; continue; }
```

- 首扣前：`not_before` 占优 → 试用期间一笔 tx 都不发。
- 首扣后：`last_charged_ms = now`（F-01），interval 占优、`not_before` 早已过去。

回归：`unit.ts › keeper not_before`（neuter 后试用期被扣，3 断言全红 → 证明真的咬得住）。

## 3. Phase 模型

```ts
/** 订阅生命周期里的一段。时间是绝对 ms（创建/试用结束时解析定死）。 */
export interface SchedulePhase {
  startMs: number;                 // 本段生效的墙钟 ms（首段 == signup 或试用结束）
  kind: 'fixed' | 'payg';
  price?: bigint;                  // fixed: 每期价
  intervalMs?: bigint;            // fixed: 扣费间隔
  rateCard?: RateCard;             // payg: 计价卡（在 mandate 签名 caps 内）
  label?: string;                  // 'trial' | 'promo' | 'standard'，给发票/UI
}

export interface Schedule {
  subscriptionId: string;          // 编排器稳定 id（升级换 mandate id 也不变）
  accountId: string;
  planId: string;
  merchant: string;
  mandateId: string;               // 当前实际计费的链上 mandate
  phases: SchedulePhase[];         // startMs 升序
  cursor: number;                  // 当前生效段下标
  status: 'active' | 'awaiting_consent' | 'cancelled';
}
```

> **subscriptionId vs mandateId**：A 的升级 = 换新 mandate = 新 object id。编排器用自己的
> `subscriptionId` 作稳定锚，把"换 id"对商家屏蔽（对账/发票按 subscriptionId 归属）。
> 这正是 B 用「同一 mandate id 贯穿全段」换掉的东西 —— 迁到 B 时这层锚自然退化为透传。

## 4. 架构 A 接口草案（贴着现有 SDK）

```ts
export type Transition =
  | { type: 'trial_end' }                                  // 免签：keeper 到 not_before 自动首扣
  | { type: 'downgrade'; refundPerPeriod: bigint }         // 免签：每期退差额
  | { type: 'upgrade'; newPrice: bigint }                  // consent：要新签
  | { type: 'payg_reprice'; rateCard: RateCard };          // 免签：换 biller 卡

export interface ConsentRequest {                           // 升级时抛给商家去找用户签
  subscriptionId: string; fromPrice: bigint; toPrice: bigint; effectiveMs: number;
}

export interface ScheduleStore {                            // 镜像 KeeperStore：可换 memory / SQL
  load(): Promise<Schedule[]>;
  upsert(s: Schedule): Promise<void>;
  appendJournal(e: ScheduleJournalEntry): Promise<void>;
  acquireLock?(): Promise<void>;
  releaseLock?(): Promise<void>;
}

export class IsubScheduler {
  constructor(isub: IsubClient, signer: IsubSigner, opts: {
    store: ScheduleStore;
    onConsentRequired?: (r: ConsentRequest) => void;       // 升级时回调（商家弹"确认新价"）
  });
  /** 注册一条带 phase 计划的订阅（首段可带试用：firstChargeAfterMs）。 */
  schedule(input: NewSchedule): Promise<Schedule>;
  /** 一次扫描：把 startMs 已到的 cursor 往前推，执行对应 Transition。永不因单条抛错中断。 */
  tick(nowMs?: number): Promise<ScheduleTickResult>;
  /** 用户回来签了升级 → 切到新 mandate、推进 cursor、revoke 旧。 */
  applyConsent(subscriptionId: string, newMandateId: string): Promise<void>;
}
```

### 编排器与 keeper/biller 的关系（重要边界）

**编排器只在 phase 边界动作；周期性扣费仍由 keeper（Fixed）/ biller（PAYG）干。** 三者并列、不互相拥有：

```
keeper.tick()      →  按 mandate.price/interval 周期扣（已修 not_before）
scheduler.tick()   →  只在 cursor 该推进时：算 Transition → 执行（refund / 抛 consent / 换卡）
biller             →  PAYG 按当前 RateCard 计价 + chargeMetered
```

### 升级的 UX 流（consent gate）

1. `tick()` 发现某段 startMs 已到且是涨价 → **不静默执行**。
2. 置 `status='awaiting_consent'`，回调 `onConsentRequired`（商家给用户一个"确认新价"链接）。
   **在用户签字前，旧的（低价）段继续计费** —— 安全、只是收入延迟。
3. 用户签新 `authorize_fixed(高价)` → `applyConsent()` `revoke` 旧 mandate、指向新 mandate、推进 cursor。

### 降级的两种策略

| | 静默退差额（**A 默认**） | 重签低价 mandate |
|---|---|---|
| 用户动作 | **零** | 要签一次（降级=拉更少，不违铁律但仍是钱包动作） |
| 实现 | 每期 `charge(高价)` 后 `refund(高价−低价)` | 新 `authorize_fixed(低价)` + `revoke` 旧 |
| mandate id | 不变 | 变 |
| 已知瑕疵 | 预算按**毛额**烧（`spent_total += 高价`，`refunded_total += 差额`，而预算闸看毛额）→ 降级后预算更早耗尽 | 干净 |

A 默认走静默退差额（拿"零动作"），把毛额预算瑕疵记为 v1 已知项。

## 5. A 施工顺序

| step | 内容 | 产物 | 状态 |
|---|---|---|---|
| 0 | keeper `not_before` 修复（试用前置） | `keeper.ts` + `unit.ts` 回归 | ✅ 本轮完成 |
| 1 | `ScheduleStore` 接口 + memory/SQL 实现（镜像 `KeeperStore`） | `scheduler-store.ts` | ⬜ |
| 2 | `IsubScheduler` 核心：`schedule()` / `tick()` cursor 推进 / Transition 计算 | `scheduler.ts` | ⬜ |
| 3 | 四类执行器：downgrade(refund) / upgrade(consent+applyConsent) / payg_reprice(换卡) / trial_end | `scheduler.ts` | ⬜ |
| 4 | `scheduler-smoke`（离线假链）：四类转换 + consent gate（涨价未签前停在旧价） | `scripts/scheduler-smoke.ts` | ⬜ |
| 5 | testnet e2e（可选，后置） | `managed-e2e` 扩展 | ⬜ |

## 6. 开工前要你拍板的设计问题

1. **降级默认**：静默退差额（推荐，真零动作，但毛额烧预算）vs 重签低价（干净但要签一次）？
2. **升级 consent 谁来呈现**：`onConsentRequired` 回调交给商家弹（推荐）vs SDK 出托管确认页？
3. **编排器定位**：并列在 keeper/biller 旁、只管 phase 边界（推荐）vs 由编排器统一驱动周期扣费？
4. **phase 时间**：创建时解析成绝对 ms（推荐，简单）vs 相对事件（"首付后 30 天"，需事件钩子）？

> 我的推荐组合：**1=静默退差额 · 2=回调 · 3=并列 · 4=绝对 ms**。确认后我从 step 1 开写。

---

## 7. 架构 B roadmap（链上 phase 向量）

触发条件：出现真实的「**无用户动作静默涨价**」需求（promo→standard 必须像 Stripe 一样自动转，
或 B2B 多段合同要 signup 一次签死）。届时在 A 的编排器之上加这层链上能力：

### B 合约改动清单

1. `Mandate` 加 `phases: vector<Phase{price:u64, from_ms:u64}>`（升序、不可变）→ **加字段 = 强制
   VERSION bump + `migrate_mandate` 给存量回填单段**。
2. `charge()`：把 `assert amount == price` 改成「选 `from_ms<=now` 的最后一段 → `assert amount ==
   该段 price`」；保留 interval 闸。
3. 新 `authorize_fixed_phased(... expected_phases ...)`，校验向量（非空、`from_ms` 严格递增、每段
   `price>0`）；旧单价 authorize 成为 1 段特例。
4. **条款绑定要 hash 整张 `phases`**（不止标量 price）—— 否则 UI 能掉包未来段。**load-bearing。**
5. 封套校验：`total_budget` 覆盖各段上界、`max_per_charge >= max(段价)`。
6. 溢出加固：`phases` 长度上界 + `from_ms` 用减法比较（审计已点过 u64 加法溢出面）。
7. 事件：`Charged` 加（或新 `PhaseAdvanced`）当前段 index/price，供对账/发票归属。

### A → B 平滑迁移

- A 的 `Schedule.phases` 与 B 的链上 `phases` 是同一张表 —— 编排器逻辑（时间表/降级退差额/换卡/试用）**整段复用**。
- 唯一替换：升级从「`awaiting_consent` → `applyConsent` 换 mandate」变为「signup 时整表已预签，`tick()` 直接推进 cursor，链上 `charge()` 自动选段」。
- `subscriptionId` 锚退化为对 mandate id 的透传（B 下同一 mandate 贯穿全段）。

### B 相对 A 的取舍（详见对话内"架构 A vs B 详细对比"）

| | A（链下） | B（链上 phase 向量） |
|---|---|---|
| 合约改动 / 重审 | 无 | 改 `charge()` 钱路径 + VERSION + 迁移 + **重新审计** |
| 静默涨价 | ❌（每次 step-up 一次签） | ✅（signup 预签全表） |
| 未来价目可验证性 | 仅链下 store | **链上公开 + 签名 hash 承诺** |
| 钱路径新风险 | 零（复用已审原语） | 选段分支 + `from_ms` 算术 |
| 上线成本 | 小（写编排器） | 大 |
| 钱包/Display 要求 | 每次签当期条款 | **signup 必须渲染整张未来价目表** |

> 一句话：**A 和 B 唯一本质区别是"涨价那次签名放在转换时(A)还是 signup 时(B)"；其余能力等价。
> 先 A（零合约风险、现在能上、消费者保护更强），B 等"静默涨价"成真需求再上，A 的编排器是 B 的地基。**
