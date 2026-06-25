# iSub 前端架构规划

*日期：2026-06-18 ｜ 决策已锁:Next.js 全栈 + 独立可嵌入 checkout 组件;登录支持钱包 + zkLogin;支付弹窗为独立 widget。*

## 0. 锁定的决策
- **技术栈**:Next.js(App Router)全栈——营销 SSR + 用户/商家两个 dashboard + zkLogin/SIWS 服务端路由;复用现有 gateway 作为商家链下数据后端。
- **登录**:钱包(dApp-kit ConnectButton,demo 已就位)+ zkLogin(OAuth→Sui 地址),两者都支持。
- **支付弹窗**:独立可嵌入 widget(商家在自己站点嵌入),**iframe 隔离**承载"可信展示"。

## 1. 仓库结构(npm/pnpm workspaces)
现有:`contracts/` · `sdk/`(`@isubpay/sdk`)· `demo/`(原型,毕业到下面两个)。新增:
```
web/        Next.js 全栈:首页 + 用户端 + 商家端 + 服务端路由(zkLogin/SIWS/商家 API)
checkout/   独立可嵌入 widget(iSub Checkout):iframe 宿主 + <script> 加载器
```
用 workspaces 让 `web`/`checkout` 干净地 `import @isubpay/sdk`(Next 下不沿用 demo 的 vite-alias,用 workspace 依赖)。`demo/` 留作参考,逻辑(walletSigner 桥接、`useIsub`、`signMessage`)移植进 `web`/`checkout`。

## 2. 路由树(web/,App Router)
```
/                       首页(营销,SSR)
/login                  登录(钱包 | Google/zkLogin)
/app                    用户端(钱包/zkLogin 门控,'use client')
  /app                  概览:账户余额 + 敞口(accountExposure)+ 在用订阅
  /app/account          充值 / 提现(非托管退出)
  /app/subscriptions    我的 mandate 列表;暂停/恢复/撤销;详情=扣款历史
/merchant               商家端(SIWS/会话门控)
  /merchant             概览:营收 + 漏收入(scheduleLag)+ 告警
  /merchant/plans       建/管 Plan(Fixed/PAYG)+ PAYG 的 RateCard 定价
  /merchant/subscribers 对我 Plan 的 mandate;已花/预算;退款
  /merchant/usage       usage_records + 定价行 + 发票(结算发票)
  /merchant/settings    API key、Webhook、收款地址、keeper/biller 健康
```

## 3. 服务端路由(Next route handlers)
- **zkLogin**:建议用 **Enoki**(Mysten 的 zkLogin-as-a-service)——**不自建 salt 服务 + prover**。`/api/auth/zklogin/*` 走 Enoki;dApp-kit 有 Enoki 集成。
- **SIWS 会话**:`/api/auth/siws/nonce` + `/api/auth/siws/verify`(`verifyPersonalMessageSignature` from `@mysten/sui/verify`)→ 下发 session cookie。商家端读链下数据要会话;授权判定靠链上 `plan.merchant == 会话地址`。
- **商家数据 API**:把现有 gateway(已拥有 sqlite:plans/usage/webhooks/api-keys)**扩展成 dashboard 需要的只读 API**(列 plans/mandates/usage/invoices/health/lag);Next 服务端持商家会话 server-to-server 调它。

## 4. 三条登录流(按角色)
| 角色 | 登录方式 | 产出 | 会话 |
|---|---|---|---|
| 用户(订阅者) | 钱包 ConnectButton **或** zkLogin(Enoki,Google→地址) | address + signer | 不强制后端会话(几乎全链上读 + 签) |
| 商家 | 钱包 SIWS **或** zkLogin 地址签 SIWS 挑战 | 后端 session cookie | 需要(读链下 gateway 数据) |
| agent | (无 UI,用 SDK/MCP 的 session key) | — | — |

## 5. 支付弹窗 = iSub Checkout(皇冠 + 可信展示落点)
- **形态**:独立 bundle,`<script>` 加载器 + **iframe 宿主**。consent UI 跑在 **iSub 自己的源**,商家页面**改不了样式、伪造不了**(trusted-display L1b 隔离)。对标 Stripe Checkout 的 embedded/redirect。
- **流程**:商家站点 `iSubCheckout.open({ planId, budget, accountId? })` → iframe 打开 → **从链上 Plan 渲染条款**(中立来源,非商家声明)→ 用户在 iframe 内连钱包/zkLogin → 复核条款 → 签 `authorize_*`(+ 可选 `signMessage` 文字同意,hook 已加)→ 经 `postMessage` 回传 `{ mandateId }` 给商家。
- **关键**:`expected_*` 取自 iframe 的链上读渲染,**绝不**取自商家声明 —— 这才让 `ETermsMismatch` 终局有意义。

## 6. 每屏数据契约(用已有能力)
| 屏 | 读 | 写(钱包签) |
|---|---|---|
| 用户概览 | `getAccount`、`accountExposure`、`getMandatesResolved` | — |
| 账户 | `getAccount` | `deposit`/`withdraw`/`withdrawAll` |
| 我的订阅 | `getMandate(s)` | `pause`/`resume`/`revoke`/`closeMandate` |
| 商家概览 | gateway:营收/健康 + `scheduleLag`(漏收入) | — |
| Plan 管理 | gateway/链:plans | `createPlanFixed`/`createPlanPayg`/`deactivatePlan` |
| 订阅者(商家视角) | `getMandatesResolved` | `refund` |
| 用量/发票 | gateway:usage_records + 发票 + RateCard | — |
| 设置 | gateway:api-key/webhook/health | (后端配置) |
| Checkout | `quoteFromPlan`(链上条款) | `authorizeFixed`/`authorizeMetered` + `signMessage` |

## 7. 复用映射(已建好的)
- `walletSigner` 桥接 + `useIsub` + `signMessage`(demo)→ 移植进 web/checkout。
- SDK 读:`getAccount`/`getMandate`/`getMandatesResolved`/`accountExposure`/`scheduleLag`/`quoteFromPlan`。
- gateway(api-key + sqlite)+ sql-store → 商家链下数据。
- pricing(RateCard)+ 结算发票(待建)→ 商家用量/账单屏。
- dapp-kit 配置(`demo/src/dapp-kit.ts`)→ web。

## 8. 建议构建顺序
1. **scaffold `web/`**(Next App Router + 'use client' provider 边界 + 移植 dapp-kit/useIsub + Tailwind/shadcn)。
2. **用户端 `/app`**(钱包登录优先;把 demo 的 账户/订阅/敞口 毕业过来)——最低风险、复用最多。
3. **Checkout widget `checkout/`**(iframe consent + trusted-display + signMessage)——皇冠、差异化卖点。
4. **商家端 `/merchant`**(SIWS 会话 + 扩展 gateway 只读 API:plans/mandates/usage/invoices/lag/health)。
5. **zkLogin via Enoki**(钱包路径跑通后,作为第二登录项加上)。
6. **首页**(营销,可并行/早做,低风险)。

## 9. 建议默认(非阻塞,可改)
- zkLogin 用 **Enoki**(不自建 salt+prover)。
- 设计系统 **Tailwind + shadcn/ui**。
- **workspaces** 管 web/checkout/sdk。
- 商家数据:**扩展 gateway** 成 dashboard 只读 API(它已拥有 sqlite)。

## 10. 待你定的次级问题
- Enoki 用不用(还是自建 zkLogin 基建)?
- 商家会话:SIWS 钱包签 vs 也允许 Google(zkLogin 地址签 SIWS)?
- 设计系统/品牌:有没有现成视觉规范,还是我用 shadcn 默认起。
- 首页要不要先出一版给老板/评委看(营销叙事)。
