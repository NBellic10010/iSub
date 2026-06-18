# iSub — Scope 与时间线

最后更新：2026-06-03

## 时间预算

- 今天 6/3 → 截止 6/21（延 2 天 ≈ 6/23）。
- 约 18–20 天，扣最后 3–4 天收尾（demo 视频/文档/测试/buffer）→ **净开发 ≈ 15–16 天**。
- 现实目标（假设 2–3 人）：**稳拿 Tier 1，摸到 1–2 个 Tier 2**。人手不同需缩放。

## 分层 Scope

### Tier 0 — 核心 MVP（必做，Week 1）
- Move 合约（**Account + Mandate**，无预储值）：`open_account`/`deposit`/`withdraw` + `create_plan` + `authorize`（发 Mandate，不搬资金）+ `charge`（按周期+上限强制）+ `revoke`。单币种（USDC/USDsui）。testnet。**✅ 骨架已 build 通过。**
- keeper 脚本：按周期触发 `charge`。
- CLI/脚本端到端 demo：创建订阅 → 周期扣费 → 撤销 → 取回。**独立成立 = 可用原语。**

### Tier 1 — 稳的参赛作品（Week 2）
- **TS SDK**：封装合约（openAccount/deposit/createPlan/authorize/charge/revoke/withdraw/query）——基础设施层。
- **商家面板 + 订阅者 UI**：建套餐 → 订阅链接 → 一键授权 → 周期扣费可见。
- **Sponsored transaction 免 gas**（订阅 + charge）——核心 Sui-native 卖点。
- demo 打磨成真实感 SaaS 订阅流程（评委 30 秒看懂）。

### Tier 2 — 差异化（Week 3，挑 1–2 个）
- zkLogin 登录 / 计量计费 / 里程碑付款 / checkout 一行嵌入 widget。
- 安全硬化（额度/撤销/重入等价检查）+ 回归测试覆盖 F-01/F-02/F-03。

### Tier 3 — Roadmap（基本做不完）
- 连续流支付模式、跨币种订阅经 DeepBook 做 FX、mainnet、Sui Prover 形式化验证、链上推荐返佣。

## 日历

| 阶段 | 日期 | 产出 |
|------|------|------|
| 0 设计（命门） | 6/3–6/6 | ✅ Account+Mandate 模型定型 + 骨架 build 通过 + 自审修复；⬜ testnet 跑通 |
| 1 核心 | 6/7–6/13 | 合约 + keeper + CLI 端到端 = Tier 0 |
| 2 产品 | 6/14–6/18 | SDK + UI + 免 gas = Tier 1 |
| 3 差异化 | 6/18–6/20 | 1–2 个 Tier 2 |
| 收尾 | 6/20–6/23 | demo 视频、文档、测试、buffer |

## 关键风险

1. ~~对象模型设计（命门）~~ **已定型并 build 通过**：Account + Mandate（无预储值）——资金在用户可取回 Account，Mandate 是可撤销授权。详见 architecture.md / phase0-contract-design.md。
2. **Sui testnet 宕机**（近期 48h×3 次）：预录 demo + 缓存数据 fallback；开发用 localnet。
3. **范围蔓延**：Tier 0 不锁死就别碰 Tier 2。
