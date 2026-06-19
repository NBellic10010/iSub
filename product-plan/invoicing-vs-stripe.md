# iSub 发票生成 & 与 Stripe Invoicing 的差异

*日期：2026-06-18 ｜ 来源：9-agent 研究 workflow(并行调研 Stripe 官方文档 + iSub 代码,带引用核查)。所有 Stripe 事实附官方 URL(见文末)。*

## 0. 核心框架(最重要的一句)

**Stripe 的发票是"先开票、再收款"的付款要求(demand);iSub 的发票是"钱已经在链上结清后"的结算回执(receipt-of-settlement)。** 因为 Sui 上一笔 `charge_metered` 落账即终局——`settle` 转账 Account→merchant、`charge_seq +1`、`spent_total +=`、发 `Charged{seq}` 事件——发票是事后凭证,不是收款触发器。这决定了几乎所有差异。

---

## 1. iSub 怎么生成发票(设计)

iSub 没有"创建再收款"的过程,发票是**结清之后**从三个已有账本拼出来的文档 + 一张新的链下表。

**真相来源(谁在哪)**
- **链上(不可篡改的结算底座)**:每笔成功扣款 `settle` → `spent_total +=`、`charge_seq +1`、转账、发 `Charged{mandate_id, account_id, amount, spent_total, seq, by}`。退款发 `Refunded{…, refunded_total}`(退款**不回滚** `spent_total`,净额 = spent − refunded)。**注意**:`Charged` 事件**不带时间戳、不带明细**,且 gRPC 无事件查询——链只证明"金额 amount 在 seq=N 结清了"。
- **链下已有**:`usage_records`(每次调用的明细级数据:冻结的 amount、`at_ms`(链上缺的时间戳)、`meter_key/qty/rate_card_version`)+ `charges` 追加日志(amount→seq→tx digest)+ `RateCard`(价目;`priceUsageMulti` 已能算出逐行 `{meterKey, qty, amount}` 且精确求和——但目前只存了总额,明细被丢弃)。
- **链下新建**:`invoices` + `invoice_lines` 表(+ 可选 PDF/托管页)。

**生成步骤**
1. **周期分组**:给每个 mandate 定一个账期(日历月,或 Fixed 的 `interval_ms`),取该期内 `kind='charged'` 的日志行(目前**没有"账期"概念,要新加**)。
2. **行项目**:每笔链上扣款展开成定价行——从 usage_records 的 `meter_key/qty/rate_card_version` 用对应版本 RateCard 复原(注意 `unbilled()` 目前**没 SELECT 这几列**,要加读路径;或入账时直接持久化 `PricedLine[]`)。行精确求和到该笔扣款(整数算钱保证)。
3. **发票编号**:`charge_seq` **不是合法发票号**(它是每 mandate 的扣款计数器)。要在"定稿(finalize)"时**链下另铸一个无间断号**(PREFIX-NNNN);提供 per-customer 和 merchant/account-level(欧盟/英国合规)两种方案;把 `seq + tx digest` 放进发票**作为结算交叉引用**(类似墨西哥 CFDI UUID / 印度 IRN),而不是当编号。
4. **状态(与 Stripe 分歧最大)**:Sui 扣款落账即终局,**没有 draft→open→paid、没有"待付款"、没有 PaymentIntent**。生命周期坍缩成 `finalized`(=已结清/已付)和 `credited/partially_credited`(发生退款)。**没有 open/uncollectible/作废-因未付**。失败的 pull 在日志里是 `fail/skip`,**永远不会变成发票行**。
5. **退款 = credit note**:链上 `refunded_total/Refunded` 就是 Stripe credit note 的经济等价物。生成带号的贷记单(自有 CN-NNNN 序列)引用原发票 + 退款 digest。因为链上已退回付款人,**永远是退回原付款方**,不需要 Stripe 的三向拆分(无链下余额、无线下现金路径)。
6. **PDF/托管页 = 薄展示层**:把定稿 JSON 渲染成 PDF + 只读"结算回执"页。**和 Stripe 的托管页不同,这不是 pay-now 页**(没东西可收)——是**可验证回执**:每行可凭 tx digest 深链到 Sui 浏览器,任何人能独立核验链上结算。

**一个坑**:recoverOrphan 恢复的孤儿扣款有 seq、但 digest 是占位符 `'recovered'`(无真 tx digest)——这类行只能引 seq、要标注/省略浏览器链接。

---

## 2. 逐项对比 Stripe vs iSub

| 维度 | Stripe | iSub |
|---|---|---|
| **核心模型** | 有状态 Invoice 对象,聚合行项目成应收总额,再收款。发票=收款要求 | 无发票对象;原生物是 `settle()` 转账 + `Charged{seq}`。发票=钱动之后的结算回执 |
| **状态/终局** | 5 态:draft/open/paid/uncollectible/void;finalize 时铸号+出 PDF+建 PaymentIntent;'open'=已定稿未付(仍可收款失败) | 落账即终局,无"待付款"/无 PaymentIntent/无付后失败。坍缩为 finalized(=已付)+ credited。失败 pull 进日志,不成发票 |
| **行项目** | `invoice.lines.data`;**当前 API**:无顶层 `type`(在 `parent.type`)、无顶层 `price`(用 `pricing`)、税在 `taxes`/`total_taxes` | 今天没有;由链上每笔扣款从 usage_records 复原定价行,`priceUsageMulti` 已能逐行求和,只是被丢弃需加持久化/读路径 |
| **用量→行** | Meter Event → Billing Meter 聚合 → usage Price → 周期末成行 | usage_records≈Meter Event,RateCard≈Meter+Price;但 iSub **入账即定价并冻结**,改价不回头重算(对账保证) |
| **编号** | PREFIX-NNNN,finalize 时铸,客户级 vs 账户级(欧盟/英国常要账户级无间断) | `charge_seq` 非法律号;需链下另铸无间断号;seq+digest 作交叉引用 |
| **税** | Stripe Tax 自动按买方地在 finalize 时算 VAT/GST/销售税;校验税号(VIES/HMRC/ABR) | **零税逻辑**;RateCard 无税字段;要全新链下计算;且 crypto 结算时点可能滞后、税是法币计价 |
| **PDF/托管页** | finalize 自动出 PDF + hosted pay-now 页 | 今天没有;薄渲染层 + **只读回执页(非收款),每行深链浏览器** |
| **Credit note** | 一等贷记单,带号/PDF/原因码,付后需三向拆分 | 链上 Refunded/refunded_total 为等价物;包成带号贷记单,**只退原付款方,无需三向拆分** |
| **按比例(proration)** | 改套餐按秒退补 | PAYG 按精确用量计费,用量 proration 无意义;仅平价 flat 套餐才需 |
| **催收/重试(dunning)** | Smart Retries(AI)~8 次/2 周 | **无重试/催收层**;失败 pull 无恢复工作流、不成发票(是 mandate 健康问题,非发票问题) |
| **收款模型** | charge_automatically / send_invoice;发票先于/触发收款 | pull 支付;收款**就是**链上 `settle()` 且**永远先于**文档;无"到期日" |
| **托管(custody)** | 托管——Stripe 中途持有资金再 payout | **非托管**——Account→merchant 直接转账,无人中间持有,无 payout、无结算/列报币种差 |
| **币种** | 每发票一个 ISO-4217 法币 | 币种是**币类型**(MIST/SUI bigint),非法币;单币种;法币列报只是展示层 FX 快照 |
| **可审计/证明** | 信 Stripe 的记录+webhook | **资金腿更强**:链上可篡改证据(seq 单调、spent/refunded、tx digest),**任何人可凭浏览器独立核验**,与日志对账 |
| **合规/电子发票** | 出合规文档但免责;**不**出结构化电子发票(ViDA/印度 IRN/巴西 NF-e/墨西哥 CFDI),交给 App 市场伙伴 | 今天没有;同样边界——链上事件**不是**法律发票,清税机关不认;须建链下合规文档,强制辖区委托 PEPPOL/IRP/SEFAZ/SAT 伙伴(链上回执是其中一个输入=付款证明) |
| **成本/gas** | 百分比+笔费;Invoicing/Tax 是付费加项;无 gas | 结算花 Sui gas(由 `by` 付);**发票生成是纯链下计算,零额外 gas** |

---

## 3. 要补的缺口(优先级)

- **P0 文档内核**:`invoices`/`invoice_lines` 表;**账期概念**;finalize 时铸**无间断发票号**;行的**人类标签/单位**(Meter 现只有机器 `key`)+ 暴露逐行明细;**定稿/快照+不可变边界**。
- **P1 合规**:商家**法律主体身份**(现只有 name+payout_address);**买方身份**(现只有 Sui 地址+free-text);**finalize 时固定税额**+税号校验;**法币列报+FX 快照**;**贷记单文档**。
- **P2 展示与恢复**:PDF+托管回执页(带浏览器深链);失败 pull 的 mandate 健康/催收(独立于发票);折扣/优惠券;flat 费 proration。
- **P3 推迟**:结构化电子发票/清税(ViDA/IRN/NF-e/CFDI)——**Stripe 自己都外包给伙伴**,iSub 也应只在商家落在强制辖区时委托。

## 4. iSub 的独有优势(Stripe 给不了)

1. **链上不可篡改结算证明**:每行可溯到 `Charged{seq}` + tx digest,金额/顺序/累计公开可验。
2. **可编程的第三方可验证性**:审计/对手方/监管无需信任 iSub、无需 API 访问,凭 digest 即可对链核验;回执页每行深链浏览器。
3. **非托管结算**:点对点直转,无 payout 延迟、无托管风险、无人能冻结/追回。
4. **结算优先的终局**:发票天生"已付",无催收风险、无付后失败(代价:不服务"先开票要钱"场景——但对周期/计量 pull 支付,事后凭证才是对的)。
5. **构造性对账保证**:入账即冻结 + 链上 seq 与日志对账,行精确求和到链上扣款,文档不会悄悄偏离结算。
6. **发票零边际 gas**:纯读已发事件,无额外链上成本。

## 5. 建议的第一版

**做一个"结算发票(Settlement Invoice)"**——对已结清链上扣款的、带号、按周期分组、不可变的回执。顺序:
1. **Schema**:`invoices`(id, merchant_id, mandate_id, number, period_start/end, status, subtotal, total, coin_type, finalized_at)+ `invoice_lines`(invoice_id, charge_seq, tx_digest, meter_key, label, qty, unit_price, amount, at_ms),按 merchant_id 租户隔离。
2. **生成器**:按 mandate+周期分组 `charged` 日志 → 每笔从 usage_records 复原定价行(加读路径或入账持久化 `PricedLine[]`)→ 行求和=该笔,扣款求和=期总。
3. **编号**:finalize 时链下铸无间断号,提供 per-customer + account-level(欧盟/英国默认账户级);行内引 seq+digest 作结算证明。
4. **状态**:只两态——`finalized` + `credited/partially_credited`。
5. **贷记单**:从 Refunded 生成带号 CN,只退原付款方。
6. **薄渲染**:JSON→PDF + 只读回执页(每行浏览器深链=差异化卖点);给 Meter 加标签、给 merchants/subscriptions 加法律身份字段。

**明确推迟**:税(VAT/GST,最大单项,先 stub 字段)、法币/FX、结构化电子发票(委托伙伴,别自建)、催收/折扣/flat proration。

**理由**:复用 iSub 已有的一切(不可变结算、冻结定价、链↔日志对账),只加链下文档/编号/渲染层,主打 Stripe 给不了的"链上可验证证明",把重的辖区合规机器推迟到有客户逼着才做。

## 6. 开放问题(待定)
1. Stripe 兼容若做,**API 版本**敏感(line item 当前用 `parent.type`/`pricing`/`taxes`)。
2. **账期定义**:日历月 vs `interval_ms` vs flush 窗口对齐?决定"哪些扣款属于发票 #N"。
3. **编号方案默认**:per-customer vs account-level(驱动欧盟/英国无间断合规);谁持有前缀+只增计数器(新表+锁)。
4. **孤儿扣款**:有 seq 无真 digest,发票行如何引证——标注,还是定稿前必须对账齐?
5. **退款→发票映射**:Refunded 链上无 seq 无时间戳,如何把退款归到某张过去发票/周期?(需链下日志关联)
6. **crypto 滞后下的税时点**:结算 at_ms vs finalize 时间,哪个定税率?
7. 法币 FX 源+时间戳(若加法币列报)。
8. 法律身份采集(商家税号、买方名址税号)从哪来(onboarding/KYC,超出 repo 范围)。
9. **链下不可变机制**:定稿发票的哈希要不要上链锚定(便宜的完整性证明,把"链上证明"优势延伸到文档本身)。

## 7. 来源(Stripe 官方 + 合规)

Stripe Invoicing/Billing:
- https://docs.stripe.com/invoicing/overview · /api/invoices/object · /api/invoice-line-item · /api/invoiceitems
- https://docs.stripe.com/billing/subscriptions/usage-based/how-it-works · /api/billing/meter/object
- https://docs.stripe.com/invoicing/hosted-invoice-page · /invoicing/customize · /invoicing/automatic-collection
- https://docs.stripe.com/changelog/2020-03-02/sequentially-number-invoices · /resources/more/what-is-an-invoice-number-…
- https://docs.stripe.com/tax/invoicing · /tax/invoicing/tax-ids · /invoicing/taxes
- https://docs.stripe.com/api/credit_notes/object · /api/credit_notes/create
- https://docs.stripe.com/billing/revenue-recovery/smart-retries · /billing/subscriptions/prorations · /billing/subscriptions/coupons
- https://docs.stripe.com/invoicing/multi-currency-customers · /payouts/multicurrency-settlement
- https://stripe.com/guides/send-e-invoices-on-stripe-billing-through-app-marketplace-partners · /legal/ssa

合规/电子发票:
- https://taxation-customs.ec.europa.eu/taxation/vat/vat-businesses/invoicing_en · /taxation/vat/vat-digital-age-vida_en
- https://www.vatcalc.com/eu/eu-2028-digital-reporting-requirements-drr-e-invoice/
- https://cleartax.in/s/e-invoicing-gst · https://invoicedataextraction.com/blog/brazil-nf-e-nota-fiscal-eletronica-guide
