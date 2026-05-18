import { SuiClient } from "@mysten/sui/client"
import { Transaction } from "@mysten/sui/transactions"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { SUI_CLOCK_OBJECT_ID, normalizeSuiObjectId } from "@mysten/sui/utils"
import { bcs } from "@mysten/sui/bcs"

export interface OracleConfig {
  packageId: string
  adminCapId: string
  client: SuiClient
  keypair: Ed25519Keypair
}

export interface CreateOracleArgs {
  asset: string
  expiryMs: bigint
  minStrike: bigint
  tickSize: bigint
  numTicks: bigint
  settlementFreshnessMs: bigint
  maxSpotDeviation: bigint // 9-decimal: 200_000_000 = 20%
}

export interface OracleState {
  asset: string
  expiry: bigint
  status: number // 1=ACTIVE, 2=PENDING_SETTLEMENT, 3=SETTLED
  isSettled: boolean
  spot: bigint
  forward: bigint
  volatility: bigint
  priceSourceTimestampMs: bigint
  priceUpdateTimestampMs: bigint
  minStrike: bigint
  tickSize: bigint
  numTicks: bigint
  maxStrike: bigint
  settlementPrice: bigint | null
}

function targetOf(packageId: string, fn: string): `${string}::${string}::${string}` {
  return `${packageId}::oracle::${fn}` as `${string}::${string}::${string}`
}

/**
 * Build + submit a single PTB that calls `create_oracle` once per arg entry.
 * Returns a map of `asset → oracleId` derived by reading the `asset` field
 * of each newly-created shared object — `objectChanges` ordering is not
 * guaranteed to match moveCall order.
 *
 * Batching into one tx also avoids the owned-object version race that would
 * otherwise happen with sequential txs sharing the same AdminCap.
 */
export async function createOracles(
  cfg: OracleConfig,
  argsList: CreateOracleArgs[],
): Promise<Record<string, string>> {
  const tx = new Transaction()
  for (const args of argsList) {
    tx.moveCall({
      target: targetOf(cfg.packageId, "create_oracle"),
      arguments: [
        tx.object(cfg.adminCapId),
        tx.pure.string(args.asset),
        tx.pure.u64(args.expiryMs),
        tx.pure.u64(args.minStrike),
        tx.pure.u64(args.tickSize),
        tx.pure.u64(args.numTicks),
        tx.pure.u64(args.settlementFreshnessMs),
        tx.pure.u64(args.maxSpotDeviation),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    })
  }
  const res = await cfg.client.signAndExecuteTransaction({
    transaction: tx,
    signer: cfg.keypair,
    options: { showObjectChanges: true, showEffects: true },
  })
  if (res.effects?.status.status !== "success") {
    throw new Error(`create_oracle failed: ${JSON.stringify(res.effects?.status)}`)
  }
  await cfg.client.waitForTransaction({ digest: res.digest })

  const createdIds = (res.objectChanges ?? [])
    .filter((c) => c.type === "created" && c.objectType.endsWith("::oracle::FlickyOracle"))
    .map((c) => normalizeSuiObjectId((c as { objectId: string }).objectId))
  if (createdIds.length !== argsList.length) {
    throw new Error(
      `expected ${argsList.length} FlickyOracle objects, got ${createdIds.length}`,
    )
  }

  const objects = await cfg.client.multiGetObjects({
    ids: createdIds,
    options: { showContent: true },
  })
  const out: Record<string, string> = {}
  for (const obj of objects) {
    if (obj.data?.content?.dataType !== "moveObject") continue
    const fields = obj.data.content.fields as Record<string, unknown>
    const asset = String(fields.asset)
    out[asset] = normalizeSuiObjectId(obj.data.objectId)
  }
  return out
}

export async function updatePrice(
  cfg: OracleConfig,
  oracleId: string,
  args: {
    spot: bigint
    forward: bigint
    volatility: bigint
    sourceTimestampMs: bigint
  },
): Promise<string> {
  const tx = new Transaction()
  tx.moveCall({
    target: targetOf(cfg.packageId, "update_price"),
    arguments: [
      tx.object(oracleId),
      tx.object(cfg.adminCapId),
      tx.pure.u64(args.spot),
      tx.pure.u64(args.forward),
      tx.pure.u64(args.volatility),
      tx.pure.u64(args.sourceTimestampMs),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  })
  const res = await cfg.client.signAndExecuteTransaction({
    transaction: tx,
    signer: cfg.keypair,
    options: { showEffects: true },
  })
  if (res.effects?.status.status !== "success") {
    throw new Error(`update_price failed: ${JSON.stringify(res.effects?.status)}`)
  }
  // Wait for the new admin-cap version to be indexed so the next sequential
  // tx in the keeper loop sees the latest object reference.
  await cfg.client.waitForTransaction({ digest: res.digest })
  return res.digest
}

/**
 * Read full oracle state. Uses `getObject` for stored fields plus `devInspect`
 * for derived getters (status, max_strike).
 */
export async function readOracleState(
  client: SuiClient,
  packageId: string,
  oracleId: string,
): Promise<OracleState> {
  const obj = await client.getObject({
    id: oracleId,
    options: { showContent: true, showType: true },
  })
  if (obj.data?.content?.dataType !== "moveObject") {
    throw new Error("oracle is not a Move object")
  }
  const fields = obj.data.content.fields as Record<string, unknown>
  // Nested Move structs come back as { type, fields: {...} }.
  const priceFields = (fields.price as { fields: Record<string, string> }).fields
  const settlementWrap = fields.settlement as { fields: Record<string, string> } | null

  const status = await callReadU8(client, packageId, "status", oracleId, true)
  const maxStrike = await callReadU64(client, packageId, "max_strike", oracleId, false)

  return {
    asset: String(fields.asset),
    expiry: BigInt(String(fields.expiry)),
    status,
    isSettled: settlementWrap !== null,
    spot: BigInt(priceFields.spot),
    forward: BigInt(priceFields.forward),
    volatility: BigInt(priceFields.volatility),
    priceSourceTimestampMs: BigInt(priceFields.source_timestamp_ms),
    priceUpdateTimestampMs: BigInt(priceFields.update_timestamp_ms),
    minStrike: BigInt(String(fields.min_strike)),
    tickSize: BigInt(String(fields.tick_size)),
    numTicks: BigInt(String(fields.num_ticks)),
    maxStrike,
    settlementPrice: settlementWrap !== null ? BigInt(settlementWrap.fields.price) : null,
  }
}

/**
 * devInspect call to a read-only entry that takes (&FlickyOracle, &Clock) and returns u64.
 */
export async function impliedProbabilityUp(
  client: SuiClient,
  packageId: string,
  oracleId: string,
  strike: bigint,
): Promise<bigint> {
  const tx = new Transaction()
  tx.moveCall({
    target: targetOf(packageId, "implied_probability_up"),
    arguments: [
      tx.object(oracleId),
      tx.pure.u64(strike),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  })
  return await devInspectU64(client, tx)
}

// --- helpers ---

async function callReadU64(
  client: SuiClient,
  packageId: string,
  fn: string,
  oracleId: string,
  withClock: boolean,
): Promise<bigint> {
  const tx = new Transaction()
  const args = [tx.object(oracleId)]
  if (withClock) args.push(tx.object(SUI_CLOCK_OBJECT_ID))
  tx.moveCall({ target: targetOf(packageId, fn), arguments: args })
  return await devInspectU64(client, tx)
}

async function callReadU8(
  client: SuiClient,
  packageId: string,
  fn: string,
  oracleId: string,
  withClock: boolean,
): Promise<number> {
  const tx = new Transaction()
  const args = [tx.object(oracleId)]
  if (withClock) args.push(tx.object(SUI_CLOCK_OBJECT_ID))
  tx.moveCall({ target: targetOf(packageId, fn), arguments: args })
  const bytes = await devInspectFirstReturn(client, tx)
  return bcs.U8.parse(Uint8Array.from(bytes))
}

async function devInspectU64(client: SuiClient, tx: Transaction): Promise<bigint> {
  const bytes = await devInspectFirstReturn(client, tx)
  return BigInt(bcs.U64.parse(Uint8Array.from(bytes)))
}

async function devInspectFirstReturn(
  client: SuiClient,
  tx: Transaction,
): Promise<number[]> {
  const res = await client.devInspectTransactionBlock({
    sender: "0x0000000000000000000000000000000000000000000000000000000000000000",
    transactionBlock: tx,
  })
  if (res.effects.status.status !== "success") {
    throw new Error(`devInspect failed: ${JSON.stringify(res.effects.status)}`)
  }
  const ret = res.results?.[0]?.returnValues?.[0]
  if (!ret) throw new Error("no return value from devInspect")
  return ret[0]
}
