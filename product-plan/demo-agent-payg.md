# iSub 演示台本 — Agent PAYG(AI 代理按次付费)

*最后验证:2026-06-22,testnet 真链跑通(x402-testnet:smoke,4 ✓,真实 digest)。*

## 一句话定位(开场就说)
> "iSub 是 Sui 上面向 **AI 代理经济**的支付轨。你的 agent 能**自己按次付费**调用付费 API——每一笔都在你**链上签过的额度**内拉取,x402/AP2 对齐,非托管、可随时撤销。卡做不到这个,iSub 可以。"

核心反差:**额度是链上强制的,不是靠信任 agent**。agent 想超支,链直接拒。

---

## 演示前准备(一次性,约 1 分钟)

```bash
# 1) 网关在跑(/app 与用量图需要它);若已在 :4100 跑着可跳过
cd sdk && PORT=4100 ISUB_NETWORK=testnet npm run gateway:serve   # 另开一个终端

# 2) 一次性置备:发布 PAYG 计划 + 充值账户 + 铸 Mandate + 生成 agent 私钥 + 用户签 AgentCert
cd sdk && npm run x402-testnet:setup
#   → 打印 mandate id + suiscan;预算 0.05 SUI、账户充 0.08 SUI
#   → 写入 scripts/.x402-testnet.json(gitignored,含 agent 私钥)
```

置备出来的"付费 API"价目(x402 卖方):

| API | 单价 |
|---|---|
| `/web_search`(Web Search MCP) | 0.001 SUI / 次 |
| `/code_interpreter`(Code Interpreter MCP) | 0.003 SUI / 次 |
| `/vision`(Vision MCP) | 0.005 SUI / 次 |

预算上限 **0.05 SUI**(≈ 50 次 web_search)——故意设小,方便现场把"封顶"演出来。

**前置**:本机有 `claude` CLI 且已登录(你在用 Claude Code,通常已具备)。

---

## 主线剧情(3 幕)

> 幕1 发现 → 幕2 代理自己付费(链上结算,money shot)→ 幕3 链上封顶(代理无法超支)

### 启动(headline:真·Claude 当 agent)
```bash
cd sdk && npm run isub:claude:testnet
```
这会打开 **Claude CLI**,把 iSub 的 x402 agent 作为 MCP server 挂上,暴露三个工具:
`list_paid_apis` · `pay` · `budget_status`。下面**直接对 Claude 说人话**即可。

---

### 幕 1 — 发现付费 API
**你打字:**
> What paid APIs can I use, and what do they cost?

**会发生:** Claude 调 `list_paid_apis` → 列出 web_search / code_interpreter / vision 及单价。
**你说:** "注意——这些是 x402 paywall 后的 API,agent 要用就得付费。"

### 幕 2 — 代理自己付费(★ money shot)
**你打字:**
> Pay for the web search API and show me the on-chain receipt.

**会发生:** Claude 调 `pay` → 完整 x402 回合:
`GET → 402 Payment Required → 用 mandate 链上 charge_metered 结算 → 携凭证重试 → 200`,
返回 `{ paid, charged, digest, explorer, spent/budget }`。

**你要指着屏幕说的三句:**
1. "**agent 没碰我的钱包私钥**——它用的是我当初签的 mandate 授权(PoP),链上拉取。"
2. 点开返回的 **suiscan 链接** → "这是**真链上的一笔 `charge_metered`**,不是模拟。"(对照刚才验证的那笔:`NxNMEfc2W9A…`)
3. "钱从**我自己的非托管账户**扣给商家,单笔被价格钉死、总额被预算钉死。"

**你打字:**
> What have I spent so far?

→ Claude 调 `budget_status` → `spent 0.001 / budget 0.05 SUI`。

### 幕 3 — 链上封顶(★ 杀招)
**你打字:**
> Spend the rest of the budget — call the vision API 12 times.

**会发生:** 连续付费到 spent 逼近 0.05;最后一笔会被**链上**以 `EOverTotalBudget` 拒掉,
Claude 如实报告"被拒、已达上限"。

**你说:**
> "这才是关键:**上限是链强制的,不是靠信任 agent**。就算 agent 失控/被攻破,它也**无法**超过我签的 0.05 SUI。这是卡和 API key 给不了的安全边界。"

**收尾(可选)**:
> Revoke / cancel my mandate.
→ "随时可撤,资金一直在我自己账户里。非托管。"

---

## 必说的卖点(命中即可)
- **x402-native**:`pay` 工具讲的就是 x402(agent 支付标准);iSub 的 `mandate` scheme = 有上限的**链上拉取**,不是盲转账 → **AP2 对齐**。
- **非托管**:钱在用户自己的 `Account` 对象里,商家只能在签过的额度内拉,用户随时提走/撤销。
- **链上强制额度**:单笔=price 钉死、总额=budget 钉死、速率有 rate cap;超了链直接 abort。
- **面向 agent 经济**:agent 用自然语言就能自主付费调 API,无人值守、可审计(每笔有 digest)。

---

## 兜底(非交互,已验证)
如果现场 `claude` CLI 抽风,用这条**一行证明**同一条链上结算路径(无需 Claude):
```bash
cd sdk && npm run x402-testnet:smoke
```
输出会打印:`402 → charge_metered → 200`、真实 digest、`spent/budget`、suiscan 链接,4 ✓。
**这跑通 = 上面的 Claude 演示在真链上也会真结算。**

---

## 可选:把账接到 /app(看板视角)
当前 x402 agent 的结算默认**不写网关索引**,所以 /app 用量图看不到这条 agent mandate 的明细
(这是设计取舍:agent 路径独立于看板)。若想在 `/app` 也展示这条 mandate 的用量曲线,我可以像
给 keeper 加的 `recordCharge` 镜像那样,给 x402 settle 路径补一个网关镜像(约 10 行)——需要就说。

> 对照:**FIXED 订阅(Cortex token 套餐)** 那条线,keeper 会把每笔 charge 镜像进网关,
> `/app` 的 Usage 图每 5s 自动刷新能看到柱子增长——那是"订阅"视角的看板演示。
> 本台本是"**agent 按次付费**"视角,主舞台在终端(Claude 自主付费 + suiscan 真链凭证)。
