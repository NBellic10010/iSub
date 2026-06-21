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

## 2. 启动(一条命令)
```bash
npm run isub:claude:testnet
```
启动 Claude CLI,把 iSub MCP 接上(工具 `list_paid_apis` / `pay` / `budget_status`,已 `--allowedTools` 预授权),进程内自带真链 x402 seller(`/weather`=0.001、`/premium-quote`=0.005 SUI),后端是真 `IsubClient` + keeper 签名 + SQL biller(agentAuth=enforce)。

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
