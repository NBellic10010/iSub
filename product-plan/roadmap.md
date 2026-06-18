# iSub — Roadmap

最后更新：2026-06-08 ｜ 模型：**Account + Mandate（无预储值、随时取消）**
> 两层：**交付 roadmap**（到 6/21–23 截止）+ **产品 roadmap**（赛后弧线）。

## 现在的位置

- **模型锁定**：Account + Mandate ——资金在用户可随时取回的 Account；商家持有上限、可撤销的 Mandate；`authorize` 不搬资金（无预储值）。Stripe"存档卡"的 Sui 等价物。
- **Phase 0 完成**：合约 `sui move build` ✅；自审修复 F-01/F-02/F-03 ✅；**功能 + 回归测试 33/33 全绿**（`sui move test`，见 test-plan.md / self-audit.md）。
- **Phase 1 完成**：TS SDK（`IsubClient` / `tx` / `IsubSigner` / `IsubKeeper`）+ keeper + e2e 冒烟在 **localnet 全绿**（smoke 17 断言、keeper-smoke 7 断言）；合约未改、33/33 仍绿。见 `../sdk/`。
- **命门已过**——最大技术风险（Sui 上非托管拉取 + 不预储值）已落成可编译、可审的合约。

---

## 一、交付 roadmap（到截止）

| 阶段 | 日期 | 产出 | 状态 |
|------|------|------|------|
| **Phase 0** 合约 + 自审 | 6/3–6/6 | Account+Mandate 合约 build + 自审修复 + **功能/回归测试跑绿** | ✅ 合约✅、自审✅、测试 33/33 绿 |
| **Phase 1** 核心 | 6/7–6/13 | keeper + TS e2e 冒烟（真网络/SDK 集成）+ **Tier 0 完整** + TS SDK | ✅ SDK+keeper+e2e localnet 全绿（见 `../sdk/`） |
| **Phase 2** 产品 | 6/14–6/18 | **TS SDK** + 商家/订阅者 UI + 免 gas（sponsored tx）= **Tier 1** | ⬜ |
| **Phase 3** 差异化 | 6/18–6/20 | 挑 1–2：PAYG demo / agent 预算 / checkout widget | ⬜ |
| **收尾** | 6/20–6/23 | demo 视频 + 文档 + 测试 + buffer + 可选 mainnet showcase | ⬜ |

**提交三件套**：① Move 合约（Account+Mandate 原语）② TS SDK（专用周期支付 SDK）③ demo 商家 app（真跑订阅）。
**现实目标**（2–3 人）：稳拿 Tier 1，摸到 1–2 个 Tier 2。

### Tier 分层（当前模型）
- **Tier 0**：`open_account`/`deposit`/`withdraw` + `create_plan` + `authorize` + `charge` + `revoke` + keeper + 端到端跑通。
- **Tier 1**：TS SDK + 商家面板/订阅者 UI（建套餐→授权→周期扣费可见→撤销）+ 免 gas 授权。
- **Tier 2**：zkLogin / 计量 PAYG demo / agent 花费预算 / checkout 一行 widget / 安全硬化。

---

## 二、产品 roadmap（赛后弧线）

### Horizon 1 — 上线与可信（赛后数周）
- **mainnet 部署 + 真 USDsui**
- charge 接入官方 **Payment Kit**（收据/防重）
- **Sui Prover 形式化验证** §7.4 十条不变量
- 第三方审计 + sponsored-tx / 协议级免 gas 生产化

### Horizon 2 — 把"无预储值"做成"无感"（数月）
- ★**法币自动续充**（Stripe Bridge → 自动充值 Account）——把"账户需有余额"做成对用户透明，**完成 Stripe 存档卡级体验**
- **PAYG 用量 attestation / 收据 / 争议窗口**（收紧信任边界）
- **带仲裁的争议托管**（解决"非交付"残余风险）
- **Milestone 模式** + **Referral 返佣**（Mandate 记 referrer，charge 时分润）
- checkout widget / React 组件 + 商家仪表盘（MRR/churn）
- ~~**Account `close`**（回收存储押金，Phase 0 #4）~~ **已完成（Phase 1.9，提前到 MVP）**：`close_account/close_mandate/close_plan`
- **多 Mandate 总敞口提示**（一个 Account 授权多商家时，UI 提示总授权 vs 余额）

### Horizon 3 — 生态扩展（更远）
- **跨币种订阅经 DeepBook 做 FX**（订阅者付币 A、商家收币 B，charge 时链上兑换 → 拉回 DeepBook + 跨协议 PTB 展示）
- **agent 经济**：机器对机器 PAYG、给 agent 的有上限非托管花费预算（Sui AI 经济）
- **流支付模式**（补上另一半 → 完整计费原语）
- 多链 / Account 生息（闲置余额存 Scallop 抵消机会成本，顺带拉回 Scallop）

---

## 关键路径与风险

- **命门已过**（合约 build + 自审完成）——最大技术风险解除。
- **下一个风险点**：Phase 2 的 SDK + UI + 免 gas 串联（Tier 1 主体）。
- **demo 必备预录 fallback**（Sui 近期 48h 宕机 3 次）。
- **法币 on-ramp 最重** → MVP 先 mock（假设 Account 已有稳定币），真续充列 Horizon 2。
- **Account 维度敞口**：多 Mandate 共用一个 Account 余额、先到先扣——产品上需在 UI 讲清。

---

## 一句话

> **MVP**：Account+Mandate 原语 + SDK + demo，跑出"无预储值、随时取消、免 gas 的链上订阅"。
> **产品弧线**：H1 上链可信 → H2 法币自动续充把"无预储值"做成"无感"→ H3 跨币种 FX + agent 经济 + 流支付，长成完整的 Sui 计费原语。
