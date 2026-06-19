# 竞争态势:Sui Payment Kit / Stripe / Loop Crypto vs iSub

*日期：2026-06-18 ｜ 来源：8-agent 研究 workflow(并行调研 + iSub 代码摸底 → 带引用核查,三家均 verify=supported/高置信)。事实附官方 URL(文末)。*

## 0. 一句话回答

**是,我们做的一部分别人已经在做——但没有任何一家做的是 iSub 的完整组合,而最接近的那家(Loop Crypto)正在关停、且不在 Sui 上。** iSub 不冗余,但也**不是品类发明**,要诚实区分"已被做"和"真没人做"。

## 1. 逐家(已做 iSub 哪部分 / 缺哪部分 / 策略)

### Sui Payment Kit(Mysten 官方)— **集成其上 + 紧盯**
- **状态**:已上线但**实验性**(`MystenLabs/sui-payment-kit` Move 包 + `@mysten/payment-kit` npm 0.2.1)。**作用域很窄:只有一次性支付**(`process_ephemeral_payment` / `process_registry_payment`)。
- **已做(重叠)**:仅单笔层——nonce 幂等(`PaymentRecord`/`EPaymentAlreadyExists`)≈ iSub 的 `charge_seq`;单笔精确金额(`EIncorrectAmount`)≈ terms-binding;资金直推商家;泛型 `<T>`;同样的"Sui 支付轨/AP2"叙事。
- **缺(iSub 独有)**:**没有任何授权对象**(Mandate)、没有用户可取回的 Account、没有 pull 模型、没有任何周期/计量/上限的链上强制。**关键:官网 sui.io/payments 和 12-23 博客把"escrow、recurring、agent 限额+时间窗"当卖点,但这些代码全不在已发布包里——是 "Coming soon" 路线图,不是已发布。**
- **策略**:**互补,在其上集成**(采用它的幂等/收据/精确金额约定做单笔步骤,对齐对象/事件形状,让 iSub 读起来像官方 kit 的"周期/计量扩展"而非分叉)。**但带紧盯条款**——那个 "Coming soon" 的协议级限额+时间窗就是 iSub 的 Mandate 地盘,来自官方厂商 → **头号存亡威胁**。

### Stripe(web2 标杆 + agentic)— **差异化**
- **状态**:已上线、成熟度/规模远超 iSub。相关 GA:Subscriptions、用量计费(Billing Meters + Metronome)、Issuing 花费控制、稳定币(USDC via Bridge 收购)、**Agentic Commerce Suite**(2025-12-11,含 Shared Payment Tokens + Machine Payments Protocol + Agent Toolkit/MCP)。
- **已做(重叠)**:**几乎覆盖 iSub 全部功能面,且更成熟**——周期(trials/proration/dunning/invoicing)、计量(meter `identifier` 的 ≥24h 唯一窗 ≈ charge_seq;分层定价 ≈ RateCard)、花费上限(Issuing 授权前拦截)、**agent 授权(Shared Payment Tokens = 限额/限商家/限时的授权 ≈ Mandate)**。
- **缺(iSub 独有)**:全在**信任模型**,不是功能勾选——① **非托管链上原语**(Account 是用户自己的、Mandate 不持币、资金 user→merchant 无中介;Stripe 永远托管、可拒付/冻结/回滚);② **链上可验证/无信任的 mandate**(每个约束智能合约强制、公开可审;Stripe 的等价物在**私有服务器**里、不可独立验证);③ **用户单方撤销/取回**,不依赖处理方;④ Sui 上 crypto 原生、无法币下匝道。
- **策略**:**不比功能广度(必输)**,只占 Stripe 结构上占不了的那一轴:**非托管 + 链上可验证上限 + 用户自主撤销 + Sui 原生**。借它成熟的心智模型(meter idempotency≈charge_seq、spending controls≈caps、SPT≈Mandate)当熟悉的上手坡道。Stripe 的 SPT 其实**验证了** agent-mandate 命题是真且及时的。

### "LoopPay" → 实为 **Loop Crypto**(crypto 周期计费)— **差异化 / 当参考设计去超越**
- **澄清**:"LoopPay" 是 2015 年三星收的移动支付,与 crypto/Sui 无关。用户指的是 **Loop Crypto**。
- **状态**:已在生产、50+ Web3 客户(Pinata、Neynar、Kaito、ENS、ETHGlobal;Circle 联盟伙伴)。**但正在关停**:团队 2025-12-10 加入 Lead Bank,**独立产品约 2026-02-13 日落**(~60 天迁移)。**EVM(以太/Polygon/Arb/OP/Base/BNB)+ Solana,不在 Sui。**
- **已做(最接近的竞品)**:**已经上线了我们的招牌命题**——非托管周期 pull、用户设/可撤销/有上限的不持币授权(=ERC-20 allowance)、商家无需用户逐笔签、**Fixed + 用量计量(含 bill-in-arrears)**、一次性/发票、off-chain API/SDK/门户、接入 Stripe/Chargebee。
- **缺(iSub 独有)**:① **Sui 原生**(Loop 仅 EVM+Solana);② **一等 typed Mandate** vs Loop 复用裸 ERC-20 allowance(只是个花费天花板,无 interval/expiry/terms-binding/charge_seq);③ **丰富的链上强制**(rate cap+window/interval/terms-binding/charge_seq 都在链上;Loop 只有 allowance 天花板,其余全 off-chain);④ 链上 price-once-frozen RateCard;⑤ **AI-agent 定位 + AP2**(Loop 无 agent 叙事);⑥ 可取回的链上 Account;⑦ exposure/scheduleLag/reconcile/consent。
- **策略**:**狠差异化在"链上强制深度 + Sui 原生 + agent 原生"**,把 Loop 当**要超越的参考设计**而非在售对手。Loop 日落意味着**连 EVM 上都没有在售的对等品 → crypto 周期这个生态位现在异常空旷。**

## 2. 冗余判定(诚实)
**不冗余,但也不是品类发明。**
- **确实已被做(别再当新颖卖)**:非托管 crypto 周期+计量这个**命题本身**(Loop 已在 EVM/Solana 生产);周期/计量/上限/dunning/agent 授权令牌(Stripe,更成熟);单笔链上幂等+精确金额(Payment Kit)。
- **确实没人做(iSub 可守的零冗余区)**:**Sui 原生的 Account/Mandate 分解(可取回 Account + 不持币 Mandate,一账户撑多 mandate)** + **一个授权对象里全套约束的链上可验证强制**(per-charge/budget/rate+window/interval/not_before/expiry/status/account/terms/charge_seq)+ **可信展示的 terms-binding 签名意向** + **charge_seq 既是幂等栅栏又是审计账本 + journaled-usageId 丢-ack 恢复** + **"签名是上限,只少拉不多拉"生命周期** + **按构造非托管的托管网关**。
- **底线:品类被占了;iSub 的免冗余区是"Sui 原生对象分解 + 链上强制的广度/可验证性 + agent 运行时 + 可信展示同意"。卖这些,别卖"首个非托管 crypto 订阅"。**

## 3. 护城河(三层,由强到弱)
1. **链上强制深度 + 可验证性**:一个 typed `Mandate<T>` 把整套约束智能合约强制且公开可审(73 Move 测试 + 多轮对抗自审)。Stripe 私有账本(非无信任)、Loop 只有裸 allowance、Payment Kit 无授权对象——**无人在单个可验证授权里匹配这个广度。**
2. **Sui 原生 Account/Mandate 分解**:针对"Sui 无 ERC-20 approve、商家碰不到 owned coin"的干净结构解,且解锁 Sui 专属 UX(赞助 gas 订阅、zkLogin、PTB 批扣)。
3. **agent 运行时 + 可信展示同意**:真 MCP server(mandateId 当凭据传、agent **永不签名**)、SpendPolicy 硬上限、AP2 对齐、consent 把人批条款绑进签名。
**真正的护城河是 Sui 上的「这套组合」**——单点都可抄,整合栈不易。

## 4. 最大威胁
**Mysten 自己上线那个官网已标 "Coming soon" 的 agent 委托花费(协议级限额+时间窗)**——正是 iSub 的 Mandate 地盘、来自官方、同链、同 AP2 叙事、带 iSub 比不了的分发与信誉。一旦 Mysten 把"有上限/有时间窗的花费授权"标准化进 Payment Kit,可能**一夜把 iSub 的核心原语商品化**、把 iSub 重framing 成"对官方标准的第三方再实现"。今天营销-代码缺口是真的(那些代码不在已发布包,最后 Move 提交早于博客)——所以是**待监控的威胁**而非现有对手,但**是 iSub 变冗余的最可能路径。**

## 5. 建议
1. **撤掉"首个/唯一非托管 crypto 订阅"叙事**(Loop 已做)。改打真正无争议的:**"一个全链上强制、可审计的 typed Mandate(单对象里全套约束)+ Sui 原生 Account/Mandate 分解 + agent 永不签名的运行时"**,以及"**Stripe 级体验 + 零托管 + 公开可验证上限**"。
2. **把"建在 Payment Kit 之上"做实**:单笔步骤采用其幂等/收据/精确金额约定,对齐对象/事件形状——既减冗余,又预置成"官方 kit 周期/计量参考实现"。
3. **把 Mysten "Coming soon" 当竞争时钟**:盯公开 repo/blog,抢在它之前成为事实上的 Mandate;若它上线,立刻重定位为"最深/最受测 + 全 SDK/gateway/agent 栈"。
4. **拿 Stripe/Loop 当验证者**:SPT 和 Loop 50+ 客户证明命题真且及时,引用作市场佐证,差异化在托管/可验证/Sui/agent。
5. **Sui Overflow 评审**:**主打 traction/生产就绪**(73 测试 + testnet 实跑 + 多轮对抗自审 + 可用 MCP)而非点子新颖——这是 iSub 领先 PPT 阶段队伍、且"Loop/Stripe 已做"批评最不伤的轴。

## 6. 开放问题(影响策略)
1. **Mysten 路线图时点**:那个 agent 委托花费何时上线?是 typed mandate(直接对手)还是更薄的能力?公开 main 最后 Move 提交 2025-09-30 但 repo updated_at 2026-01-28——**私有分支里有没有未发布的 recurring/mandate?** 这一个答案最决定 iSub 是"建在上面"还是"抢标准"。
2. **Stripe SPT 内部机制**:上限强制/撤销的真实机制(无详细公开 API 规范)?SPT↔Mandate 类比有多深?
3. **Loop 技术下限**:确认(docs.loopcrypto.xyz 当时 TLS 报错)它确实**只有 allowance 天花板、无链上 per-charge/rate/interval 强制、无幂等对象**。
4. **Loop 余生**:对等功能会不会在 Lead Bank 内重生、甚至上 Sui?
5. **iSub 自身诚实边界 vs 护城河**:总敞口=total_budget(H-2 只 surfaced)、错过的 Fixed 周期永久作废(可补最多一期)、**订阅金额/关系在 confidential-transfers 落地前链上公开**、托管网关加一个活性信任点——**隐私层能否及时落地以中和"链上公开"对 Stripe/Loop 的劣势?**
6. **标准化机会**:能否在 Mysten 出手前,把 iSub 的 Mandate 推成/对齐成 Sui 官方标准——把最大威胁转成护城河?

## 7. 来源(节选)
- Sui Payment Kit:[Move 源码](https://raw.githubusercontent.com/MystenLabs/sui-payment-kit/main/sources/payment_kit.move) · [docs.sui.io/onchain-finance/payment-kit](https://docs.sui.io/onchain-finance/payment-kit) · [sdk.mystenlabs.com/payment-kit](https://sdk.mystenlabs.com/payment-kit) · [sui.io/payments("Coming soon")](https://www.sui.io/payments) · [blog: AI agents trust layer](https://blog.sui.io/ai-agents-agentic-commerce-trust-layer/)
- Stripe:[subscriptions](https://docs.stripe.com/billing/subscriptions/overview) · [usage-based](https://docs.stripe.com/billing/subscriptions/usage-based) · [spending controls](https://docs.stripe.com/issuing/controls/spending-controls) · [machine payments](https://docs.stripe.com/payments/machine) · [Agentic Commerce Suite](https://stripe.com/blog/agentic-commerce-suite) · [agent-toolkit](https://github.com/stripe/agent-toolkit) · [stablecoin](https://docs.stripe.com/crypto/stablecoin-payments)
- Loop Crypto:[loopcrypto.xyz](https://www.loopcrypto.xyz/) · [bill-in-arrears/usage](https://www.loopcrypto.xyz/blog/how-to-use-loop-with-a-usage-based-pricing-model-and-bill-in-arrears) · [joining Lead Bank(日落)](https://www.lead.bank/blog-posts/loop-crypto-joins-lead) · [LoopPay≠(三星 2015)](https://www.channelfutures.com/mergers-acquisitions/samsung-confirms-buying-looppay-for-mobile-payments)
