# Claude CLI Demo — iSub × x402 (testnet, real on-chain settlement)

**目标(评委记住的一句):** 用自然语言让 Claude 去访问付费 API,它自动撞付费墙、用**链上封顶、可撤销的 mandate** 付清、拿到数据——**每一笔都是真 testnet `charge_metered`,带可在 suiscan 点开验证的 digest;模型不持密钥,agent 只签授权证明,keeper 拉款。**

---

## 1. 开演前(一次性,~2 分钟)
```bash
claude --version                                  # Claude CLI 在 PATH
cd ~/Desktop/iSub/sdk && npm install
npm run x402-testnet:setup                        # 链上建 plan+account+mandate+cert,写 gitignored 配置
npm run x402-testnet:smoke                         # 真链验证(1 笔真 charge_metered + 4 断言绿)= 保险
```
`x402-testnet:smoke` 实测输出(示例,真链):
```
pay /weather → 402 → on-chain settled → 200
returned a REAL on-chain digest
digest:   5wK4Goy1GhhwP9cCTUT5QBEVk9WTiiMgshRDCs2zNUEa
explorer: https://suiscan.xyz/testnet/tx/5wK4Goy1GhhwP9cCTUT5QBEVk9WTiiMgshRDCs2zNUEa
on-chain spent_total increased
```
终端字号调大、清屏。

> **`x402-testnet:setup` 的订阅者是项目 actor**(`subscriber` actor),不是你的浏览器钱包。它扣款会进 gateway 库、能在"Track a mandate"里看,但**不会出现在你自己钱包的面板聚合**(面板按你的钱包账户聚合)。要让花销显示在**你自己的面板**上,走下面的 §1b。

## 1b. 让花销显示在你自己的面板上(浏览器钱包当订阅者)
这条路把 mandate 的 `subscriber` 设成**你连接的浏览器钱包**,所以 agent 付的每一笔都落在你自己的账户 → **你的面板卡片 spent 上涨、图表出柱**。

```bash
cd ~/Desktop/iSub/sdk && npm run x402-plan:setup     # 商家+keeper actor 发一个 PAYG plan,打印 planId
```
然后在浏览器面板(`cd ~/Desktop/iSub/web && npm run dev`,用**你的钱包**连接):
1. **Deposit** 一点余额到你的账户(keeper 要能从中扣款)。
2. **"Subscribe to a plan"** → 粘 `planId` → **Review terms** → 设预算 → **Subscribe**(你的钱包签名,mandate.subscriber = 你)。
3. 新出的 **PAYG 卡片** → **"Export x402 agent config"** → 钱包签 agent 绑定证书 → 复制 JSON → 存到 `sdk/scripts/.x402-testnet.json`。
4. `cd ~/Desktop/iSub/sdk && npm run isub:claude:testnet` → Claude 付款 → **切回面板,你的卡片 spent 上涨 + 图表出柱**。

> 原理:浏览器生成 agent 密钥,用你的钱包(=subscriber)签 `bindMessage` 绑定证书;CLI 用该 agent 私钥签每次调用的 PoP,keeper(plan 里指定的 keeper actor)拉款。agent 不持你的钱包密钥,只持自己的临时 agent 密钥。导出的 JSON 含 agent 私钥,已 gitignore,别提交。

## 2. 启动(一条命令)
```bash
npm run isub:claude:testnet
```
启动 Claude CLI,把 iSub MCP 接上(工具 `list_paid_apis` / `pay` / `budget_status`,已 `--allowedTools` 预授权),进程内自带真链 x402 seller(`/weather`=0.001、`/premium-quote`=0.005 SUI),后端是真 `IsubClient` + keeper 签名 + SQL biller(agentAuth=enforce)。

## 2b. 三终端联动(Claude CLI 付款 ↔ 网页面板实时联动)— 升级版,最有冲击力
x402 testnet biller 写进的是 gateway/面板读的**同一个** `isub-index.testnet.db`(并在启动时 `ingestMandate`)。所以每次 Claude 付款 → 扣款 journal 落进面板库 → **网页图表实时出柱**。三个终端:

```bash
# T1 — 读 API,起在 web 指向的 :4100,读同一个 index 库(只读,不结算)
cd ~/Desktop/iSub/sdk && ISUB_NETWORK=testnet PORT=4100 npm run gateway:serve

# T2 — Claude CLI 真链付款(每笔写进同一个库)
cd ~/Desktop/iSub/sdk && npm run isub:claude:testnet

# 浏览器 — 订阅者面板(testnet)
cd ~/Desktop/iSub/web && npm run dev
```
面板里:**"Track a mandate id"** 粘当前 mandate(从 config 读:`cat sdk/scripts/.x402-testnet.json | grep mandateId`)→ 点该订阅的 **"Usage"**。

演示动作:在 T2 让 Claude 付一笔("帮我查天气")→ 切到浏览器刷新 → **新柱出现 + 卡片 spent 上涨**。再付一笔 premium → 又一根柱。**左边 Claude 自然语言付款,右边面板实时长出计费柱 + suiscan 可验**。

**两个 caveat(诚实)**:① 只有"接好库之后"的付款会进面板图表;`x402-testnet:setup`/早期跑出来的历史扣款若落在旧的 `.x402-testnet.db`,不回填(卡片仍按**链上**显示全额)。② 卡片 spent/budget 永远读链上;图表柱子读 index 库——所以图表只反映写进该库的那些笔。

> **验证过**:一笔真链 `charge_metered`(digest `Dpi5Wqt…`)后,`isub-index.testnet.db` 里该 mandate 有 `charges`(含 charged + 真 digest)、`usage_records`、`idx_mandates` 各就位 → 面板 `/usage`、`/charges` 即返回。

## 3. 演示脚本(照着对 Claude 说)
| 你说(自然语言) | Claude 做 | 观众看到 / 你点出的 beat |
|---|---|---|
| **"有哪些付费 API 我能用?"** | `list_paid_apis` | 列出 /weather、/premium-quote + 价格 → "Claude 发现了付费服务" |
| **"帮我查一下天气"** | `pay(/weather)` | 撞 402 → PoP 付 → **真链 `charge_metered`** → Claude 回:东京天气 + **"已结算,digest `5wK4…`"** → **"它撞付费墙、自动在链上封顶内付清、拿到数据;模型不签名、不碰密钥"** |
| **"我花了多少?"** | `budget_status` | 读**链上** spent_total(真在涨)/ 0.05 SUI |
| **"再来个 NVDA 高级报价"** | `pay(/premium-quote)` | 又一笔真链 digest,spent 累加 → **按量计费,每笔独立封顶、各自有 digest** |

## 4. 杀手 beat:当场上链验证(必演)
Claude 的 `pay` 回复里直接带 **suiscan tx 链接**。**点开它**,给评委看链上 `Charged` 事件(amount / spent_total / seq / by=keeper):
> "这不是 mock——是真的 testnet 交易。任何人都能独立核验:这笔扣款发生过、在签名的上限内、收款方是这个 merchant。"

也可以打开 mandate 对象页(`x402-testnet:setup` 打印的 suiscan 链接)看 `spent_total` 随每次 pay 增长。

## 5. 安全 beat(差异化)
另开终端:
```bash
curl http://localhost:4021/weather                # → 402 Payment Required(无 X-PAYMENT)
```
点出:**"公开的 mandate id 本身一文不值——必须有 agent 私钥签的 PoP、且在链上封顶内。不是 bearer token。"**

## 6. 收尾(thesis,15 秒)
> "每一笔都是 **keeper 在链上封顶、可撤销的 mandate 内拉款**——**服务方拉款,不是 agent push**;agent 只出示授权、不自己付钱、不持密钥。这就是给 agent 经济的**循环 + 计量计费**:Sui 原生、x402 兼容、每笔链上可审。"

## 7. 穿插话术点
- **非托管**:钱在用户自己的 Account,封顶每笔链上强制,随时可撤销/取回。
- **agent 不签转账、不持密钥、不付 gas**——只签链下 PoP;keeper 拉款并付 gas。
- **x402 兼容(骑标准)但 pull 结算(我们的模型)**——不是 push 钱包(对比 TentaclePay/exact)。
- **per-route enforce**:这条 agent 路由强制 PoP;同一 service 上的"商家自计量"路由可设 off——human PAYG 不受影响。

## 8. 兜底 / 风险
- **`claude` 不在 PATH** → 启动器打印 MCP 配置;或 `npm run x402-testnet:smoke` 把同一真链流程演成非交互版(带 digest)。
- **预算耗尽 / 想重置** → 重跑 `npm run x402-testnet:setup`(新 mandate、清零)。
- **网络抖动 / gRPC 慢** → 重试该句;真链有秒级延迟,先用 `x402-testnet:smoke` 预热。
- **要彻底离线兜底** → `npm run isub:claude`(mock 链,无需测试币;digest 是 `mock-*`,流程一致)。
- **端口占用** → `ISUB_X402_PORT=4031 npm run isub:claude:testnet`。

## 9. 诚实说明
- **testnet 计价用 SUI**(`0x2::sui::SUI`;USDsui 仅主网)——真链结算、真 digest,只是币种是 SUI。
- **keeper 付 gas**(setup 已给 keeper 充值);agent 不动钱。
- not_before 时钟偏移已规避(setup 等待 + 人操作间隔)。
- 配置 `scripts/.x402-testnet.json` 含 **agent 私钥,已 gitignore**,绝不提交。

---
**一句话给评委:** "我让 Claude 用自然语言去买数据,它在 Sui 上的一个**封顶、可撤销的 mandate** 内自动付清——这是真交易,点这个 suiscan 链接就能验。模型从不碰密钥,服务方拉款而非 agent 自付。这就是 agent 经济的计费轨。"
