# iSub — 上下文交接（HANDOFF）

最后更新：2026-06-08 ｜ 给新 session 用：读这份 + `README.md` + `product-plan/` + `sdk/README.md` 即可接上。

---

## 一句话

**iSub = Sui 原生的非托管周期/计量收款原语（订阅 + PAYG），无预储值、随时取消。** 参加 Sui Overflow 2026（截止 ~6/21，延至 ~6/23）。

## 怎么走到这里（极简）

从 DeepBook/Predict 选题探索开始（Greeks Engine、Composer）→ 约 10 个 DeepBook 方向全部核实失败（被占/做不动/不获奖）→ 转向 iSub（订阅支付），唯一查实"空白+可行"的方向。完整选题原则与否决记录：`../PredictComposer/topic-selection-principles.md`。

## 模型（已锁定）：Account + Mandate

用户硬约束：**一定不预储值 + 随时取消**。据此设计：
- **`Account<T>`**：用户自己的、可复用、随时全额取回的共享余额对象（owner-only withdraw）。
- **`Plan<T>`**：商家套餐（Fixed | PAYG）。
- **`Mandate<T>`**：有上限、可撤销的拉取授权——**不持有资金**；`authorize` 不搬钱 = 无预储值。
- **`charge`** 从 Account 在 Mandate 限额内拉款。= **Stripe"存档卡"的 Sui 等价物**（卡=Account，授权=Mandate）。
- 三种计费：Fixed / PAYG / Milestone(roadmap)。一个 Account 可被多个 Mandate 共用（充一次管所有订阅）。

## 当前状态：Phase 0 + Phase 1 完成 ✅（SDK 已迁移 gRPC，全链路 testnet 验证）

- **合约**：`contracts/sources/subscription.move` — `sui move build` ✅（Sui CLI 1.71.1，框架自动注入）。
- **自审**：3 个发现 F-01（单笔 PTB 累积抽干）/ F-02（输入校验）/ F-03（暂停语义）已修复，见 `product-plan/self-audit.md`（judge-facing 英文报告）。
- **测试**：`contracts/tests/subscription_tests.move` — `sui move test` → **33/33 全绿**，无新发现。负向测试用 `expected_failure(location = isub::subscription)` 锚定。合约加了 18 个 `#[test_only]` getter（生产零影响）。
- **所有文档已同步到 Account+Mandate。**

### Phase 1 完成 ✅（见 `sdk/`，全在 localnet 真网络验证）

- **TS SDK**（`sdk/src/`，`@mysten/sui` v2 / Node 22 / npm）：`IsubClient`（open_account/deposit/withdraw/create_plan/authorize/charge/revoke/pause/resume + 读 Account/Plan/Mandate + getActiveMandates）、`tx` 纯 PTB builder（可组合）、`IsubSigner`/`keypairSigner`（**login() 接缝**，统一 keypair/钱包/zkLogin）、`IsubKeeper`、`constants`/`types` 镜像 Move。
- **e2e 冒烟**（`sdk/scripts/smoke.ts`）：localnet 全生命周期 open→deposit→authorize→charge×2→revoke→withdraw，**17 断言全绿**；含负向（pre-interval→`EIntervalNotElapsed#6`、post-revoke→`ENotActive#4`）+ 不变量（authorize 不搬钱 / 精确扣 / 商家收款 / 非托管取回）。
- **Keeper**（`sdk/src/keeper.ts` + `scripts/keeper-smoke.ts`）：Fixed 自动扣、幂等（**零废 abort tx**）、按 interval 间隔、到 budget 即停，**7 断言全绿**。
- **发布**（`sdk/scripts/publish.ts`）：程序化发布到 localnet（`sui move build --dump-bytecode-as-base64` → `tx.publish`），写 `isub.localnet.json`。
- **合约未改动，33/33 Move 测试仍绿**。一键复现见 `sdk/README.md`。

### Phase 1.5：SDK 迁移 gRPC + testnet 全链路验证 ✅（2026-06-09）

- **JSON-RPC → gRPC**：SDK 全面改用 `SuiGrpcClient`（`@mysten/sui/grpc`，Sui 主推、JSON-RPC 在弃用路上），代码里**不再引用 `SuiJsonRpcClient`**。新增 `src/signer.ts` 归一化层 `IsubExecResult`（digest/success/**结构化 abortCode**/events/createdIds）；`src/client.ts` 读走 `getObject({json})`、抛 `IsubAbortError`（带真实 Move abort code，告别正则）；`src/errors.ts` 新增。`tx.ts`/`constants.ts`/`types.ts` **一行未改**（纯 PTB builder，transport 无关 —— 当初设计红利）。
- **keeper 改吃显式 mandate-id 监听集**：gRPC **无 `queryEvents`**，`getActiveMandates()` 作废，改为商家后端在 `authorize` 时把 id 登记给 `IsubKeeper` watch（更诚实的信任模型，非扫事件）。
- **testnet 部署 + e2e 全绿**：package `0xbebc919c9b13b1baa312a6fa6ae72a6e5862ce1daf5690d27eabb57e23e16664`（`sdk/isub.testnet.json`）。`smoke:testnet` **17/17**、`keeper-smoke:testnet` **7/7**，含两个负向 abort（#6/#4 结构化解析）。脚本网络自适应（`ISUB_NETWORK`），持久 actor keypair 在 `sdk/.secrets/testnet/`（gitignore），从用户钱包 `pay-sui` 充值。
- **修了 1 个测试时序 bug（非合约）**：keeper-smoke Phase 2 需先等满一个 interval 让 mandate 重新到期，才观察得到 "budget exhausted" 跳过（localnet 快网侥幸过、testnet 暴露）。
- 日志 `sdk/logs/*.testnet.log`。

### Phase 1.6：Payment-Infra 三缺口修复 ✅（2026-06-10/11，⚠️ 合约改动待对抗性审查）

按 infra 标准自审（见对话/`architecture.md`）修了三块：

1. **资金正确性（合约改了！）** — ① N-1 计量幂等：PAYG 拆出 `charge_metered(amount, seq)`，`seq` 必须 == mandate 新增字段 `charge_seq`（每笔成功 +1）→ 账单重试不可能双扣；旧 `charge` 仅限 Fixed（PAYG 调它 → `EBadMode`）。② N-2 退款：`refund(coin)` merchant-only、退回 Account、撤销后可退、**不回冲预算**（毛额单调），`refunded_total` 单独记账。新错误码 20/21/22；`Charged` 事件加 `seq`；新 `Refunded` 事件；结算尾抽成私有 `settle()`（守恒唯一出口）。**测试 33 → 45 全绿**（`sui move test`）。
2. **可靠性/计费状态机（纯 SDK）** — keeper 重写：链下生命周期 `active→past_due→recovered|lapsed`（+paused/expired/revoked 镜像），事件回调=商家 webhook 接缝，dunning `{graceMs}`，**余额不足不动链上 mandate**（挽回零签名，决策见 `architecture.md §2.3`）；watch 集+journal 持久化（`src/store.ts`/`store-file.ts`，重启恢复）+ 单实例锁；失败二分 + 退避；`dueMarginMs`（默认 750ms）防墙钟/链钟偏差烧 gas，`#6` abort 归类良性竞速。
3. **对账（Phase C）** — `reconcile()`（`src/reconcile.ts` + `scripts/reconcile.ts` CLI）：journal vs 链上 `charge_seq/spent/refunded` 漂移报告；keeper 丢响应/第三方 permissionless 触发由 seq 漂移检测（`charge.observed`）捕获归账。

**验证（双网全绿）**：Move 45/45；localnet+testnet 各四套 —— smoke 17、keeper-smoke 7、**payg-smoke 16（新）**、**dunning-smoke 12（新）**。日志 `sdk/logs/`。

### Phase 1.7：高危复审 H-1 / H-2 修复 ✅（2026-06-11，⚠️ 合约又改，待对抗性审查）

对抗性复审发现两个高危，已修：

- **H-1（合约改了！）条款绑定 + 用户侧限额** — `authorize` 拆成 `authorize_fixed`/`authorize_metered`，签名携带**预期条款**并断言 == Plan（`ETermsMismatch`，防 UI 谎报/掉包 plan）；新增用户自设 `max_per_charge`（PAYG；Fixed 恒 = price，`EOverMaxPerCharge`）+ 可选 `first_charge_after_ms`（首扣窗，复用 `#6`）；新错误码 23/24/25；Mandate +`max_per_charge` +`not_before_ms`。**诚实边界**：这些只**限速/防谎报**，不降低 `total_budget` 天花板；商家自设的 `rate_cap` 对抗商家本人无保护——真正"停"靠 `revoke`/`withdraw`。条款绑定依赖**可信展示路径**（SDK 强制显式传 expected，不从同一 Plan 回填；`quoteFromPlan` 仅展示）。
- **H-2（设计取舍，接受 + 缓解，纯 SDK/文档）** — mandate = 可撤销意向、非有担保应收；charge 可合法失败。缓解:past_due 状态机（已建）+ `refund`（已建）+ 新 `accountExposure()`（多 Mandate 总敞口 vs 余额，authorize 前展示，关闭 open question #6）+ 商家集成文档（`sdk/README` "Merchant integration notes"）。
- **商家作恶惩罚分层** 写进 `architecture.md §7.8`（①保证金slash ②延迟结算 ④身份；③声誉延后；中立性红线=合约无没收键）。
- **更正错误叙事**：`architecture.md §1.5/§7.4/§7.2/§7.3` 把"rate_cap=用户安全阀"改为诚实版（rate_cap 商家自设；用户护栏 = max_per_charge + total_budget + expiry + 退出权）。

**验证（双网全绿）**：Move **55/55**（+10 H-1 测试 h1_1..h1_10）；localnet+testnet 四套照旧绿（17/7/16/12）。**安全自审 `self-audit.md` 已补 F-04（幂等）/F-05（H-1）/H-2，更新 55 测试 + testnet 验证**。
**testnet 新包**（H-1 合约变更重发布）：`0xb0e4daee42a7db6b09857166112da4dd0beb7f4ab48207e2ed14ac825bdee932`（旧 `0xbe2f…6639f` 作废）。
**留给下一轮（完备度）**：`trial_ms` 试用期、对象 `version` 字段（可升级性，主网前最优先）、N-4 密钥轮换、UpgradeCap 多签、`keeper_fee_bps`、`sui::display`（H-1 可信展示链的最后一环）、webhook 服务化、USDC `pickCoins`。

### Phase 1.8：中危 M-2 修复 + M-1/M-3 入追踪 ✅（2026-06-11，⚠️ 合约又改，待对抗性审查）

对抗性复审又抓 3 个中危，逐条核实**全部仍存在**，处置：
- **M-2 修复（合约改了！）** `deactivate_plan<T>(plan)` merchant-only 单向下线；错误码 26 `ENotPlanMerchant`、`PlanDeactivated` 事件；**消除 `active` 死代码**（`EPlanInactive #11` 现在可达）。只挡新 authorize，存量 mandate 快照不受影响。SDK 加 `tx.deactivatePlan`/`client.deactivatePlan`、ERROR_CODES 补全 23-26。**Move 55 → 58 全绿**（+m2_1..m2_3）。
- **M-1 追踪不修（Low-Med）** PAYG 滚动窗口边界 ~2×rate_cap 突发。被 `total_budget`+`max_per_charge` 吸收；rate_cap 商家自设、对抗商家本人无保护（F-05）。**修法**：token bucket 连续补充（**非** tumbling，tumbling 同样有边界突发），O(1) 状态。待定 rate_cap 产品语义后做。
- **M-3 追踪不修（Low）** `authorized_keeper` 从 plan 拷入、用户不显式批准。但 keeper 仅能触发 PAYG charge、与 merchant 同 caps = 零能力增量。**修法**：前端展示 keeper +（可选）`expected_keeper` 绑定（同 H-1 条款绑定）。
- self-audit 已补 M-1/M-2/M-3（M-2 resolved；M-1/M-3 tracked-open）。**测试 58/58**；新增 `deactivate_plan` 为加性变更、不影响四套 smoke。
- **testnet 回归**：含 `deactivate_plan` 的新包重发布 + 四套全绿（17/7/16/12）。**新包 `0x59f67dea9d7b212634369b501c3ecd700ac298d4e312a7e9b6267082382e1dd2`**。

### Phase 1.9：生产化 —— 版本门 + 对象回收 ✅（2026-06-13，⚠️ 合约又改，待对抗性审查）

按"达生产级合约需补哪些"自审，补上两块"主网前最优先"（deactivate/trial 已在 1.7/1.8 完成）：

- **版本门（合约改了！⚠️ 改结构体）** `Account/Plan/Mandate` 各加 `version:u64` + `VERSION` 常量 + 每个变更入口 `check_*_version`（`EWrongVersion#27`）+ permissionless 单向 `migrate_account/plan/mandate`。**Sui 升级不能改结构体字段布局 → 主网上线即冻结**，这是加 version 字段的唯一窗口。migrate 无 admin（升级权在 UpgradeCap，已是信任点），保"无中心 admin"承诺。VERSION 维持 1，主网前字段仍可自由演进。
- **对象回收（合约）** `close_account`（owner，余额须为 0，`EAccountNotEmpty#28`）/ `close_mandate`（subscriber，须 Revoked，`EMandateNotRevoked#29`）/ `close_plan`（merchant）→ 删共享对象退存储押金，治理状态膨胀；`AccountClosed/MandateClosed/PlanClosed` 事件。
- **SDK 同步**：`tx` + `client` 加 `closeAccount/closeMandate/closePlan`，ERROR_CODES 补到 29；**smoke 现演示 close 闭环**（revoke → withdraw_all → close_mandate + close_account → 断言对象已删）。

**验证（双网全绿）**：Move **68/68**（+10：版本门 V-1/V-2、回收 C-1..C-8）；localnet+testnet 各四套 —— **smoke 19**（含 close）、keeper-smoke 7、payg-smoke 16、dunning-smoke 12。
**testnet 新包**（结构体变更重发布）：`0x573710f6a496fe01be0bcc8dd1d13f564465e75e2a6566856715772d326a2616`（旧 `0x59f67dea…1dd2` / `0xb0e4…e932` 作废）。
**仍留下一轮**：N-4 密钥轮换、`keeper_fee_bps`、`sui::display`（H-1 可信展示链）、Prover/审计、UpgradeCap 多签、webhook 服务化、USDC `pickCoins`。

### Phase 2.0：托管后端地基 ✅（2026-06-16，纯 SDK/链下，无合约改动）

把"能跑的系统"往"可托管产品 / agent PAYG"推，全部 headless 可测：
- **多租户 SQL 持久化**（`src/db.ts` + `src/sql-store.ts`，`node:sqlite` 零依赖、平迁 Postgres）：merchants/subscriptions/charges/usage_records/webhook_deliveries/idempotency_keys/locks 七表，按 `merchant_id` 硬隔离；`sqlStore`/`sqlBillerStore` 实现 `KeeperStore`/`BillerStore`（与 mem/file 同契约、插入式替换）。`store-smoke` **24 断言**（三实现等价 + 租户隔离 + 锁 + api-key 鉴权）。
- **PAYG biller**（`src/biller.ts`）：计量→累计→单飞结算（clamp 到 caps、carry、幂等、跨实例锁）。**两轮对抗审查（~50 agent）：第一轮 7 确认 bug（3 critical 双花）全修；第二轮 0 确认**。`biller-smoke` **31 断言**（含 lost-ack/崩溃恢复 = `recoverOrphan` 对账重建、绝不重扣）。⚠️ **biller 至今只对 mock 链（FaithfulChain）跑过、未对真链验证** —— 打通时补。
- **签名 webhook**（`src/webhook.ts`，子路径 `@isubpay/sdk/webhook`）：HMAC + 重试 + 死信 + `verifyWebhook`。`webhook-smoke` **13 断言**。语言无关接入的命门。
- **浏览器 signer**（`src/wallet-signer.ts`）：钱包签 + gRPC client 执行、复用同一归一化；dapp-kit 结构化适配，SDK 零前端依赖。

### Phase 2.1：Agent PAYG 打通 ✅（2026-06-16，纯 SDK/链下 + testnet 验证；方案见 `product-plan/agent-payg-wiring-plan.md`）

**问题**：零件都真且各自验证过，但 **agent 与服务没接 / 没有跑着的服务 / biller 没对真链跑** → "订阅后服务自动按量扣"作为运行系统**不存在**。
**目标（= 验收）**：一条 testnet 端到端链路真跑 + 可回归：agent 订阅 → 带凭证调服务 N 次 → 服务计量 → biller **真链扣款** → 断言 用量对得上 / 不超 budget / 每笔只扣一次 / 撤销后停且扣不动。
**组内拍板（2026-06-16）**：
- **D1 凭证模型** —— agent 调服务时带 `mandateId` 当付款凭证；服务首用上链校验（收款人==本服务 / active / 未过期）即自动登记，无单独注册步骤（对齐 x402）。
- **D2 采信 biller 跟踪的生命周期**做拒服决策（不每次读链；链上扣款时再拦一道）。
- **D3 flush = 窗口 + 阈值双触发（取先到）＋ 服务按剩余预算 gate 交付**（够付下一单才服务）。**漏扣处置**：技术性漏扣不会发生（用量 carry 不丢失）；经济性漏扣（用量超授权天花板、链上收不回）靠 gate **事前**压到接近零 —— 不是事后追回（超授权链上本就拉不动）。接软风控（超额熔断）。
- **D4 可嵌入"服务运行时"**（`node:http` 零依赖，内含接**真** `IsubClient` 的 biller + SQL + 后台 `run()` flush 循环）；demo 跑一个实例，多租户托管（SQL 已就位）留作产品化。
- **D5 上 sponsored tx**（gasless charge，Sui-native 卖点）。⚠️ 引入 Enoki/gas-station 依赖 → **建议先打通裸循环、再 sponsor 那几笔 tx**，别让 gas-station 配置卡住打通。
- **D6 用量先服务自报**（受 mandate 封顶），attestation/收据后议（F-05 边界）。
- **MCP**：**打通测试不需要 MCP**（直调 agent 动词 + 服务 HTTP，确定性、可回归）；MCP 作可选 demo 层（agent 支付工具 / 服务暴露成 MCP tool），**打通后**为 demo 加。**已落地（2026-06-18）✅**：`src/mcp.ts`（`@isubpay/sdk/mcp`，低层 MCP `Server`，组合两面：钱包动词 `agentTools` + 按次计费 `query_*` 工具，凭证=mandateId 作工具入参）+ 确定性回归 `mcp-smoke` **12 断言**（真 MCP 协议走 `InMemoryTransport` + 真 `IsubService` 接 MockChain：发现/钱包/按次计费/预算 gate/403 凭证/协议错误）。真链 `mcp-e2e:testnet` 与 Claude Desktop `serveStdio` demo 留下一步。
**范围纪律（本轮不做）**：多租户 dashboard、用量 attestation、软风控、超出闭环所需的 REST 端点。
**工时**：服务运行时 + 端点 ~1 天；testnet 端到端测试 ~半天；sponsor ~+0.5–1 天（后置）。
**落地 + 验证（已完成裸循环，sponsor D5 仍后置）**：
- `src/service.ts`（`IsubService`，子路径 `@isubpay/sdk/service`）：D1 凭证首用上链校验+自动登记、D2 信 biller 事件做拒服、D3 按剩余预算 gate + 窗口/阈值 flush、内嵌 `IsubBiller`(接真 `IsubClient`) + 薄 `node:http` `listen()`。
- **`wiring-e2e` testnet 全链路 15 断言绿**：agent.subscribe(真 mandate) → 带凭证 `service.use` ×N → `service.flush` → **真 `charge_metered` 扣款**(账户精确扣、merchant 精确收、seq 递增) → 预算耗尽 gate 402 → 撤销后 `#4` 扣不动。**这同时把"biller 只对 mock 链跑过"的洞补上了 —— biller 现已对真链验证。**
- `service-smoke` 12 断言(凭证/gate/阈值/撤销停服,headless)。
- **顺带修一个真 bug**：被撤销的 mandate 原先被 biller 误判为 `rate_limited`（暗示"稍后重试"）→ 改为显式 `not_billable`（服务据此停服）。biller-smoke 31 仍绿、无回归。

### Round 5：PAYG/Fixed 跨层审计 + F-07 双扣修复 ✅（2026-06-19，纯 SDK/链下，无合约改动）

对"合约 + 计费管线（keeper/biller/reconcile）"做对抗性跨层审计（8-agent 工作流，16 确认；大多合约残留被**重定级为有界设计取舍**，非 bug）。**真缺陷只有一条、且在链下 biller**：

- **F-07 双扣（High，已修）**：`recoverOrphan` 原先靠"对当前未计费集前缀求和到 orphan 金额"重建已落账批次，但 `submit` 日志只存 `amount`+`seq`、**没存成员**。丢 ack 后若有记录乱序/新增跨批边界 → 标错记录已计费 → 真正落账的记录留作"未计费"被**再扣一次**（链上双扣）；或前缀凑不齐金额则 bail + 重扣整批（净 2×）。**修法**：`submit` 记录确切 `usageIds`（`JournalEntry.usageIds` + SQL `charges.usage_ids` 列/迁移），`recoverOrphan` 按成员精确标记、一次处理**所有** orphan、legacy 无成员转人工。改了 `store.ts`/`biller.ts`/`db.ts`/`sql-store.ts`。`biller-smoke` 加 scenario I（乱序不双扣，spent==9 非 14）→ **31→35 断言绿**，且验证过"去掉 usageIds 即在 scenario F 翻红"。⚠️ 注：Phase 2.0 两轮 ~50-agent 审计修过 3 个 double-spend，**漏了这条 reorder 路径** —— 不同审计角度抓不同 bug。
- **追踪项**（链下 liveness/ops，无用户资金损失，见 `self-audit.md` Round 5）：FIXED 节奏漂移（产品决策）、keeper 忽略 `not_before`（试用烧 gas，**依赖长试用前先修**）、PAYG 无独立对账/dunning、service serviceable 单向锁死、默认非持久 store、输入 u64 溢出。
- **scheduler**（分阶段定价 / 预约升降级）可行性已评估：链下编排能做 ~80%，但**涨价必须订阅者签字**（非托管铁律）。**已定方案 → 见下「Scheduler」块**。

### Scheduler：架构 A 落地 / B roadmap 🚧（2026-06-19，`scheduler` 分支）

决策：**A（纯链下编排器，合约不动）现在做；B（链上 phase 向量预签，要改合约+重审）作 roadmap**。二者不互斥——A 的编排器就是 B 的地基。完整规格见 **`product-plan/scheduler-design.md`**。

- **铁律**：签名是天花板，商家只能拉更少、永不更多，除非新签名。→ 四类转换：试用/降级/PAYG改价**免签**；**涨价=consent 事件必须新签**（A 唯一做不到"静默涨价"，那要上 B）。
- **决策已拍板**：①降级=**静默退差额**（每期 charge 后 refund 差额，按 charge_seq 幂等）②升级=**`onConsentRequired` 回调**（签字前停旧价）③编排器**并列**只管 phase 边界 ④phase 时间=**绝对 ms**。详见 design §6。
- **step 0–4 已完成**（`scheduler` 分支）：
  - step 0：keeper `not_before` 修复（`keeper.ts`：`earliest = max(last+interval, not_before)`）。修前试用期每 tick 发一笔注定 `EIntervalNotElapsed` 的 charge（烧 gas+刷 journal）。回归 `unit.ts › keeper not_before`（neuter→3 红）。`self-audit` 对应追踪项已标 Resolved。
  - step 1–3：`sdk/src/scheduler.ts` —— `SchedulePhase`/`Schedule` 模型、`memoryScheduleStore`、`IsubScheduler`（`schedule`/`tick`/`applyConsent`/`cancel`）。四类执行器全实现。signer=**商家**（refund 仅 merchant）；revoke 旧 mandate 是订阅者动作（其 consent PTB 内）。已并入 core index。
  - step 4：`scripts/scheduler-smoke.ts` —— 离线假链回归：静默降级（基线/幂等/批量退差额）、升级 consent gate（停旧价→`applyConsent`→换 mandate）、PAYG reprice 事件、试用→付费。**consent gate neuter→4 红**（证明咬得住；注：链上 price 仍 UNCHANGED——合约才是 over-pull 真边界，gate 管的是状态建模+催签）。
  - step 1b：`sqlScheduleStore`（`sql-store.ts` + `db.ts` 新 `schedules` 表）—— 多租户（`merchant_id` 行隔离）、单实例锁（复用 `makeLock`）、phases 的 bigint 用 `{"$b":"…"}` 编码显式 round-trip（含嵌套 rateCard meter）。smoke 加 8 条 SQL 断言（重启 reload cursor/status/退款锚、bigint 往返、租户隔离、锁）。**scheduler-smoke 共 31 断言（23 mem + 8 SQL）全绿**。
  - step 5：`scripts/scheduler-e2e.ts`（`npm run scheduler-e2e:testnet`）—— **testnet 真链 22 断言通过**。一条完整订阅调整弧线：标准→忠诚(静默退差额，真 refund tx，period2 净=低价、refunded_total=delta、无新签)→Pro(`tick`→`consent.required`+链上 price UNCHANGED 不 over-pull→签新 mandate+revoke 旧→`applyConsent` 换 id→Pro 满额扣)。总付=标准+忠诚+Pro，`withdraw_all` 非托管退出归零。`scheduler.tick(nowMs)` 用逻辑时间驱动 phase 边界，只有链上 interval 闸需真等 1 个周期。
- **A 全部完成**（合约一行未改）。后续若要"产品化"：接 managed backend（gateway API + webhook 把 `consent.required` 推给前端）、dashboard 展示 phase 时间线。B（链上 phase 向量）仍是 roadmap，等"静默涨价"成真需求。

### 下一轮（Phase 2.2+，打通之后）

- **软风控**（P0，纯链下）：花费熔断（用量飙升→暂停+告警）、step-up 审批（大额要人/二签）、跨-mandate 全局限速、一键 panic revoke-all。见对话"agent PAYG 风控"。
- **MCP 现场 demo**：适配层 `src/mcp.ts` + 确定性回归 `mcp-smoke` 已就位（见上 Phase 2.0 MCP 块）；剩 `mcp-e2e:testnet`（真链验证）+ Claude Desktop `serveStdio` 入口脚本 → "agent 原生付费"录屏演示。
- **商家 dashboard**：读 SQL（订阅 / MRR / webhook 投递日志 / 重放测试事件）。
- **x402 互操作**：把 mandate 包成 x402 scheme/facilitator（对齐标准、补其所缺的循环/预算层）；判断"对接不依赖"见对话。
- **用量 attestation / 收据 + 争议窗口**：把 D6 从"封顶信任"升到"可验证"。
- 合约侧未决：N-4 密钥轮换、`keeper_fee_bps`、`sui::display`、Prover/审计、UpgradeCap 多签、USDC `pickCoins`。

## 文件地图

```
iSub/
├── HANDOFF.md                    ← 本文件
├── README.md                     总览 + 索引
├── contracts/
│   ├── Move.toml                 （无显式 Sui 依赖，框架自动注入）
│   ├── sources/subscription.move 合约（module isub::subscription）
│   └── tests/subscription_tests.move  33 tests 全绿
├── sdk/                          TS SDK + 脚本（gRPC；localnet + testnet）
│   ├── README.md                 跑通指南（localnet / testnet / publish / smoke / keeper）
│   ├── src/                      IsubClient · tx · signer/wallet-signer · keeper · biller · service · agent · mcp · store/store-file · db/sql-store · webhook · reconcile · exposure · errors · constants · types
│   ├── scripts/                  publish · smoke(19) · keeper-smoke(7) · payg-smoke(16) · dunning-smoke(12) · agent-smoke · store-smoke(24) · biller-smoke(35) · webhook-smoke(13) · service-smoke(12) · wiring-e2e(15,testnet) · keeper · reconcile · fund · grpc-probe
│   ├── isub.testnet.json         testnet 部署记录（package id；可入库 / explorer 可验）
│   ├── .keeper/                  keeper 运行时（watch 集/journal/锁；gitignore）
│   └── .secrets/                 持久 actor 私钥（gitignore，不入库）
└── product-plan/
    ├── concept.md                痛点/方案/订阅≠流支付/差异化/原则/赛道
    ├── architecture.md           §0命门 §1对象 §1.5模式 §3.5官方栈 §6数据流 §7安全模型
    ├── phase0-contract-design.md 决策/对象/函数×不变量/开放问题
    ├── test-plan.md              测试方案（33 tests，已全绿）
    ├── self-audit.md             安全自审报告（英文，judge-facing）
    ├── privacy.md                隐私模型（不可关联≠匿名；burner/zkLogin/隐形地址；不做混币）
    ├── scope-and-timeline.md     Tier 0–3 + 日历
    ├── roadmap.md                交付 roadmap + 产品 H1/H2/H3
    ├── phase2-demo-app.md        商家 demo app 规划（Phase 2）
    └── agent-payg-wiring-plan.md Agent PAYG 打通方案 + 组内拍板（D1–D6，本轮）
```

## 关键事实 / 上下文

- **赛事**：Sui Overflow 2026，$500K+。赛道：Agentic Web、**DeFi & Payments**(核心)、Infra & DevX + 专项(Walrus/DeepBook/**Payments & Wallets**…)。iSub 打 **DeFi & Payments + Payments & Wallets**。
- **Sponsor**：OZ / Walrus / OtterSec / Scallop / DeepBook。**OZ/OtterSec 非核心赛道、无明确要求——不为其过度工程**；OZ 有 Contracts for Sui（Access Management + DeFi Math）可实际 `use`；OtterSec 是安全公司，§7 安全严谨度=质量加分。
- **建在官方 Payment Kit 之上**：它只做一次性支付，iSub 补"周期/订阅"层（合"不造轮子"）。
- **keeper 维持中心化**（决策）：商家自跑 / iSub 托管。keeper 对资金零权力（charge 链上锁死）→ 只赌**活性**不赌**安全**；F-01 保证宕机不会追扣抽干用户、只延迟商家收入。permissionless charge 留作"去中心化就绪、无锁定"。补偿（sponsored gas / 抽成）见 `architecture.md §2`。
- **Sui-native 栈**：zkLogin（web2 登录）+ sponsored tx（免 gas）+ 协议级免 gas 稳定币 + USDsui（Bridge/Stripe，**仅 mainnet**）。
- **用户钱包**：`0x5c2b3348b8d952cac541e01755bcfa9f562cbb6fd098287c11658ae9724692fe`（已加入 Sui CLI keystore 并设 active；testnet 用它 `pay-sui` 给 actor 充值）。
- **testnet 部署**：package `0x573710f6a496fe01be0bcc8dd1d13f564465e75e2a6566856715772d326a2616`（`sdk/isub.testnet.json`，Phase 1.9 重发布；旧 `0x59f67dea…1dd2` / `0xb0e4…e932` 作废）；SDK 走 gRPC（`https://fullnode.testnet.sui.io:443`）。**testnet 程序化 faucet 已封** → actor 充值靠用户钱包 `pay-sui`（或 `fund.ts` 的自分发 funder）。
- **风险**：Sui testnet 近期 48h 宕机 3 次 → **demo 必备预录 fallback**。USDsui 仅 mainnet → testnet 开发用 mock/测试 USDC（generic `<T>`，换币只换类型参数）。

## 下一步

**Phase 2.1 打通已完成 ✅**（裸循环 testnet 全链路绿，见上方 Phase 2.1 块）。**立即下一步**：① 上 **sponsored tx（D5）** —— charge_metered 免 gas（Enoki/gas-station，Sui-native 卖点），并入 `wiring-e2e` 验收；② 然后进 Phase 2.2（软风控 / MCP demo 层 / dashboard）。

**之后**：见上方"下一轮（Phase 2.2+）"——软风控 / MCP 适配 / dashboard / x402 互操作 / 用量 attestation。

**并行轨道（商家 demo app，原 Phase 2 规划，见 `phase2-demo-app.md`）**：Vite + React + dApp Kit，浏览器 `walletSigner`（已建）实现 `IsubSigner`；zkLogin / checkout widget 属 Tier 2。
- demo 风险：testnet 不稳 → **预录 fallback + localnet 备份**（`sdk/` 已能一键 localnet 跑通）。

## 待拍板的开放问题（见 phase0-contract-design §E）

1. 首扣时点（当前：立即到期，Stripe 式）
2. ~~漏扣追补~~ 已决：作废（F-01）
3. Fixed 的 total_budget 默认值
4. Account/Mandate `close`（撤销后回收存储押金）
5. 是否补 `entry` 包装
6. 多 Mandate 共用一个 Account → 先到先扣，UI 需提示总敞口 vs 余额
- 登录基础设施（Enoki vs 自建）；mainnet vs testnet（testnet 主，收尾可选 mainnet 真 USDsui showcase）。

## 给新 session 的提示

- 合约改动要**对抗性审查**（用户一直在挑 bug，已抓出 3 个真问题）；任何改动后跑 `sui move test` 确认 33 个仍绿。
- 文档与代码已对齐；改模型要同步所有 product-plan 文档（上次同步是一次大工程）。
- 错误码是模块私有 const；测试在独立文件用 `location =` 锚定（不要改成 public const，Move 不允许）。
