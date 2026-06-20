# 决策记录:iSub 要不要把凭证存 Walrus / 存储层引入 Walrus

*日期：2026-06-18 ｜ 方法：9-agent 研究 workflow(Walrus 基础 / 凭证-上-Walrus 范式 / 替代与必要性 + iSub 存储面 → 对抗性核查 → 综合)。用 [concept.md §0.5](concept.md) 的"只在去掉真实信任缺口处才上链/上去中心化"同款诚实视角判定。*

## 0. 结论一句话

**不需要。** 钱的证明**已经在链上**(`charge_seq` + `Charged{amount,seq,spent_total}` / `Refunded{refunded_total}` 事件,凭 tx digest 任何人可验、无需信任 iSub)。iSub 的链下工件**又小(<1KB 签名 consent、薄发票渲染)、又只有订阅者+商家两方在意(各有动机自己留副本)**——所以 **DB + 链上哈希 + 用户自持签名工件**已覆盖完整性/真实性/可用性。Walrus 唯一真正独特的(去托管的"那串确切字节的可用性")在 iSub 这里**不承重**。

**存储层能不能引入?技术上能**,但只能作为**可选的异步 ArtifactStore 旁路**存不可变渲染件(发票/贷记单/consent),**绝不能放在热路径**(dedup `ON CONFLICT`、锁 CAS、journal 游标对 content-addressed blob 架构上不可行)。

## 1. 分场景
| 场景 | 判定 |
|---|---|
| **Hackathon / Overflow** | **跳过**;最多作为**显式标注的可选 stretch**(concept.md:183 本就标了"存票据/stretch")给 Walrus 赞助赛道叙事用。是"可用性/观感",不是正确性。别上热路径、别让它和链上 Mandate/caps 主线抢时间。 |
| **Testnet 试点** | **仍不需要**。全留 SQLite/Postgres + 链上。顶多做那个便宜的替代品(见 §3)。 |
| **生产** | **锦上添花,永不必需**,且要**有具体需求才做**:一个中立第三方(审计/仲裁/监管)必须在 **iSub 离线 + 对手方扣留/丢失副本**的争议里独立取回**确切字节**。即便如此也只是**不可变票据的异步归档旁路**,不是实时存储。 |

## 2. 数据放置表
**热事务面 → DB(放 Walrus 既是作秀也技术不适配)**:`usage_records`(dedup `ON CONFLICT`)、单实例**锁行**(CAS)、`charges` journal(被当**对账游标**,reconcile.ts:6-7)、subscriptions/MandateTrack 生命周期、scheduler phase、merchant 注册 + `api_key_hash`(认证密钥!)、webhook_deliveries(可变 outbox)、idempotency_keys、RateCard(私有可变配置)。——全是可变/可查/去重/加锁/秘密相邻,正是 Walrus 的"错用画像"。

**不可变渲染件 → `walrus+hash-on-chain` 候选,但都只是 NICE-TO-HAVE**:
- **签名 consent**(consent.ts,现在谁持有谁留):验证性来自**签名 + 链上 `expected_*==Plan` 绑定**,消息可从链上 Plan+用户选择**重建**(`verifyConsentSignature` 只要 message+sig+address)。Walrus 只加"去托管可用性"。**且含 {subscriber,merchant,amount,interval} = privacy.md 要防的指纹 → 必须 Seal 加密 → 公开可验证性归零。** 最现实做法:持有者签名副本为准,**可选只把 SHA-256 锚 Sui**。
- **发票 / 贷记单**(设计未建):**最强的纯 blob 第三方文档案例**,但核心证明已是链上 Charged/Refunded。**拆行**:权威表 + 查询/编号路径**留 DB**;只有**冻结的渲染件(PDF/JSON)**是 Walrus 候选,blobId+hash 锚 Sui,**仅当真有中立方去中心化取回需求时**。
- **AP2 VC**(仅规划):靠 issuer 签名 + 链上 mandate 自验,Walrus 只加可用性。同 consent 画像。

## 3. 真要捕获 Walrus 的唯一好处——有更便宜、在范围内的替代
**把"完整性证明延伸到文档本身"用 `hash-on-Sui` 做,而不是 Walrus**:建发票时,把 finalized 发票/贷记单(以及若持久化 consent,则其)的 **SHA-256 锚到 Sui**(这正是 invoicing-vs-stripe.md 开放问题 #9)。**零新基建、零 WAL 成本、零隐私泄露**,就得到不可变+可验证。**先做这个,再谈 Walrus。** 两层分清:**hash-on-Sui = "凭什么证明它",Walrus = "谁来供应字节"**。

## 4. 两个对抗性打击(进一步缩小连"锦上添花"都站不住)
1. **Walrus 没有"一次付费永久存"**:每次购买最多 ~53 epoch(~2 年)→ 多年审计线**严格需要续期 keeper**,部分侵蚀"无托管"卖点。
2. **含金额/地址/PII 必须 Seal 加密** → Walrus 退化成"和'各方自留签名副本 + hash-on-Sui'只比可用性",且**审计读不了密文** → 把"第三方可验证"这个初衷自我击穿。

## 5. 存储层设计(若将来真要引入,照此)
- **不放在 Keeper/Biller/Schedule store 接缝后**(那是热路径)。新增一个**窄的 write-once `ArtifactStore { put(bytes,{kind,key})→{blobId,sha256,epochsPaid}; get(blobId)→bytes }`**,Walrus 只是它的一个实现(与现有 memory/file/sql 同模式,调用方不变)。
- **锚定惯用法**:权威副本 + 所有索引/关系留 DB;只把**不可变渲染件**镜像到 Walrus;在现有 `invoices` 表加 `blob_id / blob_sha256 / blob_epoch_expiry` 列;查询路径全走 SQL,只有下载路径解引用 blobId。
- **批处理**:票据 ~1–2KB → 用 **Quilt** 批(~420× 便宜),consent 用 SDK 分步 flow 让**持有者钱包**签 register+certify(持有者拥有 blob)。
- **隐私门(强制)**:含金额/地址/PII 的先 **Seal 加密**再上传。
- **热路径防火墙 + 生命周期**:Walrus 写是 **finalize/settle 之后的异步旁路**,绝不进扣款循环;加**续期 job**(到期前 extend),DB 里的 blobId/hash 才是耐久记录、blob 可从 DB 权威副本重传。

## 6. 诚实必要性(照 §0.5 原则)
- **必需:无。** 没有任何现有 iSub 工件是 Walrus 能去掉、而"DB+链上哈希+用户自持签名件"去不掉缺口的。
- **锦上添花(去托管可用性,仅当中立方需在 iSub 离线时取确切字节):** consent(且偏弱)、发票/贷记单(最强)、AP2 VC。
- **作秀 + 技术不适配:** 整个热事务面(见 §2)。

## 7. 建议
1. **热事务面原样留 SQLite/Postgres**(已正确,别动);多机房的真正改动是 Postgres advisory lock,**不是 Walrus**。
2. **建发票时做 open-Q #9 的 hash-on-Sui 锚定**(便宜、在范围、把"链上证明"延伸到文档)。**先于** Walrus。
3. **Walrus 作显式可选 stretch**,限不可变票据,门控在"中立方去中心化取回"成为真实需求;真做就按 §5 的异步 ArtifactStore(Quilt + Seal + 锚 Sui + 续期),永不进扣款循环。
4. **Overflow Walrus 赛道**:一个薄"票据上 Walrus"demo(一张 finalized 发票镜像到 Quilt + blobId 锚 Sui)若有时间可作叙事加分,但**诚实标注为可用性/观感**,别和承重的链上 Mandate/caps 主线抢。

## 8. 开放问题
1. **那个"中立方必须在 iSub 离线 + 对手扣留时取确切字节"的场景是真实(产品/监管)需求,还是假想?** Walrus 全部"锦上添花"理由就压在这一条上;若无,答案坍缩成"hash-on-Sui + 各方留副本",Walrus 纯作秀。
2. **Seal 生产就绪 + 密钥托管 UX**:谁持解密钥、争议时如何放给争议方——会不会把 Walrus 想去掉的托管问题又引回来。
3. **Quilt 单文件删除 + GDPR 擦除权**:Quilt 是一个 blob,单文件能否删、删后字节是否真不可恢复——批 PII 前必须搞清。
4. 发票编号归属(open-Q #3,DB 事,别误推给 Walrus);退款→周期映射(open-Q #5,关系数据 DB 拥有,只渲染件是 Walrus 候选)。
5. Walrus 精确写/读延迟(秒级)未从一手源证实(写 ≈ 2200 节点请求 + 一笔 Sui register/certify);热路径不适配的结论不依赖此值,但要精确归档 SLA 需跑基准。
6. 报价前确认 live `walrus info`(FROST/编码单位、写押金倍率、押金是 SUI 进存储基金、删除退还)及 Quilt 是否已 GA 主网。
