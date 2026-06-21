# iSub 先行技术(Prior Art)诚实评估:这是个老点子吗?Sui Overflow 2024/2025 到底有什么?

## 1. 直接回答

**结论:在 Sui hackathon 语境下,iSub 的核心 primitive(非托管 + 硬上限 + 可撤销的链上 PULL mandate,资金留在用户自己的 Account,keeper 在上限内拉取 recurring + metered 费用)是真正的 whitespace —— 没有任何 Sui Overflow 2024 或 2025 的项目实现了它。** 但要诚实地分两层说:(a) 在 **Sui Overflow 这个具体赛事里**,这是空白,最接近的也只是 push 一次性支付、escrow 流式支付、或隐私收款,没有一个是 pull-mandate;(b) 但放到 **整个 crypto 行业的大背景**下,这个"想法"一点都不新 —— 从 2018 年的 ERC-1337 / ERC-948 / Groundhog / 8x Protocol,到今天 Visa 的 auto-payments、ERC-4337 session keys、Loop Crypto,这个 capped+revocable+whitelisted mandate 模式已经被反复提出过。所以最准确的定性是:**"想法不新,但在 Sui 上没人做成、在 EVM 上做的人都失败或半途而废" —— 是 tried-and-hard,不是 untapped-and-obvious。** 你的"奇怪没人做"的直觉是对的,而原因恰恰是 iSub 的护城河。

---

## 2. Overflow 2024/2025 里最接近的项目

**重要前提:Sui Overflow 2024 根本没有 payments track(8 个赛道是 Consumer/Mobile、DeFi、Gaming、Infra/Tools、Advanced Move、Multichain、Randomness、zkLogin);2025 也只有合并的 "Payments & Wallets" 赛道(共 4 个获奖者)。** 没有一个获奖项目是 recurring pull-mandate。下面是按"接近度"排序的真实先行技术:

| 项目 | 年份 | 它是什么 | 与 iSub 的相似点 | 与 iSub 的关键区别 |
|---|---|---|---|---|
| **SeaWallet** (ZzyzxLabs) | 2025 (P&W 第3) | 资产继承智能合约钱包,**附带**一个真正的 recurring subscription | **最接近的骨架**:非托管 + recurring + 基于 capability 的 merchant pull(`charge_fee()` 让商家从用户 vault 拉取)。比一次性/流式都更接近 | ChargeCap **无任何 cap、无预算上限、无频率/窗口限制、无过期、无用户侧撤销**(cancel/refund 在源码里被注释掉);金额从**可变的** shared Service 实时读取 → 商家可随时涨价,用户从未"锁定"价格(与 iSub 的"签名是天花板、只能拉更少"完全相反)。无 metering、无幂等、无 agent。本质是"把收费钥匙直接交给商家"的裸 pull |
| **CoinDrip** (Sui port) | 2025 (P&W) | Token streaming 协议,流按秒解锁,每条 stream 是可交易 NFT;营销中明确写"subscriptions/recurring" | 都喊"recurring/subscription/vesting" | **托管**(资金 deposit 时全额锁进合约 escrow);是 **streaming/push** 模型(从预付 escrow 按秒流出),不是从用户账户拉取的 capped pull;无 metered PAYG;原协议在 MultiversX |
| **Beep** (Agentic Finance Protocol) | 2025 旗舰 | AI agent 用 USDC 自主支付/收款/持有,a402/x402,**非托管**(资金留在用户控制的 vault),支持 scoped/可撤销 session keys,**明确列出 "subscription / usage-based billing" 用例** | **行业里最接近的直接竞品**:非托管 + agent + session-key 委托 + 明确的订阅/按量计费用例 | 公开材料中**没有**记录链上硬性 spending caps、没有 capped+revocable Mandate object、没有 cadence/renewal 规则。session-key 委托有记录,但"协议强制的硬上限 + 一等公民 mandate object + 上限内 metered pull"是 iSub 的差异点 |
| **PIVY** (Kwek Labs) | 2025 (P&W 第1) | Sui 首个 stealth-address 实现,隐私收款链接 | 非托管;赢了支付赛道 | **收款侧 push 一次性**支付;无 recurring、无 mandate、无 pull、无 agent;核心价值是隐私(iSub 完全不碰这条轴) |
| **PactDa** | 2025 | zkLogin + SUI escrow 自动化的"协议/合约"平台 | escrow 自动化算 payments-adjacent | escrow/协议自动化,不是 recurring 订阅 mandate |
| **SuiMail** | 2025 (第3) | 钱包原生去中心化邮件,pay-to-send 反垃圾 | "按单元付费"的经济味道(每封信付费像 metered) | 发件人 **push 一次性**付费;无 recurring、无 mandate、无 pull |
| **stream.gift** | 2024 (C&M 第2) | Twitch 主播加密打赏 | 都在 Sui 上转移价值 | **一次性、捐赠者发起的 PUSH** 打赏;Devpost 显示用**托管** HD 钱包;无 recurring、无 mandate |
| AdToken / Orbital / Wave / PinataBot / BioWallet / Sui NTT 等 | 2024 | 广告分发 / 跨链借贷 / 钱包 / 交易 bot / 桥 | 都"碰钱" | 全是 push 一次性、escrow 借贷、或纯钱包/交易;**没有一个**有 capped/revocable mandate 或 metered PAYG |

**一句话总结这张表:** 2024 年最接近的只是一次性打赏(stream.gift);2025 年最接近的是 SeaWallet(有 pull 骨架但裸奔无上限)、CoinDrip(托管流式)、Beep(非托管 agent 支付但无硬上限 mandate object)。**没有任何一个同时满足 iSub 的"非托管 + 资金留在用户账户 + 硬上限 + 可撤销 + recurring + metered pull"。**

---

## 3. 为什么(几乎)没人做 recurring 链上支付 —— 结构性原因

这是你"奇怪没人做"的真正答案。这不是没人想做,而是 **底层架构不支持,做的人都死了或绕路了**。来源:Visa、Stripe、GoCardless、Technorely、eco.com。

1. **没有原生 PULL primitive(根因)。** Crypto 是 push-only。Visa 直言:"Ethereum 支持 push 支付但原生不支持 pull 支付","智能合约不能自己发起交易,交易必须始终来自用户账户并由用户签名。" GoCardless:"用户不能扣别人的账户,只能发请求。" eco.com:"没有中心网络去拉取资金。" —— **这正是 iSub 要造的 rail。**

2. **签名/密钥托管悖论。** EOA 上"每个动作都要钱包主人手动签名","每次订阅续费都要新签名"(Technorely)。Visa 的灵魂拷问:"如果 Alex 去度假了,谁来生成这个签名?" 自托管与无人值守的 recurring 扣款天然冲突 —— 除非加上委托/账户抽象。

3. **没有原生定时/cron。** 链上不能定时跑代码,所以每个方案都要外挂 **off-chain scheduler/keeper**(Chainlink Automation、Gelato、中继器)—— 这就是 iSub 的 keeper 组件,也是额外的信任面与故障点(Stripe、eco.com)。

4. **Gas。** 主网 gas 尖峰让小额高频扣款不经济,用户还得持有波动的 gas 币才能"被扣款"。直到最近才用 Paymaster/gas 赞助解决。

5. **失败支付/催收逻辑全靠自建。** "没有 fallback debit 或 retry 逻辑,除非你自己写"(Stripe)。余额不足、gas 不够、取消、涨价都要自定义处理。

6. **波动性逼用稳定币;涨价要重新征得用户同意,有时甚至要重新部署合约**(GoCardless)。

7. **标准从未落地。** ERC-948 + EIP-1337(Gitcoin/Owocki,2018)试图标准化链上订阅,但卡在 scope/复杂度/定义争议上 —— governance dead-end,没有可互操作的 rail 出现。

8. **创业公司坟场证明"做过且失败"。** **Groundhog**(2018:escrow + 白名单商家 pull + 稳定币 —— 基本就是 Ethereum 版 iSub,~2019 后无活动)和 **8x Protocol**(2018:DAO recurring pay 用 off-chain 中继器,已停)。之后整个生态**绕开**了缺失的 pull primitive,改用 **streaming**(Sablier/Superfluid)—— 但 streaming 要资金预先 escrow/锁定且偏向 DAO 工资,不等于从用户自己余额按量拉取。

> 注:任务前提里说 **Loop Crypto 已 sunset 是不准确的**。Loop Crypto(SaaS recurring/稳定币支付处理器,USDC 跨 ~3 条 EVM 链,集成 Stripe)**仍在运营**;"sunset"实际是无关的 Loopring L2 钱包(2025 年中关闭)。Loop 是概念上最直接的竞品,但它是 EVM/token-allowance、处理器层带托管味。

**所以这个 gap 是 "tried-and-hard",不是 "untapped"。** 而 Visa 自己给出的答案(AA delegable accounts + 预批商家名单 + 可编程上限)和 ERC-4337 模式(session keys + spending caps + 可撤销 allowances)**正好就是 iSub 的 capped+revocable+whitelisted mandate** —— 强有力的外部验证:iSub 在造的正是整个行业已经收敛到的那条 rail,而且是在一条 object/account 模型能原生支持它、且没找到竞品的链(Sui)上。

---

## 4. 这对 iSub 在 Overflow 2026 的意义

**净判断:先行技术总体上 HELP(帮助)多于 HURT(伤害),但你必须把定位从"我发明了订阅支付"换成"我交付了别人都没交付的那个具体 primitive"。**

**为什么 HELP:**
- **品类已被验证、whitespace 真实存在。** 行业反复尝试(2018 至今)+ Visa/Stripe/Google 都在写这个叙事,证明需求真实;而 Sui Overflow 两届都没人占下这个 primitive,证明在 Sui 上是空地。
- **Sui 官方叙事就是 iSub 的论文。** Sui 的 ["agentic-commerce trust layer" 博文](https://blog.sui.io/ai-agents-agentic-commerce-trust-layer/) 几乎逐字写出 iSub 的 thesis:分离 intent/authorization/execution,"用户委托狭义授权,如 spending limit、采购类别、时间窗口",并点名 Beep + Talus 为 builder —— 但**没有描述任何已交付的 capped-mandate object**,把这个具体 on-chain primitive 留成了**公开空位**。
- **有现成标准可对齐。** [Google AP2](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)(Sui 是 launch partner)的 Intent Mandate 是主流里最接近 iSub 的类比,x402/a402 是付费协议 —— iSub 应明确对齐这些。
- **有现成积木可 build on,而非竞争。** Mysten 的 [PAS (Permissioned Asset Standard)](https://github.com/MystenLabs/pas)(policy+request 审批、非托管、scoped)是最接近的 Mysten primitive,可作为 mandate 的实现底座;[Sui Payment Kit](https://docs.sui.io/standards/payment-kit) 虽被营销说成支持"recurring",但**实际 shipped 标准只有一次性支付**,所以它是 iSub 可以建在其上的结算/收据 rail,不是竞品。

**为什么会 HURT(要正视):**
- **Beep 是真实威胁。** 它已经是 Sui 旗舰 agent 支付平台,非托管 + session keys + "spending limits/permissions" 语言 + 明确的订阅/按量计费用例。iSub 必须能清晰说出差异:**协议强制的硬性 per-charge / total caps + 一等公民可撤销 Mandate object + terms-binding(签名=天花板、只能拉更少)+ 上限内 metered PAYG + 幂等/审计 ledger** —— 这些是 Beep 公开材料里**没有规格说明**的。如果 Beep 在 2026 前补上 capped-mandate object,你的差异化会被压缩。
- **"recurring/subscription"这个词已被多个项目蹭(SeaWallet、CoinDrip、Sui Nova、Beep)** —— 不能再以"概念新"取胜,必须以"primitive 的严谨性 + 非托管 pull + 上限/可撤销/metered 的完整性"取胜。

**与团队已有材料的交叉引用:** 你们自己的 **competitive-landscape.md 已经标记了 Loop Crypto + Mysten Payment Kit** —— 这份评估证实了那个判断是对的方向,但需要**补两条更紧的**:(1) **Beep / Agentic Finance Protocol** 应升级为头号直接竞品(比 Loop 更近,因为它在 Sui 上、非托管、agent-native);(2) **SeaWallet** 应被记下,因为它是 Overflow 里唯一真正实现了"非托管 recurring pull 骨架"的项目 —— 正好用作"裸 pull vs iSub 的 capped+revocable+terms-bound typed Mandate"的对比靶子。

---

## 5. 没查到 / 盲区(诚实说明局限)

- **无法扫描完整的非获奖提交列表(这是原任务目标但没做到)。** 两届 Overflow 都跑在 Devfolio(非 DoraHacks);Devfolio 的 gallery 是 JS 渲染的,公开 Elasticsearch index 只返回 2025 的 **8 个** public 项目、2024 的 **0 个**,而非全部 599(2025)/352(2024)份提交 —— 团队只把设为 public 的项目索引出来。**所以"全量非获奖项目"无法从静态抓取确认**;本评估基于官方 Sui winners 博客(两届完整赛道列表)+ 新闻/X 报道。
- 已抓到的 8 个 2025 public 项目(SuiSnap、票务、Fitness、众筹、Rah TTS、MetaVote、Knightingale、SuiStream)均非支付/订阅类。
- **若有隐藏的 mandate 功能藏在非获奖项目里,无法排除** —— 但鉴于结构性壁垒,概率低。
- **几个站点抓取失败:** suipay.pro(TLS 证书错误,搜索也无订阅/recurring 证据,疑似支付品牌代币而非 primitive);pinatabot.com(TLS 错误,靠 Sui 博客佐证);blockchain.news / ChainCatcher / 0xmedia 文章体返回 403/404。
- **Overflow 2026 的项目列表/赛道细节尚不存在**(赛事尚未/正在进行)—— 无法确认 2026 会不会突然冒出竞品;只看到泛泛的"financial primitives / payment rails"赛道框架。注:早前抓取把 "EVE"(CCP Games 的 EVE Frontier 游戏 hackathon)误当成支付赞助方,**已证伪**,不存在独立的 "EVE payment rails" 赛道。
- **AP2 / x402 在 Sui 上的具体实现细节无法确认:** 没有任何来源描述实现 AP2 mandates 的具体 Sui Move 合约;Sui 的角色只停留在"可编程支付 + 身份层"的表述。x402 官方工具仍以 Base/EVM + Solana 为主,未找到 Sui 原生 x402 facilitator/SDK(Beep 出了 a402)。
- **无法找到一篇明确题为"为什么某加密订阅创业公司倒闭"的 obituary;** Groundhog / 8x 的失败是从项目无活动**推断**的,非官宣关停。
- **语言盲区:** 未系统检索中/韩/日文社区对 Overflow 项目的报道,可能漏掉非英文披露的小项目。

---

**一句话给 founder:** 你不是在重新发明一个老掉牙的东西,你是在一条终于能原生支持它的链上,交付一个整个行业(从 2018 的 Groundhog 到 2025 的 Visa/Google/Beep)反复想要、但因为缺 native pull / 缺 AA / 缺 scheduler 而一直没人在 Sui 上做成的 primitive。"奇怪没人做"是因为难,而难正是你的护城河 —— 前提是你把差异化讲成 **capped + revocable + terms-bound 的 typed Mandate object + 非托管 pull + metered PAYG**,而不是泛泛的"链上订阅"。
