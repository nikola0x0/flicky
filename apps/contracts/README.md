# @flicky/contracts

Move 2024 smart contract package for **Flicky** (Tinder-style PvP prediction-duel built on top of **DeepBook Predict**) plus TypeScript tooling for deployment, package upgrades, and typed binding generation against the **Sui Testnet**.

---

## 📖 Table of Contents
- [Quick Reference Commands](#quick-reference-commands)
- [System Overview & Architecture](#system-overview--architecture)
- [Move Modules Documentation](#move-modules-documentation)
- [The 4-Step E2E Duel Lifecycle](#the-4-step-e2e-duel-lifecycle)
- [Error Codes Reference](#error-codes-reference)
- [Environment Setup](#environment-setup)
- [Deployment & Tooling Scripts](#deployment--tooling-scripts)
- [Stub Dependency Packages](#stub-dependency-packages)
- [Standalone Swap AMM Pool](#standalone-swap-amm-pool)

---

## ⚡ Quick Reference Commands

Run these commands from the `apps/contracts` directory:

```bash
# Compile and run Move unit tests
bun run test               # Runs: sui move test --gas-limit 100000000000

# Compile the Move codebase
bun run build              # Runs: sui move build

# Deploy to Testnet (requires SUI_DEPLOYER_PRIVATE_KEY in .env.local)
bun run publish

# Upgrade after making any Move contract changes
bun run upgrade

# Regenerate TypeScript bindings from the current Move package
bun run codegen
```

---

## 🏗️ System Overview & Architecture

Flicky bridges social betting (PvP Escrows) with automated binary options markets (DeepBook Predict). The logic operates on two distinct layers:
1. **Flicky Duel Escrow (Staking)**: Two players lock a fixed amount of collateral (e.g. 1, 3, 5, or 10 dUSDC) into a shared `Duel<T>` object.
2. **DeepBook Predict Trading (Gameplay)**: When "swiping" UP or DOWN on a card, players mint actual binary options contracts on-chain using their personal `PredictManager`. This premium is funded separately from their wallet, ensuring option assets belong entirely to them.

### State Transition Machine
```
   [PENDING] (Creator stakes + commits deck hash)
       │
       ▼ (Challenger joins + matches stake)
    [ACTIVE]
       │
       ▼ (Creator reveals deck cards to on-chain)
    [PLAYING]
       │
       ▼ (Both players submit swipes; 10 min window)
  [AWAITING EXPIRY]
       │
       ▼ (Oracles expire; individual cards settled)
  [ALL SETTLED]
       │
       ▼ (Finalize scores and distribute escrow)
   [COMPLETE]
```

---

## 📦 Move Modules Documentation

Located in `sources/`:

*   **`duel.move`**: The core game coordinator. Manages the lifecycle of a `Duel<T>` shared object, processes challenger joins, verifies deck coordinates against committed hashes, records player predictions, settles individual cards against expired Oracles, and distributes rewards.
*   **`pricing.move`**: SVI binary-digital fair pricing calculator. Reads `OracleSVI` spot/forward prices and surface volatility parameters, computing cumulative distribution functions $N(d_2)$ to mirror DeepBook's fair option pricing logic.
*   **`math.move` / `i64.move`**: Fixed-point mathematical libraries (ln, sqrt, exp, normal CDF) ported from `deepbook_predict::math` / `deepbook_predict::i64` for precise on-chain calculations.

---

## 🔄 The 4-Step E2E Duel Lifecycle

### Step 1: Start Duel (Create & Join)
*   **Create**: The Creator stakes a specific amount of `Coin<T>` (e.g., 1 dUSDC) and commits a `deck_hash` (the SHA3-256 hash of the 5 generated cards). The duel is initialized in `STATUS_PENDING`.
*   **Join**: A Challenger calls `join_duel`, staking the exact same amount of `Coin<T>` to match the Creator. The status advances to `STATUS_ACTIVE`, and the game timer starts.

### Step 2: Reveal Deck
*   The Creator calls `reveal_deck`, passing the raw 5 `Card` coordinates (containing Pyth Oracle IDs and strike prices snapped to the grid).
*   The contract validates that:
    $$\text{sha3\_256}(\text{bcs::to\_bytes}(\text{cards})) == \text{deck\_hash}$$
    Once successfully revealed, the cards become visible on-chain, enabling swipes.

### Step 3: Submit Player Swipes
*   Players swipe UP or DOWN sequentially starting from **Card 0 to Card 4** within a **10-minute window** (`started_at_ms + 600,000ms`).
*   To record a swipe, the client runs an atomic Programmable Transaction Block (PTB):
    1.  Mints the binary option contract via `predict::mint`, utilizing the player's personal `PredictManager`.
    2.  Calls `duel::record_swipe`, verifying that the player's `PredictManager` holds a sufficient balance of the minted position to back their prediction.

### Step 4: Settle & Finalize
*   **Settle Card**: Once an individual card's Pyth Oracle reaches its expiry and is resolved on-chain, `settle_card` can be called. The contract compares the Oracle's final `settlement_price` against the card's `strike` to determine which player guessed correctly, calculating card-level PnL.
*   **Finalize**: After all 5 cards are settled, `finalize` is called. The system compares the sum of the PnL of both players:
    $$\text{Score}_p = \sum_{i=0}^4 (\text{Payout}_i - \text{Premium}_i)$$
    The player with the higher score claims the entire escrowed stake pool. In the event of a tie, stakes are refunded.

---

## 🚨 Error Codes Reference

Listed below are the exception abort codes defined in `duel.move`:

| Code | Constant | Description |
| :---: | :--- | :--- |
| **0** | `ENotPlayer` | The signer is neither the Creator nor the Challenger of this duel. |
| **1** | `EDuelNotPending` | Operation requires a pending duel, but the duel status has already moved forward. |
| **2** | `EDuelNotActive` | Operation requires an active duel (e.g. swipes, settle, finalize). |
| **3** | `EAlreadyJoined` | A challenger has already joined this duel. |
| **4** | `ECreatorCannotJoin` | The creator is attempting to challenge/join their own duel. |
| **5** | `EStakeMismatch` | The challenger's staking amount does not match the creator's staking tier. |
| **6** | `EInvalidDeckSize` | The revealed cards vector length is not exactly `DECK_SIZE` (5). |
| **7** | `ECardIndexOOB` | The target card index is out of bounds (must be 0-4). |
| **8** | `EOracleMismatch` | The passed oracle object does not match the committed oracle ID for this card index. |
| **9** | `EOutOfTurn` | Swipe was submitted out of order. Cards must be swiped sequentially from Card 0 to 4. |
| **10** | `ECardAlreadySettled` | The card at this index has already been settled. |
| **11** | `EAllCardsNotSettled` | Finalization failed because some cards in the deck have not been settled yet. |
| **13** | `EZeroStake` | The staking amount for creating a duel must be greater than zero. |
| **14** | `EOracleNotLive` | The Oracle does not have a `settlement_price` yet (either not expired or not resolved). |
| **15** | `EInvalidDeckHash` | The submitted deck hash is empty or invalid. |
| **16** | `EDeckAlreadyRevealed` | The deck cards have already been revealed on-chain. |
| **17** | `EDeckHashMismatch` | The revealed cards do not match the deck hash committed during creation. |
| **18** | `EDeckNotRevealed` | Swiping is blocked because the creator has not revealed the deck (Step 2). |
| **19** | `ENotManagerOwner` | The sender does not own the `PredictManager` passed to record the swipe. |
| **20** | `EZeroPositionQuantity` | The swipe quantity is zero or exceeds the options owned inside the `PredictManager`. |
| **21** | `ESwipeTimeout` | The 10-minute swiping window has expired. |

---

## ⚙️ Environment Setup

1.  Copy `.env.example` to `.env.local`:
    ```bash
    cp .env.example .env.local
    ```
2.  Export your active Sui keypair to retrieve the private key:
    ```bash
    sui keytool export --key-identity $(sui client active-address)
    ```
3.  Paste the output `suiprivkey1q...` string as the value for `SUI_DEPLOYER_PRIVATE_KEY` in `.env.local`.

---

## 🛠️ Deployment & Tooling Scripts

*   **`scripts/publish.ts`**: Deploys the package to Testnet and writes `deployed.json` containing:
    *   `packageId`: The active package ID.
    *   `originalPackageId`: The immutable genesis package ID (preserved across upgrades).
    *   `upgradeCap`: The object authorizing upgrades.
*   **`scripts/upgrade.ts`**: Upgrades the package using the `upgradeCap`, updates `deployed.json`, and injects the new `packageId` directly into `apps/web/.env.local`.
*   **`scripts/codegen.ts`**: Uses `@mysten/codegen` to parse Move build artifacts and output type-safe `moveCall` bindings under `apps/web/src/sui/gen/`. This eliminates hand-rolled call signatures and manual BCS serialization.

---

## 📦 Stub Dependency Packages

Three minimal "stub" Move packages are included to facilitate local compilation against on-chain dependencies:

| Stub Package | Bound Address | Description |
| :--- | :--- | :--- |
| `deepbook_predict_min/` | `0xf5ea2b3749…` | Declares the public structs and signatures (`predict::*`, `predict_manager::*`, `OracleSVI`) for DeepBook Predict. |
| `deepbook_min/` | `0x74cd5657…` | Declares dependency signatures for DeepBook v3 core. Required because `deepbook_predict` references core math structures. |
| `token_min/` | `0x36dbef86…` | Declares the SUI Token/Deep package stubs required transitively. |

> [!NOTE]
> The compiler tree-shakes empty stubs out of compilation. During deployment, `publish.ts` automatically maps these stubs to the official on-chain packages (e.g. DeepBook Predict main package).

---

## 🪙 Standalone Swap AMM Pool

Located in the [swap/](file:///Users/alvin/Developer/sui-flow/flicky/apps/contracts/swap/) directory:
A Constant Product ($x \cdot y = k$) AMM pool deployed to facilitate instant, slippage-protected test swaps between **SUI** and **dUSDC**.

*   **Testnet Package ID**: `0x51ea0f29321f3c25f8b2f530ecd3ed3dec569d954c8832d318de7e203653a936`
*   **Upgrade Cap**: `0x676dcb5f4a83791aed86c7a2f0488a75caa93aa49f90b22b98b30a17ebe8c178`

For setup, code breakdown, and test execution details, see the standalone [swap/README.md](file:///Users/alvin/Developer/sui-flow/flicky/apps/contracts/swap/README.md).
