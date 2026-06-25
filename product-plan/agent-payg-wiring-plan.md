# Agent PAYG 打通方案（组内评审稿）

最后更新：2026-06-16 ｜ 目的：把"agent 订阅 → 服务按用量自动扣款"从"一堆各自验证过的零件"接成"一条能在 testnet 真跑的链路"。

---

## 1. 背景：现在卡在哪（诚实版）

零件都真、且各自验证过，但**没串起来**：

- ✅ `agent.subscribe()` 真的在链上建了一张有上限的授权（Mandate），testnet 实测过。
- ✅ `charge_metered`（按量扣款 + 各种上限 + 防双花）testnet 实测过。
- ✅ `biller`（计量→结算编排）逻辑写好、31 项测试全绿。

**但有两根线没接：**

1. **agent 和服务没接**：订阅完，`mandateId` 只存进了 agent 进程的内存，**没有任何代码告诉服务"该开始给这张授权计费了"**。
2. **没有跑着的服务**：`biller` 是个库，没有被任何服务进程调起来；它至今**只对一个模拟链（mock）跑过**，没对真链跑过。

一句话：**"订阅后服务自动按量扣"这件事，作为一个运行的系统，目前不存在。**

## 2. 目标：什么叫"打通"

一条端到端链路在 **testnet 真跑一次并可回归**：

> agent 自主订阅一个 PAYG 服务 → 调用该服务若干次 → 服务计量 → biller 在授权上限内**从 agent 账户真扣款**（真链，不再 mock）→ 用量与扣款对得上、不超额、不双花 → agent 撤销后服务停止且扣不动。

**验收标准（下方 §6 的测试跑绿即视为打通）。**

## 3. 方案核心：把"授权"当成"付款凭证"

最干净的接法 —— **agent 调服务时,在请求里带上 `mandateId` 当凭证**（类似 API key，也对齐 x402 的"付款头"）。服务据此自动登记、计量、扣款。**不需要单独的注册步骤。**

### 要新增的东西
1. **服务运行时（service runtime）** —— 一个轻量 HTTP 服务（用 `node:http`，零依赖，和我们 SQLite 一个路子），任何服务方嵌入即可。它：
   - 内含一个 `IsubBiller`（接**真** `IsubClient` + 服务自己的扣款 key）+ SQL store；
   - 后台跑 `biller.run()` 的结算循环；
   - 暴露最小端点（见下）。
2. **三个端点**
   - `POST /use`（或服务自己的业务 API）：agent 调用时带 `mandateId`。服务**首次见到该 mandate 就上链校验**（收款人 == 本服务、状态 active、未过期、账户匹配），通过则登记，然后 `recordUsage` 记一笔用量，返回业务结果。
   - `GET /subscriptions/:mandateId`：查生命周期/已扣/剩余预算。
   - （webhook 复用已有的派发器：`budget.threshold` / `budget.exhausted` / `charge.succeeded`）
3. **biller 对真链跑** —— 用 `IsubClient` 替掉测试里的 `FaithfulChain`。这一步顺带补上"biller 从没对真链验证过"的洞。

## 4. 打通后的端到端流程

```
1. agent.subscribe(服务S, 预算)        → 链上真 Mandate M（授权 S 为收款人 + 上限）
2. agent 调 S 的 API，带 X-iSub-Mandate: M
3. S 首次见 M → 上链校验(收款人==S? active? 未过期?) → 登记
   S 计量这次调用 → biller.recordUsage(M, 用量, usageId)
   S 返回业务结果
4. S 的 biller 后台循环 → flush → charge_metered(用量, seq) → 真链从 agent 账户拉款
5. 余额/预算告警走 webhook；M 被撤销/过期/预算耗尽 → S 拒服(402) 且链上扣不动
```

## 5. 决策（已拍板 2026-06-16）

| # | 决策 | **结果** |
|---|---|---|
| **D1** | mandate 怎么交给服务 | ✅ **凭证模型**：agent 调用时带 `mandateId`,服务首用上链校验(收款人==本服务/active/未过期)即自动登记,无注册步骤(对齐 x402) |
| **D2** | 每次调用是否重查链上状态 | ✅ **采信 biller 跟踪的生命周期**做拒服决策(不每次读链;链上扣款时再拦一道) |
| **D3** | 计量→扣款节奏 | ✅ **窗口 + 阈值双触发(取先到)** ＋ **服务按剩余预算 gate 交付**(见 §5.1 漏扣处置) |
| **D4** | 托管 or 自托管 | ✅ **可嵌入的"服务运行时"**;demo 跑一个实例,多租户托管(SQL 已就位)留作产品化 |
| **D5** | 扣款 gas | ✅ **上 sponsored tx**(gasless,Sui-native 卖点)。⚠️ 引入 Enoki/gas-station 依赖 → **先打通裸循环、再 sponsor**,别让 gas 配置卡住打通 |
| **D6** | 用量可信度 | ✅ **先服务自报**(受 mandate 封顶);attestation/收据后议(F-05 边界) |

### 5.1 漏扣处置（D3 展开）
- **技术性漏扣 —— 不会**：记进来的用量在 `unbilled` 里留到扣成,不静默丢;加 biller 的崩溃/丢回执恢复 + 不双花,账面不漏。
- **经济性漏扣 —— 会,且是真问题**:两次 flush 之间用掉的量若**超过 `total_budget`**(或过期/账户取空),超出部分**链上拉不回**(不能扣超过授权)。处置 = **事前别超服务**,不是事后追回:
  - 服务**按剩余预算 gate 交付**(够付下一单才服务,否则 402);
  - **窗口 + 阈值双触发** flush,把 at-risk 敞口压到 ≤ 一个阈值的用量;
  - 撤销/过期由 biller 状态(D2)即时停服;reconcile 兜底告警。
- **本质**:mandate 是硬天花板 —— 天花板内零漏扣,天花板外是"服务过度交付"的自担风险,gate 压到接近零。接软风控(超额熔断,下一轮)。

### 5.2 MCP（测试是否需要）
**打通测试不需要 MCP** —— 直调 `IsubAgent` 动词 + 服务 HTTP,确定性、可回归;MCP 引入 LLM 不确定性,不适合正确性测试。**MCP 作可选 demo 层**(agent 支付工具 / 服务暴露成 MCP tool),**打通后**为"agent 原生付费"演示再加。

> **现状(2026-06-18)**:MCP demo 层已落地。`src/mcp.ts`(`@isubpay/sdk/mcp`,低层 MCP `Server`,一个 server 组合两面:钱包动词 `agentTools` + 按次计费 `query_*` 工具;凭证=mandateId 作工具入参,LLM 自己 subscribe→拿 id→query 串联)。确定性回归 `scripts/mcp-smoke.ts`(`npm run mcp:smoke`):真 MCP 协议走 `InMemoryTransport`(真 SDK Client↔Server,无 LLM)+ 真 `IsubService` 接 MockChain,**12 断言**(发现/钱包/按次计费/预算 gate 402/凭证 403/协议错误)。这正是 §5.2 说的"确定性、可回归"——MCP 协议层真、链下 mock,无需 LLM。真链验证(`mcp-e2e:testnet`)与 Claude Desktop 现场 demo(`serveStdio` 入口)留作下一步。

## 6. 验收：一条 testnet 端到端测试

写一个假"GPU/API 服务"嵌入服务运行时，然后：

1. agent 订阅（真 Mandate）。
2. agent 带凭证调服务 N 次，服务计量。
3. biller 后台 flush → **真 `charge_metered` on testnet**。
4. **断言**：① agent 账户被扣 = Σ 用量（在上限内）② 每笔只扣一次（幂等）③ 不超 `total_budget` ④ agent 撤销后服务拒服、且链上扣不动。

这条绿 = **既打通、又把 biller 对真链验证了**。

## 7. 本轮不做（范围纪律）

多租户 dashboard、sponsored 免 gas、用量 attestation、软风控（异常熔断/超额审批，见风控文档）、超出闭环所需的其余 REST 端点。**这一版只为"让链路真跑起来"。**

## 8. 风险与工时

- **风险**：testnet 不稳（已有 localnet 兜底 + 预录 fallback）；服务自报用量的信任边界（本轮接受、文档讲清）。
- **工时**：服务运行时 + 3 端点 ~1 天；testnet 端到端测试 ~半天。合计约 **1.5 人日**。

## 9. 一句话给会议

> 零件都是真的、最难的链上部分 testnet 证明过；这一版只做"接线 + 让它真跑一次"——加一个嵌入式服务运行时（把 agent 的授权当付款凭证、自动计量、biller 对真链扣款），用一条 testnet 端到端测试封板。约 1.5 人日。
