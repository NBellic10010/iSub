# iSub 内部战略备忘录

**主题:** iSub 的定位、护城河、合规落地与路线图 —— 诚实版
**收件:** 团队 / 评委预演
**日期:** 2026-06-20
**性质:** 内部权威文档。已逐条吸收 VC 与法律顾问(Counsel)的高/中级批评,不粉饰、不绕开。凡未做的事写"未做",凡推断的事写"推断",凡只是 feature 而非 company 的部分,写"这是 feature"。

> **跨文档诚实账本(外发前必须清账,先列在最前面,因为它最伤可信度):**
> - **测试计数统一为 72/72**。`self-audit.md:254` 为权威。`competitive-landscape.md:37,50` 写 73、`concept.md` 写 68 均为过期数字,**所有对外材料必须改成 72**。VC 已指出"同一团队两份文档三个数字"是最致命的 tell,会让其余每个量化声明都被怀疑。
> - **$150B+/年 TAM 删除或换源**。该数字在 repo 中无任何引用源(`concept.md:56` 裸写),grep 全库不存在。要么补真实来源,要么删掉,**不得裸用**。
> - **Loop Crypto 细节**(50+ 客户、2026-02-13 日落、仅 allowance 天花板)研究时 `docs.loopcrypto.xyz` TLS 报错、部分未确认 —— 引用时标注"据公开信息,未完全核实"。
> - **Mysten "Coming soon" 威胁**基于对未发布代码的推断(公开 main 最后 Move 提交 2025-09-30 早于 12-23 博客,但 repo updated_at 2026-01-28)。
> - **Stripe 量化事实**(Smart Retries ~8 次/2 周、meter ≥24h 窗、line-item API 在 parent.type/pricing 下)版本敏感,引用前对 live docs 复核。

---

## 1. 一句话定位 + "这不是玩具"的核心论点

**一句话定位(诚实版,不是 "Stripe for the agent economy"):**

> **iSub 是 Sui 上一个经过硬化、攻击测试过的非托管循环 + 计量拉款支付原语(hardened non-custodial primitive),正在寻找它的 wedge —— 在那个对"运营方永远无法冻结/挪用资金 + 链上可验证的支出上限 + 用户单方撤销"有硬性需求的场景里,Stripe 结构上给不了,iSub 能。**

这个措辞是被迫诚实的。VC 的最重批评是 **"feature-not-a-company"**:整个命题坍缩成一条可抄的轴(非托管 + 链上可验证上限 + 单方撤销,Sui 原生),而 typed/capped/revocable Mandate 不过 ~500 行 Move;团队自己的文档都承认"单点可抄、整合栈才难"(`competitive-landscape.md:37-40`)—— 这正是"feature 的护城河"的标准说辞。我们**不再把"原语"当作 pitch**,而是把它当作底座,去找那个让非托管成为**硬需求(hard requirement)而非 nice-to-have** 的 wedge 客户,并在那里捕获循环经济。

**"这不是玩具"的核心论点 —— 评委应记住的一句话:**

> **iSub 的资金安全内核在你对它"敌对"时才显出价值 —— 重试、崩溃、reorg、被换的 Plan、撒谎的 UI、撤销后退款 —— 因为这些都在已审计的 Move 里强制、且每笔扣款重新校验;而残余的全部是链下健壮性、规模与外部验证,每一条团队都已白纸黑字写明。**

但这句话必须立刻附带 VC 与 Counsel 共同戳破的**两条限定**,否则就是 overclaim:

1. **"数学上无法超额"只在单 mandate 层成立,钱包层不成立**(VC + Counsel 一致)。一个共享 `Account` 同时支撑多个先到先得的 mandate;agent 可连开 N 个订阅、每个都顶到单 sub 上限,真实敞口爆到 **N × 人类批准的上限**(团队自己的 A2 发现,`agent-special-review.md:73-88`)。所以每次说"mathematically cannot overspend",**必须加 "per-mandate" 限定**,并披露**钱包层聚合敞口在跨订阅聚合上线前是无界的**。这条聚合**是安全声明,不是规模功能,已从 Phase 3 上移**(见 §4)。
2. **最强的"认真度证据"目前仍是团队自家 agent 的对抗审计**(27-agent、两轮 ~50-agent 自审)。自审深度是好工程,但作为投资证据**仍是自评**:零第三方审计、零形式化验证、零真实 merchant、零主网、零设计伙伴(全部已承认)。Traction 是客户和收入,不是测试数。**所以"这不是玩具"不能靠测试数收尾,要靠"谁在付钱/即将付钱"。** 这是我们当前最大的空缺(见 §6)。

---

## 2. iSub vs Stripe

定调:**不比功能广度(必输)**。这里先放"Stripe 领先在哪",再只认领那一条轴 —— 这是 VC 明确要求的反转顺序(把 primitive 和 $1T 平台并排做大表会招致"cute demo vs real rail"的反应)。

### 2.1 诚实承认 Stripe 领先之处(放在最前)

iSub **不**赢在让 Stripe 成为 Stripe 的大多数东西上:

- **法币普及**:真钱、所有卡网络、数百法币 vs iSub 单一 coin type、**无法币出口**。
- **chargeback / 争议基础设施**:成熟的拒付与争议轨道 vs iSub **完全没有**;且不可逆结算在争议中对消费者**更糟**。
- **合规即服务**:Stripe Tax 按买方地算 VAT/GST/销售税、校验税号(VIES/HMRC/ABR)vs iSub **零税逻辑**,`RateCard` 无税字段。
- **商户信任、支持、客户经理**:多年沉淀 vs iSub 按团队自己的判定,**单机房 Fixed+PAYG 可用、testnet pilot 条件性 OK、尚未准备好主网大规模真钱**(无多机房 HA、webhook 仅内存、gateway 无限流)。
- **欺诈 ML**:Radar + Smart Retries 挽回失败扣款 vs iSub 只有硬上限、无行为评分、**完全没有 dunning/重试层**(失败 pull 无恢复工作流)。
- **全球出入金 + 2 行集成**:Stripe 移动 crypto↔银行系统的价值 vs iSub 假设你已在链上;且 iSub 较年轻、链下 biller 仍有规模/可观测性 gap。

**结论(直接说给评委):** iSub 的主张**不是**"比 Stripe 好"。是:*若你需要非托管保证 —— 运营方永远无法冻结的资金、合约数学强制的上限、不需任何人许可的退出、人人可核验的支出 —— Stripe 结构上给不了,iSub 能。若运营方可信、法币够用,Stripe 更好,iSub 不该存在。* 那条边界就是全部的 pitch。

### 2.2 相同点(功能映射,**非同等成熟度**)

> **VC 警告已采纳:** 这不是"覆盖"。除用量计量与 e-invoicing 边界外,几乎没有真正的 parity —— 每一行都是"用结构不同的机制解决同一需求"。把 Connect/Radar/Invoicing 列成"行"会借 Stripe 抬高 iSub,故每行都附"诚实差距"。

| 同一活儿 | Stripe 产品 | iSub 机制 | 诚实差距 |
|---|---|---|---|
| 循环订阅 | Subscriptions + Billing(trial/proration/dunning/invoicing)| `Plan<T>`(Fixed)+ keeper 在链上强制的 `interval`/`not_before`/`expiry` 内拉款 | iSub 只有循环 *pull*;**无** dunning、**无** proration、**无** tax。成熟度差距真实存在。 |
| 计量计费 | Billing Meters(+Metronome)| PAYG:`usage_records`≈Meter Event,`RateCard`≈Meter+Price,`charge_metered` 在 `rate_cap`+window 内结算 | 最接近真正概念 parity 的一行。但 iSub **缺模块化定价层**(tier/package)—— AI-agent 计量故事的关键空缺。 |
| 委托/agent 授权 | Shared Payment Tokens(2025-12-11)| `Mandate<T>`:typed/capped/revocable、**不持资金**,强制 `max_per_charge`/`total_budget`/`rate_cap`+window/`interval`/`not_before`/`expiry`/账户绑定/条款绑定/`charge_seq` | Stripe 等价物在私有服务器;iSub 上限在合约强制、公开可验。这是 iSub 的招牌轴。 |
| 发票 | Invoicing(PDF + hosted pay-now;finalize→号+PaymentIntent)| **结算回执**:`settle()` 之后出具的只读页,每行深链 Sui explorer | 不是同一对象:Stripe 发票=付款要求;iSub 回执=钱已动的证明。无 draft/open/paid、无到期日、无付后失败。 |

(完整 parity 大表已按 VC 要求**删除**,只保留这四行核心映射 + 上面的"Stripe 领先"列表打头。)

### 2.3 不同点(结构性分歧)

| 维度 | Stripe | iSub |
|---|---|---|
| **托管** | 托管 —— 中途持有再 payout;可拒付/冻结/回滚 | 非托管 **by construction** —— 资金在用户自己的 `Account<T>`;余额写入者只有 owner 的 deposit/withdraw 与 mandate-capped 的 settle/refund;**模块内无 admin/freeze/capability 类型** |
| **信任模型** | 信 Stripe 私有账本 + webhook | 链上验证 —— 防篡改证据(单调 seq、spent/refunded、tx digest),**任何人**可在 explorer 独立核验。**⚠ 限定见下** |
| **结算** | 卡/银行轨,可逆(chargeback/reversal)| 落账即终局 —— 无 pending、无 PaymentIntent、无付后失败;收款即扣款 |
| **撤销** | 经 Stripe 取消,依赖处理方履行 | 用户单方 —— revoke/withdraw 无需 merchant/keeper 配合;active mandate 锁定零资金,随时取回无条件 |
| **争议/拒付** | 成熟拒付+争议轨(消费者保护)| 无。退款仅 merchant 发起、封顶于累计支出、始终退回订阅者 `Account`。**不可逆对 merchant 是优点、对消费者是缺点 —— 且可能是法律不合规,非仅 UX 劣势(见 §3.5)** |
| **市场准入** | 逐国牌照、收单关系、KYC | 无许可 —— 任何 Sui merchant/app/agent 无需批准即可集成;抗审查 |

> **⚠ "信任模型"行的强制限定(VC + Counsel):** "verify on-chain, trust no one" 是**合约范围(contract-scoped)**的属性,**不是端到端无信任**。今天你仍需信任:(a) **keeper 的活性**(单机房、内存 webhook、无 HA);(b) **SDK 从可信表面取 `expected_*` 条款** —— `client.ts:90-98` 警告若 SDK 回读被授权的 Plan 会让条款绑定**沦为同义反复**;(c) **可信展示链 `sui::display` 尚未发货**。**把这三个链下信任点(活性、展示完整性、SDK 取值)写进 pitch,而不是埋在 caveat 里** —— 评委自己发现这个缺口,会折损全部可信度。

### 2.4 非托管被 oversell 成纯优势 —— 它至少同等是采纳负债

VC + Counsel 一致的高级批评:草稿把"运营方永远无法冻结你的资金"当纯 upside。对**真正买循环支付轨的人**(SaaS CFO / merchant),非托管意味着:无 chargeback 轨、无争议解决、无 dunning/重试挽回、不可逆结算 ——**merchant 无法被补偿、无法逆转欺诈**,消费者只能"止血"、不能 clawback。"运营方永远无法冻结你的资金"是说给 crypto-native 和被制裁方听的,**不是说给买 Stripe 的 SaaS CFO 听的**。

**诚实定位结论:** 我们**不暗示主流 merchant 想要非托管**。非托管的真实需求方目前只画得清一个段:**crypto-native 的 agent / 协议 / 那些把"不可被 deplatform / 运营方不可冻结"视为活的、deal-breaking 关切的方**。TAM 据此 scope 到这个段,不外推到主流商户。这个 wedge 是否成立、是否有 GMV 意图,是 §6 的头号空缺。

---

## 3. 合规落地地图

总纲(Counsel 校正后的定调):**非托管真实地 SHRINK 了 safeguarding/PCI 表面,但它 SHIFT 而非 REMOVE 其余义务 —— shift 到那个最可能成为受监管主体的 operator/keeper 身上。** "合约不持有 Balance"**不**解决 custody 与 money-transmission,因为美/欧的操作性测试落在 **CONTROL** 与 **作为业务 accepting-and-transmitting** 上 —— 一个对共享 Account 拥有**单边拉款权**的 keeper,可以在从不持有资金的情况下满足"control"/"transmission"。

| 维度 | iSub 姿态 | 原因 | 缓解 / 路线图 |
|---|---|---|---|
| **1. 客户资金保管 / safeguarding** | **合约:设计即满足;运营 keeper:OPEN**(已从原稿"satisfied-by-design, the crux"下调)| 资金在用户自己的 `Account<T>`;余额写入者只有 owner-gated withdraw、mandate-capped settle、refund-into-account;**无 admin/freeze/capability**;`withdraw` 只校验 owner、无 status/mandate/时间门(`:168-184`);Mandate 无 Balance 字段(`:101-135`)。**但** `authorized_keeper` 对共享 Account 有**站立拉款权**,可在用户**不在扣款时签名**的情况下触发 `charge_metered`(`:383`)。 | **不再用"数学上从未到达 holds-it 状态"当作处置了法律 control 问题。** 操作性测试是 FinCEN 2019 CVC / NYDFS / 多州 MTL 的 **"total independent control"**(控制非等于持有)。共享对象 + keeper-pull 正是区分"非托管钱包软件"与"受监管 transmitter"的 fact pattern。**未决,需辖区意见。** |
| **2. Money transmission / 牌照** | **部分,且结构上脆弱** | 非托管挫败"holding/safeguarding"这一 prong,但 **operator 发起的 "accepting and transmitting value" prong 存活、且 fact-specific**。`settle`(`:405-406`)原子地 split + `public_transfer` 给 merchant,**但构造并提交该 PTB 的是 operator 的 keeper**。FinCEN/多州用功能性 "integral to the transaction" 测试 —— 不要求 transmitter 取得 title 或中途暂停资金。 | **删除 "anonymizing-software provider" 引用(用反了)**:FinCEN 2019 区分**未受监管的"工具/软件提供者"**与**受监管的"用软件作为业务 accept+transmit value 的人"**;iSub 运营 hosted infra + 提交扣款的 keeper +(路线图)`keeper_fee_bps` 与 ramp ——落在**受监管那半边**。引用有利的一半 = cherry-picking,会被 counsel 看穿。**"merchants are paid directly" 是有利事实、非法律盾牌。** 一旦运营 fee-taking hosted keeper 或加 fiat ramp,operator 很可能 re-enter scope —— 这正是 iSub 需要的变现路径,**marquee 优势在法律上未验证、且对变现路径结构性脆弱**。**FIX:先拿真实辖区意见再 pitch "非托管=无 MTL";并 model 不依赖 fee-taking hosted keeper 的变现。** |
| **3. KYC/AML、OFAC SDN、Travel Rule** | **GAP,且必须前置(非可延后路线图项)** | OFAC 是**严格责任**,US person facilitate 触及 SDN/blocked 方的那一刻即附着,**无宽限期、无"下季度再加"抗辩**。当前后端**无地址筛查/KYC**;gateway 还无限流(`backend-audit.md:39`)。Travel Rule 取决于 **operator 是否为 obligated VASP/CASP**,**非路由拓扑**;EU TFR(MiCA)**取消了 crypto 转账的 de-minimis 门槛**,要求完整 originator+beneficiary 身份。链上事件(地址+金额)**不是** Travel-Rule 报文 —— 缺规则要求的已验证对手方身份。 | **重新分类(Counsel 高级):OFAC 筛查必须在 operator 为第三方中继任何主网交易之前到位,不是 Phase-2 路线图。** 义务含:对 SDN+sectoral+**50% 规则**+辖区(非仅"地址")筛查;**blocking/rejecting + 10 日内向 OFAC 报告**;意图/知情无关。**且:permissionless `charge`(Fixed,`:339-341`)意味着被制裁方可绕过 keeper 直接交易(直 SDK / permissionless Fixed)—— operator 无法靠只筛自己中继表面完全免除 OFAC 风险,只能筛流经它的部分。** 删除 "direct settlement reduces applicability"。 |
| **4. PCI-DSS** | **不适用(更准:iSub 不是 card-acceptance 系统),非"完全 out of scope"** | 从不触碰 PAN/CVV/持卡人数据;"on-file 工具"是链上 Mandate(`concept.md:66`),非卡数据。 | **重述为 "PCI-DSS does not apply because iSub is not a card-acceptance system"**(比"out of scope"更干净、更强)。但 **caveat 与路线图须对称:Phase 3 计划 fiat on/off-ramp —— 一旦加任何 fiat 卡 ramp,PCI(或依赖 PCI 合规 ramp 伙伴的 scope)即返回。** 不把 PCI-free 当永久产品属性。 |
| **5. 消费者保护 & 授权** | **强在 caps/撤销;但 chargeback 是法律不合规风险,非仅 feature 缺口** | 强(by design):per-charge/lifetime 上限、PAYG rate-cap、`not_before`/`expiry`、条款绑定、退款入 Account。**但**结算不可逆、**无 chargeback / 无强制 reversal**;退款 merchant-discretionary(`ENotMerchant`,`:423`)。 | **Counsel 高级更正:这可能是法律 NON-COMPLIANCE,非仅 UX 劣势。** 当用户为消费者、mandate 被定性为消费者支付授权时,不可逆 + 退款随 merchant 意 **可能直接冲突**:US **EFTA/Reg E、TILA/Reg Z** 的不可放弃 reversal/error-resolution/未授权交易权;EU **PSD2** 对未授权及某些 pull 交易的无条件退款 + **SEPA mandate 的 8 周无条件退款权**。这些通常**不可合同放弃**。**诚实姿态:消费者向使用可能需限定 B2B/老练对手方,或由 operator 提供合同退款 SLA 复制法定权利 —— caps+撤销不能替代法定 reversal 权。** 且**撤销只解决"停止未来拉款"轴,与"逆转已执行的未授权扣款"的法定权正交** —— 别让强撤销框架暗示消费者保护 parity。路线图:用量 attestation/收据 → 争议窗口 → bonded/仲裁 escrow(`HANDOFF.md:147`;`self-audit.md:240-242`)。 |
| **6. 数据保护(GDPR/CCPA)** | **部分(两个相反张力)** | (a) 链下 gateway/indexer 存关系/PII-邻近数据 → controller 义务(标准、可满足、**未建为合规程序**);(b) 链上**订阅金额 + 付款方↔merchant 关系公开可见**(`competitive-landscape.md:57`),与 Art.17 erasure 冲突。 | **Counsel 更正:Confidential Transfers(加密金额)≠ Art.17 erasure** —— 加密但不可删的个人数据仍是个人数据(密钥存在使其仍可识别);**且向不可变公开账本写 PII 在写入时刻即可能违反 Art.5 minimization/storage-limitation,与后续缓解无关**;**permissionless 协议里 controller/processor 映射本身未定**(参 CNIL/EDPB 区块链指引)。状态:Confidential Transfers 仍 devnet beta、未审计、非生产、未并入主流程(`concept.md:163-166`)。链下 GDPR/CCPA 程序(DPA、retention、DSAR/erasure for off-chain、最小化链上 PII)**未建**。 |
| **7. 税 & 发票** | **缺口** | 零税逻辑;`RateCard` 无税字段;结算是 coin type 非法币(税是法币计价、结算时点可能滞后);iSub "发票" = 结算回执、链上事件**不是法律发票**(`invoicing-vs-stripe.md:7,41`)。 | 税计算是**全新链下层**;结构化 e-invoicing(ViDA/IRN/NF-e/CFDI)**委托 PEPPOL/IRP/SEFAZ/SAT 伙伴**(Stripe 自己也外包,`:50`)。**未开始,委托模型是计划非 build。** |
| **8. Agent-economy 合规** | **部分;责任归属当前弱且不可辩护(非"用户已授权"那么干净)** | 强在 *enforcement* 轴:agent 只在 typed/链上/公开可审的信封内行动,每笔 `Charged{amount,spent_total,seq,by}`(`:407-410`),agent 从不签走 custody。**但**`max_per_charge` 只节流斜率、不降终身天花板(仍是 `total_budget`,`:276-278`);**无跨订阅 budget 聚合 —— LLM 循环可连开 N 订阅、敞口爆到 N× 人类批准上限**(`agent-special-review.md:73-88`);Model B 丢弃用户独立节流阀(`maxPerCharge=rateCap`,条款绑定沦为 self-comparison no-op,`:91-109`)。 | **Counsel 高级更正:把 "within-cap = 用户已授权责任" 改为 "责任归属未定且当前弱"。** "签了 cap" **≠** Reg E 下"每笔 within-cap 交易都获法律授权",尤其 agent **故障或被攻陷**时;团队自己的事实(无界 N 订阅 + Model B 丢节流阀)**已承认该归属今天失败**;**且 ship agent runtime 的 operator 可能承担独立 product-liability / negligence / UDAP(FTC §5 不公平做法)暴露**。**FIX:跨订阅聚合 + agent 持久化(当前 restart=失忆,`:57-69`)+ Model-B 全局上限,从 Phase 3 上移到安全项。** |

### 诚实总判定(Counsel 更正后,删去"primitive 本身干净"的暗藏前提)

**iSub 的资金安全/custody 内核是 compliance-by-construction 且有审计支撑(72/72 Move 测试、多轮对抗审查、从未发现资金损失缺陷),并在 PCI 表面、safeguarding、消费者 caps/撤销 上挣得真实可辩护的 delta。但 money-transmission / AML-sanctions / KYC、税、GDPR-erasure、chargeback-争议、agent-budget-聚合 的整个表面是 operator 层工作,大体未建、且无 counsel 出具的辖区意见。** 因此 iSub 作为**非托管原语**在监管上就绪,作为**被运营的合规服务尚未就绪**。

**两条不可省的限定(Counsel):**
1. **"只是个 primitive" 不是保证的 safe harbor** —— 发布/维护合约、提供 SDK、指定默认 keeper,在某些辖区仍可能把发布者卷入 facilitation/operator 分析(参 Tornado Cash 对不可变合约作者的执法理论)。
2. **permissionless Fixed `charge`(`:339-341`)意味着任何人都能触发扣款** —— 所以 sanctions/AML 控制在 operator 中继处**必然不完整**,这是**原语固有的合规限制,无法在 operator 层治愈**。

---

## 4. 路线图

组织逻辑:**按"玩具感知"的退役顺序**,而非按功能。每阶段配 **合规闸门**(不达标不进下一阶段)+ **"证明认真"里程碑**。

**贯穿结论(grounded):** 迄今每个确认缺陷都是链下记账/活性、**从不是用户资金损失** —— 合约层 `charge_seq` 幂等 + 每笔重校验上限,在链下失效时仍兜住非托管内核(`backend-audit.md:21,53`;`self-audit.md:207`)。故所有硬化都围绕**链下健壮性 / 合规 / 去中心化 / agent 安全**,不是补一个不存在的链上漏洞。

> **VC 高级要求已采纳:对 "为什么 Mysten 不直接把这个做进 Payment Kit 就终结你?" 必须有真答案 —— 见各阶段里程碑与 §5 第 2 条。** "audit + traction + 去中心化 keeper" 是 execution,不是 moat;真正的答案是**成为标准(被 adopt AS the standard),而非赛跑**:抢先落地一个真实 agent/SaaS 的生产用例 + permissionless 第三方集成 + 链上交叉核对的权威 MRR,让生态在 Payment Kit 标准化前就已经在 iSub 上运行。这是赌"先成为 schema"的路径,我们诚实承认这是一场赛跑、且对手是链本身的 foundation(kill-shot 级威胁)。

### Phase 0 — NOW(黑客松):证明内核是真的
- **Goal:** 证明这套组合不是 slide,而是 Sui testnet 上可独立复核的运行代码。
- **Deliverables(已为真):** testnet 部署(包 id `0x573710f6...a2616`,explorer 可验,`HANDOFF.md:88,188`);非托管结构性证据;授权上限单 choke-point 强制;72/72 Move 测试 + F-01..F-07 全修;双网 e2e(19+7+16+12);MCP + wiring-e2e 15 断言真链通过。
- **合规闸门 0:** 公开诚实成熟度声明(**尚未主网大规模真钱**);**统一测试计数为 72**;**删/换 $150B TAM**;披露 H-2(Mandate=可撤销意图非保证应收)与"错过的 Fixed 周期永久作废"。
- **"证明认真"里程碑 —— 退役 #1("只是 demo,没人独立验证"):** 27-agent 独立后端审计结论零资金安全缺陷、无 blocker + explorer 可核验包摘要,任何人可自行复核资金腿。**(诚实标注:此仍为自家 agent 的自审,外部审计在 Phase 1。)**

### Phase 1 — Pilot(0–3 月):退掉单点信任,真钱在主网跑一次 + 一个真实设计伙伴
- **Goal:** 从"testnet 可验证"跨到"主网有真客户、真稳定币、第三方审计背书、拉款不再依赖一台机器"。
- **Deliverables:** 主网部署 + struct freeze(版本门已就位);收尾 `sui::display`(条款绑定真正生效前提)/N-4 密钥轮换/`UpgradeCap` 多签/USDC `pickCoins`;USDC 计价(USDsui 仅 mainnet,故只能在主网真正发生);**模块化定价层**(AI-agent 计量故事关键拼图,`biller-exec-brief.md:53`);**ONE 设计伙伴**(单一灯塔,优先 AI-agent 平台);**第三方智能合约审计**(目前 Roadmap 未做,`self-audit.md:258-259`);**去单点 keeper**(主从热备 + 跨实例 SQL 锁 + leadership-handoff e2e;强制生产用 durable store)。
- **合规闸门 1:** **第三方审计报告 published** 且 High/Critical 已修/接受;**OFAC/sanctions 筛查在中继任何主网交易前到位**(从 Phase 2 上移 —— Counsel 高级);**漏收可见性**指标(schedule-lag/past_due),能回答"MRR 准不准、漏收率多少"(今天答不上);keeper 不再单点;与设计伙伴签书面范围声明(iSub 不持有资金)。
- **"证明认真"里程碑 —— 退役 #2("跑在一台机器上,比 Stripe 还脆"):** **一个真实付费的 AI-agent/SaaS 设计伙伴在主网用 USDC 跑通完整账期,由通过第三方审计的合约结算,拉款由去单点 keeper 执行。** —— 这同时是 VC 给"yes"的四个硬条件之一(真实设计伙伴 + GMV 意图)。

### Phase 2 — Compliance hardening(3–6 月):让"非托管"在法律与运营上站得住
- **Goal:** 把"非托管=无监管暴露"这个直觉性但未证实的假设,变成有辖区法律意见、有筛查、有争议 SLA 的合规姿态。
- **Deliverables:** **非托管/no-MTL 辖区法律意见**(首发 1–2 个;**必须同时 model 不依赖 fee-taking hosted keeper 的变现** —— Counsel);网关层筛查产品化(50% 规则 + sectoral + 辖区 + blocking/reporting);**消费者向法律对齐**(限定 B2B,或 operator 退款 SLA 复制 Reg E/PSD2/SEPA 法定 reversal 权 —— Counsel 高级);Travel-Rule 就绪(取决于 operator VASP 身份非路由;EU TFR 无 de-minimis);托管网关 SOC2-lite(webhook 持久化 + durable store + 限流三项 Medium 关闭);争议/退款 SLA + 用量 attestation/争议窗口 v1。
- **合规闸门 2:** 辖区非托管法律意见 published/on-file;筛查对每笔授权/扣款生效;SOC2-lite Type I 启动;三项 Medium 关闭;争议/退款 SLA published 使 PAYG 不再纯"封顶信任"。
- **"证明认真"里程碑 —— 退役 #3("非托管很美,但合规上不能碰真用户"):** 辖区法律意见 + 上线的制裁筛查 + 带 SLA 的可验证退款同时就位 —— 这是 VC 给"yes"的"一个外部验证(第三方审计或 LOI)"与 Counsel 关切的交集。

### Phase 3 — Scale(6–12 月):从"一个客户的轨道"到"生态的轨道"
- **Goal:** 三道质疑(资金安全、单点信任、合规)退役后才扩规模。顺序 load-bearing。
- **Deliverables:** event-tail indexer(权威发现 + 链上交叉核对,slices 3-4);agent marketplace + AP2/x402 对齐 + **软风控**(熔断/step-up/全局限速/panic revoke-all);fiat on/off-ramp 伙伴(注意 **PCI 随 ramp 返回**);多链/多币(定位:不主打"首个非托管 crypto 订阅",主打"Sui 上这套整合组合")。
- **⚠ 已从 Phase 3 上移到 Phase 1/2 的安全项(VC + Counsel):** **跨订阅 budget 聚合 + agent 持久化 + Model-B 全局上限** —— 这是安全声明,不是规模功能,**不得留在 Phase 3**。
- **合规闸门 3:** indexer 作为权威发现使 MRR/漏收率链上可证;**跨订阅聚合 + agent 持久化已在更早阶段完成并验证**;每新增辖区/链**重跑 Phase 2 合规闸门**。
- **"证明认真"里程碑 —— 退役"它只是 Sui 上孤立 SDK":** 第三方 agent/merchant 经权威 indexer 发现并接入 iSub、无需 iSub 的 API key 或商务合作(permissionless 可组合 —— 原语而非平台),且这些链外创建对象被纳入权威 MRR。**这也是对 Mysten kill-shot 的实质答案:在 Payment Kit 标准化前已成为生态在跑的 schema。**

---

## 5. 给评委的话术(中文要点 + English one-liner,每条预先化解一个"玩具"反对)

**1. 资金安全是构造性的,不是承诺(预先化解"hand-wavy / trust us"):**
非托管在 Move 里强制 —— 模块内无 admin/freeze 类型,withdraw 只认 owner、随时无条件;每笔扣款重校验所有上限。
> *"Funds live in the user's own Account; there is no admin or freeze type in the entire module — the contract mathematically can't move money outside the caps the user signed, per-mandate."*

**2. 对"Mysten 为什么不直接做了你?"有真答案(预先化解"平台owner一夜商品化"):**
我们不赛跑功能,我们赛跑**成为标准** —— 抢先让一个真实 agent/SaaS 生产用例 + permissionless 第三方集成在 iSub 上跑,在 Payment Kit 标准化前成为生态已采用的 schema;且我们的强制深度与可验证性是 integrated stack,单点可抄、整合栈不易。
> *"We don't race Mysten on features — we race to become the adopted schema before Payment Kit standardizes, with depth-of-enforcement and a live third-party integration footprint they'd have to displace, not just ship."*

**3. 每个声明都标了限定,因为限定本身是可信度(预先化解"polished demo 的过度声明"):**
"数学上无法超额"只在 per-mandate 层成立;钱包层聚合敞口在跨订阅聚合上线前是无界的 —— 我们自己先说,并已把它从 scale 上移为安全项。
> *"Our caps are mathematically enforced per-mandate; wallet-level aggregate exposure is unbounded until cross-subscription aggregation ships — we say this first, and we moved it out of 'scale' into 'safety.'"*

**4. 非托管是 trust-model 选择,不是普适更好(预先化解"crypto 信仰叫卖"):**
若运营方可信、法币够用,Stripe 更好、iSub 不该存在;iSub 只为对"运营方不可冻结 + 链上可验证上限 + 单方退出"有硬需求的方而生。
> *"If the operator is trustworthy and fiat suffices, Stripe is better and iSub shouldn't exist — we're for the specific buyer who needs un-freezable, on-chain-verifiable, exit-anytime guarantees."*

**5. 不可逆既是优点也是法律风险,我们承认(预先化解"忽略消费者保护"):**
不可逆对 merchant 是优点、对消费者可能是 Reg E/PSD2/SEPA 下的不合规风险 —— 故消费者向限定 B2B 或用 operator SLA 复制法定 reversal 权,而非假装 caps+撤销能替代它。
> *"Irreversibility helps merchants but may conflict with non-waivable consumer reversal rights (Reg E/PSD2/SEPA) — so consumer-facing use is scoped B2B or backed by an SLA that replicates the statutory right, not papered over."*

**6. 我们的 pitch 轴是生产就绪 + 可验证强制,不是点子新颖(预先化解"Loop/Stripe 已做"):**
品类不新(Loop 在 EVM/Solana 做过、Stripe 更成熟)—— 我们卖的是 Sui 上链上强制的广度 + 可验证性 + agent runtime + 可信展示同意这套整合栈,并用 traction 证明。
> *"The category isn't novel — Loop and Stripe got here first; what's defensible is the integrated, on-chain-enforced, independently-verifiable stack on Sui, and we lead with production-readiness, not novelty."*

---

## 6. 诚实的"还差什么"(这份诚实本身就是可信度)

直接列残余空缺,不粉饰。VC 与 Counsel 的批评在此收束。

1. **零真实 traction —— 最大空缺(VC 头号)。** 零真实 merchant、零主网、零设计伙伴、零 agent GMV。所有 agent-economy 验证都是 supply-side(我们建了 Mandate / 对齐 AP2/x402 / 有 MCP)或借来的(Stripe SPT、Loop 50+,明确"不是我们的客户")。**没有证据表明 agent 真的需要在链上大额支付。** Traction 是客户与收入,不是测试数。**下一里程碑诚实地就是:一个有 GMV 意图的设计伙伴 LOI。**

2. **存在性威胁:Mysten 自己。** `sui.io/payments` + 12-23 博客已把"escrow/recurring/agent 限额+时间窗"当卖点(代码不在已发布包,是 Coming soon),同链、同 AP2、分发与可信度 iSub 无法匹敌 —— 一旦标准化进 Payment Kit 可一夜商品化核心原语。我们的答案(§5.2)是"先成为标准",**这是赛跑、不是 moat,我们诚实承认。**

3. **钱包层聚合敞口无界(安全,非规模)。** agent 可连开 N 订阅、敞口爆到 N× 人类批准上限;Model B 丢弃用户节流阀;agent runtime 无持久化(restart=失忆,`budgetStatus` 谎报 atRisk=0)。**这是团队自己的 A2/B 发现 —— 我们一边说"数学强制"一边自审说"agent 层预算不聚合",必须先修 runtime 再让 agent 叙事打头。**

4. **money-transmission/non-custody 法律论点零辖区意见。** load-bearing 的差异化点在法律上**未验证**,且对 iSub 需要的变现路径(fee-taking hosted keeper、fiat ramp)结构性脆弱 —— 这两步最可能把 operator 拉回 scope、消解优势。

5. **off-chain keeper/gateway 悄悄重引入它声称要消灭的托管信任问题。** 非托管"只在"gateway 从不路由资金时成立;条款绑定"只在"SDK 不回读 Plan 时有意义;`sui::display` 未发货。今天端到端**不是**无信任的 —— 仍需信任 keeper 活性、SDK 取值、不存在的展示层。

6. **采纳负债的非托管 + 缺口全在采纳要紧处。** 无 chargeback/争议救济(且可能法律不合规)、零税逻辑、GDPR right-to-erasure 与公开不可变账本结构冲突(缓解 Confidential Transfers 仍 devnet/未审计/未并入主流程、且加密≠erasure)。对一条支付轨,"合规被运营的服务"才是产品,primitive 只是容易的 20%。

7. **外部验证全缺。** 零第三方审计、零形式化验证(Sui Prover)、零 LOI。最强"认真度证据"目前仍是自家 agent 自审 —— 好工程,但作为投资证据是自评。**最快可拿的外部证据(第三方审计 engagement letter 或设计伙伴 LOI)应成为头条,自审降为脚注。**

8. **链下健壮性是真短板(团队自评)。** 单机房、无多机房 HA、内存 webhook、无限流、默认非持久 store、biller 串行处理过约几十订阅静默失效、keeper 停机=永久漏收且对账看不见。全部可软件修复、不动已审计合约 —— 但**主网大规模真钱前必须做完**。

---

**当前最诚实的对外 framing:** *"hardened non-custodial primitive seeking its wedge"*,**不是** *"Stripe for the agent economy"*。到达 VC 的"yes"需要四件事同时为真:一个有 GMV 意图的真实设计伙伴、对"Mysten 为什么不直接吸收你"的可信答案、钱包层(非 per-mandate)的支出 bounding、一个外部验证(第三方审计或 LOI)。在那之前,这份备忘录的价值正是它的诚实账本。

---

**关键 grounding 文件(绝对路径):** `/Users/tatar/Desktop/iSub/contracts/sources/subscription.move`、`/Users/tatar/Desktop/iSub/sdk/src/client.ts`、`/Users/tatar/Desktop/iSub/sdk/src/biller.ts`、`/Users/tatar/Desktop/iSub/product-plan/invoicing-vs-stripe.md`、`competitive-landscape.md`、`concept.md`、`biller-exec-brief.md`、`self-audit.md`、`backend-audit.md`、`ops-plan.md`、`scheduler-design.md`、`indexer-plan.md`、`special-review/biller-special-review.md`、`special-review/agent-special-review.md`、`/Users/tatar/Desktop/iSub/HANDOFF.md`。
