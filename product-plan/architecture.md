# iSub — 架构

最后更新：2026-06-03
> 模型：**Account + Mandate**（非托管、**无按订阅预储值**）。取代早期 escrow 草图与更早的 Solana（Token-2022）草图。

## 0. 命门：非托管拉取怎么在 Sui 上做（且不预储值）

Sui 没有 ERC20 式 `approve(spender)`，对象所有权模型下你**碰不到别人地址里的 owned object**——所以"商家从主钱包拉款"不能照搬 EVM/Solana，且"自动拉取"要求资金待在一个商家够得到的共享对象里。

**Account + Mandate 模型：**
- **Account**：用户自己的、可随时全额取回的共享余额对象（多订阅共用，**不按订阅锁定**）。
- **Mandate**：用户授予商家的、**有上限、可撤销**的拉取授权——**不持有任何资金**。
- `authorize`（发 Mandate）**不搬动任何资金** → 无按订阅预储值。
- `charge` 从 Account 在 Mandate 限额内拉款；用户随时 `revoke`（撤授权）或从 Account `withdraw`（取回）。

这是 **Stripe"存档卡"的 Sui 等价物**：卡 = 你的 Account，扣款授权 = Mandate。诚实边界：资金仍在你自己的可取回 Account 里（Sui 拉不到主钱包），但非按订阅托管；配法币自动续充使其无感。

## 1. Move 合约对象

```
Account<T>（用户拥有，共享）
  - owner: address
  - balance: Balance<T>          // 用户可复用、随时取回的余额（非按订阅锁定）

Plan<T>（商家创建，共享）
  - merchant, mode(Fixed|PAYG), price, interval_ms,
    rate_cap, rate_window_ms, keeper, active

Mandate<T>（用户授权，共享，不持有资金）
  - account_id, subscriber, merchant, plan_id, mode
  - price, interval_ms, last_charged_ms                                          // Fixed
  - rate_cap, rate_window_ms, window_start_ms, window_spent, authorized_keeper   // PAYG
  - spent_total, total_budget, expiry_ms, status(Active|Paused|Revoked)
```

### 核心函数
| 函数 | 调用者 | 作用 / 规则 |
|------|--------|------------|
| `open_account` | 用户 | 创建自己的共享 Account |
| `deposit` | 任何人 | 往 Account 加钱（只增加用户可取回余额） |
| `withdraw` / `withdraw_all` | Account 所有者 | 随时取回（非托管退出权） |
| `create_plan_fixed/payg` | 商家 | 注册套餐 |
| `authorize` | 用户（签一次） | 发 Mandate（**不搬动任何资金**） |
| `charge(amount)` | Fixed:任何人 / PAYG:merchant\|keeper | 按 mode 强制规则，从 Account 在 Mandate 限额内拉款给商家 |
| `revoke` | 用户 | 撤授权 = 取消订阅（终态） |
| `pause` / `resume` | 用户 | 暂停/恢复（resume 豁免暂停期，见 §7 / self-audit F-03） |

不变量（安全核心）：charge 不能超额/超频；revoke 后不可 charge；withdraw 只动当前 Account 余额；金额守恒。

### 1.4 可升级性 + 对象生命周期（生产化，Phase 1.9 已落地）
- **版本门**：三个对象都带 `version:u64`，每个变更入口断言 == 包 `VERSION`；`migrate_*` 为 permissionless 单向（升级后把存量对象搬进新代码）。动机：**Sui 升级不能改已有结构体字段布局 → 共享对象字段在主网上线即冻结**，所以 `version` 字段必须在主网前就位。migrate **无中心 admin**（真正升级权在 UpgradeCap，已是信任点），与"无托管/无 admin"定位一致。
- **对象回收**：`close_account`（owner，余额须为 0）/ `close_mandate`（subscriber，须 Revoked）/ `close_plan`（merchant）→ 删共享对象、退还存储押金，治理状态膨胀。close 故意**不查版本**（纯清理，避免旧对象被卡死）。
- **首扣延迟 / 试用期**：`authorize` 的 `first_charge_after_ms` 把首扣推后（= App Store 式"前 N 天免费"），由 `not_before_ms` 链上强制（试用期内任何人触发 charge 都 abort）。

## 1.5 计费模式（一个原语，三种计费）

同一个 Mandate，靠 charge 规则区分三种计费——这让 iSub 是"**通用计费原语**"，不是单一订阅 app。

| 模式 | charge 规则 | 用途 |
|------|------------|------|
| **Fixed** | `now ≥ last + interval` 且 `amount == price`；扣后 `last = now` | 订阅（Netflix 式） |
| **PAYG** | 可变金额、按需调用；`滚动窗口累计 ≤ rate_cap` 且 `spent_total + amount ≤ total_budget` | 计量计费、API/AI 按用量、**agent 花费预算** |
| **Milestone** | 满足条件释放一笔（roadmap） | 里程碑付款 |

### PAYG：链下计量 + 链上结算
逐次调用上链不现实（gas/延迟）。**链下累计用量 → 按周期或阈值 `charge(累计量)` 一次结算**。链上层只负责**结算 + 上限强制 + 非托管保证**，不做逐次计量。（近实时逐笔需支付通道，范围外，列 roadmap。）

### PAYG 信任边界（必须讲清）
用量由商家上报，**链上封顶损失**：用户自设的 `max_per_charge`（单笔）+ `total_budget`（终身）+ `expiry`，封顶内信任上报值——与 Web2 PAYG（信 AWS 计量）同理。⚠️ 商家自设的 `rate_cap` 只约束 keeper 相对商家自己的策略、**对抗商家本人无保护**（见安全自审 F-05）。用户随时 `revoke` / `withdraw`。更高信任度（用量收据 / attestation / 争议窗口）列 roadmap。

### 资金正确性强化（N-1 幂等 / N-2 退款，已落地）
- **计量幂等（N-1）**：PAYG 走专用入口 `charge_metered(amount, seq)`，`seq` 必须等于 mandate 的 `charge_seq`（每笔成功 +1）。账单超时重试 → 要么落账一次、要么撞 `EBadChargeSeq` —— **同一账单不可能双扣**（Stripe idempotency key 的链上等价物）。Fixed 天然幂等（interval 闸），旧 `charge` 入口现仅限 Fixed。`charge_seq` 同时是链上"扣款笔数"，供链下对账锚定。
- **退款（N-2）**：`refund(coin)` 仅 merchant 可调，退**回订阅者 Account**（资金留在体系内、随时可取）；撤销/过期后照样可退。**不回冲 spent_total/预算**（毛额单调，防 charge↔refund 往返洗额度），`refunded_total` 单独记账，净支出 = spent − refunded。

## 2. Keeper（链下自动化）
- 监听活跃 Mandate，到期周期触发 `charge`。
- 幂等 + 重试；charge 失败（Account 余额不足）→ 标记宽限/通知，不崩。
- 也支持**商家自行触发**（去 keeper 依赖）。Fixed 模式 charge 无许可，可用公共 keeper。

### 2.1 决策：keeper 维持中心化（商家自跑 / iSub 托管）
- **为何中心化可接受**：keeper 对资金**零权力**——`charge` 被链上锁死（interval / `amount==price` / budget / expiry / 收款人=merchant），keeper 哪怕恶意或私钥被盗也**只能"不扣"，偷不走、多扣不了**（见 §7.2）。故中心化只赌**活性**、不赌**安全**。
- **宕机不伤用户**：keeper 下线时用户的钱安然在自己 Account（随时可取）；加 F-01（`last_charged=now`，漏期作废不追补）→ **宕机绝不会变成对用户的追扣抽干，只是商家少收那几期**。代价由商家承担、用户被保护。
- **trustless 边界**：托管/上限/撤销 = 链上 trustless；自动化（时钟 + 付 gas）= 链下、可中心化。中心化的时钟不削弱"非托管订阅"。
- **去中心化就绪、无锁定**：Fixed charge 已是 permissionless → 现在跑中心化 keeper、零锁定；将来要开放只需加 keeper 抽成激励，合约"任何人可触发"层不动。
- **PAYG**：keeper 天然**每商家中心化**（charge 限 merchant/授权 keeper，金额来自链下用量、只有商家知道）。

### 2.2 keeper 补偿（gas 与利润分开解，roadmap）
- **垫 gas** → Sponsored tx（商家/平台/iSub 赞助，keeper 支出归零，见 §3）。
- **图利润** → keeper 抽成：`charge` 从 price 里**切**一份给触发者，商家从收入出（像刷卡手续费），用户仍只付 price → §7 订阅者安全模型不变。
- 三层落地：**自营**（默认，gas = 收款成本，零协议费）/ **托管**（iSub 跑 keeper + sponsored，收小协议费 = 链上 Stripe）/ **开放市场 + 抽成**（roadmap）。

### 2.3 计费状态机 + dunning（决策：余额不足 ≠ 取消/冻结，已落地）
- **决策**：Account 余额不足时**链上 Mandate 一动不动**（不自动 revoke / 不自动 pause——两者都是 subscriber-only，且会把"挽回"变成需要用户再签名）。"余额不足"是纯链下业务状态：**授权与服务分离** —— 冻结的是商家的服务，不是用户的授权。
- **链下生命周期**（keeper 维护、持久化）：`active → past_due(自何时) → recovered | lapsed`，外加 `paused/expired/revoked` 镜像链上态。转移即触发事件回调（`charge.succeeded / mandate.past_due / mandate.recovered / mandate.lapsed`…）= 商家的 webhook 接缝；停服/降级由商家依事件自决。
- **挽回零签名**：正因 mandate 没动，用户充值后下个 tick 自动扣款恢复（F-01 保证只扣一期、不追扣欠费期）。dunning 策略 `{graceMs}` 商家可配；**lapse 后永久停盯**（mandate 链上可能仍有效 → 通知必须带一键 revoke 入口，重新计费需用户在产品内明确同意）。
- **可靠性底座**：watch 集 + 行动日志（append-only journal）落盘、重启恢复；单实例锁（双 keeper 链上安全、只费 gas）；失败二分（链上 abort=确定性 / RPC=瞬态退避）；`EIntervalNotElapsed` 归类为良性竞速跳过 + `dueMarginMs` 安全边距防墙钟/链钟偏差烧 gas。
- **对账闭环**：链上 `charge_seq`（笔数）+ journal → `reconcile()` 逐 mandate 报告 `drift`；keeper 崩溃丢响应或第三方 permissionless 触发的扣款，由 seq 漂移检测捕获（`charge.observed`）并归账 —— gRPC 无事件查询下的对账路径。

## 3. Sui 原生 UX
- **Sponsored transaction**：订阅者 `authorize` 与（可选）后续操作免 gas，商家/relayer 代付。
- **zkLogin**：web2 式登录上手。
- **PTB 批量**：一笔交易批量 charge 多个 Mandate。

## 3.5 建在官方栈之上 + 无感支付栈

### 建在 Payment Kit 之上（不重造）
Sui 官方 `Payment Kit`（`MystenLabs/sui-payment-kit`）只做**一次性**支付（registry/ephemeral 支付、收据、防重、`sui:pay` 链接），**不做周期/订阅/拉取**。所以：
- iSub 每笔 `charge` 的**支付执行 + 收据 + 防重**复用 Payment Kit；iSub 只造 **Account + Mandate + 周期/上限/撤销**层。
- 叙事：建在 Mysten 官方支付标准上的"**缺失的订阅层**"，扩展其栈而非竞争（合 P5，省工作量）。

### 无感支付栈 + PTB 边界（重要澄清）
"法币充值 → 账户 → 商家扣款" **无法塞进一个 PTB**：① 法币是链下 on-ramp；② charge 跨时间反复发生。实际是三段：

| 段 | 链上/链下 | PTB |
|----|----------|-----|
| ① 法币 → 稳定币 | 链下 on-ramp（Stripe Bridge / USDsui） | ❌ 不可能 |
| ② authorize（发 Mandate，**不搬资金**，用户签一次） | 链上 | ✅ 1 个 PTB，gasless |
| ③ charge（每周期，keeper/商家触发，无需用户签名） | 链上 | ✅ 每周期 1 个 PTB，gasless，走 Payment Kit |

**无感 = 组合拳，不是一笔交易**：链下 on-ramp（续充 Account）+ **sponsored tx**（覆盖自定义 authorize/charge）+ **协议级免 gas 稳定币转账**（5/20 主网，7 币种，用户无需持有 SUI）+ Account 模型（后续 charge 零交互）+ zkLogin。
> 法币 on-ramp 是最重一环（Bridge 直接 on-ramp 网络列表暂不含 Sui，虽 USDsui 由 Bridge 发行）。**MVP 先 mock 法币、假设 Account 已有稳定币**，真 on-ramp 列 Tier 2/3。

## 4. SDK 分层（基础设施 = 别人嵌入）
- **TS SDK**：`openAccount / deposit / withdraw / createPlan / authorize / charge / revoke / query`（底层走 `SuiGrpcClient`，不用 JSON-RPC）。
- **React 组件 / Checkout 链接**：商家一行接入订阅按钮。

## 5. Referral Incentives（增长机制，roadmap）
- 链上推荐归因：Mandate 记录 referrer，charge 时按比例分润给推荐人。列入 Tier 2/Roadmap。

## 6. 数据流（一个订阅生命周期）
```
商家 create_plan
   → 用户 open_account + deposit（可复用余额，可随时取回）[sponsored, 免 gas]
   → 用户 authorize（发 Mandate，不搬资金，签一次）
   → keeper 每 interval 调 charge（从 Account 在 Mandate 限额内放款给商家）
   → 用户随时 revoke（撤授权）/ withdraw（取回 Account 余额）
```

## 7. 安全模型

> **核心思想：不假设商家诚实——让作恶有上界、且用户随时能退出。** 即便商家完全恶意、甚至私钥被盗，损失也被链上规则封死，用户永远能单边退出。安全严谨度是 DeFi & Payments 赛道的质量差异化。
> **已修复的发现见 [`self-audit.md`](self-audit.md)（F-01 累积抽干 / F-02 输入校验 / F-03 暂停语义）。**

### 7.1 威胁模型
- **对手**：商家本人作恶 / 商家私钥被盗 / keeper 被盗 / 链上 griefer。
- **目标**：从用户 Account 拉取超过 Mandate 授权的价值，或阻止用户退出。
- **假设**：合约代码公开；攻击者可任意构造交易、可抢跑；Move VM 与 Sui 共识可信。

### 7.2 攻击 → 防御对照
| 恶意拉取手法 | iSub 防御 |
|------------|----------|
| 单次超额扣 | Fixed `amount == price`；PAYG `amount ≤ max_per_charge`（**用户自设**，F-05）**且** `≤ rate_cap`（商家自设）；超则 abort |
| 高频连扣 / 单笔 PTB 累积抽干 | Fixed `now ≥ last + interval` **且扣后 `last = now`**（F-01）；PAYG 滚动窗口累计 ≤ `rate_cap`；首扣可设 `first_charge_after`（F-05） |
| 0 值参数静默关限速 | 创建/授权时**输入校验**（price/interval/rate/window/budget>0、expiry>now）（F-02） |
| 暂停期被追扣 | `resume` 把 `last_charged`/窗口拉到 `now`，暂停期豁免（F-03） |
| 抽干 Account（含"授权即扣满预算"） | `total_budget` 终身封顶 + `expiry` 时间封顶；**单 Mandate 最大损失 = min(total_budget, Account 余额)**。⚠️ 诚实声明：`max_per_charge`/`first_charge_after` 只**限速**、不降低此天花板；商家自设的 `rate_cap` **对抗商家本人无保护**——真正能"停"的是 `revoke`/`withdraw`（见 F-05） |
| 撤销后继续扣 | `charge` 校验 `status == Active`，revoke 后 abort |
| 阻止用户撤销/取回 | `revoke`（撤授权）/ `withdraw`（取回 Account）是 user-only，商家无法阻止 |
| 改币种/改收款人 | `coin_type`(T) 与 `merchant` 创建时绑定、不可改；Mandate 绑定 `account_id` |
| 商家私钥/keeper 被盗 | 一切仍受上限约束；被盗也最多扣到 `total_budget`；keeper 只能触发合法扣款给合法商家 |
| 重入/逻辑漏洞 | Move 资源模型按构造防双花/重入；不变量 + Sui Prover（roadmap） |

### 7.3 三层防御
- **L1 上限封顶最坏情况**：per-charge / 频率 / 总预算 / 到期——四道闸，单 Mandate 最大损失链上可证有界。**注（F-05）**：对抗商家本人时，`price`/`interval`/`rate_cap` 是商家自设、非保护；用户独立护栏 = `max_per_charge`（限速）+ `total_budget` + `expiry` + L2 退出权。条款绑定（`authorize` 断言 expected==Plan）防 UI 谎报/掉包，但依赖可信展示路径（钱包 Display / 中立 widget；不可由被授权的同一 Plan 回填）。
- **L2 用户单边退出**：`revoke` + `withdraw` 任何时刻可用、商家拦不住——非托管命根。**L2 才是真正能"停止扣款"的层**（L1 只封顶/限速）。
- **L3 代码正确性**：Move 安全 + 不变量 + 输入校验 + 形式化验证（roadmap）。

### 7.4 不变量清单（形式化验证目标）
1. **金额守恒**：`Account.balance + 累计已付出 == 累计已存入`（每个 Account）
2. **单次上限**：`charge.amount ≤ max_per_charge`（Fixed `== price`；PAYG 为**用户自设**值，独立于商家 `rate_cap`，F-05）
3. **频率/速率**：Fixed `now ≥ last_charged + interval` 且 `now ≥ not_before`；PAYG 滚动窗口内 `Σcharge ≤ rate_cap` 且 `now ≥ not_before`
2b. **条款绑定**：`authorize` 仅当用户携带的 expected 条款 == Plan（`ETermsMismatch`）——防 UI 谎报/掉包（F-05）
4. **总额封顶**：每 Mandate `spent_total ≤ total_budget`
5. **时间封顶**：`charge` 仅当 `now < expiry_ms`
6. **状态门**：`charge` 仅当 `status == Active`；`status == Revoked ⇒ 任何 charge abort`
7. **退出权**：`withdraw` 只动当前 Account 余额；所有者随时可取
8. **收款/账户绑定**：charge 资金只流向 `merchant`，币种固定 `T`，且 `mandate.account_id == account.id`
9. **计数单调**：`spent_total`/`window_spent` 仅在 charge 时递增；`last_charged` 仅前进（charge 或 resume 时置 `now`），不可被商家回拨
10. **授权才动钱**：`authorize` 不转移任何资金

### 7.5 共享对象访问控制规则
`Account` 与 `Mandate` 均为**共享对象**（charge 需无用户签名）。**共享对象谁都能传进交易 ⇒ 不能靠所有权做访问控制，一切校验写在函数体**：

| 函数 | 访问控制 |
|------|---------|
| `charge` | 校验 caps + interval/rate + status + expiry + merchant/coin 绑定 + `mandate.account_id == account.id`。**Fixed 可 permissionless 触发**；**PAYG 限 merchant/授权 keeper** |
| `withdraw` / `withdraw_all` / `deposit` | withdraw 校验 `sender == account.owner`（deposit 无害、permissionless） |
| `authorize` / `revoke` / `pause` / `resume` | 校验 `sender == account.owner` / `sender == mandate.subscriber`（user-only） |
| `create_plan_*` | `plan.merchant = sender`（merchant-only） |

### 7.6 残余风险（诚实声明）
链上能防"超额/超频/抽干/盗取"，但**防不了"商家拿了授权额度却不提供服务"**——这是**信任/纠纷问题，不是盗窃**：损失仍有界（≤ `total_budget`）但消不掉。缓解：用户只授权愿承担的小额度、勤撤销、商家声誉，以及 roadmap 的带仲裁争议托管。类比 Web2 存档卡：能扣到你设的额度，不满意就退订 + 申诉——iSub 把"额度上限 + 即时退订"做成链上强制。

### 7.7 安全 Roadmap
- Sui Prover 形式化验证 §7.4 关键不变量
- PAYG 用量 attestation / 收据 / 争议窗口
- 带仲裁的争议托管（解决"非交付"）
- 第三方审计

### 7.8 商家作恶与惩罚分层

**地基定理（先承认物理极限）**：非托管 + 终局性 ⇒ **商家已扣走的资金，协议永远没收不回**。一切"惩罚"只有四条路径：**① 事前**押了东西（保证金 → slash）、**② 事中**钱未终局（延迟结算 → 争议冻结）、**③ 事后**毁其未来收入（声誉/分发）、**④ 链下**绑定真实身份（法律追责）。不存在第五条"事后伸进商家钱包"。想罚，必须在作恶**之前**埋好抓手。

**主攻 ①②④（③ 声誉系统延后）**：

| 优先 | 机制 | 设计 | 关键约束 |
|---|---|---|---|
| **② 延迟结算**（先做，= §7.7"争议托管"的具体化） | `charge` 可选不直付：进 `PendingPayment{release_after}`；窗口内用户争议 → 冻结进入仲裁；无争议则任何人可触发放款 | 这是**唯一**能"追回"的窗口（终局化之前）。牺牲"实时到账"卖点 ⇒ 做成**分层**：新商家默认 24h escrow，有保证金/履历者升级即时结算（Stripe rolling reserve 的反向版） | opt-in / 按 plan 配置，不设为协议门槛 |
| **① 保证金 + slash** | `create_plan_bonded(stake)`：商家质押；争议裁定作恶 → slash 赔付受害者；checkout 展示"已质押 X" | 把"未来声誉损失"变成"现在割肉"。**硬前置：PAYG 作恶（虚报用量）必须先有 attestation/用量收据，否则仲裁无证据，slash 即冤案机器**——依赖顺序：attestation → 争议窗 → slash，严禁跳步 | 仲裁者引入（委员会/optimistic challenge）是中心化点，须公开声明 |
| **④ 身份绑定** | "verified" 档商家提交 KYB → 链下法律可追责（Stripe 的真正底牌）；与 ①② 组合定义商家信任分级 | 注册表放 **iSub 平台层**（checkout widget / 托管 keeper / 目录的**分发权**），**绝不进合约** | 中心化注册表 = 商业层，不污染协议中立性 |
| ③ 声誉（**延后**） | 现有事件（`PlanCreated/Charged(seq)/MandateRevoked/Refunded`）已是完整原料：首 24h revoke 率、refund 率、争议率可全部链上推导 | 延后原因：需要 indexer + 指标口径设计；先把 ①②④ 的硬抓手立起来 | 原料已齐，随时可补 |

**中立性红线**：合约层**不设任何"没收/冻结商家"的管理员键**——逻辑与不冻结用户资金完全对称：今天能罚"作恶商家"的键，明天就是能罚任何商家的键，中立性一破，没有商家敢把营收挂上来。惩罚只存在于三处：**opt-in 的合约机制**（①②，商家自愿用摩擦换信任）、**市场层**（③）、**iSub 平台层**（④ 的分发权——可以拒绝*分发*坏商家，不能拒绝*协议*执行他）。即 App Store 下架 vs 操作系统封杀的区别。

**结构性优势（写进 pitch）**：`total_budget` 把单受害者案值钉小 ⇒ 规模化作恶必须骗很多人 ⇒ 在全公开账本上**规模化作恶 = 规模化留证**（对比 Web2 隐蔽扣费）。叠加 terms-binding（H-1 修复）消灭"谎报条款"类作恶、`refund` 让"拒退款"本身成为可量化负信号——防与罚互为表里。
