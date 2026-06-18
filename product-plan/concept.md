# iSub — 概念

最后更新：2026-06-11

## 0. 重定位（2026-06-11）：从"订阅支付原语"到"AI agent 经济的支付轨道"

**为什么改**：本届 [Sui Overflow 2026](https://overflow.sui.io/) 的头号叙事是 **"AI agents that act + financial rails that move"**（$500K，**Agentic Web + DeFi & Payments** 双核）。而我们的 Mandate——**有上限、可撤销、可编程的花费授权**——本来就是"给自主 agent 的预算原语",不是订阅专用。"又一个订阅支付"会被评委划走;**"让 AI agent 在人类预算内自己买服务、用完自动退订、每笔链上可审"** 会让评委停下。

**新定位一句话**：
> iSub = **Sui 上 AI agent 经济的支付轨道**。给自主 agent 在人类设定的**硬预算**内**自己订阅/购买服务**（数据、算力、API）的能力——单笔上限、总额上限、到期/任务结束自动退订、每笔链上可审计、随时一键收回。**同一个原语**也直接驱动人类的 SaaS 周期订阅与计量计费。

**为什么我们已经赢在起跑线**：文档里那份 agent 支付 MVP,90% 是我们**已造好、68 测试 + 双网验证过**的东西——Mandate 从设计第一天就是"有上限、可撤销、可编程的花费授权"（"$2/笔"= `max_per_charge`、"$50/月"= `total_budget`、计量 = PAYG、自动退订 = `revoke`+`expiry`+dunning、链上可审 = `charge_seq`+事件）。**不 pivot,只 re-label + 加 agent 接口 + 出 demo。**

**三根支柱（命中三赛道,见 §4.6 / §4.7）**：
1. **AI agent（主战场,已 90%）** — Mandate = 焊在链上的有限额公司卡。
2. **商家/服务快速接入** — ~10 行 SDK 把任何服务变成"agent 可订阅 / 人类可订阅"。
3. **机密支付（Sui 6/8 刚出的新原语）** — agent 花费 / 商家营收对竞品不可见,上限与审计仍在链上。

**底牌**：评委看 **traction / production-readiness**,不看点子——我们 68 测试 + testnet 实跑 + 多轮对抗性自审,正好在这条轴上领先于"还在 PPT"的多数队伍。

> 下面 §1–§4.5 是原"订阅"叙事,仍然成立——现在它是**这条 agent 轨道的一个应用面(人类 SaaS)**,不再是唯一主打。

## 1. 痛点（被证实的真问题）

> 非托管加密网关无法自动扣款——稳定币在用户自己钱包里，商家没有办法在用户不每次签名的情况下拉取资金。

传统支付（Stripe 等）能凭保存的卡自动续费；非托管加密支付做不到。这让"加密订阅 / SaaS 周期收费"在 Web3 长期缺位。订阅与周期性支付是一个 $1500 亿+/年的市场。

## 2. 解决方案

**iSub = Sui 原生订阅原语（Account + Mandate 模型，无预储值）**：

- 用户在自己的**可复用支付账户（Account）**里放余额，**随时可全额取回**（多订阅共用，不按订阅锁定）。
- 用户**签一次**给商家发一张**有上限、可撤销的扣款授权（Mandate）**——**不搬动任何资金（无预储值）**。
- 商家（或 keeper）每个周期调用 `charge`，链上规则强制：只能在到期周期、只能在上限内、从用户 Account 拉取。
- 用户随时 `revoke`（撤授权）或从 Account `withdraw`（取回）。**非托管：用户掌控 Account，商家只能在 Mandate 限额内拉。**
- 这是 **Stripe"存档卡"的 Sui 等价物**（卡=Account，授权=Mandate）。定位：**原语 + SDK**，任何 Sui 商家/应用嵌入（满足"基础设施"原则）。

支持的付费类型（对齐成熟订阅产品）：固定周期订阅、计量计费（usage-based）、里程碑付款。

## 3. 为什么是"订阅"而非"流支付"（核实结论）

Tributary 概念有两半，命运不同：

| 半边 | Sui 现状 | 判定 |
|------|---------|------|
| 流支付 / 归属（Sablier/Streamflow/Coindrip 式） | 那些协议在 EVM/Solana/MultiversX；Sui 仅有原生 vesting 原语，无成品协议。**全球拥挤 + 较简单** | 不主打 |
| **订阅 / 周期性拉取（非托管委托）** | **未见 Sui 协议**；解决上面的真痛点；更难 | **✅ 空白，主打** |

核实要点：
- **Coindrip 是 MultiversX（ESDT）协议，不在 Sui 上**——不是 Sui 占位者。
- Sablier / Superfluid / Streamflow 在 EVM/Solana，**不在 Sui**（先发窗口，但留意它们移植过来的潜在威胁）。
- **未发现 Sui 上的订阅/周期拉取协议。**
- **PIVY 拿过 Sui Overflow 2025 的 payment wallet 赛道**——证明有 payments 赛道作为归属。

## 4. Sui 原生差异化（不是 Solana 移植）

| 能力 | 用法 |
|------|------|
| **Object-model 委托（Mandate）** | 一个 Mandate 对象 = 授予商家**有上限、可撤销、无预储值**的拉取权限；资金留在用户自己的 Account，比 Solana delegation / Token-2022 transfer hook 更干净 |
| **Sponsored transaction** | 订阅者**免 gas**（商家/relayer 代付）——web2 级体验，Sui 强项 |
| **PTB 批量扣费** | 一笔交易里给多个订阅批量 charge |
| **zkLogin** | web2 式登录，降低订阅者上手门槛 |

## 4.5 竞争差异化：如何在流支付人群中脱颖而出

支付是本季最热主题（Sui 协议级免 gas、官方 Payment Kit、USDsui 同期落地），**大量队伍会涌入，且多数会做最显而易见的事：移植 Sablier/Superfluid 式"流支付"**（按时间线性放款、推送、预锁仓，做工资/归属/grant）。脱颖而出 = **不进这条道**，做"拉取支付原语"，并叠加中位队伍不会做的设计选择。

### 六轴差异化（中位队伍 / iSub）
| 轴 | 中位队伍 | iSub |
|----|---------|------|
| 拉 vs 流 | 流支付（推送/归属/工资） | **拉取订阅**，解决"非托管无法自动扣款"真痛点 |
| 通用性 | 单一模式（多为流） | **一个原语三模式**：订阅 / PAYG / 里程碑 |
| 造 vs 组合 | 自己重写支付，多半不知 Payment Kit | **建在官方 Payment Kit + 协议级免 gas 之上**（合 P5） |
| 价值定位 | "把钱随时间转过去" | "**有上限、可撤销、非托管的授权**"——可证明的有界授权（安全核心） |
| 形态 | 独立 app（流支付界面） | **原语 + SDK + checkout**，别人嵌入（P2） |
| 无预储值 | 多数预锁/预存资金 | **authorize 不搬资金**，钱留在用户可取回的 Account（Stripe 存档卡式） |
| Sui 原生深度 | 生硬移植 EVM/Solana | 吃透"为何 Sui 无 approve"后的 **Account + Mandate** 设计 |

**锋利角度**：给 AI agent 的**花费预算（PAYG + 上限）**——流支付-工资队伍不会碰，踩中 Sui AI 经济热点。iSub 是支付轨道，**不是 AI**（不踩团队短板）。

### 差异化必须"看得见"——五个 demo 时刻
1. 商家试图**超额扣款 → 合约当场拒绝**（安全，最直观）
2. 用户点**撤销 → 即时非托管取消 + 取回未用额度**（控制权）
3. **一键免 gas 订阅**（不需持有 SUI）
4. **同一原语**并排跑订阅 + PAYG/agent 预算（通用性）
5. **第三方商家 ~10 行 SDK 接入**（基础设施）
6. （每笔 charge 吐一张 **Payment Kit 收据** → 建在官方轨道上）

### 一句话定位
> **iSub 不是流支付 app——是 Sui 上的非托管周期/计量收款原语：无预储值、随时取消，商家只能在用户设定的上限内拉款，建在官方 Payment Kit + 协议级免 gas 之上。**

评委听到"又一个流支付"会划走；听到这句会停下。

## 4.6 三类接入（老板最关心的"别人怎么用我们"）

三类角色,全部基于**现有 SDK**（`@isub/sdk`,方法名为真实 API）。

### A. AI agent 怎么接（花费方）
**模型**：给 agent 一个**专属 iSub Account**,人类只充入"愿意让它花的额度"（= 一道硬上限 = 余额）。agent 在额度内**自主订阅**服务;每个 Mandate 再叠加 `max_per_charge`（单笔）/`total_budget`（单服务总额）/`expiry`（任务期）三道细粒度闸。

```
人类一次性：  openAccount() → deposit(本月给 agent 的额度)
agent 自主：  authorizeMetered(service, { totalBudget:$50, maxPerCharge:$2, expiry:任务结束 })  // = "订阅它,单笔≤$2、总额≤$50"
agent 查账：  getMandate() / accountExposure()                                                  // 还能花多少
服务方扣款：  （服务方按用量 chargeMetered，见 B）
agent 用完：  revoke()                                                                          // 任务结束自动退订,防僵尸订阅
人类兜底：    withdraw_all() / revoke()，每笔 Charged 事件链上可审
```
这一层经 **MCP / LangChain / OpenAI-function 适配器**暴露给 agent,它把 `authorizeMetered/revoke/getMandate` 当成 `subscribe/unsubscribe/budgetStatus` 三个 tool 调用。
→ **一句话：给 agent 一张焊在链上、有限额、随时可收回、每笔可审计的公司卡。**

### B. agent 的"订阅源"怎么接（被 agent 买的服务：数据源 / GPU / LLM API）
服务商把链上 Mandate 映射到自己现有的 API-key 体系,照常计量,多一个 charge 调用 + 一个状态回调:

```
一次性：    createPlanPayg({ rateCap, rateWindowMs, keeper })                 // 定价上链
被订阅时：  从 MandateAuthorized 事件拿 mandateId → 绑定到一个 API key        // API key ↔ 链上凭证映射
计量结算：  按用量周期性 chargeMetered(mandateId, amount, seq)                // 或直接跑我们的 IsubKeeper
访问门控：  mandate Active+有余额 → 放行;扣款失败 → past_due 事件 → 降级/停服  // dunning 状态机现成
```
→ **一句话：~100 行 = 你现有的计量管道 + 一个 `chargeMetered` + 一个 `past_due` 回调。** 任何 API 服务一天内变成"agent 可订阅"。

### C. 商家用 SDK 快速搭一个订阅平台（人类 SaaS）
```
一次性：  createPlanFixed(各档位价格)                                       // 定价上链
前端：    「订阅」按钮 = openAccount → deposit → authorizeFixed              // 上 sponsored+zkLogin 后压到 1 次/免 gas
后端：    跑 IsubKeeper（或用我们托管的）自动周期扣款                        // 消费它的事件当 webhook
          → charge.succeeded / past_due / lapsed 三个回调门控服务/催费/流失
售后：    refund() 退款回用户 Account；用户随时 revoke()
```
→ **一句话：不自建计费系统、不接信用卡、不写催收逻辑 —— 几天而非几个月,就有了 Stripe 式订阅 + 自动催费挽回。**

## 4.7 机密支付层（Sui Confidential Transfers，2026-06-08 刚公测）

[Sui 6/8 上线机密转账公测](https://crypto-economy.com/sui-opens-public-beta-for-confidential-transfers-to-enable-private-onchain-payments/)（Twisted ElGamal + ZK,**余额与金额加密、身份可见、可合规审计**）。叠到 iSub 上 = **agent 在买什么/花多少、商家营收多少,对竞品不可见**,而上限/撤销/审计仍在链上强制——直接消解我们一直诚实声明的残余风险("订阅金额/关系全链公开")。
**现状**：devnet beta、未审计、非生产;集成需动 settle() 资金路径（大改）。→ **定位为 iSub 下一层 + 一个 devnet POC + 路线图中心**,命中隐私赛道、拿"Sui 最前沿"分,但**不retrofit进主流程、不拖垮 agent demo**（取舍见 architecture / roadmap）。

## 5. 选题原则契合

| 原则 | 判定 |
|------|------|
| P1 不克隆 incumbent / 不做薄壳 | ✅ Sui 上无此物；靠 Sui-native 差异化 |
| P2 基础设施（别人构建） | ✅ 订阅原语 + SDK，商家/应用嵌入 |
| P3 不太简单 | ✅ 非托管委托 + 上限/撤销 + keeper 拉取，比流支付难 |
| P4 surface | ✅ 主网级支付场景，不依赖 testnet 弱原语 |
| P5 不重复造轮子 | ✅ 组合 Sui 原语，非重建 |
| 可行性（一个月） | ✅ 见 scope-and-timeline.md，Tier 1 稳交付 |
| 获奖模式 | ✅ 解决真问题的协议/产品 + 真实 demo（payments 赛道有先例 PIVY） |

## 6. 赛道与 Sponsor 角度

- **主赛道（重定位后）**：**Agentic Web（主攻）+ DeFi & Payments（核心）+ Payments & Wallets（专项）**——agent 支付轨道双栖前两核;PIVY 2025 在 payment wallet 赛道获奖为支付侧先例。机密支付层另踩隐私/前沿角度。
- **可选加分（非核心赛道、无明确要求）**：OZ 提供 Contracts for Sui 库（Access Management + DeFi Math），合约可实际 `use`；OtterSec 是安全公司 sponsor，§7 的安全严谨度是质量加分；Walrus（存票据）、DeepBook（跨币种订阅做 FX）为 stretch。
- 诚实保留：OZ/OtterSec 非核心赛道、无明确产出要求，**不为其过度工程**；重心是打赢 DeFi & Payments / Payments & Wallets。

## 7. 风险

- **流支付 incumbent 移植到 Sui**（Sablier/Streamflow）——先发 + Sui-native 体验是防线。
- **Sui testnet 近期 48h 内宕机 3 次**——demo 需预录视频 + 缓存数据 fallback，开发用 localnet。
- ~~非托管拉取的对象模型设计是命门~~ **已定型并 build 通过**（Account + Mandate，无预储值；见 architecture.md / phase0-contract-design.md），自审已修 F-01/F-02/F-03。
