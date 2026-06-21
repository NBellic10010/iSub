# FAQ

**How is iSub different from Stripe?**
Stripe is custodial — it holds a token for your card and pulls from a balance you don't control. iSub is non-custodial: funds stay in the subscriber's own `Account` (withdraw-anytime) and the merchant only holds a **capped, revocable** right to pull. No pre-funding, no escrow, on-chain-verifiable caps.

**How is it different from streaming payments (Sablier / Streamflow)?**
Streaming locks funds up front and releases them linearly. iSub locks **nothing** — it's an authorization to pull *on demand* within caps, which fits subscriptions and metered billing (variable amounts, pauses, refunds) rather than a fixed drip.

**Does authorizing a mandate move money?**
No. `authorize*` transfers zero funds — the account balance is identical before and after. Money moves only when a `charge`/`charge_metered` succeeds.

**Who can charge me?**
For **Fixed** plans, `charge` is permissionless but can only ever pull the exact `price`, no more often than `intervalMs`, up to `totalBudget`, before `expiryMs`. For **PAYG**, only the merchant or the plan's `keeper`, capped by `rateCap`/`maxPerCharge`/`totalBudget`. You can `revoke` at any time.

**What stops a merchant from over-charging or faking the price I agreed to?**
Every cap is enforced by the Move contract, not the merchant's backend. And `authorize*` echoes the terms you reviewed (`expected*`); the chain aborts `ETermsMismatch` if they don't equal the plan — so a tampered UI or a swapped plan can't authorize different terms. See [Trusted display](../concepts/trusted-display.md).

**Can a charge double-bill if my keeper times out?**
No. Metered charges pass an idempotency `seq`. On a timed-out retry you resubmit the **same** seq — it lands once or aborts `EBadChargeSeq`. The biller's `recoverOrphan` repairs a lost-ack submit via the seq.

**I charged a mandate but the dashboard shows no usage. Why?**
Three things must line up: (1) a charge actually ran (`spentTotal > 0` on-chain), (2) the biller wrote to the **same** db the gateway serves (`ISUB_INDEX_DB=isub-index.<network>.db`), and (3) the web app's `NEXT_PUBLIC_GATEWAY_URL` points at the running gateway's port. Also, for the wallet-wide rollup the mandate must be **indexed** (`POST /relations/mandate`) so `mandatesBySubscriber` finds it. See [Gateway HTTP API](../reference/gateway-api.md).

**Can I bill in USDC instead of SUI?**
Yes — the primitive is generic over `<T>`. Bind a different coin type when constructing `IsubClient`. The convenience `deposit`/`refund` auto-split SUI only; for other coins use the `tx.*` builders with an explicit `Coin<T>`.

**What about AI agents?**
An agent runs a budget-bounded session key: a human funds an account and allow-lists services with caps; the agent `subscribe`s and pays per call within that policy, optionally driven by an LLM over MCP. See [AI-agent payments](../guides/ai-agents-mcp.md).

**Which networks?**
localnet and Sui testnet today. Testnet package: `0xb11a3defcf0edb190edcf17aab87946a78ff514b1c547ff02dc5444b093bce7a`.

**Do I have to self-host a keeper/biller?**
No — use the [managed gateway](../guides/managed-gateway.md) and the thin `@isub/sdk/client` (api-key + `use` + `verifyWebhook`). Your backend never signs or touches a chain client.

**How do I cancel everything right now?**
`revoke` each mandate (terminal) and `withdrawAll` from the account. Both need only your signature.
