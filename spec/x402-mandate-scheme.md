# x402 `mandate` scheme — pull-settled payments for recurring & metered agent commerce

- **Status:** Draft proposal · v0.1
- **Layer:** an x402 (HTTP 402) **payment scheme** extension — x402 wire version **2**
- **Reference implementation:** Sui (this repo) — [`sdk/src/x402.ts`](../sdk/src/x402.ts), [`sdk/src/agent-auth.ts`](../sdk/src/agent-auth.ts), [`contracts/sources/subscription.move`](../contracts/sources/subscription.move)
- **Honest scope:** this is a **proposal with one working single-chain reference implementation**, *not* an adopted or registered x402 standard. The wire is x402-v2-compatible ("interoperable by shape"), but the scheme **semantics** are only understood by implementations that adopt this document — of which there is currently one (Sui, here). See [§12](#12-status--honesty).

## 1. Motivation

x402 ships the **`exact`** scheme: the buyer authorizes a *fresh on-chain transfer per call* (a one-shot push). That fits a single payment, but it cannot express what subscription and AI-agent payments need:

- **recurring / metered** charges over a *standing* authorization;
- **on-chain-enforced caps** — rate-per-window, per-charge, total budget, expiry;
- charging **without a fresh user signature per call** (an agent pays autonomously);
- **revocability + non-custody** — funds stay in the payer's own balance until pulled, and are withdrawable at any time.

`exact` has none of these: it is push, one-shot, and re-signed every time. The **`mandate`** scheme adds a **pull-settled** model — the buyer presents a *proof-of-possession over a standing on-chain authorization* (a "mandate"), and the facilitator settles through a capped, idempotent biller. It reuses the entire x402 envelope (the 402 challenge, the `X-PAYMENT` header codec, the buyer/seller/facilitator roles) but carries a fundamentally different payment model.

## 2. Roles & terminology

| Term | Meaning |
|---|---|
| **Controller** (payer / subscriber) | the on-chain identity that owns the funding and authorizes the mandate. |
| **Agent** | a delegated key the controller authorizes to spend *within* the mandate (may be the controller itself). |
| **Payee** (merchant / resource server / "seller") | receives funds; emits the 402 challenge. |
| **Facilitator** | verifies proofs (chain-free) and settles (authoritative). MAY be run by the payee. |
| **Mandate** | a standing, capped, revocable, on-chain pull-authorization (the unit this scheme is named for). |

The key safety property the whole scheme rests on: **the facilitator/keeper is trusted for liveness only, never custody** — every cap is enforced on-chain at settlement, so a compromised facilitator can still only pull what the controller already authorized.

## 3. Abstract model (chain-neutral)

A conformant **chain binding** ([§9](#9-chain-bindings)) supplies the two primitives below. Everything in §4–§8 is defined over these abstractly, so the scheme is not Sui-specific.

### 3.1 The mandate object

A mandate is addressable by an opaque **`mandateRef`** (string) and exposes:

| field | meaning |
|---|---|
| `controller` | the authorizing payer identity |
| `payee` | the recipient |
| `rateCap` + `window` | maximum spend per rolling time window |
| `maxPerCharge` | per-charge ceiling |
| `totalBudget` | lifetime ceiling |
| `notBefore` / `expiry` | validity window |
| `status` | `active` \| `paused` \| `revoked` |
| `chargeSeq` | a monotonic idempotency counter |
| `funding` | a balance/allowance the payee can pull from, **withdrawable by the controller at any time** (non-custody) |

and a settlement operation:

```
chargeWithin(mandateRef, amount, seq) -> { ok, digest }
```

which the chain MUST perform **atomically**:

1. reject unless `seq == chargeSeq` (idempotency);
2. reject if `status != active`, or now ∉ [`notBefore`, `expiry`), or `amount` would exceed `rateCap`-in-window / `maxPerCharge` / `totalBudget` / `funding`;
3. otherwise transfer `amount` to `payee`, increment `chargeSeq`, and account the spend.

Because every limit is re-checked here, on-chain, the off-chain facilitator can never over-pull.

### 3.2 Proof of possession (two signatures)

Two domain-separated, deterministic, **signature-suite-agnostic** messages. (Reference suite: ed25519 over Sui's personal-message envelope; an EVM binding uses secp256k1 / EIP-712 — see [§9.2](#92-evm-sketch-not-implemented).)

**BIND CERT** — the controller authorizes an agent key (issued once, then cached and re-used across calls):

```
isub-agent-bind-v1
mandate=<mandateRef>
agent=<agent pubkey/address>
not_after=<ms epoch | 0 = bounded by the mandate's expiry>
ver=<monotonic integer>
```

Signed by the **controller**. A verifier MUST recover the signer and check it equals the on-chain `controller` of `mandateRef` (so the cert is *self-verifying* — no trusted certificate store). `ver` is a **rollback floor**: a verifier MUST reject any cert whose `ver` is below the highest `ver` it has *durably* accepted for that `mandateRef` (defeats replay of a rotated-out / leaked agent key, even across a restart or a second facilitator instance).

**CALL PROOF** — the agent authorizes exactly one charge (signed per call):

```
isub-call-v1
mandate=<mandateRef>
usage=<usageId — a one-time nonce>
merchant=<payee>
payload=<canonical charge>
not_after=<ms epoch>
```

Signed by the **agent**. `payload` is canonical:
- a **flat** charge → `amount=<u64>`;
- a **metered** charge → `items=<key1>:<qty1>,<key2>:<qty2>,…` with meter keys sorted ascending.

A verifier MUST recover the signer to the **bound agent** (from the cert), check `now < not_after`, and check `payload` equals the charge being settled. Binding the signature to `usage` + the exact `payload` is what stops a captured signature from being replayed on a different `usageId` or a different amount.

### 3.3 Single-use & two-layer idempotency

- **`usageId` is single-use per mandate** (durable dedup): a verbatim replay MUST be refused (HTTP `409`). This stops *theft-of-service* (re-delivering a paid resource), independent of funds.
- **On-chain `chargeSeq`** makes settlement idempotent independently: even if an ack is lost and the charge is retried, the chain rejects a stale `seq`, so funds are never double-pulled.

These are deliberately two layers: `usageId` guards the *resource*, `chargeSeq` guards the *money*.

## 4. Wire format (x402 v2)

All u64 values cross the wire as decimal strings. Both bodies are transported as **base64(JSON)** (the `X-PAYMENT` header and the 402 body).

**402 challenge** — `PaymentRequirements` inside `accepts[]`:

| field | value |
|---|---|
| `scheme` | `"mandate"` |
| `network` | e.g. `sui-testnet` \| `sui-mainnet` \| (binding-specific) |
| `maxAmountRequired` | the authoritative ceiling for this call (decimal string) |
| `resource`, `description?` | what is being paid for |
| `payTo` | the payee identity (must equal the mandate's `payee`) |
| `asset` | the settlement asset |
| `extra` | `{ "metered": bool, … }` |

**`X-PAYMENT`** — `PaymentPayload { x402Version, scheme:"mandate", network, payload }`, where `payload` (`MandatePayload`) is:

| field | meaning |
|---|---|
| `mandateId` | the `mandateRef` |
| `usageId` | one-time nonce |
| `sig`, `notAfter` | the **CALL PROOF** signature + its deadline |
| `cert` | `{ agent, notAfter, ver, sig }` — the **BIND CERT** (omittable after first call if the facilitator caches the binding) |
| `amount` *xor* `items` | flat charge (must equal `maxAmountRequired`) **or** metered line items |

**`X-PAYMENT-RESPONSE`** — the settlement receipt (`SettleResponse`, [§6](#6-settlement-provisional-vs-final)).

## 5. Protocol flow

```
buyer → GET resource
seller → 402 { accepts: [ {scheme:"mandate", payTo, maxAmountRequired, …}, … ] }
buyer  → build CALL PROOF (+ BIND CERT on first call) → retry with X-PAYMENT
facilitator.verify(payload, requirements)   // chain-free: scheme/network/amount + PoP recovery + not_after
facilitator.settle(payload, requirements)   // authoritative: re-check binding vs on-chain controller,
                                            // single-use usageId, chargeWithin(caps + chargeSeq)
seller → 200 + resource + X-PAYMENT-RESPONSE
```

`verify` is a cheap, side-effect-free pre-check; `settle` is the single authoritative chokepoint and MUST enforce the proof-of-possession (it is never disabled from client-supplied input).

## 6. Settlement: provisional vs final

| mode | meaning | `txHash` |
|---|---|---|
| **provisional** (default) | the charge is recorded + accrued into the biller's batch and settled on-chain at the next flush. The facilitator's promise is **"at-most-once within mandate caps; on-chain settlement timing not guaranteed."** | `null` |
| **final** | an in-band on-chain digest is returned. | set |

Provisional is correct for a first-party metered service (the payee owns its biller) and keeps micro-metering viable (one on-chain settlement per window, not one tx per call). Final is for callers that need an immediate on-chain proof. *(Reference implementation: provisional is shipped; final is a follow-up — `SettleResponse.settlement` already carries the distinction.)*

## 7. Relationship to the `exact` scheme

`mandate` does not replace `exact`; they compose. A payee that wants to serve **generic x402 clients** SHOULD list **both** in `accepts`:

- **`exact`** — the one-shot push fallback / on-ramp for a client that doesn't understand `mandate`;
- **`mandate`** — the recurring/metered/capped pull path for a client that does.

A client that understands `mandate` SHOULD prefer it (no fresh transfer, no per-call user signature, caps enforced). This dual-offer is the recommended interop bridge.

## 8. Security considerations

- **Bearer rejection** — a request carrying only a (public) `mandateRef`, with no PoP, MUST be refused (`403`). Knowing a mandate id grants nothing.
- **Replay on a new `usageId`** — refused (`403`): the CALL PROOF is bound to the exact `usage` + `payload`.
- **Verbatim replay** — refused (`409`): `usageId` is single-use.
- **Key rotation / leak** — the cert `ver` rollback floor MUST be durable (survive restart + hold cross-instance).
- **Caps are on-chain** — the facilitator/keeper is liveness-only; `chargeWithin` re-enforces every limit.
- **Clock skew** — `not_after` (proofs) and `notBefore`/`expiry` (mandate) are wall-clock vs chain-clock; bindings SHOULD allow a small skew tolerance, and the chain is authoritative.
- **Provisional honesty** — a provisional `settle` is the resource server's promise, **not** a chain proof; clients needing finality MUST request `final`.

## 9. Chain bindings

A binding specifies: how `mandateRef` maps to an on-chain object, the signature suite + personal-message envelope, how `controller` is recovered, and how `chargeWithin` maps to a chain call.

### 9.1 Sui (reference, implemented)

| abstract | Sui binding |
|---|---|
| `mandateRef` | a shared-object id (`Mandate<T>`) |
| signature suite | **ed25519** over Sui's **personal-message** envelope (`verifyPersonalMessageSignature`) |
| `controller` | `Mandate.subscriber` (set to `ctx.sender()` at authorize) |
| caps / `chargeSeq` | fields on the Move object, enforced in `charge_metered` (abort codes: rate `8`, budget `9`, balance `10`, seq `20`, per-charge `24`, …) |
| `chargeWithin(ref, amount, seq)` | `subscription::charge_metered(account, mandate, amount, seq, clock, ctx)` |
| `funding` | the controller's `Account<T>` balance — withdrawable at any time |

Code: [`subscription.move`](../contracts/sources/subscription.move) (object model + caps + `charge_seq`), [`agent-auth.ts`](../sdk/src/agent-auth.ts) (the two-signature PoP), [`x402.ts`](../sdk/src/x402.ts) (seller/buyer/facilitator). Exercised by `npm run x402:smoke`, `x402-agent:smoke`, and on testnet.

### 9.2 EVM (sketch, not implemented)

To show the model is **not Sui-shaped in disguise**, here is how a binding would work on an EVM chain — *only the object representation, signature suite, and `chargeWithin` call change; the wire, the two-signature PoP, `usageId` single-use, and provisional/final settlement are identical.*

| abstract | EVM binding (sketch) |
|---|---|
| `mandateRef` | `(chainId, mandateManager, mandateId)` |
| signature suite | **secp256k1** over **EIP-712** typed data — the BIND/CALL messages become typed structs (`AgentBind`, `CallProof`) under an EIP-712 domain |
| `controller` | the mandate owner (an EOA or smart account) |
| caps / `chargeSeq` | state in a `MandateManager` contract; `chargeSeq` is a per-mandate nonce |
| `chargeWithin(ref, amount, seq)` | `MandateManager.pull(mandateId, amount, seq)` — reverts on bad nonce / cap / expiry, transfers `amount` to `payee` |
| `funding` | an ERC-20 allowance / EIP-2612 `permit`, or a deposited balance the owner can withdraw at any time |

This binding is intentionally left as a specification, not code (no reference implementation exists for it yet).

## 10. Conformance

An implementation MAY claim `mandate` support iff it:

1. implements the canonical **BIND CERT** + **CALL PROOF** messages of §3.2 and recovers signers via its binding's suite;
2. enforces **single-use `usageId`** (§3.3) and the durable **cert `ver` rollback floor** (§3.2);
3. routes `settle` through an on-chain **`chargeWithin`** that enforces *all* caps + `chargeSeq` (§3.1) — i.e. the facilitator is liveness-only;
4. returns `verify` / `settle` responses with the fields of §4 and the provisional/final semantics of §6;
5. rejects bearer / replayed / expired / wrong-payload proofs per §8.

## 11. Test vectors

A machine-checkable fixture set (`spec/mandate-test-vectors.json`) — canonical BIND/CALL messages, known-key signatures, a sample 402 challenge + `X-PAYMENT` + expected `verify` result — is **planned**, to be generated directly from the reference implementation so the spec and code can never drift. *(Not yet committed.)*

## 12. Status & honesty

This is a **draft proposal** with **one** reference implementation (Sui, this repo). There are **no independent implementations and no registry/governance adoption** yet, so:

- the wire is **interoperable by shape** (x402-v2): any x402 tool can *parse* a `mandate` challenge and `X-PAYMENT` envelope;
- the scheme is **not interoperable by semantics**: no generic facilitator can `verify`/`settle` `mandate` until it adopts this document.

Becoming a real interoperable standard requires what this document *cannot* unilaterally deliver — a second independent implementation, a chain-neutral conformance suite, and upstream acceptance. Those are tracked as future work, not claimed as done.
