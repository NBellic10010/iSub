# PAYG 定价层设计（RateCard）

*日期：2026-06-18 ｜ 来源：7-agent 设计 workflow(3 视角 → 对抗性陷阱检查 → 综合)。2/3 视角"需修订",修正已折入;综合结果零陷阱违规。*

## 0. 设计要旨

定价层**严格位于结算管线的上游**:一个新的**纯模块** `src/pricing.ts`(无 `node:*`,和 exposure/lag 一起从核心 barrel 导出)把"用量数量"换算成**冻结的 bigint MIST 金额**;该金额随后走**完全不变的** `recordUsage(amount)` 去重路径。结算(`settle`/`recoverOrphan`/`flush`/单飞)一行不动。

**唯一承重不变量 —— 入账即定价并冻结(price-once-at-ingest-and-freeze)**:`settle` 与 `recoverOrphan` 只读 `r.amount`(`recoverOrphan` 用"整条记录前缀和 `sum===target`"去匹配日志里的 `submit` 金额)。RateCard 在入账后**结构上不可达**,所以**窗口中途改价永远无法对已入账的行重新定价**、也就不会破坏前缀和匹配把 mandate 卡进人工对账。**在 flush 时重新定价 = 不安全,被构造上禁止。**

---

## 1. 类型(`src/pricing.ts`,纯)

```ts
/** 有理→bigint collapse 的舍入。卡级一个旋钮;允许每 meter 覆盖。 */
export type Rounding = 'ceil' | 'floor' | 'half_up';

/** 精确有理单价:每 (priceDen * units) 数量收 priceNum 个 base-unit(MIST)。
 *  3 MIST / 1000 tokens => {priceNum:3n, priceDen:1000n, units:1n}
 *  3 MIST / 百万 tokens => {priceNum:3n, priceDen:1n, units:1_000_000n} */
export interface Meter {
  key: string;            // 稳定 provenance 键,如 'tokens.in' | 'tokens.out' | 'calls' | 'gb' | 'gpu.sec'。非空
  priceNum: bigint;       // 单价分子(MIST),>= 0n
  priceDen: bigint;       // 分母,> 0n。可表达亚 MIST/单位
  units: bigint;          // 数量粒度:每这么多 qty 计一次价,> 0n,默认 1n
  includedQty?: bigint;   // 定价前从 qty 扣除的免费额度(每 usageId 一次性,非滚动),默认 0n
  minCharge?: bigint;     // 每记录下限(MIST),舍入后施加(仅当该行 qty>0),>= 0n
  rounding?: Rounding;    // 每 meter 舍入覆盖;回退到 card.rounding,再回退 'ceil'
}

/** 冻结、带版本的一组 meter,biller 在入账时据此定价。 */
export interface RateCard {
  version: number;        // 单调版本;改卡即 +1。只作为每行 provenance 存储,绝不据此重定价
  rounding?: Rounding;    // 卡级默认舍入(每 meter 覆盖优先),默认 'ceil'
  meters: Readonly<Record<string, Meter>>; // 以 Meter.key 为键
}

export interface PricedLine { meterKey: string; qty: bigint; amount: bigint }
export interface PriceResult { amount: bigint; lines: PricedLine[]; cardVersion: number }
```
全程无浮点;数量与价格都是 bigint。

---

## 2. API

```ts
// ---- src/pricing.ts(纯) ----

/** 构造时校验一次。priceDen<=0n / units<=0n / priceNum<0n / includedQty<0n /
 *  minCharge<0n / 空键 / 重复键 / 键与槽不符 → 抛 IsubError('config', …)。 */
export function assertValidRateCard(card: RateCard): void;

/** 单 meter 定价到冻结 bigint MIST:
 *  eff = max(0n, qty - includedQty);
 *  raw = round(eff*priceNum, priceDen*units, mode);
 *  amount = qty>0n ? max(raw, minCharge??0n) : raw。
 *  未知 meter / qty<0n → 抛 'usage';amount > u64 上限 → 抛 'priced amount exceeds u64'。可返回 0n。 */
export function priceUsage(card: RateCard, meterKey: string, qty: bigint): bigint;

/** 一条或多条 {meterKey, qty} → 一个冻结总额 + 每行明细。
 *  amount = Σ priceUsage(line);每行各自舍入后再求和(逐行可审计,精确等于总额)。 */
export function priceUsageMulti(
  card: RateCard,
  items: ReadonlyArray<{ meterKey: string; qty: bigint }>,
): PriceResult;

/** 仅供参考的活性校验。用 spendableNow 同款 clamp(rateCap/window、maxPerCharge、totalBudget-spentTotal;
 *  正确地省略 accountBalance 这一运行时值)校验每个 meter 可达的单笔扣款。返回问题列表(空=无结构性死卡)。
 *  调用方决定 warn 还是硬停。不保证任何记录能结算、也不保证不结转。 */
export function assertRateCardFits(
  card: RateCard,
  m: Pick<MandateState, 'mode'|'rateCap'|'rateWindowMs'|'maxPerCharge'|'totalBudget'|'spentTotal'>,
): RateCardFitProblem[];

export interface RateCardFitProblem {
  meterKey: string;
  code: 'min_exceeds_max_per_charge' | 'min_exceeds_rate_cap' | 'min_exceeds_budget_left'
      | 'unit_exceeds_max_per_charge' | 'not_payg';
  detail: string;
}
```

```ts
// ---- biller.ts:一个新入账方法(无 node 依赖,只 import 纯 priceUsageMulti) ----
async recordMeteredUsage(u: {
  mandateId: string; usageId: string;
  items: ReadonlyArray<{ meterKey: string; qty: bigint }>; // 1+ 行,共用一个 usageId
  atMs?: number;
}): Promise<void> {
  const { amount, lines, cardVersion } = priceUsageMulti(this.rateCard, u.items); // 定价一次,冻结
  if (amount <= 0n) throw new IsubError('usage', 'priced amount must be positive'); // 对齐 recordUsage:145
  await this.store.recordUsage({
    usageId: u.usageId, mandateId: u.mandateId, amount, atMs: u.atMs ?? Date.now(),
    meterKey: lines.length === 1 ? lines[0]!.meterKey : 'multi',  // provenance
    qty: lines.length === 1 ? lines[0]!.qty : undefined,          // provenance
    rateCardVersion: cardVersion,                                // provenance
  });
}
// biller 经 ctor opts.rateCard 接卡,并在 ctor 跑 assertValidRateCard。
// 旧 recordUsage(amount) 保持不变、仍公开(预定价 / Fixed 调用方用)。
```

```ts
// ---- service.ts(node shell):面向 agent 的定价入口,复用同一道门 ----
async useMetered(mandateId, items, usageId): Promise<UseResult> {
  let amount: bigint;
  try { amount = priceUsageMulti(this.card, items).amount; }
  catch (e) { return { ok:false, status:400, reason: e instanceof Error ? e.message : 'bad meter' }; }
  if (amount <= 0n) return { ok:false, status:400, reason:'priced amount must be positive' };
  // …复用 use() 逐字的 serviceable / remaining 门控,然后 biller.recordMeteredUsage(...)
}
```

---

## 3. v1 定价模型 + 推迟项

**v1 纳入**(都是"能从单条记录数量独立定价"的形状 —— 这正是冻结的前提):
1. **每单位线性有理定价** —— 一个形状用 meter `key` + `units` 粒度覆盖 per-token / per-call(units=1,den=1)/ per-GB / per-compute-sec。80% 场景。
2. **一卡多 meter、一次调用多行** —— `priceUsageMulti` 把多行汇成**一个冻结金额、一个 usageId、一行 usage_records、一个去重槽**。LLM 调用 input+output token(+每请求费)= 一个 usageId。多维计量是推理 API 的刚需。
3. **可选每记录 `minCharge`** —— 舍入后施加的下限(qty>0 时)。单调,绝不破坏前缀和。覆盖"最低计费单位"。
4. **可选每记录 `includedQty`** —— 定价前扣除的免费额度(每 usageId 一次性)。覆盖"前 N 单位免费(记录级)"。一次减法,仍整数。

**推迟**(每个都需要跨记录/运行态,会逼出 flush 时重算 → 对 `recoverOrphan` 不安全):
- 阶梯/累进/阶量(价取决于跨记录累计量);滚动/周期免费额度("每月 10k 免费");**每结算最低消费**(每 flush 一个 min,会插入无 UsageRow 可映射的幻影额,破坏 `sum===target`,**v1 完全不含**);FX/多币种(也是浮点陷阱);每 mandate/每客户改价、优惠券、预付额度燃烧;时段/峰时倍率;在定价内截断到 maxPerCharge(超额记录应**结转**,绝不静默裁剪);把整张卡或逐行明细落库(v1 只存整数 `rate_card_version` 指针)。
- **逃生口**:将来要做任一推迟项,必须实现成"入账时投影、仍产出每 usageId 一个冻结 bigint"(如入账时解析阶梯计数并冻结结果),**绝不 flush 时重算**。

---

## 4. 整数算钱

所有钱与数量都是 bigint,money 路径绝不碰 Number(对齐 sql-store 的 amount-as-string/BigInt() 约定)。

核心每行:`eff = max(0n, qty-includedQty)`;`raw = roundDiv(eff*priceNum, priceDen*units, mode)`;`amount = qty>0n ? max(raw, minCharge??0n) : raw`。总额 = Σ 各行(每行先各自舍入再求和,逐行可审计且精确等于总额)。

舍入助手(纯 bigint,操作数非负):
- `floorDiv(a,b) = a / b`
- `ceilDiv(a,b)  = (a + b - 1n) / b`
- `halfUp(a,b)   = (2n*a + b) / (2n*b)`(平局向上)

**默认 = `ceil`**(三个设计里唯一分歧点,综合定为 ceil):商家计量并主动 pull,floor/截断会让对抗性 agent 把一次逻辑调用拆成 N 条 qty=1、每条舍入到 0 MIST —— **免费用量 / 收入流失漏洞**(百万次微调用)。ceil 保证 `priceNum>0 且 qty>0` 的每条记录 ≥ 1 MIST,把过收上界压到 < 1 MIST/行(经济上可忽略),且链上 rate_cap/maxPerCharge/budget/balance 封上界。`floor` 给明确想"绝不过收"的商家(自担拆分风险);`half_up` 给对称舍入。

**溢出**:bigint 任意精度,无静默回绕(不像链上 u64)。分子 `eff*priceNum` 在除前用 bigint 算(无精度损失)。守卫:每行 amount 算完断言 `amount <= (1n<<64n)-1n`(链上 u64 上限),否则抛 `IsubError('usage','priced amount exceeds u64')` —— 让胖手指卡/qty 在入账即**大声失败(400)**,而不是 flush 时 `EWrongAmount` abort。`priceDen>0`/`units>0` 在构造时断言,无除零。

**边界**:qty=0n 无 minCharge → 行 0n;**整笔多行总额为 0n** → `recordMeteredUsage` 抛 `'priced amount must be positive'`(对齐 `recordUsage:145`,不让不可计费的幻影行进去重库);qty<0n → 抛 'usage';priceNum=0n 且 qty>0 无 minCharge → 0n 行,若总额 0n 则拒绝(免费 meter 不产生存储行);qty 小到 `eff*priceNum < priceDen*units` → ceil 得 1n(任何真实用量 ≥ 1 MIST),或 minCharge。

---

## 5. 数据模型 + 迁移

只给 **biller 自有的 `usage_records`** 加 meter/qty/卡版本 **provenance**;**绝不动共享 `store.ts` JournalEntry**(keeper/reconcile/store-file 消费它,SQL charges 路径映射固定列、静默丢未知字段;`recoverOrphan` 需要 `submit` 金额保持纯 bigint 不被 qty 污染)。

1. `UsageRow`(biller.ts)加三个**可选**字段(让 memBillerStore 与旧 `recordUsage` 仍能 typecheck):
```ts
export interface UsageRow {
  usageId: string; mandateId: string; amount: bigint; atMs: number;
  meterKey?: string;        // 新 provenance(多行时 'multi')
  qty?: bigint;             // 新 provenance(多行时 undefined)
  rateCardVersion?: number; // 新 provenance
}
```
`amount` 仍是冻结的权威扣款额;provenance 仅审计用,settle/recoverOrphan/unbilled/markBilled **永不读取**。

2. `db.ts` 今天无迁移(只 `CREATE TABLE IF NOT EXISTS`)。node:sqlite 无 `ADD COLUMN IF NOT EXISTS`,故加**幂等 PRAGMA 守卫迁移** + 把三列也加进 SCHEMA 字面量(新库):
```ts
function addColIfMissing(db: Db, table: string, col: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
function migrate(db: Db): void {
  addColIfMissing(db, 'usage_records', 'meter_key', 'TEXT');
  addColIfMissing(db, 'usage_records', 'qty', 'TEXT');             // bigint 存字符串,同 amount
  addColIfMissing(db, 'usage_records', 'rate_card_version', 'INTEGER');
}
// openDb: db.exec(SCHEMA); migrate(db);  // :memory: 与文件都跑,SCHEMA 后、prepare 前;重跑 no-op
```
新列可空无默认 → 老行不受影响,`recoverOrphan` 前缀和(只读 amount)不变。

3. **sql-store.ts 必改**(否则 provenance 静默为 NULL,最易错):扩展 `sqlBillerStore.recordUsage` 的 INSERT 列出 `meter_key, qty, rate_card_version` 并绑定 `u.meterKey ?? null` / `u.qty?.toString() ?? null` / `u.rateCardVersion ?? null`。`unbilled` SELECT 可仍 4 字段(settle 只要 amount;provenance 留给未来审计/导出路径)。

**明确不动**:store.ts JournalEntry、charges 表、idx_usage_unbilled 索引。

---

## 6. 接入

- `src/pricing.ts`:新纯模块,`export * from './pricing'`(浏览器安全核心,和 exposure/lag 并列,checkout/agent UI 可客户端报价)。只 `import type { MandateState }` + `{ IsubError }`,过现有 `testCoreIsomorphism` 守卫,**无需改 allowlist**。
- **RateCard 存在「每服务」层**(每个商家服务实例)。价目是服务的属性(商家设 MIST/token),对它定价的每个 mandate 都相同;**不能放每 mandate**(mandate 是用户花费上限,不是价格)、**也不上链**(PAYG plan/mandate 的 price=0)。挂在 `IsubService`(ctor opt),传进它构造的 biller。多产品商家:每价目一个 IsubService 实例(或日后扩 `Record<string,RateCard>` 按产品键选,仍每服务自有、仍入账时解析一次)。
- `IsubBiller`:`opts.rateCard?`,ctor 跑 `assertValidRateCard`(坏卡启动即失败)。`recordMeteredUsage` 是定价前门,定价一次后走**同一** `store.recordUsage`。settle/spendableNow/recoverOrphan/flush/run/单飞 inflight **全不变**。
- `IsubService`(node shell):`useMetered(mandateId, items, usageId)` 复用 `use()` 逐字的 serviceable/remaining 门控,再调 `biller.recordMeteredUsage`。旧 `use()` 保留。`listen()` 加 `POST /use-metered`(body `{items, usageId}`)。可在首见 `session()` 把 `assertRateCardFits` 作为告警事件暴露。
- gateway.ts(node shell)可加镜像 `useMetered` 的 HTTP 入口。
- 链上仍对定价后的 bigint 经不变的 chargeMetered 重扣 rate_cap/max_per_charge/budget/balance。**无 Move 改动。**

---

## 7. 正确性规则(实现必守)

1. **入账即定价/冻结**:`recordMeteredUsage` 调 `priceUsageMulti` 恰一次,在 `store.recordUsage` 前,把 bigint 存为 `UsageRow.amount`;此后不可变,provenance 永不作计费输入。
2. **flush 不重定价(承重)**:settle 与 recoverOrphan 只读 `r.amount`,从不读卡/meterKey/qty/version。改卡只影响未入账用量;已入账行保持冻结额,recoverOrphan 前缀和匹配不破,mandate 不卡人工对账。**构造上禁止 flush 重定价。**
3. **去重键不变**:`usageId` 仍是唯一幂等键。重报同 usageId 是 no-op 且不重定价;改卡期间 first-write-wins。
4. **amount<=0n 永不入账**:全零总额抛 `'priced amount must be positive'`,守住 `recordUsage` 的 amount>0n。已知边界(记录在案):零价 usageId 不被记录,故同一 usageId 先零价后(改卡降 includedQty)非零会billing 后者 —— 可接受,因为不同逻辑事件用不同 usageId(见开放决策)。
5. **fits 仅参考**:校验每 meter 可达单笔对同款 clamp;必须标 `min_exceeds_max_per_charge`(否则永久 #24 strand)、`min_exceeds_rate_cap`(永久 #8)、单价>maxPerCharge;Fixed 返回 `not_payg`。空列表 = "无结构性死卡",**不等于**"都能结算"。
6. **舍入按卡/meter 固定且确定**:同 (card, meterKey, qty) 永远冻结同一 bigint(冻结不变量 + useMetered/recordMeteredUsage 双次定价一致 的前提)。
7. **不动共享 JournalEntry**:provenance 不进 store.ts JournalEntry;日志仍载纯 bigint,keeper/reconcile/store-file 不受影响。
8. **同构**:pricing.ts 无 node:*;recordMeteredUsage 在无 node 的 biller.ts;SQL 列/迁移留在 db.ts/sql-store.ts(已是 NODE_SHELLS)。

---

## 8. 测试计划(加入 scripts/unit.ts,同 `check()`/`rejects()` harness)

- **纯定价**:线性精确;三种舍入的非整除案例(7/2→ceil 4/floor 3/half_up 4;5/2→half_up 3;亚单位 qty=1@{3,1000,1}→ceil 1/floor 0);includedQty;minCharge 单调;多 meter 求和精确 + >1 行 meterKey 收敛 'multi';守卫(未知 meter/qty<0/坏卡/溢出);确定性。
- **fits**:正常→空;minCharge>maxPerCharge / minCharge>rateCap / 单价>maxPerCharge / Fixed;**诚实测试**:单价合规但 burst 会结转 → 无问题(证明 fits≠carry 保证)。
- **集成**(memBillerStore + mock chain):recordMeteredUsage 冻结(存的 amount===priceUsage 且 provenance 落库);去重(同 usageId 第二次在涨价后→第二次 false,unbilled 一行且为首次冻结额);全零总额抛、不记录;flush 不新定价。
- **承重回归(冻结扛过改卡 + 丢 ack 经 recoverOrphan)**:卡 v1(3/1000)入账 u1→冻结 3 → flush 让链上 chargeSeq 推进但 commit 抛(模拟丢 ack)→ 改卡 v2(9/1000)→ 再 flush:recoverOrphan 前缀和必须 ===3(冻结 v1 额)而非 9 → 回填 charged、**不写人工对账 fail**。**负对照**:一个 flush 重定价的变体在同测试里失败(9≠3)→ 证明测试真守了不变量。
- **迁移**:新 :memory: 有三列;模拟旧文件库(无列)重开→migrate 补齐、二次重开幂等、老行 NULL provenance 仍计费;sql 往返 provenance 落库(防"列在但恒 NULL")。
- **同构**:现有 testCoreIsomorphism 覆盖;断言 pricing.ts 非 offender、biller.ts 仍无 node。

---

## 9. 不做清单(诚实)

- 不在 flush 重定价(承重保证,非遗漏);不改结算(settle/spendableNow/recoverOrphan/flush/run/单飞/链上 chargeMetered 全不动);不改去重契约;不动 Move/合约;不动共享 JournalEntry / charges 表;不做阶梯/累进/阶量/滚动周期额度/每结算最低消费/FX/每客户改价/优惠券/信用余额;不在定价内截断到 maxPerCharge(超额结转);不落整卡或逐行明细(只存整数版本指针);不提供"先零价后非零"同 usageId 的严格一次性(已记边界);money 路径无浮点;fits 不保证任何记录结算/不结转;不迁移或重定价历史行(冻结额不可变)。

---

## 10. 待你拍板(5 个开放决策,附建议)

1. **默认舍入 ceil vs floor** → **建议 ceil**(堵住拆调用免费用量漏洞,过收 <1 MIST/行;floor/half_up 作 opt-in,卡级+每 meter 覆盖)。
2. **useMetered 与 recordMeteredUsage 双次定价** → **建议 v1 双次定价(a)**(纯确定性函数,两次必得同一 bigint,代价微;recordMeteredUsage 保持唯一权威定价点,直连 biller 的调用方也正确)。热点再优化成"传 PriceResult"。
3. **零价 usageId 不记录(规则 4 边界)** → **建议(a)抛+不记录并记录在案**(不同逻辑事件用不同 usageId,晚计费边界在正确用法下不可达;(b)需第二条入账路径+0 额行让 settle 学会跳过,v1 不值)。
4. **每服务单卡 vs 多卡** → **建议 v1 每服务单卡**(最简,符合"一商家服务=一价目");多产品现在每价目起一个 IsubService,日后加按键选多卡(不改冻结不变量)。
5. **assertRateCardFits 在哪调** → **建议 (a)注册/onboarding 为主 + (b)首见 session() 发非致命告警事件**;不硬停(它是参考性活性,单 meter 超额不该停整卡);仅在商家选 strict 模式时对 `minCharge>maxPerCharge` 硬停。
