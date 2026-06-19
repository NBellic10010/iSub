# iSub — Sui 原生订阅原语

> **一句话**：非托管的周期性拉取支付（**无预储值**、签一次授权、有上限、随时撤销），让任何 Sui 商家/应用一行接入"订阅"能力。
> 状态：Phase 0–1.9 完成（合约 **68/68** + 安全自审 4 轮 + SDK/keeper/e2e 走 **gRPC** 在 **localnet 与 Sui testnet 双网全绿**，2026-06-13）。目标：Sui Overflow 2026（截止 6/21，通常延至 ~6/23）。

## 这是什么

加密支付有个被证实的真痛点：**非托管钱包无法自动扣款**——稳定币在用户自己钱包里，商家没法在用户不每次签名的情况下拉取周期性费用。Stripe 能自动续费，非托管加密网关不能。

**iSub 用 Sui 的对象模型解决它（Account + Mandate）**：用户在自己**可随时取回的支付账户（Account）**里放余额，再**签一次**给商家发一张**有上限、可撤销的扣款授权（Mandate）**——**不预储值**（authorize 不搬资金）；商家（或 keeper）每个周期从用户 Account 在授权限额内拉款。这是 **Stripe 存档卡的 Sui 等价物**。定位为**原语 + SDK**——别的商家/应用嵌入它来收订阅，而不是又一个成品 app。

## 为什么是"订阅"不是"流支付"

流支付（Sablier / Streamflow / Coindrip）全球已拥挤、且较简单（锁仓+线性释放）；**订阅式非托管委托拉取在 Sui 上是空白、更难、戳真痛点**。详见 `product-plan/concept.md` 的核实结论。

## 文档索引

- [`product-plan/concept.md`](product-plan/concept.md) — 概念、痛点、Sui 原生差异化、核实结论、原则契合、赛道/sponsor
- [`product-plan/architecture.md`](product-plan/architecture.md) — Move 合约对象模型、charge/撤销、keeper、sponsored tx、SDK 分层
- [`product-plan/scope-and-timeline.md`](product-plan/scope-and-timeline.md) — 分层 scope（Tier 0–3）、日历计划、风险、现实目标
- [`product-plan/privacy.md`](product-plan/privacy.md) — 隐私模型：不可关联 vs 匿名、burner/zkLogin/隐形地址、刻意不做混币
- [`sdk/README.md`](sdk/README.md) — TS SDK（gRPC）+ e2e/keeper/payg/dunning 脚本（localnet + testnet 全绿）
- [`product-plan/phase2-demo-app.md`](product-plan/phase2-demo-app.md) — 商家 demo app 规划（Phase 2）

## 由来

本方向是从 `../PredictComposer` 的 DeepBook 选题探索中筛出的——约十个 DeepBook 方向核实后全部败于"被占/做不动/不获奖"，唯一查实"空白+可行"的就是这条订阅线。完整选题原则与否决记录见 `../PredictComposer/topic-selection-principles.md`。
