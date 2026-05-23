# 🔬 DeepBook Predict Playground: Complete Usage Guide

Welcome to the **DeepBook Predict Playground**! This guide explains the purpose of the playground, details how to use each of its tabbed panels, defines core protocol concepts, and walks you through typical testing workflows.

---

## 🎯 What is the Predict Playground?

The **DeepBook Predict Playground** is an interactive, developer-centric frontend designed to test and interact with the **DeepBook Predict** protocol on the Sui Testnet. 

DeepBook Predict is a decentralized, binary and range prediction market protocol where users can trade options based on underlying assets (e.g., BTC, SUI) and oracle-driven outcomes. 

The playground acts as a control panel allowing developers, traders, and protocol operators to:
1. **Manage user accounts and funds** via a `PredictManager`.
2. **Execute option trades** (Range positions and Binary positions) in real-time.
3. **Provide liquidity** (LP) to the underlying pool.
4. **Perform keeper operations** like compacting settled markets and settling positions permissionlessly.
5. **Inspect on-chain oracle states** and protocol configurations directly.

---

## 📂 Tab-by-Tab Usage Guide

### 1. 💼 Manager Panel
The **Manager** panel is your gateway to interacting with the protocol. In DeepBook Predict, users do not trade directly out of their wallets; instead, they interact through a `PredictManager` object.

* **Purpose**: Create, fund, and inspect your personal trading manager.
* **Key Actions**:
  * **Create Manager**: Deploys a new `PredictManager` shared object on-chain owned by your wallet. Copy this ID; you will need it for all trading actions.
  * **Get Active Manager**: Automatically queries the blockchain to discover any `PredictManager` owned by your current connected wallet address, avoiding the need to remember or locally save your manager ID.
  * **Deposit dUSDC**: Deposit test dUSDC from your wallet into the manager's balance to fund your trades.
  * **Withdraw dUSDC**: Withdraw settled payouts and unused collateral back to your wallet.
  * **Balances**: Inspect on-chain dUSDC balances held within your manager wrapper.

---

### 2. 💹 Trading Panel
The **Trading** panel is where you buy and sell prediction contracts. It supports both **Range Positions** (price bands) and **Binary Positions** (direction bets).

* **Purpose**: Open and close options contracts based on active oracle prices.
* **Key Fields**:
  * **Market Oracle ID**: The specific market contract to trade (defaults to the latest discovered oracle).
  * **Lower & Higher Strikes (Range)**: Define the floor and ceiling prices. You can use `-∞` (0) or `+∞` (u64 max) for one-sided directional bounds.
  * **Strike Price & Direction (Binary)**: Define a single strike barrier and bet whether the final price settles **UP (Bullish)** or **DOWN (Bearish)** relative to it.
  * **Contracts Quantity**: The size of the trade.
* **Key Actions**:
  * **Preview Price**: Queries the on-chain trade matching logic using `devInspect` to estimate the **Mint Cost** and **Redeem Payout** for a single contract before executing.
  * **Buy (Mint)**: Uses your manager's dUSDC balance to open the options contract.
  * **Sell (Redeem)**: Closes an owned contract. If the oracle has settled, this redeems your winning payout.
* **Active Positions Table**:
  * **Real-time (On-chain)**: Directly queries your `PredictManager` dynamic fields on the Sui blockchain. It displays exactly what contracts you currently own. Clicking **Use** on a position row automatically loads the strike, direction, oracle, and quantity into the input fields, making it easy to sell/redeem.
  * **Indexer PnL**: Fetches position histories and calculates your realized/unrealized profit-and-loss from the indexer database.

---

### 3. 💧 LP Panel
The **LP (Liquidity Provider)** panel allows users to act as market makers for the protocol by supplying collateral to underwrite the trades.

* **Purpose**: Deposit liquidity into the pool to earn trading fees, or withdraw it.
* **Key Actions**:
  * **Supply Liquidity**: Deposit dUSDC from your wallet into the Predict vault. In return, you receive **PLP (Predict LP)** shares representing your portion of the pool.
  * **Withdraw Liquidity**: Burn your PLP shares to redeem your share of dUSDC back from the vault.

---

### 4. 🛠️ Keeper Panel
The **Keeper** panel represents operations typically performed by automated keeper bots, but here made accessible via a manual UI for testing.

* **Purpose**: Maintain the protocol's health, settle expired markets, and view global activity.
* **Key Actions**:
  * **Compact Settled Oracle**: After an oracle settles, its strike data structure can be compacted on-chain. Paste the settled `Oracle ID` and your `OracleSVICap` (which is auto-detected from your wallet) to compress the storage.
  * **Permissionless Redemption**: Settle binary contracts in your manager permissionlessly after expiration.
  * **Recent Protocol Activity Feed**: Shows real-time streams of recent **Mints** and **Settlements** (both Ranges and Binary) across the entire protocol. Use the tabs to toggle views.

---

### 5. 🔮 Oracle Panel
The **Oracle** panel is a diagnostic dashboard to read on-chain market status, calculations, and global parameters.

* **Purpose**: Inspect oracle price feeds, Black-Scholes calculations, and system boundaries.
* **Key Sections**:
  * **Active Oracle Metadata**: Select an oracle to view its expiry, status (`Active`, `Settled`, `PendingSettlement`), spot price, Black-Scholes forward price, and settlement price.
  * **Protocol Rules (Grid)**: Displays system parameters like `Base Spread`, `Min Spread`, `Utilization Multiplier`, and `Max Exposure Pct`.
  * **Raw Bytes Parser**: Input any contract method call to inspect its raw return value.

---

## ⚙️ Core Technical Concepts

### 1. Scaling Factors
To handle fractional values without floating-point issues, the protocol uses large integer scaling factors on-chain:
* **Strikes / Prices**: Scaled by **$10^9$** ($1.00 = 1,000,000,000$).
* **Quantities / dUSDC**: Scaled by **$10^6$** ($1.00 = 1,000,000$).
* *Note: The playground inputs are parsed in friendly decimal format (e.g., entering `74724` and `1.5` contracts) and are scaled automatically before reaching the blockchain.*

### 2. Market Keys
* **`MarketKey` (Binary)**: Contains `oracle_id`, `expiry`, `strike`, and `direction` (0 = UP, 1 = DOWN).
* **`RangeKey` (Range)**: Contains `oracle_id`, `expiry`, `lower_strike`, and `higher_strike`.

---

## 🚀 Step-by-Step Testing Workflow

Follow this sequence to test a complete trade lifecycle:

1. **Get Funded**: Make sure your Sui Testnet wallet has SUI gas tokens and some test dUSDC.
2. **Setup Manager**:
   * Open the **Manager** tab.
   * Click **Create Manager** (or click **Get Active Manager** if you already have one).
   * Copy the generated `PredictManager ID` and paste it into the input field.
3. **Deposit Collateral**:
   * Enter a quantity (e.g., `100` dUSDC) in the deposit box.
   * Click **Deposit to Manager** and approve.
4. **Choose a Market**:
   * Open the **Trading** tab.
   * Look at the **Live Market Info** block to see the current BTC/USD spot price (e.g., `$74,724.00`).
5. **Open a Directional UP Position**:
   * Switch the trading type to **Binary Position**.
   * Enter Strike Price: `74724`.
   * Click **🟢 UP (Bullish)**.
   * Enter Quantity: `10` contracts.
   * Click **Buy (Mint)** and sign the transaction.
6. **Track your Position**:
   * Scroll to the **Active Positions** table.
   * Toggle to **Real-time (On-chain)**. You should see your Binary position listed as `🟢 UP @ 74724.00` with quantity `10.00`.
7. **Close/Redeem the Position**:
   * When you want to exit or if the oracle settles, click **✏️ Use** on the position row.
   * The inputs are populated. Click **📉 Sell (Redeem)** to settle your contract and receive your payout back into your `PredictManager`.
