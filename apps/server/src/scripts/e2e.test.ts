/**
 * End-to-end test against live Sui testnet — predict-testnet-6-24 flow.
 *
 * Exercises the FULL staked-duel lifecycle against real 6-24 DeepBook
 * Predict infrastructure:
 *   fund player 1 → onboard both players' `AccountWrapper`s (create + share
 *   + deposit dUSDC) → discover live BTC `ExpiryMarket`s from the predict
 *   indexer → create/join/reveal a duel → both players ATOMICALLY mint a
 *   real 6-24 position AND record the swipe (one PTB per swipe, chaining
 *   `mint_exact_quantity`'s `order_id` into `duel::record_swipe`) → settle
 *   via the `finalize_test_one_price` dev shortcut → assert a winner.
 *
 * This supersedes the 4-16 version of this file (deleted): that version
 * discovered a settled `OracleSVI`, created a `PredictManager` via
 * `predict::create_manager`, and used JSON-RPC `queryEvents` — all gone in
 * 6-24 (no on-chain oracle scan, account model instead of PredictManager,
 * gRPC + GraphQL replace JSON-RPC).
 *
 * PTB recipes / ids are copied verbatim from this repo's own working code,
 * NOT re-derived from SDK types (see `check-6-24-live.ts`, `keeper.ts`,
 * `predict.ts`, `apps/web/src/lib/deepbook.ts`):
 *   - gRPC `getObject` / `simulateTransaction` / `signAndExecuteTransaction`
 *     / `waitForTransaction` shapes: `check-6-24-live.ts` + `keeper.ts`.
 *   - devInspect + `bcs.Address` decode (wrapper resolution): `predict.ts`'s
 *     `deriveWrapperFor` — reimplemented locally here (see note below) to
 *     avoid `predict.ts`'s Postgres-backed cache, which throws if
 *     `DATABASE_URL` is unset (this test has no DB dependency otherwise).
 *   - atomic mint+record_swipe PTB: `apps/web/src/lib/deepbook.ts`'s
 *     `buildStakedSwipeTx` (account::generate_auth → load_live_pricer →
 *     mint_exact_quantity → duel::record_swipe, same arg order).
 *   - deck hash BCS layout: `deckmaster.ts`'s `CardBcs`/`commitDeck`
 *     (`{ expiry_market_id: bcs.Address, strike: bcs.u64() }`, sha2-256 of
 *     the BCS-serialized vector) — this MUST match `duel.move`'s
 *     `reveal_deck` (`hash::sha2_256(bcs::to_bytes(&cards))`) exactly.
 *   - market discovery + strike snapping: reuses `deckmaster.ts`'s
 *     `selectMarketRows` / `snapToAdmissionTick` / `readBtcSpot` directly
 *     rather than reimplementing.
 *
 * DEVIATION from the task brief's literal wording ("extract the Duel id
 * from objectChanges"): the gRPC `signAndExecuteTransaction` response shape
 * for created-object introspection isn't exercised by any existing repo
 * file, so guessing at its field names would violate the anti-stall
 * directive. Instead this file resolves the created `Duel<T>` id (and later
 * reads the `DuelFinalized` event) via the SAME GraphQL event-query pattern
 * `keeper.ts`'s `sweep()` already uses in production (`events(filter: {
 * type }, last: N) { nodes { contents { json } } }`) — a proven, already-
 * working shape in this codebase. See `queryEventsJson`/`findDuelCreatedId`/
 * `findDuelFinalizedEvent` below.
 *
 * Required env (apps/server/.env / .env.local) — checked in this priority
 * order (SUI_DEPLOYER_PRIVATE_KEY / SUI_KEEPER_PRIVATE_KEY per the task
 * brief's naming; ADMIN_SECRET_KEY as the actually-populated fallback in
 * this repo's `.env` — all three decode to the same funded test address,
 * `0x9826b0…`, confirmed live 2026-07-10 to hold ~92.62 dUSDC + ~3.48 SUI):
 *   - one of SUI_DEPLOYER_PRIVATE_KEY / SUI_KEEPER_PRIVATE_KEY /
 *     ADMIN_SECRET_KEY (bech32 `suiprivkey1…`) — player 0 (creator), must
 *     hold SUI (gas) + dUSDC (stake + account deposit + player-1 funding).
 *   - env.flickyPackageId resolves (apps/contracts/deployed.json or
 *     FLICKY_PACKAGE_ID override).
 *
 * Skipped entirely (describe.skip) when the key or package id is missing,
 * so a default `bun test` run (no secrets, CI) stays green. Run explicitly
 * via `bun test:e2e` — spends real testnet gas + dUSDC.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Transaction, coinWithBalance } from "@mysten/sui/transactions"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"
import { bcs } from "@mysten/sui/bcs"
import { normalizeSuiObjectId, normalizeSuiAddress } from "@mysten/sui/utils"
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { getSuiClient, getGraphQLClient } from "../lib/sui"
import { env } from "../env"
import {
  readBtcSpot,
  selectMarketRows,
  snapToAdmissionTick,
  type MarketRow,
} from "../deckmaster"

// ─── Deck hash — MUST match duel.move's reveal_deck (sha2_256 of the BCS
// vector) and deckmaster.ts's CardBcs field order exactly. ─────────────────

const CardBcs = bcs.struct("Card", {
  expiry_market_id: bcs.Address,
  strike: bcs.u64(),
})
const DeckBcs = bcs.vector(CardBcs)

interface DeckCardIn {
  expiryMarketId: string
  strike: bigint
}

function deckHash(cards: DeckCardIn[]): Uint8Array {
  const bytes = DeckBcs.serialize(
    cards.map((c) => ({
      expiry_market_id: normalizeSuiAddress(c.expiryMarketId),
      strike: c.strike.toString(),
    }))
  ).toBytes()
  return new Uint8Array(createHash("sha256").update(bytes).digest())
}

// ─── Env / gating ───────────────────────────────────────────────────────

const rawKey =
  process.env.SUI_DEPLOYER_PRIVATE_KEY ??
  process.env.SUI_KEEPER_PRIVATE_KEY ??
  process.env.ADMIN_SECRET_KEY
const hasKey = typeof rawKey === "string" && rawKey.startsWith("suiprivkey1")
const hasPackage = typeof env.flickyPackageId === "string"
const canRun = hasKey && hasPackage

// ─── Amounts (kept small — this spends real testnet dUSDC/SUI) ─────────────

const STAKE = 1_000_000n // 1 dUSDC per side
const DEPOSIT = 5_000_000n // 5 dUSDC — each player's AccountWrapper premium float
const P1_FUND_SUI = 500_000_000n // 0.5 SUI — gas for ~8 player-1-signed txs
const P1_FUND_DUSDC = 10_000_000n // 10 dUSDC — covers stake(1) + deposit(5) + buffer
const SWIPE_QTY = 1n // 1 contract per swipe — minimal real mint
const DECK_SIZE = 5
const MARKET_HEADROOM_MS = 5 * 60_000 // markets must clear "now + 5min"

const U64_MAX = 2n ** 64n - 1n
const LEVERAGE_1X = 1_000_000_000n // 1e9-scaled; 1e9 == 1x
const POS_INF_TICK = (1n << 30n) - 1n
const CLOCK = "0x6"

/** UP=(K,+inf], lower=K/tick, higher=pos_inf_tick. DOWN=[0,K], lower=0, higher=K/tick. */
function deriveTicks(strike: bigint, isUp: boolean, tickSize: bigint) {
  const strikeTick = strike / tickSize
  return isUp
    ? { lowerTick: strikeTick, higherTick: POS_INF_TICK }
    : { lowerTick: 0n, higherTick: strikeTick }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── gRPC tx helpers (mirrors keeper.ts's signAndExecuteTransaction /
// waitForTransaction call shape verbatim) ───────────────────────────────

async function signAndWait(
  client: SuiGrpcClient,
  signer: Ed25519Keypair,
  tx: Transaction,
  label: string
): Promise<string> {
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
  })
  if (!(res.$kind === "Transaction" && res.Transaction.status.success)) {
    const reason = res.Transaction?.status.error?.message ?? "unknown"
    throw new Error(`${label} failed: ${reason}`)
  }
  const digest = res.Transaction.digest
  await client.waitForTransaction({ digest })
  return digest
}

// ─── Wrapper resolution — mirrors predict.ts's deriveWrapperFor's
// devInspect shape (existsBytes / addrBytes via bcs.Address.parse), but
// reimplemented locally WITHOUT predict.ts's Postgres cache (getSql()
// throws if DATABASE_URL is unset — this test has no DB dependency
// otherwise, so importing deriveWrapperFor directly would force a DB dep
// onto a test that shouldn't need one). ─────────────────────────────────

async function devInspectReturn(
  client: SuiGrpcClient,
  sender: string,
  build: (tx: Transaction) => void,
  commandIndex = 0
): Promise<Uint8Array | undefined> {
  const tx = new Transaction()
  build(tx)
  tx.setSender(sender)
  const res = await client.core.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
  })
  return res.commandResults?.[commandIndex]?.returnValues?.[0]?.bcs
}

async function derivedWrapperExists(
  client: SuiGrpcClient,
  owner: string
): Promise<boolean> {
  const bytes = await devInspectReturn(client, owner, (tx) => {
    tx.moveCall({
      target: `${env.accountPackageId}::account_registry::derived_wrapper_exists`,
      arguments: [tx.object(env.accountRegistryId), tx.pure.address(owner)],
    })
  })
  if (!bytes) {
    throw new Error(`derived_wrapper_exists(${owner}): no return value`)
  }
  return bcs.bool().parse(bytes)
}

async function derivedWrapperAddress(
  client: SuiGrpcClient,
  owner: string
): Promise<string> {
  const bytes = await devInspectReturn(client, owner, (tx) => {
    tx.moveCall({
      target: `${env.accountPackageId}::account_registry::derived_wrapper_address`,
      arguments: [tx.object(env.accountRegistryId), tx.pure.address(owner)],
    })
  })
  if (!bytes) {
    throw new Error(`derived_wrapper_address(${owner}): no return value`)
  }
  return normalizeSuiObjectId(bcs.Address.parse(bytes))
}

/**
 * Ensure `kp`'s AccountWrapper exists (create + share if absent) and has a
 * fresh `DEPOSIT` dUSDC funding pass. Returns the wrapper id.
 */
async function setupAccount(
  client: SuiGrpcClient,
  kp: Ed25519Keypair
): Promise<string> {
  const owner = kp.toSuiAddress()
  const exists = await derivedWrapperExists(client, owner)
  if (!exists) {
    const tx = new Transaction()
    const wrapper = tx.moveCall({
      target: `${env.accountPackageId}::account_registry::new`,
      arguments: [tx.object(env.accountRegistryId)],
    })
    tx.moveCall({
      target: `${env.accountPackageId}::account::share`,
      arguments: [wrapper],
    })
    await signAndWait(client, kp, tx, `setupAccount(${owner}) new+share`)
  }
  const wrapperId = await derivedWrapperAddress(client, owner)

  const depositTx = new Transaction()
  const auth = depositTx.moveCall({
    target: `${env.accountPackageId}::account::generate_auth`,
  })
  const coin = depositTx.add(
    coinWithBalance({ balance: DEPOSIT, type: env.dusdcCoinType })
  )
  depositTx.moveCall({
    target: `${env.accountPackageId}::account::deposit_funds`,
    typeArguments: [env.dusdcCoinType],
    arguments: [
      depositTx.object(wrapperId),
      auth,
      coin,
      depositTx.object(env.accumulatorRootId),
      depositTx.object(CLOCK),
    ],
  })
  await signAndWait(client, kp, depositTx, `setupAccount(${owner}) deposit`)

  return wrapperId
}

// ─── Market discovery → deck cards (reuses deckmaster.ts's vetted
// filter/snap logic rather than reimplementing it). ─────────────────────

interface DeckCard {
  expiryMarketId: string
  strike: bigint
  tickSize: bigint
}

async function discoverMarkets(n: number): Promise<DeckCard[]> {
  const res = await fetch(`${env.predictIndexerUrl}/markets`)
  if (!res.ok) throw new Error(`GET /markets ${res.status}`)
  const rows = (await res.json()) as MarketRow[]
  const snapshots = selectMarketRows(rows, {
    now: Date.now(),
    minHeadroomMs: MARKET_HEADROOM_MS,
    maxHorizonMs: env.deckCardMaxHorizonMs,
    count: n,
  })
  if (snapshots.length < n) {
    throw new Error(
      `discoverMarkets: only ${snapshots.length} live BTC markets available, need ${n}`
    )
  }
  const spot = await readBtcSpot()
  return snapshots.map((m) => {
    const strikeTick = snapToAdmissionTick(
      spot,
      m.tickSize,
      m.admissionTickSize
    )
    return {
      expiryMarketId: m.expiryMarketId,
      strike: strikeTick * m.tickSize,
      tickSize: m.tickSize,
    }
  })
}

// ─── GraphQL event lookups — mirrors keeper.ts's sweep() query shape ───────

async function queryEventsJson(
  eventType: string,
  last: number
): Promise<Record<string, unknown>[]> {
  const gql = getGraphQLClient()
  const query = `query Ev($type: String!, $last: Int!) {
    events(filter: { type: $type }, last: $last) {
      nodes { contents { json } }
    }
  }`
  const res = (await gql.query({
    query,
    variables: { type: eventType, last },
  })) as {
    data?: {
      events?: {
        nodes?: Array<{ contents: { json: Record<string, unknown> } }>
      }
    }
  }
  return (res.data?.events?.nodes ?? []).map((node) => node.contents.json)
}

async function findDuelCreatedId(
  packageId: string,
  creator: string
): Promise<string> {
  const normalizedCreator = normalizeSuiAddress(creator)
  for (let attempt = 0; attempt < 5; attempt++) {
    const events = await queryEventsJson(`${packageId}::duel::DuelCreated`, 10)
    for (let i = events.length - 1; i >= 0; i--) {
      const j = events[i] as { duel_id: string; creator: string }
      if (normalizeSuiAddress(j.creator) === normalizedCreator) {
        return normalizeSuiObjectId(j.duel_id)
      }
    }
    await sleep(1_000)
  }
  throw new Error(
    "findDuelCreatedId: no DuelCreated event found for creator (indexer lag?)"
  )
}

interface DuelFinalizedJson {
  duel_id: string
  winner: string
  payout_to_p0: string
  payout_to_p1: string
}

async function findDuelFinalizedEvent(
  packageId: string,
  duelId: string
): Promise<DuelFinalizedJson> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const events = await queryEventsJson(
      `${packageId}::duel::DuelFinalized`,
      10
    )
    for (let i = events.length - 1; i >= 0; i--) {
      const j = events[i] as unknown as DuelFinalizedJson
      if (normalizeSuiObjectId(j.duel_id) === duelId) return j
    }
    await sleep(1_000)
  }
  throw new Error(
    "findDuelFinalizedEvent: no DuelFinalized event found (indexer lag?)"
  )
}

// ─── Lifecycle helpers ──────────────────────────────────────────────────

async function createDuel(
  client: SuiGrpcClient,
  p0: Ed25519Keypair,
  packageId: string,
  hash: Uint8Array,
  deckSize: number
): Promise<string> {
  const tx = new Transaction()
  const stake = tx.add(
    coinWithBalance({ balance: STAKE, type: env.dusdcCoinType })
  )
  tx.moveCall({
    target: `${packageId}::duel::create_duel`,
    typeArguments: [env.dusdcCoinType],
    arguments: [
      stake,
      tx.pure.vector("u8", Array.from(hash)),
      tx.pure.u64(BigInt(deckSize)),
    ],
  })
  await signAndWait(client, p0, tx, "create_duel")
  return findDuelCreatedId(packageId, p0.toSuiAddress())
}

async function joinDuel(
  client: SuiGrpcClient,
  p1: Ed25519Keypair,
  packageId: string,
  duelId: string
): Promise<void> {
  const tx = new Transaction()
  const stake = tx.add(
    coinWithBalance({ balance: STAKE, type: env.dusdcCoinType })
  )
  tx.moveCall({
    target: `${packageId}::duel::join_duel`,
    typeArguments: [env.dusdcCoinType],
    arguments: [tx.object(duelId), stake, tx.object(CLOCK)],
  })
  await signAndWait(client, p1, tx, "join_duel")
}

async function revealDeck(
  client: SuiGrpcClient,
  p0: Ed25519Keypair,
  packageId: string,
  duelId: string,
  cards: DeckCard[]
): Promise<void> {
  const tx = new Transaction()
  const cardArgs = cards.map((c) =>
    tx.moveCall({
      target: `${packageId}::duel::new_card`,
      arguments: [tx.pure.id(c.expiryMarketId), tx.pure.u64(c.strike)],
    })
  )
  tx.moveCall({
    target: `${packageId}::duel::reveal_deck`,
    typeArguments: [env.dusdcCoinType],
    arguments: [
      tx.object(duelId),
      tx.makeMoveVec({
        type: `${packageId}::duel::Card`,
        elements: cardArgs,
      }),
    ],
  })
  await signAndWait(client, p0, tx, "reveal_deck")
}

/**
 * ONE PTB: account::generate_auth → expiry_market::load_live_pricer →
 * expiry_market::mint_exact_quantity → flicky::duel::record_swipe, chaining
 * the mint's u256 order id straight into record_swipe. Mirrors
 * apps/web/src/lib/deepbook.ts's `buildStakedSwipeTx` verbatim.
 */
async function atomicSwipe(
  client: SuiGrpcClient,
  kp: Ed25519Keypair,
  packageId: string,
  duelId: string,
  wrapperId: string,
  card: DeckCard,
  cardIdx: number,
  isUp: boolean,
  qty: bigint
): Promise<void> {
  const tx = new Transaction()
  const { lowerTick, higherTick } = deriveTicks(
    card.strike,
    isUp,
    card.tickSize
  )

  const auth = tx.moveCall({
    target: `${env.accountPackageId}::account::generate_auth`,
  })
  const pricer = tx.moveCall({
    target: `${env.deepbookPredictPackageId}::expiry_market::load_live_pricer`,
    arguments: [
      tx.object(card.expiryMarketId),
      tx.object(env.protocolConfigId),
      tx.object(env.oracleRegistryId),
      tx.object(env.pythFeedId),
      tx.object(env.bsSpotFeedId),
      tx.object(env.bsForwardFeedId),
      tx.object(env.bsSviFeedId),
      tx.object(CLOCK),
    ],
  })
  const order = tx.moveCall({
    target: `${env.deepbookPredictPackageId}::expiry_market::mint_exact_quantity`,
    arguments: [
      tx.object(card.expiryMarketId),
      tx.object(wrapperId),
      auth,
      tx.object(env.protocolConfigId),
      pricer,
      tx.pure.u64(lowerTick),
      tx.pure.u64(higherTick),
      tx.pure.u64(qty),
      tx.pure.u64(LEVERAGE_1X),
      tx.pure.u64(U64_MAX),
      tx.pure.u64(U64_MAX),
      tx.object(env.accumulatorRootId),
      tx.object(CLOCK),
    ],
  })
  tx.moveCall({
    target: `${packageId}::duel::record_swipe`,
    typeArguments: [env.dusdcCoinType],
    arguments: [
      tx.object(duelId),
      tx.pure.u64(BigInt(cardIdx)),
      tx.pure.bool(isUp),
      tx.pure.u64(qty),
      order,
      tx.object(CLOCK),
    ],
  })
  await signAndWait(client, kp, tx, `atomicSwipe(card ${cardIdx})`)
}

async function settleAndFinalize(
  client: SuiGrpcClient,
  p0: Ed25519Keypair,
  packageId: string,
  duelId: string,
  price: bigint
): Promise<void> {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::duel::finalize_test_one_price`,
    typeArguments: [env.dusdcCoinType],
    arguments: [tx.object(duelId), tx.pure.u64(price), tx.object(CLOCK)],
  })
  await signAndWait(client, p0, tx, "finalize_test_one_price")
}

// ─── Suite ──────────────────────────────────────────────────────────────

const describeFn = canRun ? describe : describe.skip

describeFn("e2e duel — predict-testnet-6-24 flow", () => {
  let client: SuiGrpcClient
  let packageId: string
  let p0: Ed25519Keypair
  let p1: Ed25519Keypair
  let p0Addr: string
  let p1Addr: string
  let p0Wrapper: string
  let p1Wrapper: string
  let cards: DeckCard[] = []
  let hash: Uint8Array
  let duelId: string | null = null

  beforeAll(async () => {
    const pkg = env.flickyPackageId
    if (!pkg)
      throw new Error("env.flickyPackageId missing — publish flicky first")
    packageId = pkg
    client = getSuiClient()
    const { secretKey } = decodeSuiPrivateKey(rawKey!)
    p0 = Ed25519Keypair.fromSecretKey(secretKey)
    p1 = Ed25519Keypair.generate()
    p0Addr = p0.toSuiAddress()
    p1Addr = p1.toSuiAddress()
    console.log(`flicky package:   ${packageId}`)
    console.log(`p0 (creator):     ${p0Addr}`)
    console.log(`p1 (challenger):  ${p1Addr}`)
  }, 30_000)

  test("funds player 1 with SUI (gas) + dUSDC (stake + account deposit)", async () => {
    const tx = new Transaction()
    const [gas] = tx.splitCoins(tx.gas, [tx.pure.u64(P1_FUND_SUI)])
    const dusdc = tx.add(
      coinWithBalance({ balance: P1_FUND_DUSDC, type: env.dusdcCoinType })
    )
    tx.transferObjects([gas, dusdc], tx.pure.address(p1Addr))
    await signAndWait(client, p0, tx, "fund p1")
  }, 60_000)

  test("sets up both players' AccountWrapper + deposits dUSDC premium float", async () => {
    p0Wrapper = await setupAccount(client, p0)
    p1Wrapper = await setupAccount(client, p1)
    expect(p0Wrapper).toBeTruthy()
    expect(p1Wrapper).toBeTruthy()
    console.log(`p0 wrapper: ${p0Wrapper}`)
    console.log(`p1 wrapper: ${p1Wrapper}`)
  }, 60_000)

  test("discovers live BTC ExpiryMarkets and builds a committed deck", async () => {
    cards = await discoverMarkets(DECK_SIZE)
    expect(cards.length).toBe(DECK_SIZE)
    hash = deckHash(cards)
    console.log(
      `deck: ${cards.map((c) => c.expiryMarketId.slice(0, 10)).join(", ")}`
    )
  }, 30_000)

  test("creates duel, challenger joins, creator reveals deck", async () => {
    duelId = await createDuel(client, p0, packageId, hash, cards.length)
    expect(duelId).toBeTruthy()
    await joinDuel(client, p1, packageId, duelId)
    await revealDeck(client, p0, packageId, duelId, cards)
    console.log(`duel: ${duelId}`)
  }, 120_000)

  test("both players atomically mint + record_swipe every card (p0=UP, p1=DOWN)", async () => {
    if (!duelId) throw new Error("duelId not set — earlier step failed")
    for (let i = 0; i < cards.length; i++) {
      await atomicSwipe(
        client,
        p0,
        packageId,
        duelId,
        p0Wrapper,
        cards[i],
        i,
        true,
        SWIPE_QTY
      )
      await atomicSwipe(
        client,
        p1,
        packageId,
        duelId,
        p1Wrapper,
        cards[i],
        i,
        false,
        SWIPE_QTY
      )
    }
  }, 300_000)

  test("finalize_test_one_price settles + finalizes; DuelFinalized has a winner", async () => {
    if (!duelId) throw new Error("duelId not set — earlier step failed")
    // deck_size=5 is odd and p0=UP/p1=DOWN on every card are complementary
    // outcomes per card, so whichever price we feed, p0-wins + p1-wins ==
    // 5 with no possible tie in card count — a strict winner is guaranteed.
    let price = await readBtcSpot().catch(() => 0n)
    if (price <= 0n) price = cards[0].strike
    await settleAndFinalize(client, p0, packageId, duelId, price)
    const ev = await findDuelFinalizedEvent(packageId, duelId)
    expect([p0Addr, p1Addr]).toContain(normalizeSuiAddress(ev.winner))
    console.log(
      `winner: ${normalizeSuiAddress(ev.winner) === p0Addr ? "p0" : "p1"}  ` +
        `payout_to_p0=${ev.payout_to_p0} payout_to_p1=${ev.payout_to_p1}`
    )
  }, 60_000)

  // ─── Slow path (real settlement) — SKIPPED scaffold ────────────────────
  //
  // The fast path above uses the TEST/DEV-ONLY `finalize_test_one_price`
  // shortcut (free-style scoring, no anti-replay, premium always 0) because
  // waiting for a real `ExpiryMarket` to actually reach expiry + get
  // indexed as settled would make this suite minutes-to-hours long and
  // flaky on CI cadence. The PRODUCTION path — exercised live by
  // `Keeper.tryClose` in keeper.ts — is:
  //   1. Poll `GET {predictIndexerUrl}/markets/{expiry_market_id}/state`
  //      per unique card market until `settlement.settlement_price` is set
  //      (keeper.ts's `readMarketSettlement`).
  //   2. For each card: `settle_card<DUSDC>(duel, p0Wrapper, p1Wrapper,
  //      card_idx, settlementPrice, p0Premium, p1Premium)` — premiums read
  //      via `readOrderPremium(expiryMarketId, orderId)` (the predict
  //      indexer's `/markets/{id}/positions/{order_id}/cashflow` endpoint).
  //   3. `finalize<DUSDC>(duel, clock)`.
  //   4. `expiry_market::redeem_settled(market, AccountRegistry, wrapper,
  //      ProtocolConfig, OracleRegistry, PythFeed, order_id, close_quantity,
  //      root, clock)` per player per card, so each `AccountWrapper`'s
  //      dUSDC payout actually materializes.
  // Gate this on picking markets with a near-term (e.g. 1-minute) cadence
  // and polling `/state` in a loop with a real timeout before wiring it up.
  test.skip("slow path: settle_card × deckSize + finalize + redeem_settled (real settlement, not wired up — see comment above)", async () => {})

  afterAll(async () => {
    if (!canRun) return
    // Best-effort: sweep p1's leftover SUI back to p0 so testnet SUI/dUSDC
    // don't pile up in a throwaway keypair across repeated runs.
    try {
      const tx = new Transaction()
      tx.setGasBudget(3_000_000n)
      tx.transferObjects([tx.gas], tx.pure.address(p0Addr))
      await signAndWait(client, p1, tx, "sweep leftover SUI")
    } catch {
      // best-effort
    }
  }, 30_000)
})
