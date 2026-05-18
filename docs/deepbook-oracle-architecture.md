# DeepBook Predict — Price Oracle Architecture

> A reading of the on-chain code in `temp/deepbookv3/packages/predict/`, focused
> on **how DeepBook gets a BTC spot price on-chain, what it stores per market,
> and what an independent oracle would have to replicate to be drop-in
> equivalent.**
>
> Audience: anyone planning to build a Flicky-style prediction product on Sui
> that wants the same price-feed properties as DeepBook (permissionless
> updates, per-market settlement, SVI-based fair pricing) without depending on
> DeepBook itself.

---

## 1. TL;DR — three layers, two operators

DeepBook splits the oracle into **three on-chain objects** so price ingestion,
per-market accounting, and quoting are independently auditable:

```
   ┌────────────────────────────┐
   │      PythSource            │  ← shared object, one per asset feed
   │  (deepbook_predict::       │     • Stores latest Pyth Lazer spot
   │   pyth_source)             │     • PERMISSIONLESS writes (anyone with
   └────────────┬───────────────┘       a verified Lazer Update can push)
                │ referenced by id
                ▼
   ┌────────────────────────────┐
   │      MarketOracle          │  ← shared object, one per (asset, expiry)
   │  (deepbook_predict::       │     • Stores forward + SVI surface
   │   market_oracle)           │     • CAP-GATED writes (operator only)
   │                            │     • Status: ACTIVE → PENDING → SETTLED
   └────────────┬───────────────┘
                │ read by
                ▼
   ┌────────────────────────────┐
   │      pricing               │  ← stateless read layer
   │  (deepbook_predict::       │     • Resolves spot/forward freshness
   │   pricing)                 │     • Computes SVI fair price (compute_nd2)
   │                            │     • Adds Bernoulli + utilization fee
   └────────────────────────────┘
```

**Two operator roles** drive ingestion:

| Operator | What they push | Cap required | Frequency | Trust model |
|---|---|---|---|---|
| **Anyone** (community) | Pyth Lazer spot → `PythSource.spot` | None — verified `pyth_lazer::Update` is its own trust root | Whenever someone wants fresh spot | Permissionless |
| **Market operator** (DeepBook keeper) | Forward price + SVI surface → `MarketOracle.block_scholes_prices` + `MarketOracle.block_scholes_svi` | `MarketOracleCap` | Per 15-min market lifecycle | Trusted operator |

The split matters: spot is the cheap commodity (Pyth gives it for free,
verified); forward and SVI parameters are the expensive proprietary inputs
DeepBook pays Block Scholes for. By keeping them in different objects with
different write authorities, the spot can stay maximally fresh without the
operator running a hot wallet for every block.

---

## 2. Layer 1 — `PythSource`: permissionless spot via Pyth Lazer

### 2.1 What it stores

```move
// packages/predict/sources/oracle/pyth_source.move
public struct PythSource has key {
    id: UID,
    feed_id: u32,                // Pyth Lazer numeric feed id (e.g. BTC/USD)
    spot: u64,                   // normalized to 1e9 fixed point
    source_timestamp_ms: u64,    // publisher's timestamp from the verified payload
    update_timestamp_ms: u64,    // clock.timestamp_ms() when push landed
}
```

The dual timestamp pattern (`source_*` + `update_*`) appears in every layer of
the system and is critical for staleness checks — see §4.

### 2.2 The write path

```move
public fun update_from_lazer(
    source: &mut PythSource,
    update: LazerUpdate,    // ← see § 2.3 for why this is the trust root
    clock: &Clock,
)
```

Anybody with a verified `LazerUpdate` may call this. The function:

1. Extracts `(spot_1e9, source_timestamp_us)` for `source.feed_id` via
   `lazer_helper::extract_spot(&update, feed_id)`.
2. Asserts `spot > 0`, `source_timestamp_ms > prior source_timestamp_ms`
   (strict monotonicity, prevents replay), and `source_timestamp_ms <= now`
   (rejects future-dated payloads).
3. Writes new spot + both timestamps and emits `PythSourceUpdated`.

There is no admin cap. No allowlist. The only entry barrier is constructing a
`pyth_lazer::update::Update`, which is gated entirely by the verifier package.

### 2.3 Why `LazerUpdate` is the trust root

`pyth_lazer::update::Update` is a Move struct whose constructor is
**package-scoped** to the on-chain `pyth_lazer` package. Move's type system
guarantees no external caller can fabricate one. The only path to obtain an
`Update` is:

1. Fetch a signed payload from Pyth's hosted Lazer service.
2. Pass it through `pyth_lazer::verifier::verify(...)` on-chain, which checks
   the publisher signatures.
3. The verifier returns a `LazerUpdate` value, which the caller can then feed
   to any `update_from_lazer`-style consumer.

This is the key insight that makes the price feed permissionless without
sacrificing authenticity: **the cryptographic verification is offloaded to a
shared on-chain primitive, and consumer modules only need to type-check that
they're handling a "real" `Update`.**

### 2.4 Normalization details

`lazer_helper::extract_spot` does three things:

1. Looks up the requested `feed_id` in the update's feed vector (`feeds_ref`).
   Aborts `ELazerFeedNotFound` if missing.
2. Reads `price: I64` and `exponent: I16`, both Pyth signed types. Asserts the
   price isn't negative (crypto spot can't be).
3. Rescales `magnitude × 10^(exponent + 9)` to land in the predict package's
   1e9 fixed-point scaling. Aborts `ELazerPriceOverflow` if the multiplication
   would exceed `u64::MAX`.

The overflow guard is non-trivial — see `checked_scale_up`. For BTC/USD with
`exponent = -8` and price `$80_000`, magnitude is `8_000_000_000_000`
(`8 × 10^12`); the shift is `+1`, product is `8 × 10^13` which fits in `u64`.

---

## 3. Layer 2 — `MarketOracle`: per-expiry state machine

### 3.1 What it stores

```move
// packages/predict/sources/oracle/market_oracle.move
public struct MarketOracle has key {
    id: UID,
    authorized_cap_ids: VecSet<ID>,   // multi-cap authorization (operator rotation)
    pyth_source_id: ID,               // pinned spot source for this market
    expiry: u64,                      // ms timestamp; canonical end of life
    block_scholes_prices: BlockScholesPriceState,  // operator-pushed spot + forward
    block_scholes_svi: BlockScholesSVIState,       // operator-pushed SVI surface
    bounds: MarketOracleBounds,       // staleness + circuit-breaker config
    settlement: Option<SettlementState>,  // terminal value; None until settled
}
```

Critically, **one `MarketOracle` is one expiry**. When the market expires, the
object is permanently retired — its `settlement` becomes `Some(...)` and no
further writes are accepted. A new expiry requires a new `MarketOracle`
object.

DeepBook in production creates a new `MarketOracle` every **15 minutes**, each
with a **75-minute lifetime**, so at any moment there are ~5 active oracles
overlapping. The Predict `registry` module tracks the active set.

### 3.2 The state machine

```move
const STATUS_ACTIVE: u8 = 1;
const STATUS_PENDING_SETTLEMENT: u8 = 2;
const STATUS_SETTLED: u8 = 3;
```

Derived from `(settlement, expiry, now)`:

```move
public fun status(market: &MarketOracle, clock: &Clock): u8 {
    if (market.is_settled()) {
        STATUS_SETTLED
    } else if (clock.timestamp_ms() >= market.expiry) {
        STATUS_PENDING_SETTLEMENT
    } else {
        STATUS_ACTIVE
    }
}
```

| State | Reads allowed | Writes allowed |
|---|---|---|
| `ACTIVE` | spot, forward, SVI | `update_block_scholes_prices`, `update_svi` |
| `PENDING_SETTLEMENT` | spot, forward, SVI (stale by definition) | `settle_if_possible` only |
| `SETTLED` | `raw_settlement_price()`, `pricing::settlement_price()` | none |

The transition `ACTIVE → SETTLED` happens via a separate spot snapshot taken
**after** expiry — see §5.

### 3.3 The cap-gated write paths

```move
public fun update_block_scholes_prices(
    market: &mut MarketOracle,
    pyth: &PythSource,        // referenced for ID check only
    cap: &MarketOracleCap,
    block_scholes_spot: u64,
    block_scholes_forward: u64,
    block_scholes_source_timestamp_ms: u64,
    clock: &Clock,
)
```

Enforces (in order):

1. `cap` is in `market.authorized_cap_ids` (multi-cap supports operator rotation
   without rebuilding the oracle).
2. `pyth.id() == market.pyth_source_id` (this market is bound to one source).
3. `status != SETTLED`.
4. `spot > 0`, `forward > 0`, source timestamp strictly increasing and not
   future-dated.
5. `basis := forward / spot` is inside `[bounds.min_basis, bounds.max_basis]`.
6. If a prior push exists: new spot is within `bounds.max_spot_deviation` of
   the prior spot, and new basis is within `bounds.max_basis_deviation` of the
   prior basis.

`update_svi` is analogous but only carries the SVI params — no basis check
because SVI doesn't constrain spot.

The double-validation (per-push deviation + absolute bounds) catches three
distinct failure modes:

- **Fat-finger / decimal slip** → caught by `max_spot_deviation` (default 2%).
- **Block Scholes feed glitch returning garbage** → caught by basis bounds
  (default `[0.9, 1.1]`).
- **Slow drift attack** → caught by absolute basis ceiling/floor, which the
  per-push delta can't sweep through in one shot.

### 3.4 The bounds object

```move
public struct MarketOracleBounds has copy, drop, store {
    settlement_freshness_ms: u64,  // default 3_000 (3 s)
    max_spot_deviation: u64,       // default 20_000_000 (2% in 1e9 scale)
    max_basis_deviation: u64,      // default 20_000_000 (2%)
    min_basis: u64,                // default 900_000_000 (0.9)
    max_basis: u64,                // default 1_100_000_000 (1.1)
}
```

`tuning_constants.move` exposes `default_*` macros for these plus hard
ceilings on the admin setters (`max_basis_deviation_ceiling = 10%`,
`min_basis_floor = 0.5`, `max_basis_ceiling = 2.0`). The principle: even a
compromised admin can't turn the deviation cap into a no-op (e.g. set it to
100%) — the on-chain validator rejects.

---

## 4. Dual-timestamp staleness model

Both `PythSource` and `MarketOracle` store **two timestamps per data update**:

| Field | Meaning |
|---|---|
| `source_timestamp_ms` | The timestamp the data publisher signed into the payload. |
| `update_timestamp_ms` | `clock.timestamp_ms()` captured when the push tx landed on-chain. |

Freshness is taken as the **minimum** of the two:

```move
fun pyth_spot_is_fresh(config: &PricingConfig, pyth: &PythSource, clock: &Clock): bool {
    let now = clock.timestamp_ms();
    let timestamp = pyth.source_timestamp_ms().min(pyth.update_timestamp_ms());
    timestamp > 0 && timestamp <= now && now - timestamp <= config.pyth_spot_freshness_ms
}
```

Why the min? It defends against two distinct attacks:

- **Stale publisher**: source timestamp old but landed recently → caught by
  source comparison.
- **Sandwich/timewarp**: forged old payload submitted recently → caught
  because publisher's timestamp can't be in the future.

Defaults (from `tuning_constants`):

- `pyth_spot_freshness_ms`: **2_000 ms** for live quoting
- `block_scholes_prices_freshness_ms`: **3_000 ms**
- `block_scholes_svi_freshness_ms`: **60_000 ms** (SVI changes slowly)
- `settlement_freshness_ms`: **3_000 ms**
- `max_freshness_threshold_ms` (admin ceiling): **60_000 ms**

---

## 5. Settlement — two sources, oldest-wins

Once a market reaches `PENDING_SETTLEMENT`, settlement can come from **either**
the Pyth source or the operator's last Block Scholes push. The selector is:

```move
fun valid_settlement_spot_source(
    market: &MarketOracle,
    pyth: &PythSource,
    clock: &Clock,
): Option<u8>
```

A source is **valid** for settlement if:

1. Its `source_timestamp_ms` is **strictly after** `market.expiry`. (Pre-expiry
   prices can't define the settlement — that's the whole point.)
2. The `min(source_timestamp, update_timestamp)` is within
   `bounds.settlement_freshness_ms` of `now`. (No stale settles.)
3. The timestamps are not in the future.

If both sources qualify, **the earlier `source_timestamp_ms` wins**
(`pyth_source_timestamp_ms <= block_scholes_source_timestamp_ms` → Pyth).
Earliest-wins is the conservative choice: it limits the operator's window to
inject a different settlement after the canonical Pyth print has landed.

The chosen source then writes:

```move
public struct SettlementState has copy, drop, store {
    price: u64,                  // the spot at settlement
    source: u8,                  // SOURCE_PYTH = 1 or SOURCE_BLOCK_SCHOLES = 2
    source_timestamp_ms: u64,
    update_timestamp_ms: u64,
}
```

Anyone can trigger settlement by calling `settle_if_possible(market, pyth,
cap, clock)`. The function is **idempotent** — `STATUS_SETTLED` markets just
return `false`. The cap is required only to authorize *which* operator key
triggered the call (for audit), not to gate the price choice.

> **Subtle game-theoretic point.** The operator could conceivably hold back a
> Block Scholes push until it sees the live Pyth print, then either push a
> matching/different settle-time spot OR refuse to push, forcing Pyth-only.
> The "earliest source timestamp wins" rule limits this: if a fresh Pyth print
> with `source_timestamp > expiry` has landed and is still inside the freshness
> window, the operator cannot displace it.

---

## 6. Layer 3 — pricing: stateless quoting on top

`pricing.move` is read-only: it never mutates oracle or vault state. Its job
is to combine the two writable layers (`PythSource` + `MarketOracle`) into a
single fair-price function used by `predict::mint` etc.

### 6.1 The "fresh forward" resolution

For live quoting, pricing combines layers like so:

```move
let forward = if (pyth_spot_is_fresh(config, pyth, clock)) {
    math::mul(pyth.spot(), market.block_scholes_basis())   // basis = bs_forward / bs_spot
} else {
    market.block_scholes_forward()
};
```

That is: **Pyth spot is canonical when fresh; basis from the latest operator
push synthesizes a forward.** If Pyth is stale, fall back to the operator's
last forward directly.

This is the meaningful design choice: spot moves continuously (cheap), forward
encodes the time-to-expiry component (rare slow-moving update). Synthesizing
forward as `pyth_spot × bs_basis` lets the system track tick-by-tick spot
moves without the operator having to push every block.

### 6.2 SVI fair price

The binary "will price be above strike at expiry" probability comes from a
Gatheral SVI surface fit to the strike grid. The math, in
`pricing::compute_nd2`:

```
k          = ln(strike / forward)
w(k)       = a + b · (rho · (k - m) + sqrt((k - m)² + sigma²))   ← SVI total variance
d2         = -((k + w(k)/2) / sqrt(w(k)))
up_price   = N(d2)                                                ← Normal CDF
```

Where `(a, b, rho, m, sigma)` are the five SVI parameters Block Scholes pushes
per market.

`predict_math::normal_cdf` is a polynomial approximation in 1e9 fixed point;
`predict_math::ln` and `predict_math::sqrt` are likewise integer
approximations. There's no on-chain floating point.

The probability is just `up_price` — for a binary above-strike contract, it
equals the implied probability of the UP outcome.

### 6.3 Fees on top

`quote_fee_rate` adds two components to the fair price:

- **Bernoulli component**: `base_fee × sqrt(price × (1 - price))`. Peaks at
  `p = 0.5` (max uncertainty), goes to 0 at the tails. Floors at `min_fee`.
- **Utilization component**: `base_fee × util_mult × (liability/balance)²`.
  Scales quadratically with vault utilization.

The all-in price `fair_price + fee_rate` must fall inside
`[min_ask_price, max_ask_price]` (default `[1%, 99%]` of 1e9), otherwise
`assert_mint_quote_allowed` aborts.

---

## 7. Operator topology and lifecycle

Putting the pieces together, a single market's lifecycle is:

```
T = 0    Operator runs registry::create_oracle(...)
         → MarketOracle (new) with expiry T + 75 min, bounds + cap
         → bound to existing PythSource for the asset
T = 1s   Operator: update_block_scholes_prices(market, pyth, cap, spot, forward, src_ts, clock)
         Operator: update_svi(market, cap, params, src_ts, clock)
         Now ACTIVE — quotes work
T = 2s   Anyone with a verified Pyth Lazer update:
         pyth_source::update_from_lazer(pyth, update, clock)
         → spot refreshed continuously without operator
T = 0–75 min  Loop: operator refreshes forward + SVI on cadence
                    (default freshness 3 s for forward, 60 s for SVI);
                    community refreshes Pyth spot on demand.
T = 75 min   market.expiry reached → status = PENDING_SETTLEMENT
T = 75 min + (a few seconds)
             Pyth Lazer publishes a post-expiry print.
             Anyone calls market_oracle::settle_if_possible(...).
             → settlement set; status = SETTLED.
             → existing positions can now redeem at the canonical price.
```

In parallel, every 15 minutes the operator creates the next overlapping
`MarketOracle` so users always have a fresh market to mint into.

---

## 8. Function reference (the ones that matter for replication)

### `pyth_source` module

| Function | Visibility | Purpose |
|---|---|---|
| `create(feed_id, ctx)` | `public(package)` | Bootstrap a shared PythSource for an asset. |
| `update_from_lazer(source, update, clock)` | `public` | Permissionless spot refresh. The only mutator. |
| `spot(source)` | `public` | Latest 1e9-scaled spot. |
| `source_timestamp_ms`, `update_timestamp_ms` | `public` | Used by freshness checks elsewhere. |
| `feed_id(source)` | `public` | Bound Pyth Lazer feed id, for cross-checks. |
| `id(source)` | `public` | For comparing against `MarketOracle.pyth_source_id`. |

### `market_oracle` module

| Function | Visibility | Purpose |
|---|---|---|
| `create(pyth_source_id, expiry, bounds, cap, ctx)` | `public(package)` | New per-expiry oracle, bound to a Pyth source. |
| `update_block_scholes_prices(market, pyth, cap, spot, forward, src_ts, clock)` | `public` | Operator pushes forward + spot snapshot. Validates basis bounds + deviations + freshness. |
| `update_svi(market, cap, svi, src_ts, clock)` | `public` | Operator pushes SVI surface params. |
| `settle_if_possible(market, pyth, cap, clock)` | `public` | Permissionless trigger; picks best post-expiry source and freezes settlement. |
| `set_settlement_freshness_ms`, `set_basis_bounds` | `public` | Operator retuning within hard ceilings. |
| `register_cap`, `unregister_cap`, `self_unregister_cap` | `public(package)` | Multi-cap rotation. |
| `status(market, clock)` | `public` | One of `STATUS_ACTIVE`, `STATUS_PENDING_SETTLEMENT`, `STATUS_SETTLED`. |
| `raw_settlement_price(market)` | `public` | `Option<u64>` — `Some` only when settled. App code should prefer `pricing::settlement_price`. |
| `block_scholes_spot`, `block_scholes_forward`, `block_scholes_svi` | `public` | Latest operator-pushed values. |
| `block_scholes_*_timestamp_ms` | `public` | Freshness inputs. |
| `block_scholes_basis` | `public(package)` | `forward / spot`, used by pricing's `live_inputs`. |

### `pricing` module (read-side only)

| Function | Visibility | Purpose |
|---|---|---|
| `settlement_price(market)` | `public` | Settled value, with timestamp guard. |
| `quote_live_range(config, market, pyth, range_key, clock)` | `public(package)` | Mid quote for a range, no fee. |
| `quote_mint_live_range(...)` | `public(package)` | Quote + fee + utilization. |
| `build_live_curve(...)` | `public(package)` | Vector of `(strike, up_price)` across a grid — what UIs draw. |
| `settled_range_payout(settlement, key, quantity)` | `public(package)` | Post-settlement redemption math. |
| `compute_nd2(forward, svi, strike)` | `private` | The SVI+normal-CDF kernel. |

---

## 9. What an independent oracle (Flicky-style) must replicate

If a separate protocol wants the same properties — multi-asset, permissionless
spot, per-expiry settlement, SVI fair pricing — it has to land **all five** of
these:

### 9.1 Pyth Lazer integration, not Pyth Hermes

Hermes is the off-chain REST endpoint. Pulling spot off Hermes and pushing via
an admin cap is **functionally equivalent to the Block Scholes path** — the
keeper becomes a trusted operator. To get permissionless updates you must
consume the on-chain `pyth_lazer::Update` type, which means:

- Add `pyth_lazer` (and `wormhole` for testnet) as Move dependencies with the
  right `dep-replacements` for each environment.
- Vendor or wrap `lazer_helper::extract_spot` for your scaling decisions.
- Expose `update_from_lazer(...)` so anyone can push.

There is no on-chain shortcut. The `LazerUpdate` constructor is
package-scoped to `pyth_lazer`; you can't fake it.

### 9.2 Per-expiry shared object, not a singleton

A single long-lived oracle object that "rolls over" can't carry the
ACTIVE → PENDING → SETTLED state machine — once you settle it, every position
referencing it is forced to that value. DeepBook gets correct accounting by
making each expiry its own object that can be permanently retired. Replicas
must do the same.

### 9.3 Dual-timestamp staleness, not just expiry

The `min(source_timestamp, update_timestamp)` check defends against both
stale-publisher and time-warp attacks, and is the only thing standing between
the system and someone replaying an old payload at expiry-1. Building only an
expiry check is not sufficient for a settlement market.

### 9.4 Basis bounds + per-push deviation, not just absolute bounds

The two-layer circuit breaker (per-push delta + absolute floor/ceiling) is
necessary because either alone has known bypasses:

- Absolute bounds alone: many small pushes drift across the entire allowed
  range (slow rug).
- Per-push delta alone: a single bad push within delta still corrupts a long
  series.

Both checks are cheap in Move; there's no reason to skip one.

### 9.5 Settlement source comparison, not single-source

If only one source can settle, that source's operator controls the outcome.
Even when the protocol intends a single source, having a fallback gives the
contract a path to settle when the primary is down at expiry-time — and the
"earliest source-timestamp wins" rule prevents that fallback from being abused
to displace a valid primary.

---

## 10. Implementation roadmap (suggested for Flicky)

Status of each piece in the current Flicky codebase, against the DeepBook
reference:

| Piece | DeepBook reference | Flicky today | Gap |
|---|---|---|---|
| Permissionless spot via Pyth Lazer | `pyth_source.move::update_from_lazer` | Hermes HTTP + admin keeper (`apps/server/src/scripts/keeper.ts`) | **Significant.** Need Move-side `pyth_lazer` dep + on-chain `update_from_lazer` entry. |
| Per-expiry MarketOracle | `market_oracle.move` | `flicky::oracle::FlickyOracle` per expiry | Adequate. Field layout differs but state machine matches. |
| ACTIVE → PENDING → SETTLED status | `market_oracle::status` | `flicky::oracle::status` returning `STATUS_ACTIVE/PENDING/SETTLED` | Equivalent. |
| Dual-timestamp staleness | `(source_timestamp_ms, update_timestamp_ms)` | Same pair on `PriceState` and `SettlementState` | Equivalent. |
| Basis bounds + per-push deviation | `MarketOracleBounds` with 5 fields | `OracleBounds { settlement_freshness_ms, max_spot_deviation }` only | Missing `max_basis_deviation`, `min_basis`, `max_basis`. Add or document why omitted. |
| Settlement source comparison | Pyth vs Block Scholes, earliest wins | Single admin-pushed settlement via `oracle::settle` | Missing fallback path. Could add a Pyth-Lazer-only `settle_from_lazer` once layer 1 is in. |
| SVI fair pricing | `pricing::compute_nd2` (Gatheral SVI + normal CDF) | `flicky::oracle::implied_probability_up` — distance-from-forward heuristic clamped to [5%, 95%] | **Significant divergence.** The simpler model is fine for the hackathon POC but won't quote DeepBook-style range markets. |
| Per-market quoting + fees | `pricing.move` with Bernoulli + utilization fee | None | Acceptable if Flicky is the only consumer (game pays its own fees). |

The realistic order for Flicky to grow toward parity is:

1. **Add basis bounds + per-push deviation tests** to `flicky::oracle::update_price`.
   Cheap, defensive, no external deps.
2. **Add a permissionless `settle_from_pyth` path** that takes a verified
   `LazerUpdate` post-expiry. Removes the admin cap from the settlement path.
3. **Add `update_price_from_lazer`** so the live spot is permissionless. At
   this point Flicky doesn't need a keeper at all — anyone refreshing their
   own duel's oracle is enough.
4. **Replace `approx_p_up` with a proper SVI quoter** if and when range
   markets / non-binary cards are introduced.
5. **Operator rotation cadence**: until the above, a long-running daemon
   inside `apps/server` should automate `oracles:create + keeper + settle` on
   a 15-min lifecycle. This is the temporary equivalent of DeepBook's
   operator keeper.

The path is incremental: each step is independently shippable and each
removes a specific manual operation.

---

## Appendix A — Pyth Lazer dependency snippet

The on-chain Pyth Lazer + Wormhole packages need `dep-replacements` per
environment. From `temp/deepbookv3/packages/predict/Move.toml`:

```toml
[dependencies]
pyth_lazer = { git = "https://github.com/pyth-network/pyth-crosschain.git",
               subdir = "lazer/contracts/sui", rev = "sui-testnet" }

[dep-replacements.testnet]
pyth_lazer = { git = "https://github.com/pyth-network/pyth-crosschain.git",
               subdir = "lazer/contracts/sui", rev = "sui-testnet",
               published-at = "0xf5bd2141967507050a91b58de3d95e77c432cd90d1799ee46effc27430a68c21",
               original-id  = "0xf5bd2141967507050a91b58de3d95e77c432cd90d1799ee46effc27430a68c21" }
wormhole   = { git = "https://github.com/pyth-network/wormhole.git",
               subdir = "sui/wormhole", rev = "sui-testnet",
               published-at = "0xd5afd4e456e5451f1ca1e7b3d734ce7a0a3b397811a6cb72a4bd1dfc387839f2",
               original-id  = "0xd5afd4e456e5451f1ca1e7b3d734ce7a0a3b397811a6cb72a4bd1dfc387839f2" }
```

For mainnet, both addresses are different — fetch from
`pyth-network/pyth-crosschain` at `contract_manager/src/store/contracts/SuiLazerContracts.json`.

## Appendix B — Default tuning constants reference

From `tuning_constants.move`:

| Constant | Default | Hard ceiling | Used for |
|---|---|---|---|
| `block_scholes_prices_freshness_ms` | 3_000 | 60_000 | live quoting validity |
| `block_scholes_svi_freshness_ms` | 60_000 | 60_000 | live quoting validity |
| `pyth_spot_freshness_ms` | 2_000 | 60_000 | live spot canonical window |
| `settlement_freshness_ms` | 3_000 | 60_000 | settlement source validity |
| `max_spot_deviation` | 20_000_000 (2%) | 100_000_000 (10%) | per-push spot circuit-breaker |
| `max_basis_deviation` | 20_000_000 (2%) | 100_000_000 (10%) | per-push basis circuit-breaker |
| `min_basis` | 900_000_000 (0.9) | floor 500_000_000 (0.5) | absolute basis bound |
| `max_basis` | 1_100_000_000 (1.1) | ceiling 2_000_000_000 (2.0) | absolute basis bound |

All values are in 1e9 fixed-point unless noted.
