# iSub 接入 5 分钟上手(商家 / 服务方)

你提供一个按量计费的服务(API、推理、算力…)。iSub 替你**自动从客户的链上授权里按用量收款**,你**什么都不用跑**——没有 keeper、没有数据库、没有链客户端、不签任何扣款。

你只做两件事:
1. 在你的接口里调一次 `isub.use(...)` —— 计量这次用量 + 判断该不该服务。
2. 加一个 webhook 接收器 —— 收到账单生命周期事件(扣款成功 / 余额耗尽 / 失效)做相应处理。

> 完整可跑范例见 [`service.ts`](./service.ts)(~70 行,零业务依赖)。

---

## 0. 我们给你什么(开通时)
- `ISUB_BASE_URL` —— iSub 托管网关地址
- `ISUB_API_KEY` —— 你的 api-key
- `ISUB_WEBHOOK_SECRET` —— 验签密钥
- `ISUB_KEEPER_ADDRESS` —— iSub 的扣款 keeper 地址(建套餐时用)

## 1. 建一个套餐(一次性,你的钱包签 1 次)
决定你的收款地址和计费上限。PAYG(按量)套餐把 `keeper` 设成我们给你的 `ISUB_KEEPER_ADDRESS` —— 这授权 iSub 替你扣款,**但 iSub 碰不到钱**:每笔扣款受链上限额约束、且只打进你自己的收款地址。
> dashboard 点一下,或用 CLI/SDK。我们会给你 `planId`。

## 2. 在你的接口里计量 + 门控(核心,~5 行)
```ts
import { IsubServiceClient } from '@isub/sdk/client';
const isub = new IsubServiceClient({ baseUrl: ISUB_BASE_URL, apiKey: ISUB_API_KEY });

// 你的接口处理里:客户在 header 带上他的 mandate(支付凭证)
const r = await isub.use(mandateId, costInBaseUnits, requestId /* 幂等键 */);
if (r.status !== 200) return reject(r.status, r.reason); // 402=超预算/余额不足  403=凭证无效
// 200 = 已计费,放行,做你的活
```
- `costInBaseUnits` 是**你定的价**(按 token / 按秒 / 按调用,随你)。
- `requestId` 用**稳定的每请求 id**(同一请求重试不会重复计费 —— 幂等)。
- iSub 在后台按窗口聚合、在链上结算(不逐笔上链,省 gas);你不用管。

## 3. 收 webhook(~10 行)
```ts
import { verifyWebhook } from '@isub/sdk/client';
// 你的 /isub/webhook 处理:
if (!verifyWebhook({ secret: ISUB_WEBHOOK_SECRET, body: rawBody, signatureHeader: req.headers['isub-signature'] }))
  return reject(401);
switch (evt.type) {
  case 'charge.succeeded':  /* 记收入 */ break;
  case 'budget.exhausted':
  case 'mandate.lapsed':    /* 暂停该客户 */ break;
  case 'mandate.recovered': /* 客户充值了 → 恢复 */ break;
}
```

**就这些。** 没有 keeper、没有 DB、没有链、没有扣款签名。

---

## 你的客户(付费方 / agent)那边做什么
这是**你客户**的事,不是你的;放这里让你看到全貌。客户(或其 agent)对你的套餐授权**一次**,拿到一个 `mandateId`,之后每次调你的接口带上它:
```ts
// 客户侧(人类钱包 或 agent 运行时):
const { mandateId } = await agent.subscribe({ service: planId, budget }); // 签 1 次,链上建授权,不预付
// 之后每次调用你的服务:
fetch(`${YOUR_API}/infer`, { method:'POST', headers:{ 'x-isub-mandate': mandateId }, body });
```
agent 全程**不需要为每次调用签名** —— 授权一次,你按用量在限额内拉取。失控也只花到预算上限,客户随时可撤销。

---

## 本地跑通范例
```bash
# 在你的项目里
npm install @isub/sdk
# 起范例服务(指向我们给的网关)
ISUB_BASE_URL=$ISUB_BASE_URL ISUB_API_KEY=$ISUB_API_KEY \
ISUB_WEBHOOK_SECRET=$ISUB_WEBHOOK_SECRET PORT=3000 \
npx tsx examples/merchant/service.ts

# 模拟一次付费调用(mandateId 来自你客户的订阅)
curl -X POST localhost:3000/infer -H 'x-isub-mandate: 0x<mandate>' -d '{"tokens":100}'
#   200 → {"result":"…","charged":"100000"}      已计费、已服务
#   402 → 超预算 / 余额不足(已门控,未服务)
#   403 → 凭证无效(不是给你这个服务的授权)
```

## 信任边界(给你工程师的定心丸)
- iSub 替你触发扣款,但**偷不走、多扣不了**:扣款金额/速率/总额/有效期全在**链上**锁死,且只打进**你的收款地址**。你信任 iSub 的只是"按时扣款"(活性),不是"别乱扣"(安全由链保证)。
- 客户的钱在**客户自己的链上账户**,不预付、随时可取回 —— 这也是你客户敢授权的原因。

## 多语言
非 Node 后端:直接对 `POST {BASE_URL}/usage`(头 `x-isub-api-key` + `x-isub-mandate`,体 `{amount, usageId}`)发请求,webhook 按同样的 HMAC 方案验签即可。`@isub/sdk/client` 只是 Node 的便捷封装。
