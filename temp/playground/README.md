# 🔬 DeepBook Predict Playground

A standalone React frontend playground for testing all DeepBook Predict functions on Sui testnet.

> [!NOTE]
> Read the complete [Playground Guide](file:///Users/alvin/Developer/sui-flow/flicky/temp/playground/PLAYGROUND_GUIDE.md) for a detailed walkthrough of all tabs, how to use them, and core concepts.

## Setup

### 1. Install Dependencies

```bash
cd temp/playground
bun install
```

### 2. Configure Environment

Copy `.env.example` to `.env.local` and fill in your testnet values:

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```
VITE_NETWORK=testnet
VITE_PREDICT_PACKAGE_ID=0x...          # DeepBook Predict package ID
VITE_REGISTRY_ID=0x...                 # Registry shared object ID
VITE_PREDICT_OBJECT_ID=0x...           # Predict shared object ID (optional, can be derived)
VITE_MARKET_ORACLE_ID=0x...            # Your test market oracle ID
VITE_PYTH_SOURCE_ID=0x...              # Pyth source ID
VITE_DUSDC_PACKAGE_ID=0x...            # dUSDC package ID
```

### 3. Run Development Server

```bash
bun dev
```

Opens http://localhost:5173 automatically.

## Features

### Panels

| Panel | Functions |
|-------|-----------|
| **Manager** | Create manager, deposit/withdraw dUSDC, view balance |
| **Trading** | Mint positions, redeem (live/settled auto-detect) |
| **LP** | Supply/withdraw vault liquidity |
| **Keeper** | Redeem permissionless, refresh MTM, compact oracle |
| **Oracle** | Read market status, settlement price, BS prices |

### Key Capabilities

- ✅ **Wallet connection** via dapp-kit (supports all Sui wallets)
- ✅ **Transaction building** using @mysten/sui Transaction API
- ✅ **Read-only calls** via devInspectTransactionBlock
- ✅ **JSON output** for all results with copy-to-clipboard
- ✅ **Explorer links** for transaction digests
- ✅ **Dark mode** developer UI

## How to Use

### 1. Connect Wallet

Click the connect button in the top-right. Any Sui wallet works.

### 2. Create Manager

1. Go to **Manager** panel
2. Click **Create Manager** button
3. Confirm transaction in wallet
4. Copy the manager ID for future transactions

### 3. Deposit dUSDC

1. Go to **Manager** panel
2. Paste manager ID
3. Click **Deposit** (auto-detects your dUSDC coin)
4. Confirm transaction

### 4. Mint a Position

1. Go to **Trading** panel
2. Enter your manager ID
3. Set strike range:
   - **Lower Strike**: 0 for down bets
   - **Higher Strike**: 18446744073709551615 for up bets
4. Enter quantity
5. Click **Mint**

### 5. Redeem Position

Same as mint, but click **Redeem** instead. Automatically detects if market is settled.

## Example: UP Bet (Bull Call)

To bet the price will go UP:

| Field | Value |
|-------|-------|
| Lower Strike | `95000000000000000` (price floor in 9-decimal) |
| Higher Strike | `18446744073709551615` (u64::MAX) |
| Quantity | `1000000000` (1 dUSDC in smallest units) |

Win if final price > lower strike.

## Example: DOWN Bet (Bear Put)

To bet the price will go DOWN:

| Field | Value |
|-------|-------|
| Lower Strike | `0` |
| Higher Strike | `100000000000000000` (price ceiling in 9-decimal) |
| Quantity | `1000000000` |

Win if final price ≤ higher strike.

## Architecture

```
src/
├── main.tsx              # Provider setup
├── config.ts             # Config from .env
├── lib/
│   ├── client.ts         # SuiClient singleton
│   └── predict-txb.ts    # All PTB builders
├── components/
│   ├── WalletBar.tsx
│   ├── OutputPanel.tsx
│   └── panels/
│       ├── ManagerPanel.tsx
│       ├── TradingPanel.tsx
│       ├── LPPanel.tsx
│       ├── KeeperPanel.tsx
│       └── OraclePanel.tsx
└── index.css             # Tailwind
```

## Transaction Builders

All Move functions are in `src/lib/predict-txb.ts`:

```typescript
import { txMint, txRedeem, txSupply, txWithdrawLP } from './lib/predict-txb'
import { Transaction } from '@mysten/sui/transactions'

const tx = new Transaction()
txMint(tx, managerId, oracleId, pythSourceId, lower, higher, quantity)
// ... use tx with useSignAndExecuteTransaction()
```

## Common Issues

### "Manager ID required"

Create a manager first on the **Manager** panel.

### "No DUSDC coins found"

Ensure you have dUSDC in your wallet. Supply comes from testnet faucets or prior trades.

### Transaction fails with "oracle not active"

The market must be ACTIVE (not expired, not settled) for mint operations.

### "Configuration missing"

Check `.env.local` has all required IDs. Use Sui Explorer to find them.

## Testnet Addresses

Get addresses from:

1. **Sui Explorer**: https://testnet.suiscan.xyz/
2. **DeepBook docs**: https://github.com/mystenlabs/deepbookv3
3. Your own deployment output

## Build for Production

```bash
bun build
```

Output: `dist/`

## Troubleshooting

Enable browser dev tools (F12) console for detailed errors.

Check network tab for failed RPC calls.

Ensure `.env.local` variables match deployed addresses exactly.

## License

MIT
