/**
 * DeepBook Predict integration — staked-tier swipes.
 *
 * Each staked swipe is an atomic PTB combining:
 *   - `deepbook_predict::predict::mint(...)` — creates a real Predict position
 *     on DeepBook with dUSDC from the player's PredictManager
 *   - `flicky::duel::record_swipe_deepbook(...)` — records the swipe in the
 *     Flicky duel for score-based PvP payout
 *
 * The player must own a `PredictManager` and have dUSDC in its balance before
 * staked swipes will succeed. Free-tier swipes (FlickyOracle path) do not
 * need any of this.
 *
 * TESTNET BLOCKERS (as of writing):
 *   - DeepBook hasn't created a fresh BTC `OracleSVI` in days; `predict::mint`
 *     will abort `EMarketNotActive` until rotation resumes.
 *   - dUSDC has no public faucet; players need an existing source.
 */
import { Transaction } from "@mysten/sui/transactions"
import type { SuiClient, SuiObjectResponse } from "@mysten/sui/client"
import { SUI_CLOCK_OBJECT_ID, normalizeSuiObjectId } from "@mysten/sui/utils"
import { bcs } from "@mysten/sui/bcs"
import { CONFIG } from "./config"

/** Hard-coded testnet object IDs for DeepBook Predict. */
export const DEEPBOOK = {
  predictPackage: CONFIG.deepbookPredictPackageId,
  /** Singleton `Predict` shared object; the protocol entry-point state. */
  predictObject:
    import.meta.env.VITE_DEEPBOOK_PREDICT_OBJECT_ID ??
    "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a",
  /** Registry tracking oracle IDs per asset. */
  registry:
    import.meta.env.VITE_DEEPBOOK_REGISTRY_ID ??
    "0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64",
  /** Canonical dUSDC coin type on testnet (1e6 decimals). */
  dusdcType:
    "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC",
} as const

const PACKAGE = DEEPBOOK.predictPackage
const PREDICT_MANAGER_TYPE = `${PACKAGE}::predict_manager::PredictManager`

// === Discovery ===

/**
 * Find the PredictManager owned by `address`. DeepBook's `create_manager`
 * transfers the new manager to the caller, so each player has at most one.
 */
export async function findPredictManager(
  client: SuiClient,
  address: string,
): Promise<{ id: string; balanceDusdc: bigint } | null> {
  const owned = await client.getOwnedObjects({
    owner: address,
    filter: { StructType: PREDICT_MANAGER_TYPE },
    options: { showContent: true },
  })
  const first = owned.data[0]
  if (!first || !first.data) return null
  const id = normalizeSuiObjectId(first.data.objectId)
  // PredictManager wraps a BalanceManager; reading its dUSDC balance requires
  // an on-chain devInspect (or recursively walking the BalanceManager). For
  // UI purposes we just report the raw object ID here; balance is fetched
  // separately via `getDusdcBalance` on the *owner*, which is simpler and
  // matches the deposit-from-wallet flow.
  return { id, balanceDusdc: 0n }
}

/** Return the player's spendable dUSDC balance in their wallet (not in manager). */
export async function getWalletDusdcBalance(
  client: SuiClient,
  address: string,
): Promise<bigint> {
  const coins = await client.getCoins({
    owner: address,
    coinType: DEEPBOOK.dusdcType,
  })
  let total = 0n
  for (const c of coins.data) total += BigInt(c.balance)
  return total
}

/**
 * Read dUSDC balance held by a PredictManager via devInspect of
 * `predict_manager::balance<DUSDC>`.
 */
export async function getManagerDusdcBalance(
  client: SuiClient,
  managerId: string,
): Promise<bigint> {
  const tx = new Transaction()
  tx.moveCall({
    target: `${PACKAGE}::predict_manager::balance`,
    typeArguments: [DEEPBOOK.dusdcType],
    arguments: [tx.object(managerId)],
  })
  const res = await client.devInspectTransactionBlock({
    sender: "0x0000000000000000000000000000000000000000000000000000000000000000",
    transactionBlock: tx,
  })
  const ret = res.results?.[0]?.returnValues?.[0]
  if (!ret) return 0n
  return BigInt(bcs.U64.parse(Uint8Array.from(ret[0])))
}

// === PTB builders ===

/**
 * Create a PredictManager for the caller. One-time setup per player.
 * On-chain `predict::create_manager(ctx)` transfers the new manager to
 * `ctx.sender()`.
 */
export function buildCreateManagerTx(): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${PACKAGE}::predict::create_manager`,
    arguments: [],
  })
  return tx
}

/**
 * Deposit dUSDC from the player's wallet into their PredictManager. The
 * coin to spend is picked from the gas wallet's owned dUSDC coins; we split
 * `amountMicroDusdc` (6-decimal scaling) into a fresh coin first.
 */
export async function buildDepositDusdcTx(
  client: SuiClient,
  owner: string,
  managerId: string,
  amountMicroDusdc: bigint,
): Promise<Transaction> {
  const coins = await client.getCoins({ owner, coinType: DEEPBOOK.dusdcType })
  if (coins.data.length === 0) {
    throw new Error("no dUSDC coins to deposit")
  }
  const tx = new Transaction()
  // Merge all dUSDC coins into the first, then split off the deposit amount.
  const [primary, ...rest] = coins.data.map((c) => tx.object(c.coinObjectId))
  if (rest.length > 0) tx.mergeCoins(primary, rest)
  const [deposit] = tx.splitCoins(primary, [tx.pure.u64(amountMicroDusdc)])
  tx.moveCall({
    target: `${PACKAGE}::predict_manager::deposit`,
    typeArguments: [DEEPBOOK.dusdcType],
    arguments: [tx.object(managerId), deposit],
  })
  return tx
}

/** Withdraw dUSDC from a PredictManager back to the owner's wallet. */
export function buildWithdrawDusdcTx(
  managerId: string,
  amountMicroDusdc: bigint,
  recipient: string,
): Transaction {
  const tx = new Transaction()
  const coin = tx.moveCall({
    target: `${PACKAGE}::predict_manager::withdraw`,
    typeArguments: [DEEPBOOK.dusdcType],
    arguments: [tx.object(managerId), tx.pure.u64(amountMicroDusdc)],
  })
  tx.transferObjects([coin], tx.pure.address(recipient))
  return tx
}

/**
 * Atomic staked swipe: mint a binary Predict position on DeepBook AND record
 * the swipe in the Flicky duel.
 *
 * `quantity` is in dUSDC micro-units (1e6 = 1 dUSDC). The dUSDC is debited
 * from the player's PredictManager; the position pays `quantity` if correct.
 *
 * Will abort:
 *   - `EMarketNotActive` if the OracleSVI isn't ACTIVE
 *   - insufficient PredictManager balance
 *   - flicky `EOracleNotLive` if the oracle is expired
 *   - flicky `EOutOfTurn` etc. (standard swipe guards)
 */
export function buildStakedSwipeTx(args: {
  flickyPackageId: string
  duelId: string
  oracleSviId: string
  managerId: string
  oracleExpiry: bigint
  strike: bigint
  isUp: boolean
  quantity: bigint
  cardIdx: number
  stakeType: string
}): Transaction {
  const tx = new Transaction()

  // 1. Build MarketKey for the chosen direction.
  const buildFn = args.isUp ? "up" : "down"
  const marketKey = tx.moveCall({
    target: `${PACKAGE}::market_key::${buildFn}`,
    arguments: [
      tx.pure.address(args.oracleSviId), // object::ID is BCS-equivalent to address
      tx.pure.u64(args.oracleExpiry),
      tx.pure.u64(args.strike),
    ],
  })

  // 2. Mint the real DeepBook position.
  tx.moveCall({
    target: `${PACKAGE}::predict::mint`,
    arguments: [
      tx.object(DEEPBOOK.predictObject),
      tx.object(args.managerId),
      tx.object(args.oracleSviId),
      marketKey,
      tx.pure.u64(args.quantity),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  })

  // 3. Record the swipe in the Flicky duel — same OracleSVI, atomic.
  tx.moveCall({
    target: `${args.flickyPackageId}::duel::record_swipe_deepbook`,
    typeArguments: [args.stakeType],
    arguments: [
      tx.object(args.duelId),
      tx.object(args.oracleSviId),
      tx.pure.u64(BigInt(args.cardIdx)),
      tx.pure.bool(args.isUp),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  })

  return tx
}

/**
 * Keeper path: after the OracleSVI is settled, anyone can call
 * `predict::redeem_permissionless` to push the Predict position payout into
 * the player's manager.
 *
 * Pair this with `flicky::duel::settle_card_deepbook + finalize` (existing) to
 * close the loop on both DeepBook positions and the Flicky side-pot.
 */
export function buildRedeemPermissionlessTx(args: {
  managerId: string
  oracleSviId: string
  oracleExpiry: bigint
  strike: bigint
  isUp: boolean
  quantity: bigint
}): Transaction {
  const tx = new Transaction()
  const buildFn = args.isUp ? "up" : "down"
  const marketKey = tx.moveCall({
    target: `${PACKAGE}::market_key::${buildFn}`,
    arguments: [
      tx.pure.address(args.oracleSviId),
      tx.pure.u64(args.oracleExpiry),
      tx.pure.u64(args.strike),
    ],
  })
  tx.moveCall({
    target: `${PACKAGE}::predict::redeem_permissionless`,
    arguments: [
      tx.object(DEEPBOOK.predictObject),
      tx.object(args.managerId),
      tx.object(args.oracleSviId),
      marketKey,
      tx.pure.u64(args.quantity),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  })
  return tx
}

// === Helpers ===

export function fmtDusdc(microUnits: bigint): string {
  return `${(Number(microUnits) / 1e6).toFixed(4)} dUSDC`
}

/**
 * Parse the `created` change matching the new PredictManager out of a
 * `create_manager` tx's objectChanges. Returns the new manager's object ID.
 */
export function extractManagerIdFromChanges(
  changes: SuiObjectResponse[] | { type: string; objectType?: string; objectId?: string }[],
): string | null {
  for (const c of changes) {
    const raw = "type" in c ? c : undefined
    if (!raw) continue
    if (raw.type !== "created") continue
    if (!raw.objectType || !raw.objectType.endsWith("::PredictManager")) continue
    return normalizeSuiObjectId(raw.objectId!)
  }
  return null
}
