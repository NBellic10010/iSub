# iSub — 测试方案

最后更新：2026-06-08 ｜ 标的：`contracts/sources/subscription.move`（Account + Mandate）
> **状态：已实现，`sui move test` → 33/33 全绿**（FN-1..7 + F01/F02/F03 + E/F）。测试文件：`contracts/tests/subscription_tests.move`。

## 原则：功能先于安全

合约 build 通过 ≠ 能用。**先用功能测试证明"做对了事"，再用回归/安全测试证明"安全地拒绝错的"。**

## 执行顺序
1. 在合约加一组 `#[test_only]` getter（只读内部字段，生产模块零暴露）。
2. **Phase 1 功能测试 FN-1..7** → `sui move test` 跑绿 = 基本功能验证过。
3. **Phase 2 回归/安全测试**（F-01/F-02/F-03 + E + F）→ 跑绿 = self-audit 的可执行证据。

## 测试基础设施
- `sui::test_scenario`（多 tx/多地址）+ `sui::clock::create_for_testing`（**可即时跳时间**）+ `coin::mint_for_testing<TEST_USD>`。
- 测试币：`#[test_only] public struct TEST_USD has drop {}`。
- 角色：`MERCHANT` / `USER` / `KEEPER` / `ATTACKER`。
- 助手：`setup_fixed()` / `setup_payg()` → 返回 Account / Plan / Mandate。
- 负向用例：`#[test, expected_failure(abort_code = ...)]` 断言**精确错误码**。
- `#[test_only]` getter：`account_balance` / `mandate_spent` / `mandate_last_charged` / `mandate_status` / `mandate_window_spent`。

---

## Phase 1 — 功能测试（证明"能用"，断言精确数值）

| ID | 场景 | 断言（精确值） |
|----|------|--------------|
| **FN-1** | open→deposit(100)→withdraw(30)→withdraw_all | balance 100→70→0；用户先后收到 30、70（守恒） |
| **FN-2** | deposit(100)→authorize | **authorize 后 balance 仍 == 100**（不搬资金，证不变量 #10「无预储值」） |
| **FN-3** ★核心 | deposit(100), fixed price=10, 过 interval, charge | **商家收到 10；account==90；spent_total==10；last_charged 前进** |
| **FN-4** | 连续 3 个 interval 各 charge 一次 | 商家共收 30；account==70；spent_total==30 |
| **FN-5** | deposit(100), PAYG rate_cap=50, charge(7)+charge(8) | 商家收 15；account==85；window_spent==15 |
| **FN-6** ★e2e | open→deposit→create_plan→authorize→charge×2→revoke→withdraw | 每步断言余额/状态全对 |
| **FN-7** | 一个 Account 授权两个商家，各自 charge | account 正确递减、两商家各收各的、**互不串款** |

---

## Phase 2 — 回归/安全测试（证明"安全拒绝"）

### F-01 单笔 PTB 累积抽干
| ID | 场景 | 预期 |
|----|------|------|
| **F01-1** | 闲置多个 interval 后，同一 tx 内连扣两次 | 第一次成功；**第二次 abort `EIntervalNotElapsed`** |
| F01-2 | 扣后推进 <interval 再扣 / ≥interval 再扣 | 前者 abort；后者成功（严格一周期一扣） |

### F-02 输入校验（0 值参数）
| ID | 场景 | 预期 abort |
|----|------|-----------|
| F02-1..2 | create_plan_fixed price=0 / interval=0 | `EZeroPrice` / `EZeroInterval` |
| F02-3..4 | create_plan_payg rate_cap=0 / rate_window=0 | `EZeroRateCap` / `EZeroRateWindow` |
| F02-5..6 | authorize total_budget=0 / expiry≤now | `EZeroBudget` / `EBadExpiry` |

### F-03 暂停=豁免不是延期
| ID | 场景 | 预期 |
|----|------|------|
| **F03-1** | charge→pause→推进数个 interval→resume→立刻 charge | **abort `EIntervalNotElapsed`**；再推进一个 interval→成功 |
| F03-2 | PAYG：pause→推进→resume | window_spent 归零、window_start=now |

### E. §7.4 不变量 / 访问控制 必须 abort
| ID | 场景 | 预期 abort | 不变量 |
|----|------|-----------|--------|
| E1 | Fixed charge amount≠price | `EWrongAmount` | #2 |
| E2 | PAYG 窗口内累计超 rate_cap | `EOverRateCap` | #3 |
| E3 | 累计 charge 超 total_budget | `EOverTotalBudget` | #4 |
| E4 | now≥expiry 时 charge | `EExpired` | #5 |
| E5 | revoke 后 charge | `ENotActive` | #6 |
| E6 | paused 时 charge | `ENotActive` | #6 |
| E7 | charge amount＞Account 余额 | `EInsufficientAccount` | #1 |
| E8 | charge 传入不匹配的 Account | `EAccountMismatch` | #8 |
| E9 | PAYG charge 由非 merchant/keeper 调 | `ENotAuthorizedCharger` | 访问控制 |
| E10 | withdraw 由非 owner 调 | `ENotOwner` | §7.5 |
| E11 | revoke 由非 subscriber 调 | `ENotSubscriber` | §7.5 |

### F. 退出权 + 有界损失（正向断言关键性质）
| ID | 场景 | 预期 |
|----|------|------|
| F1 | 活跃 mandate 下用户随时 withdraw | 成功取回（退出权不被阻挡） |
| F2 | withdraw_all 清空后 charge | abort `EInsufficientAccount` |
| **F3** | 恶意商家反复扣到 total_budget | spent_total 封顶；再扣 abort `EOverTotalBudget`（损失链上可证有界） |

---

## 覆盖映射
- **三个自审发现**：F01-1/2、F02-1..6、F03-1/2。
- **§7.4 十条不变量**：#1(E7)、#2(E1)、#3(E2/F03-2)、#4(E3/F3)、#5(E4)、#6(E5/E6)、#7(F1/FN-1)、#8(E8)、#9(F01/F03/FN-3)、#10(FN-2)。
- **访问控制**：E9/E10/E11。
- **能用**：FN-1..7。

约 34 个 `#[test]`。

---

## 工具选择：Move test（结论）

- **功能 + 回归套件全部用 Move test。** 决定性理由：几乎每条测试都要**推进时间**（interval / expiry / rate window / pause-resume），只有 Move 的 `clock::increment_for_testing` 能**即时、确定地跳时间**；TS 跑在真实系统时钟（`0x6`）上无法快进。叠加：hermetic（避开 testnet 宕机）、快、可断言精确 abort 码与内部状态、不需 gas/私钥/造币。
- **TS e2e 脚本作补充**（Phase 1 后期，不替代）：一条 happy-path 在 localnet/testnet 跑通，验证 **SDK + PTB + 真网络集成**并驱动 demo——不做穷尽逻辑测试。
