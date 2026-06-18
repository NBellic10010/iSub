# Phase 2 — 商家 demo app 规划

最后更新：2026-06-08 ｜ 对应 roadmap Phase 2（6/14–6/18）
> 前置：**Phase 1 已完成**——TS SDK + keeper + e2e 全绿（localnet，见 [`../sdk/`](../sdk/README.md)）。本文是 demo app 的落地规划。

## 目标

一个"**30 秒看懂**"的真实感 SaaS 订阅 demo，跑通 iSub 全流程，证明它是**可嵌入的原语 + SDK**（别人嵌它来收订阅），不是又一个成品 app。评委一眼看到四个卖点：**非托管 / 无预储值 / 随时取消 / 损失有上界**；Tier 1/2 再叠**免 gas + Google 登录**。

## 两个界面

| 界面 | 角色 | 核心动作 | 用到的 SDK |
|------|------|---------|-----------|
| **商家面板** `/merchant` | 商家 | 建套餐、看订阅者 & MRR、看扣费流水 | `createPlanFixed/Payg`、`getActiveMandates`、`queryEvents(Charged)` |
| **订阅门户** `/subscribe/:plan` | 用户 | 连钱包、开户+充值、一键授权订阅、看状态、取消、取回 | `openAccount`、`deposit`、`authorize`、`getMandate/getAccount`、`revoke/pause`、`withdrawAll` |

## 技术栈

- **Vite + React + TS**（单页，两条路由）。
- **@mysten/dapp-kit**：`ConnectButton`、`useSuiClient`、`useSignAndExecuteTransaction`、`useCurrentAccount`；`@tanstack/react-query`（dapp-kit 依赖）。
- 消费 **`@isub/sdk`**（本仓 `sdk/`）——tx 构建 + 解析 + 类型直接复用，UI 不碰 PTB 细节。

## login/signer 适配（关键复用点）

SDK 的 `IsubSigner` 是唯一的"写"接缝。Phase 1 已有 Node 版 `keypairSigner`；浏览器版只需把 dApp Kit 的签名 hook 适配成同一接口：

```ts
// 浏览器实现，与 Node keypairSigner 同接口 → SDK 零改动跨环境复用
function walletSigner(account, signAndExecuteTransaction): IsubSigner {
  return {
    address: account.address,
    signAndExecute: ({ transaction }) => signAndExecuteTransaction({ transaction }),
  };
}
```

这就是 HANDOFF "**login() 抽象统一钱包连接 / zkLogin 两条路**" 的落地：
- **Tier 1 MVP**：钱包连接（dApp Kit `ConnectButton`），零基础设施。
- **Tier 2 差异化**：zkLogin（经 Enoki）= "Google 登录"；sponsored tx = `authorize`/`charge` 免 gas（用户无需持 SUI）。Enoki 能力/配额建时核实。

## 免 gas（Tier 1/2）

- `authorize`（用户签一次）+ `charge`（keeper 触发）走 **sponsored tx**，subscriber 无需 SUI。
- 配**协议级免 gas 稳定币转账**（主网）→ 真正"无感"。MVP 可先钱包付 gas，sponsored 作增量。

## Keeper 在 demo 里

- 后台跑 **`IsubKeeper`**（`sdk/scripts/keeper.ts` 服务化）→ demo 里"扣费流水"**随时间自动出现**，体现"自动续费"。
- Fixed 公共 keeper（permissionless）；演示可缩短 `interval` 或手动"快进"。

## 屏幕流（demo 叙事，~90s）

1. **商家面板**：建 "Pro 套餐 $X/月"（`createPlanFixed`）→ 得到订阅链接。
2. **订阅门户**（订阅链接）：连钱包 → 开户+充值（一次充值管所有订阅）→ 一键"订阅"（`authorize`，**签一次、不搬钱**）。
3. **时间推进**：keeper 自动 `charge` → 商家面板流水 +1、MRR 更新；订阅门户显示"下次扣费"。
4. 用户**"取消"**（`revoke`）→ 此后不可扣；**"取回"**（`withdrawAll`）→ 余额秒退。
5. 字幕收尾：非托管 / 无预储值 / 随时取消 / 损失有上界（`total_budget` + `expiry`）。

## 数据流 → SDK

开户+充值 [sponsored] → `authorize` [签一次] → keeper `charge` ×N → `revoke`/`withdraw`。完整生命周期映射见 `architecture.md §6`，且**已在 `sdk/` 的 e2e（`smoke.ts` 17 断言 + `keeper-smoke.ts` 7 断言）验证过**。

## Scope

- **Tier 1（必做）**：两面板 + 钱包连接 + 建套餐→授权→可见周期扣费→取消/取回 + 接 `@isub/sdk` + keeper 后台。
- **Tier 2（挑 1–2）**：zkLogin 登录 / sponsored 免 gas / PAYG 计量 demo（**agent 花费预算**很抓眼球）/ checkout 一行嵌入 widget。
- **不做**：法币 on-ramp（mock，假设 Account 已有币）、多币种 FX。

## 风险 / fallback

- **Sui testnet 近期 48h 宕机 3 次** → demo **预录 fallback** + localnet 演示备份（`sdk/` 已能一键 localnet 跑通，最稳）。
- 法币 on-ramp 最重 → MVP mock。

## 开放问题

1. demo 录 **testnet 还是 localnet**？建议：localnet 录主轨（稳）+ testnet 真跑一遍截图佐证（真实）。
2. **Enoki 配额 / sponsored** 是否赶得上 Tier 1？建时核实；赶不上则降级钱包付 gas，sponsored 作 Tier 2。
3. **PAYG demo** 纳入 Tier 1 主叙事（agent 花费预算抓眼球）还是 Tier 2？
