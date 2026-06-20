# iSub Relationship Index (Indexer) — handoff plan

*Self-contained spec for another session to build. Date: 2026-06-19.*

## STATUS (2026-06-20) — slices 1–2 SHIPPED, slices 3–4 deferred (by evaluation)
The necessity split: the **write-time relationship index** is necessary for the dashboard and is cheap;
the **event-tail indexer** (gRPC subscription / GraphQL backfill / sui-indexer-alt) is NOT needed for the
managed-first / hackathon scope — almost everything is created through our own surfaces, so there is little
to "catch outside our surfaces" yet. So we built the first half and deferred the second.

**Shipped:**
- `@isub/sdk/relations` — `IsubIndex` (write-time capture: `ingestPlan` / `ingestMandate` (auto-captures the
  account) / `ingestAccount`, each RE-DERIVED from a chain point-read; reads: `plansByMerchant`,
  `mandatesByMerchant`, `mandatesBySubscriber` (cross-merchant), `mandatesByPlan` (the plan↔user mapping),
  `accountsByOwner`, `mandate`). READ-ONLY projection; keeper/biller never read it (hot-path invariant intact).
- Tables `idx_plans` / `idx_mandates` / `idx_accounts` in `sdk/src/db.ts` — GLOBAL, address-keyed, kept
  SEPARATE from the keeper's `subscriptions` table (resolves the §9 open decision: keep separate, no drift).
- `sdk/src/gateway.ts` routes: `POST /index/plan|mandate` (api-key, re-derives), `GET /plans` · `GET /mandates`
  (api-key → your address), public `GET /relations/mandates?plan=|subscriber=|merchant=` · `/relations/plans`
  · `/relations/accounts` (address-keyed; on-chain-public data). Bigints serialized as decimal strings.
- `@isub/sdk/client` one-call API: `indexPlan` / `indexMandate` / `listPlans` / `listMandates` /
  `mandatesByPlan` / `mandatesBySubscriber` / `accountsByOwner`.
- `web/lib/gateway.ts` seam wired (`listPlans` / `listMandates` / `mandatesByPlan` no longer throw `todo`).
- Tests: `npm run relations:smoke` (20, index unit) + `npm run relations-http:smoke` (12, thin client →
  gateway → index over HTTP, incl. bigint-over-wire + api-key scoping). Both green, headless, no chain.

**Deferred (slices 3–4):** the event tail (gRPC `subscription_service` steady + GraphQL backfill cold-start)
and `sui-indexer-alt`. Build when we need to (a) discover objects created OUTSIDE our surfaces (direct SDK
authorize / permissionless Fixed charge / third-party), (b) provide a trustless chain-derived cross-check,
or (c) scale analytics. Until then write-time capture covers the managed flow.

## 0. Problem
The web dashboards (`web/`) currently remember plan ids / mandate ids in **localStorage** → per-browser, no cross-device, can't see objects created elsewhere, no usage/revenue view. Root cause: **there is no persistent index** mapping the on-chain relationships:
- merchant → [plans]
- subscriber → [accounts], [mandates] (across ALL merchants)
- plan → [mandates]
- mandate → [charges / usage / revenue]

Why it's missing: the SDK read path deliberately avoids event queries (the keeper uses an explicit watch set), and gRPC cannot enumerate **shared** objects by owner. So the relationships exist on-chain but the frontend can't read them out.

## 1. The data exists on-chain — fully indexable
Events emitted by `contracts/sources/subscription.move` (verified):

| Event | Fields | Builds |
|---|---|---|
| `PlanCreated` | `plan_id, merchant, mode` | merchant → plans |
| `PlanDeactivated` / `PlanClosed` | `plan_id` | plan status |
| `MandateAuthorized` | `mandate_id, account_id, subscriber, merchant` | subscriber→mandate, merchant→mandate (⚠ **no `plan_id`** — fill via one `getMandate`) |
| `MandateRevoked` / `MandateClosed` | `mandate_id` | mandate status |
| `AccountOpened` / `AccountClosed` | `account_id, owner` | user → account |
| `Charged` | `mandate_id, account_id, amount, spent_total, seq, by` | mandate → charges / usage / revenue |
| `Refunded` | `mandate_id, account_id, amount, refunded_total` | refunds / credit |

Package id (testnet): `0xb11a3defcf0edb190edcf17aab87946a78ff514b1c547ff02dc5444b093bce7a`. Event type filter = `<pkg>::subscription::<EventName>`.

## 2. Architecture: DUAL-SOURCE (the key decision)
Do NOT make event-polling the primary path. iSub originates almost everything through its own surfaces, so:

**(A) Write-time capture — PRIMARY, zero-poll, immediate.** Record relationships the moment we create them:
- Checkout host (`web/components/checkout.tsx`, on `authorize*` success) knows subscriber + planId + mandateId + accountId → POST to an index ingest route.
- Merchant plans (`web/components/merchant-plans.tsx`, on `createPlan*`) knows merchant + planId.
- Biller/keeper (`sdk/src/biller.ts` journal, `usage_records`) already record charges/usage.

**(B) Event tail — BACKSTOP/reconciler.** Subscribe to the chain's iSub events to (a) confirm finality, (b) capture objects created OUTSIDE our surfaces (direct SDK authorize, permissionless Fixed `charge`, third-party), (c) self-heal a lost write-time POST. Low-rate safety net, not the hot path.

This makes the system correct AND cheap: you barely poll, because you already know what you wrote.

## 3. Event-source strategy (polling → push)
**JSON-RPC is deprecated (sunset ~July 2026) — never poll it.** Recommended (load skill `accessing-data` → `grpc.md`/`graphql.md`/`indexers.md` and confirm exact APIs, don't guess):
- **Steady-state tail = gRPC subscription (push)** — `subscription_service` via `SuiGrpcClient` streaming, filtered to `<pkg>::subscription::*`. Only gRPC supports subscriptions today.
- **Cold-start backfill = GraphQL RPC `events`** — filtered pagination by event type + cursor. Only GraphQL supports filtered historical event pagination today. Run once to catch up to head, then hand off to the gRPC tail.
- **At scale = `sui-indexer-alt`** checkpoint pipeline (push from checkpoint stream; exactly-once via checkpoint seq; writes to any store). DEFER until volume warrants.
- **Cross-cutting**: persist a cursor/checkpoint watermark (resume, no re-scan, no gaps); server-side event-type filter; read-after-write via GraphQL execution-attached scope (or `waitForTransaction`) so checkout confirms a mandate instantly without waiting on the indexer.

## 4. Schema (extend the gateway SQLite — `sdk/src/db.ts`)
GLOBAL index (NOT per-tenant — a subscriber's mandates span merchants). Add idempotent migrations (the migration runner already exists in db.ts: `addColumnIfMissing` + `migrate()`):
```sql
CREATE TABLE IF NOT EXISTS plans (
  plan_id PRIMARY KEY, merchant, mode, price, interval_ms,
  rate_cap, rate_window_ms, keeper, active, created_at, created_seq);
CREATE INDEX idx_plans_merchant ON plans(merchant);

CREATE TABLE IF NOT EXISTS mandates (
  mandate_id PRIMARY KEY, account_id, subscriber, merchant, plan_id,
  mode, status, total_budget, expiry_ms, created_at);
CREATE INDEX idx_mandates_subscriber ON mandates(subscriber);
CREATE INDEX idx_mandates_merchant   ON mandates(merchant);
CREATE INDEX idx_mandates_plan       ON mandates(plan_id);

CREATE TABLE IF NOT EXISTS accounts (account_id PRIMARY KEY, owner);
CREATE INDEX idx_accounts_owner ON accounts(owner);

CREATE TABLE IF NOT EXISTS index_cursor (name PRIMARY KEY, cursor, updated_at);
```
Reuse existing `charges` (journal) + `usage_records` for the usage/revenue view, keyed by `mandate_id`. NOTE: the existing `subscriptions` table is keeper-watch-scoped — decide whether to merge it with the new global `mandates` index or keep separate (recommend: keep `mandates` as the canonical relationship index; leave `subscriptions` to the keeper).

## 5. Gateway read API (fill the seam in `web/lib/gateway.ts`, implement in `sdk/src/gateway.ts`)
Ingest (write-time capture, POST):
- `POST /index/plan` `{planId}` → resolves on-chain (getPlan) + upserts.
- `POST /index/mandate` `{mandateId}` → getMandate + upserts (fills plan_id).
Reads:
- `GET /plans?merchant=` · `GET /mandates?merchant=` · `GET /mandates?subscriber=`
- `GET /accounts?owner=` · `GET /usage?mandateId=` · `GET /revenue?merchant=` · `GET /lag?merchant=` (reuse `scheduleLag`)

Auth: merchant routes behind the **SIWS session** (= merchant address). Subscriber routes by wallet address (mandates are on-chain public, so reads can be address-keyed; gate any writes). The ingest routes can be open (they only re-derive from chain) or session-gated.

## 6. Dashboard wiring (delete localStorage)
- Merchant `web/components/merchant-plans.tsx`: list from `GET /plans?merchant=<session>` (after create, also `POST /index/plan`). Same for subscribers/revenue.
- Subscriber `web/components/subscriber-dashboard.tsx`: list from `GET /mandates?subscriber=<address>` + `GET /accounts?owner=<address>`. After checkout authorize, the checkout host `POST /index/mandate`.
- Keep localStorage only as an offline fallback, not the source of truth.

## 7. Build slices (suggested order)
1. **Schema + write-time capture**: add tables + ingest routes; checkout & merchant-plans POST on create/authorize. (No event tail yet — immediate cross-device for first-party writes.)
2. **Read API + dashboard wiring**: listPlans/listMandates by merchant/subscriber → drop localStorage.
3. **Event tail backstop**: gRPC subscription (steady) + GraphQL backfill (cold start) → reconcile into the same tables (idempotent upserts keyed by id; cursor watermark).
4. **Usage/revenue views**: `Charged`/`Refunded` → per-mandate usage, per-merchant revenue, `scheduleLag` (漏收入) on the merchant dashboard.

## 8. For the executing session
- Load skill **`accessing-data`** → `grpc.md` (subscription_service / SuiGrpcClient streaming), `graphql.md` (events filtered pagination + read-after-write), `indexers.md` (sui-indexer-alt if scaling). Confirm exact APIs there — do not guess subscription/method names.
- Reuse: `@isub/sdk` reads (`getPlan`/`getMandate`/`getMandatesResolved`/`getAccount`), `sdk/src/db.ts` (migration runner + SQLite), `sdk/src/sql-store.ts` (tenant store patterns), `sdk/src/gateway.ts` (HTTP front), `web/lib/gateway.ts` (the typed seam — TODO methods to implement).
- Keep the keeper's "no event query on the hot path" invariant intact — the indexer is a SEPARATE component; querying events there is correct.

## 9. Open decisions
- Subscriber-side auth: public address-keyed reads vs session-gated (mandates are public on-chain either way).
- Merge new `mandates` index with the keeper's `subscriptions` table, or keep separate (recommend separate).
- Multi-network: one index DB per network (testnet/localnet/mainnet) or a `network` column.
- When to graduate from gRPC-subscription-tail to a full `sui-indexer-alt` pipeline.
