# Managed 接入实现方案 —— 商家"接入即用、不 self-host"

> 内部评审 ｜ 2026-06-16
> 前提:embedded 端到端已建并对真链验证 —— `IsubService`(src/service.ts)把 agent mandate → biller → 链上 `charge_metered` 接通,`wiring-e2e` 在真网络上跑通(agent.subscribe → service.use ×N → 真扣款 → 对账/gate/撤销)。**本方案在其上加一层"多租户托管"。**

## 1. 一句话
现在的 `IsubService` 是**可嵌入**的——商家自己 `new` 一个来跑(self-host)。Managed = **iSub 替所有商家跑 `IsubService`**,商家只通过 api-key + 几个 HTTP 调用接入,**不跑进程、不建库、不签扣款**。

## 2. 为什么 managed 不破非托管(底线)
iSub 替商家扣款,但**碰不到钱**:Fixed charge permissionless、PAYG 把 iSub 设为授权 keeper;charge 链上锁死(限额 + 收款人=商家)。iSub 只能"按约定把钱打给商家、或不打" → **赌活性,不赌安全**。托管不引入任何托管风险。

## 3. 商家接入面(瘦 client,任意语言,就 4 件事)
1. **建套餐**(连钱包签 1 次;PAYG 把 `keeper` 设成 iSub 公开的 keeper 地址)—— 走 dashboard 或一行 SDK。
2. **前端嵌 `<IsubSubscribe>`**(客户 authorize)。
3. **(PAYG)上报用量**:服务每次被调用 → `client.use(mandateId, amount, usageId)`(底层 POST 到 iSub 托管网关)。
4. **收 webhook**:`verifyWebhook(签名)` + 按事件开通 / 降级 / 停服。

→ **没有 IsubService、没有 biller、没有数据库、没有扣款签名 —— 全是 iSub 跑。**

## 4. iSub 要建什么(托管网关 = `IsubService` 的多租户外壳)
- **多租户网关(HTTP)**:api-key 鉴权 → 解析 merchant(`merchantByApiKey` 已有)→ 路由到该商家的 `IsubService` 实例(`sqlBillerStore(db, merchantId)` 已按租户隔离)。
- **托管 IsubService**:每商家一个逻辑实例(共享 DB、按 `merchant_id` 隔离),**iSub 的 keeper key 签扣款**。
- **后台 flush 循环**:网关跑(`IsubService.start()` 已有)。
- **webhook 投递**:复用已建的 dispatcher,投给商家 endpoint。
- **端点**:`POST /usage`(=use)、`GET /subscriptions/:id`、`POST /refunds`、(可选)`POST /plans`。
- **瘦 client SDK(`@isubpay/sdk/client`)**:`use` / `status` / `verifyWebhook` 几个 HTTP 封装;其他语言给 OpenAPI。

> 关键:网关是 `IsubService` 的**薄外壳** —— 难的部分(wiring、biller、链上、不双花)已经做完测完。Managed 主要是"多租户 + 对外 HTTP + 瘦 client"。

## 5. 需要拍板的决策

| # | 决策 | 建议 |
|---|---|---|
| D1 | 建套餐谁签 | 商家钱包(收款人必须=商家)→ dashboard 连钱包点一下,或商家自己 SDK 建。**managed 也躲不过这一次签名。** |
| D2 | mandate 登记 | 沿用 `IsubService` 的"**首次 use 时上链核对 + 自动登记**"(商家零额外步骤),不做显式 register |
| D3 | 用量上报通道 | 托管走 `POST /usage`;自嵌走进程内 `use()`。**两者都留**(一份内核两种壳) |
| D4 | 扣款签名 | **iSub keeper key**(PAYG 需商家把 `keeper` 设成它)→ 公开 iSub keeper 地址 |
| D5 | gas | iSub 垫扣款 gas → 抽成 / sponsored 回收(architecture §2.2 托管层) |
| D6 | 瘦 client 形态 | 先 JS 包,后 OpenAPI 多语言 |
| D7 | 多租户部署 | 单网关进程 + 按 merchant 隔离 store + 每商家 flush + per-merchant 锁(已有);HA 上 Postgres(后) |

## 6. 范围
**做**:多租户网关(`IsubService` 外壳 + api-key 路由 + per-merchant 实例管理 + flush)、瘦 client SDK、一条 **managed e2e 测试**。
**不做(本轮)**:dashboard UI、sponsored gas、OpenAPI 多语言客户端、前端组件(Phase 2)。

## 7. 验收(满足才算"接入即用")
一条测试:一个"商家"**只用 `@isubpay/sdk/client`**(api-key + `use` + `verifyWebhook`)对接一个**跑着的 iSub 网关**,agent 订阅后在 **testnet 真被扣款**;商家侧代码里**没有 `IsubService` / biller / DB / 扣款签名**。

## 8. 工作拆解(估时,1 人)

| 任务 | 估时 |
|---|---|
| 多租户网关(包 IsubService + api-key 路由 + per-merchant 实例 + flush) | 1–1.5 天 |
| 瘦 client SDK(HTTP 封装 + 复用 verifyWebhook) | 0.5 天 |
| webhook 投递串接(已建,接线) | 0.25 天 |
| managed e2e 测试(= 验收第 7 条) | 0.5 天 |
| 文档 | 0.25 天 |
| **合计** | **~2.5–3 天** |

## 9. 待讨论的开放问题
1. **一个 merchant 一个 `IsubService` 实例**(隔离干净、内存随商家数涨)**vs 一个共享 biller**(按 mandate 隔离、更省)?建议先前者(懒创建),量大再优化。
2. **iSub keeper key 的密钥管理(KMS / 轮换)** —— 它签所有托管商家的扣款,是关键件;密钥泄漏只能"乱触发扣款(钱仍进商家、受上限)",偷不走,但要 KMS + 轮换(对应合约 N-4)。
3. 建套餐那一次商家签名的 UX(dashboard 连钱包),确认可接受。
