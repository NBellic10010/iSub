# Phase 0 — 合约设计（命门）

最后更新：2026-06-03 ｜ 对应 scope 的 6/3–6/6 ｜ **模型：Account + Mandate（无按订阅预储值）**
> 骨架见 [`../contracts/sources/subscription.move`](../contracts/sources/subscription.move)（`sui move build` ✅ 通过）。

## A. 锁定的设计决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | **Account / Mandate / Plan 均为共享对象** | `charge` 需无订阅者签名即可被 merchant/keeper 调用 → 共享对象；**规则全写在函数体**（见 §7.5） |
| 2 | **不预储值**：`authorize` 不搬动任何资金 | 资金待在用户**可复用、可随时取回的 Account**；Mandate 只是有上限、可撤销的拉取授权 |
| 3 | **泛型币种 `T`** | `Account<phantom T>` / `Plan<phantom T>` / `Mandate<phantom T>`；USDC/USDsui/任意稳定币只是类型参数 |
| 4 | **charge 权限**：Fixed 无许可触发 / PAYG 限 merchant 或 keeper | Fixed 有 `amount==price`+interval 门，无许可安全且支持公共 keeper；PAYG 金额可变，必须限授权方 |
| 5 | **keeper 地址放在 Plan 上**（merchant 设），authorize 时复制进 Mandate | 由 merchant 决定谁能代扣；订阅者不指定 |
| 6 | **非托管 = Account 属用户 + 规则在函数体** | 用户随时 `revoke`（撤授权）/ `withdraw`（取回 Account），merchant 只能在 Mandate 上限内拉 |
| 7 | **Payment Kit**：Phase 0 用 `public_transfer` 直付；Phase 1 接 Payment Kit 出收据/防重 | 先跑通核心，再接官方栈 |
| 8 | **keeper 发现**：靠 `MandateAuthorized`/`Charged` 事件 + 链下索引，MVP 不建链上 registry | 省复杂度 |

## B. 对象模型（摘要，完整见 .move）

```
Account<T>   owner, balance: Balance<T>            // 用户可复用、随时取回的余额

Plan<T>      merchant, mode(Fixed|PAYG), price, interval_ms,
             rate_cap, rate_window_ms, keeper, active

Mandate<T>   account_id, subscriber, merchant, plan_id, mode,   // 不持有资金
             price, interval_ms, last_charged_ms,               // Fixed
             rate_cap, rate_window_ms, window_start_ms, window_spent, authorized_keeper,  // PAYG
             spent_total, total_budget, expiry_ms, status(Active|Paused|Revoked)
```

## C. 函数 × 强制的不变量

| 函数 | 调用者 | 强制（§7.4 不变量号） |
|------|--------|---------------------|
| `open_account` | 用户 | account.owner = sender |
| `deposit` | 任何人 | 只增加 Account 余额（无害） |
| `withdraw` / `withdraw_all` | Account 所有者 | §7.5 owner-only · #7 只取当前余额 |
| `create_plan_fixed/payg` | merchant | plan.merchant = sender · **输入校验（F-02）** |
| `authorize` | 用户（签一次） | §7.5 owner-only · **不搬资金（#10）** · 输入校验 · 复制条款 |
| `charge(amount)` | Fixed:任何人 / PAYG:merchant\|keeper | #8 account 绑定 · #6 Active · #5 未过期 · #2 amount==price(Fixed) · #3 interval/rate · #4 spent_total≤budget · #1 Account≥amount · #8 只付 merchant · #9 计数单调 |
| `revoke` | 订阅者 | §7.5 · #6 置 Revoked（终态） |
| `pause` / `resume` | 订阅者 | §7.5 · resume 豁免暂停期（F-03） |

## D. 不变量 → 在哪强制（验收红线）

| §7.4 不变量 | 强制点 |
|------------|--------|
| #1 金额守恒 | charge 用 `balance::split`，withdraw 用 `withdraw_all`——Account 只减实付 |
| #2 单次上限 | charge: `amount == price`(Fixed) |
| #3 频率/速率 | charge: `now ≥ last+interval`(Fixed) / 滚动窗口 `window_spent+amount ≤ rate_cap`(PAYG) |
| #4 总额封顶 | charge: `spent_total + amount ≤ total_budget` |
| #5 时间封顶 | charge: `now < expiry_ms` |
| #6 状态门 | charge: `status == Active`；revoke 置 Revoked |
| #7 退出权 | withdraw: owner 只取当前 Account 余额，随时 |
| #8 收款/账户绑定 | charge: `public_transfer(paid, merchant)`、币种 T 固定、`mandate.account_id == account.id` |
| #9 计数单调 | charge: `spent_total += amount`；`last_charged = now`（**F-01**，非 += interval）；resume 置 now |
| #10 授权才动钱 | `authorize` 不转移任何资金 |

## E. 开放问题（更新）

1. **首次扣款时点**：authorize 时设 `last_charged = now - interval` → **首扣立即到期**（Stripe 式）。骨架采此。备选：等一个 interval。
2. ~~漏扣追补~~ **已决（F-01）**：charge 后 `last_charged = now`（漏扣**作废**，不追补）——堵住单笔 PTB 累积抽干。
3. **total_budget for Fixed**：建议设为 `n_periods × price` 或一个大值（仅受 Account 余额 + expiry 约束）。
4. ~~**关闭对象**：revoke 后 Mandate 空壳仍在（共享对象）。要不要加 `close`？~~ **已决（Phase 1.9）**：加 `close_mandate`（须 Revoked）/ `close_account`（须空）/ `close_plan`，删共享对象退存储押金。
5. **是否需要 entry 包装**：核心用 `public fun`（可 PTB 组合）；是否补 `entry` 版直调？
6. **Account 维度的总敞口**：多 Mandate 共用一个 Account 余额，先到先扣。需在 UI 提示用户总授权 vs 余额。

## F. Next（Phase 0 收尾，6/4–6/6）
1. ✅ `sui move build` 通过。
2. ✅ 自审修复 F-01（累积抽干）/ F-02（输入校验）/ F-03（暂停语义）——见 `self-audit.md`。
3. ✅ 功能 + 回归测试套件（33 个 test：FN-1..7 + F01/F02/F03 + E/F），`sui move test` 全绿；无新发现（见 self-audit.md）。
4. ⬜ 用 mock `TEST_USD` 在 localnet/testnet 跑 open_account→deposit→authorize→charge→revoke→withdraw。
