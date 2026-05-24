/**
 * End-to-end demo — walks a player through every step of the staked
 * duel happy path, exercising backend HTTP + WebSocket and on-chain
 * Move calls in one continuous flow.
 *
 * Steps:
 *   1. Wallet                — sign-in (Sui Wallet or zkLogin)
 *   2. PredictManager        — find existing OR create + deposit dUSDC
 *   3. Backend handshake     — connect WS, send `hello`
 *   4. Generate Deck         — POST /deckmaster/generate
 *   5. Create Duel           — duel::create_duel(stake, deck_hash)
 *   6. Wait for Challenger   — second tab joins (shows shareable URL)
 *   7. Watch Reveal          — keeper auto-reveals; we just listen on room_state
 *   8. Swipe 5 Cards         — atomic predict::mint + duel::record_swipe per card
 *   9. Watch Settle + Result — oracle ticks + settledCount → DuelFinalized payout
 *
 * Multi-player UX: there's no chain-supported "self-join" because of
 * `ECreatorCannotJoin`. Step 6 surfaces the duel id + share URL so the
 * opponent can join from another tab / wallet. For a 1-person demo,
 * open the playground in two browsers with different wallets.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { bcs } from '@mysten/sui/bcs'
import { normalizeSuiObjectId } from '@mysten/sui/utils'
import { CONFIG } from '../../config'
import { client } from '../../lib/client'
import { txCreateDuel, txJoinDuel, txRecordSwipe, txRevealDeck } from '../../lib/duel-txb'

// ─── Types ──────────────────────────────────────────────────────────────────

type StepId =
  | 'wallet'
  | 'manager'
  | 'backend'
  | 'match'
  | 'deck'
  | 'create'
  | 'wait_challenger'
  | 'reveal'
  | 'swipe'
  | 'result'

const TIERS = ['starter', 'casual', 'standard', 'high_roller'] as const
type Tier = (typeof TIERS)[number]

type StepStatus = 'pending' | 'active' | 'running' | 'done' | 'error'

interface PanelOutput {
  type: 'success' | 'error' | 'info'
  title: string
  data: string
  txDigest?: string
}

interface Props {
  onOutput: (o: PanelOutput) => void
}

interface DeckCard {
  oracle_id: string
  strike: string
  expiry: string
}

interface DeckResponse {
  cards: DeckCard[]
  hash: string
  seed: string
}

interface RoomState {
  status: 'PENDING' | 'ACTIVE' | 'COMPLETE'
  cardsRevealed: boolean
  cardCount: number
  settledCount: number
  challenger: string
  creator: string
  p0Payout: string
  p0Premium: string
  p1Payout: string
  p1Premium: string
  startedAtMs: number
  cardOutcomes: Array<{
    cardIdx: number
    settlementPrice: string
    strike: string
    upWon: boolean
    p0Pnl: string | null
    p1Pnl: string | null
    p0Swipe: { isUp: boolean; quantity: string; premium: string } | null
    p1Swipe: { isUp: boolean; quantity: string; premium: string } | null
  }>
  /**
   * Per-card swipes (settled or not). One entry per card slot with
   * at least one swipe. Source of truth for running PnL + F5 recovery.
   */
  swipes: Array<{
    cardIdx: number
    p0Swipe: { isUp: boolean; quantity: string; premium: string } | null
    p1Swipe: { isUp: boolean; quantity: string; premium: string } | null
  }>
}

interface SwipeResult {
  cardIdx: number
  isUp: boolean
  digest: string
}

/**
 * Per-address session snapshot persisted to localStorage so an F5
 * doesn't reset progress mid-demo. Anything that survives a reload
 * goes here; ephemeral state (balance reading, oracle ticks, WS
 * status) re-derives on mount.
 */
interface CachedSession {
  managerId?: string
  deck?: DeckResponse
  duelId?: string
  swipeResults: SwipeResult[]
  // Match-related state — survives F5 so the role/opponent context
  // isn't lost mid-flow.
  matchedRole?: 'creator' | 'challenger' | null
  matchedOpponent?: string | null
  tier?: 'starter' | 'casual' | 'standard' | 'high_roller'
}

const SESSION_KEY = (addr: string) => `flicky_e2e_session:${addr.toLowerCase()}`
/** Cross-panel manager id (compatible with ManagerPanel). */
const SHARED_MANAGER_KEY = 'flicky_predict_manager_id'

// ─── Constants ──────────────────────────────────────────────────────────────

const DEEPBOOK_PKG =
  import.meta.env.VITE_DEEPBOOK_PREDICT_PACKAGE_ID ||
  '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138'
const DEEPBOOK_OBJ =
  import.meta.env.VITE_DEEPBOOK_PREDICT_OBJECT_ID ||
  '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a'
const DUSDC_COIN_TYPE =
  import.meta.env.VITE_DUSDC_COIN_TYPE ||
  '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC'

/** Stake amount per tier (dUSDC, 6-decimal micro units). Both creator + challenger stake the same. */
const STAKE_BY_TIER = {
  starter: 1_000_000n,
  casual: 3_000_000n,
  standard: 5_000_000n,
  high_roller: 10_000_000n,
} as const
/** Per-card mint quantity. */
const MINT_QUANTITY = 20_000n
/** Placeholder premium (50% of quantity). Production should use `pricing::p_up`. */
const MINT_PREMIUM = 10_000n
/** Required PredictManager balance to enter the staked queue (PRD). */
const MIN_BALANCE = 5_000_000n

// ─── Utilities ──────────────────────────────────────────────────────────────

function short(addr: string | undefined, n = 6): string {
  if (!addr) return ''
  return addr.length > n * 2 + 2
    ? `${addr.slice(0, n + 2)}…${addr.slice(-n)}`
    : addr
}

function fmtDusdc(micro: bigint): string {
  return (Number(micro) / 1_000_000).toFixed(4)
}

function fmtPnl(pnl: string | null): string {
  if (pnl === null) return '—'
  const n = Number(pnl) / 1_000_000
  return (n >= 0 ? '+' : '') + n.toFixed(4) + ' dUSDC'
}

/**
 * Per-card live PnL — proportional (mark-to-market) view.
 *
 *   diff   = swipe.isUp ? (live − strike) : (strike − live)
 *   pnl    = diff × quantity / FLOAT_SCALING
 *
 * Where FLOAT_SCALING = 1e9 (oracle price scale). Quantity is in
 * dUSDC micro-units (1e6); price diff is in 1e9 fixed. Dividing by
 * 1e9 leaves the answer in micro-dUSDC, so a $1 favorable price move
 * yields exactly `quantity` micro-dUSDC of PnL — a $42 move on a
 * 0.02 dUSDC position works out to 42 × 20_000 = 840_000 micro-dUSDC
 * = +0.84 dUSDC if your direction is correct, −0.84 if wrong.
 *
 * Returns null when we lack a tick (can't yet judge winning side).
 *
 * Settled cards still use the contract's binary PnL (`p{0,1}Pnl`)
 * from `cardOutcomes` — this proportional preview only applies
 * pre-settlement.
 */
const FLOAT_SCALING = 1_000_000_000n

function liveCardPnl(
  swipe: { isUp: boolean; quantity: string; premium: string } | null,
  strike: string | undefined,
  forward: string | undefined,
): bigint | null {
  if (!swipe || strike === undefined || forward === undefined) return null
  const s = BigInt(strike)
  const f = BigInt(forward)
  const q = BigInt(swipe.quantity)
  const diff = swipe.isUp ? f - s : s - f
  return (diff * q) / FLOAT_SCALING
}

/**
 * Total running PnL for `side` = settled PnL (definitive, from the
 * contract's payout − premium cumulative fields) + live PnL for cards
 * that have a swipe + an oracle tick but no settlement yet. Cards with
 * no swipe contribute 0; cards swiped without a tick are skipped
 * (we honestly don't know the direction outcome yet).
 */
function runningPnl(
  rs: {
    p0Payout: string
    p0Premium: string
    p1Payout: string
    p1Premium: string
    cardOutcomes: Array<{ cardIdx: number }>
    swipes: Array<{
      cardIdx: number
      p0Swipe: { isUp: boolean; quantity: string; premium: string } | null
      p1Swipe: { isUp: boolean; quantity: string; premium: string } | null
    }>
  },
  side: 'p0' | 'p1',
  deck: { cards: Array<{ oracle_id: string; strike: string }> } | null,
  ticks: Record<string, { spot: string; forward: string }>,
): bigint {
  const settled =
    side === 'p0'
      ? BigInt(rs.p0Payout) - BigInt(rs.p0Premium)
      : BigInt(rs.p1Payout) - BigInt(rs.p1Premium)
  const settledIdx = new Set(rs.cardOutcomes.map((o) => o.cardIdx))
  let live = 0n
  for (const s of rs.swipes) {
    if (settledIdx.has(s.cardIdx)) continue
    const swipe = side === 'p0' ? s.p0Swipe : s.p1Swipe
    if (!swipe) continue
    const card = deck?.cards[s.cardIdx]
    if (!card) continue
    const tick = ticks[card.oracle_id]
    if (!tick) continue
    const pnl = liveCardPnl(swipe, card.strike, tick.forward)
    if (pnl !== null) live += pnl
  }
  return settled + live
}

/**
 * Translate a raw Sui MoveAbort error message into something the user
 * can act on. Maps the contract's u64 error codes (duel.move:E*) to
 * short reason strings + recovery hints.
 *
 * Example input: "MoveAbort in 2nd command, abort code: 1, in
 * '0x…::duel::join_duel' (instruction 14)"
 */
function parseMoveAbort(msg: string): {
  fn: string | null
  code: number | null
  label: string | null
  hint: string | null
} | null {
  const m =
    /MoveAbort.*abort code:\s*(\d+).*'(?:[^']+::)?([a-z_]+)::([a-z_]+)'/i.exec(msg)
  if (!m) return null
  const code = Number(m[1])
  const fn = `${m[2]}::${m[3]}`
  const DUEL_CODES: Record<number, { label: string; hint: string }> = {
    0: { label: 'ENotPlayer', hint: 'Your wallet is not creator or challenger on this duel.' },
    1: { label: 'EDuelNotPending', hint: 'Duel already joined or completed. The cached id is stale — click "Reset session" to find a fresh match.' },
    2: { label: 'EDuelNotActive', hint: 'Duel is not in ACTIVE state. Either still PENDING (challenger hasn\'t joined) or already COMPLETE.' },
    3: { label: 'EAlreadyJoined', hint: 'A challenger already joined this duel.' },
    4: { label: 'ECreatorCannotJoin', hint: 'You created this duel — you can\'t also join it. Use a second wallet.' },
    5: { label: 'EStakeMismatch', hint: 'Your stake amount doesn\'t match the creator\'s. Reset session and re-match with the same tier.' },
    6: { label: 'EInvalidDeckSize', hint: 'Deck must have exactly 5 cards.' },
    7: { label: 'ECardIndexOOB', hint: 'Card index out of range (must be 0-4).' },
    8: { label: 'EOracleMismatch', hint: 'Oracle id doesn\'t match the card\'s recorded oracle.' },
    9: { label: 'EOutOfTurn', hint: 'You\'re swiping the wrong card next — chain enforces order 0→4.' },
    10: { label: 'ECardAlreadySettled', hint: 'This card already had its oracle resolved.' },
    11: { label: 'EAllCardsNotSettled', hint: 'finalize requires all 5 cards settled first.' },
    13: { label: 'EZeroStake', hint: 'Stake amount must be > 0.' },
    14: { label: 'EOracleNotLive', hint: 'Oracle is not ACTIVE (settled or pending settlement). Pick a fresher deck.' },
    15: { label: 'EInvalidDeckHash', hint: 'Deck hash must be exactly 32 bytes (sha2_256).' },
    16: { label: 'EDeckAlreadyRevealed', hint: 'Deck was already revealed.' },
    17: { label: 'EDeckHashMismatch', hint: 'Revealed deck doesn\'t hash to the committed value.' },
    18: { label: 'EDeckNotRevealed', hint: 'Reveal the deck before recording swipes.' },
    19: { label: 'ENotManagerOwner', hint: 'PredictManager owner ≠ signer. Use the wallet that created the manager.' },
    20: { label: 'EZeroPositionQuantity', hint: 'Mint a Predict position first (atomic mint + record_swipe).' },
    21: { label: 'ESwipeTimeout', hint: 'Swipe window (10 min from duel start) has expired.' },
  }
  const known = fn.startsWith('duel::') ? DUEL_CODES[code] : null
  return {
    fn,
    code,
    label: known?.label ?? null,
    hint: known?.hint ?? null,
  }
}

/**
 * Has a real challenger joined the duel yet? The contract initializes
 * `challenger` to `@0x0`, which Sui RPC returns as the padded 64-char
 * zero address. A naive `!== '0x0'` check misreads the padded form as
 * "joined", so check both shapes here.
 */
function isChallengerJoined(rs: RoomState | null): boolean {
  if (!rs?.challenger) return false
  const c = rs.challenger.toLowerCase()
  if (c === '0x0') return false
  if (/^0x0+$/.test(c)) return false
  return true
}

/** Decode a 0x-prefixed hex string into a byte array for tx.pure.vector('u8', …). */
function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out: number[] = []
  for (let i = 0; i < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16))
  }
  return out
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function E2EFlowPanel({ onOutput }: Props) {
  const account = useCurrentAccount()
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction()

  // Step state
  const [stepStatuses, setStepStatuses] = useState<Record<StepId, StepStatus>>({
    wallet: 'pending',
    manager: 'pending',
    backend: 'pending',
    match: 'pending',
    deck: 'pending',
    create: 'pending',
    wait_challenger: 'pending',
    reveal: 'pending',
    swipe: 'pending',
    result: 'pending',
  })

  // Matchmaking state
  const [tier, setTier] = useState<Tier>('starter')
  const [queueSize, setQueueSize] = useState<number | null>(null)
  const [matchedRole, setMatchedRole] = useState<
    'creator' | 'challenger' | null
  >(null)
  const [matchedOpponent, setMatchedOpponent] = useState<string | null>(null)

  // Challenger-side: visibility into the poll loop so the user can see
  // it's still trying + a manual paste box as escape hatch.
  const [pollStartedAt, setPollStartedAt] = useState<number | null>(null)
  const [lastPollAt, setLastPollAt] = useState<number | null>(null)
  const [pollAttempts, setPollAttempts] = useState(0)
  const [manualDuelId, setManualDuelId] = useState('')

  // Collected data — managerId is also lazily seeded from the shared
  // localStorage key the ManagerPanel writes to, so a setup done in
  // either panel carries over.
  const [managerId, setManagerId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return localStorage.getItem(SHARED_MANAGER_KEY) || null
  })
  const [managerBalance, setManagerBalance] = useState<bigint>(0n)
  const [deck, setDeck] = useState<DeckResponse | null>(null)
  const [duelId, setDuelId] = useState<string | null>(null)
  const [roomState, setRoomState] = useState<RoomState | null>(null)
  const [swipeResults, setSwipeResults] = useState<SwipeResult[]>([])
  const [hydrated, setHydrated] = useState(false)
  const [oracleTicks, setOracleTicks] = useState<Record<string, { spot: string; forward: string }>>({})
  const [error, setError] = useState<string | null>(null)
  const [busyStep, setBusyStep] = useState<StepId | null>(null)

  // WebSocket
  const wsRef = useRef<WebSocket | null>(null)
  const [wsOpen, setWsOpen] = useState(false)

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const setStatus = useCallback((id: StepId, status: StepStatus) => {
    setStepStatuses((prev) => ({ ...prev, [id]: status }))
  }, [])

  const runStep = useCallback(
    async (id: StepId, fn: () => Promise<void>) => {
      setBusyStep(id)
      setStatus(id, 'running')
      setError(null)
      try {
        await fn()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const abort = parseMoveAbort(msg)
        const friendly = abort?.label
          ? `${abort.fn} aborted ${abort.label} (code ${abort.code})${abort.hint ? ` — ${abort.hint}` : ''}`
          : msg
        setStatus(id, 'error')
        setError(`${id}: ${friendly}`)
        onOutput({
          type: 'error',
          title: `step ${id} failed`,
          data: abort
            ? `${friendly}\n\nraw: ${msg}`
            : msg,
        })
      } finally {
        setBusyStep(null)
      }
    },
    [setStatus, onOutput],
  )

  // ─── WS lifecycle ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!account) return
    const ws = new WebSocket(CONFIG.serverWsUrl)
    wsRef.current = ws
    setStatus('backend', 'running')

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', address: account.address }))
      setWsOpen(true)
      setStatus('backend', 'done')
    }
    ws.onmessage = (e) => {
      let msg: { type: string; [k: string]: unknown }
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : '')
      } catch {
        return
      }
      if (msg.type === 'room_state') {
        const rs = msg as unknown as RoomState
        setRoomState(rs)
        onOutput({
          type: 'info',
          title: 'room_state',
          data: `status=${rs.status} · revealed=${rs.cardsRevealed} · settled=${rs.settledCount}/${rs.cardCount} · challenger=${rs.challenger.slice(0, 10)}…`,
        })
        // Auto-advance steps based on duel state
        if (rs.status === 'ACTIVE' && rs.cardsRevealed) {
          setStatus('wait_challenger', 'done')
          setStatus('reveal', 'done')
          setStepStatuses((prev) =>
            prev.swipe === 'pending' ? { ...prev, swipe: 'active' } : prev,
          )
        }
        if (rs.status === 'COMPLETE') {
          setStatus('swipe', 'done')
          setStatus('result', 'done')
        } else if (rs.settledCount > 0 && rs.settledCount < rs.cardCount) {
          setStatus('result', 'running')
        }
      } else if (msg.type === 'queue_status') {
        setQueueSize((msg.size as number) ?? null)
      } else if (msg.type === 'queue_left') {
        setQueueSize(null)
      } else if (msg.type === 'match_found') {
        setMatchedRole((msg.role as 'creator' | 'challenger') ?? null)
        setMatchedOpponent((msg.opponent as string) ?? null)
        setQueueSize(null)
        setStatus('match', 'done')
        onOutput({
          type: 'success',
          title: 'match_found',
          data: JSON.stringify(msg, null, 2),
        })
      } else if (msg.type === 'duel_assigned') {
        // Backend saw creator's DuelCreated event + pushed it to us
        // (we're the matched challenger). Far faster than polling.
        const id = msg.duelId as string
        setDuelId(id)
        setLastPollAt(null)
        onOutput({
          type: 'success',
          title: 'duel_assigned',
          data: `creator created duel ${id}`,
        })
      } else if (msg.type === 'oracle_tick') {
        const oid = msg.oracleId as string
        setOracleTicks((prev) => ({
          ...prev,
          [oid]: { spot: msg.spot as string, forward: msg.forward as string },
        }))
      } else if (msg.type === 'error') {
        onOutput({
          type: 'error',
          title: `ws error: ${msg.code}`,
          data: (msg.message as string) ?? '',
        })
      }
    }
    ws.onclose = () => setWsOpen(false)
    ws.onerror = () => {
      setStatus('backend', 'error')
      setError(`backend WS unreachable: ${CONFIG.serverWsUrl}`)
    }
    return () => {
      ws.close()
      wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.address])

  // Detect wallet step
  useEffect(() => {
    setStatus('wallet', account ? 'done' : 'pending')
  }, [account, setStatus])

  // ─── Session persistence ─────────────────────────────────────────────────
  //
  // On wallet sign-in, hydrate from localStorage (per-address key) so
  // an F5 doesn't lose mid-demo state. Each subsequent change writes
  // the snapshot back — wallet switch swaps to a different session
  // automatically.

  useEffect(() => {
    if (!account) {
      setHydrated(false)
      return
    }
    try {
      const raw = localStorage.getItem(SESSION_KEY(account.address))
      if (raw) {
        const cached = JSON.parse(raw) as CachedSession
        if (cached.managerId) setManagerId(cached.managerId)
        if (cached.deck) setDeck(cached.deck)
        if (cached.duelId) setDuelId(cached.duelId)
        if (Array.isArray(cached.swipeResults))
          setSwipeResults(cached.swipeResults)
        if (cached.matchedRole) setMatchedRole(cached.matchedRole)
        if (cached.matchedOpponent) setMatchedOpponent(cached.matchedOpponent)
        if (cached.tier) setTier(cached.tier)
      }
    } catch {
      // bad JSON — ignore, will overwrite on next change
    }
    setHydrated(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.address])

  useEffect(() => {
    if (!account || !hydrated) return
    const session: CachedSession = {
      managerId: managerId ?? undefined,
      deck: deck ?? undefined,
      duelId: duelId ?? undefined,
      swipeResults,
      matchedRole,
      matchedOpponent,
      tier,
    }
    // Only write when there's actual progress — otherwise we churn
    // localStorage on every render for empty sessions.
    if (
      managerId || deck || duelId || swipeResults.length > 0 ||
      matchedRole || matchedOpponent
    ) {
      localStorage.setItem(SESSION_KEY(account.address), JSON.stringify(session))
    }
    // Mirror managerId to the shared key for cross-panel reuse.
    if (managerId) localStorage.setItem(SHARED_MANAGER_KEY, managerId)
  }, [account, hydrated, managerId, deck, duelId, swipeResults, matchedRole, matchedOpponent, tier])

  // ─── Status derivation from state ────────────────────────────────────────
  //
  // Steps' visual statuses are derived from the underlying data, so
  // hydrating from localStorage automatically rolls the wizard back to
  // where the user left off — no replay needed.

  useEffect(() => {
    if (managerId && managerBalance >= MIN_BALANCE) setStatus('manager', 'done')
  }, [managerId, managerBalance, setStatus])

  // Challenger doesn't generate a deck — their "step 5" is just
  // waiting for the creator. Mark it `done` as soon as we've located
  // the opponent's duel (or skip it entirely if deck arrives via WS,
  // which never happens for challengers but keeps the dep array honest).
  useEffect(() => {
    if (deck) setStatus('deck', 'done')
    else if (matchedRole === 'challenger' && duelId) setStatus('deck', 'done')
  }, [deck, matchedRole, duelId, setStatus])

  // Creator: step 6 done when their create_duel returns a duelId.
  // Challenger: step 6 done only after they successfully join_duel,
  // which is signaled by room_state.status flipping ACTIVE.
  useEffect(() => {
    if (matchedRole === 'challenger') {
      if (roomState?.status === 'ACTIVE') setStatus('create', 'done')
    } else if (duelId) {
      setStatus('create', 'done')
    }
  }, [matchedRole, duelId, roomState?.status, setStatus])

  // Challenger has no "wait for challenger" step — they ARE the
  // challenger. Auto-complete when they've joined.
  useEffect(() => {
    if (matchedRole === 'challenger' && roomState?.status === 'ACTIVE') {
      setStatus('wait_challenger', 'done')
    }
  }, [matchedRole, roomState?.status, setStatus])

  useEffect(() => {
    if (swipeResults.length === 5) setStatus('swipe', 'done')
    else if (swipeResults.length > 0) setStatus('swipe', 'running')
  }, [swipeResults, setStatus])

  // After hydration, if managerId came from cache, re-read its
  // balance from chain so the gate check is accurate.
  useEffect(() => {
    if (!hydrated || !managerId || !account) return
    readManagerBalance(managerId).then(setManagerBalance).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, managerId, account?.address])

  // ─── Challenger: hydrate deck from chain after reveal ─────────────────
  //
  // The creator's tab has `deck` in state from /deckmaster/generate.
  // The challenger never called that endpoint — but once the keeper (or
  // manual reveal) lands `reveal_deck` on chain, the Duel object now
  // carries the full cards vector. We pull it + each oracle's expiry
  // so the swipe PTB can build market_key with the right (oracle, expiry,
  // strike) tuple.
  useEffect(() => {
    if (!duelId) return
    if (deck) return
    if (!roomState?.cardsRevealed) return

    let cancelled = false
    ;(async () => {
      try {
        const obj = await client.getObject({
          id: duelId,
          options: { showContent: true },
        })
        if (obj.data?.content?.dataType !== 'moveObject') return
        const f = obj.data.content.fields as {
          deck_hash: string | number[]
          cards: Array<{ fields: { oracle_id: string; strike: string } }>
        }
        if (!Array.isArray(f.cards) || f.cards.length === 0) return
        // Fetch oracle expiries in one batch.
        const oracleIds = f.cards.map((c) => c.fields.oracle_id)
        const oracleObjs = await client.multiGetObjects({
          ids: oracleIds,
          options: { showContent: true },
        })
        if (cancelled) return
        const expiryById: Record<string, string> = {}
        for (const obj of oracleObjs) {
          if (obj.data?.content?.dataType !== 'moveObject') continue
          const ff = obj.data.content.fields as { expiry?: string }
          if (ff.expiry !== undefined) expiryById[obj.data.objectId] = ff.expiry
        }
        const hashHex =
          typeof f.deck_hash === 'string'
            ? f.deck_hash.startsWith('0x')
              ? f.deck_hash
              : '0x' + f.deck_hash
            : '0x' +
              f.deck_hash
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('')
        setDeck({
          hash: hashHex,
          seed: '',
          cards: f.cards.map((c) => ({
            oracle_id: c.fields.oracle_id,
            strike: c.fields.strike,
            expiry: expiryById[c.fields.oracle_id] ?? '0',
          })),
        })
      } catch (e) {
        if (!cancelled) {
          onOutput({
            type: 'error',
            title: 'hydrate deck from chain',
            data: e instanceof Error ? e.message : String(e),
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [duelId, deck, roomState?.cardsRevealed, onOutput])

  // Auto-subscribe to room + oracles when duel + deck are known
  useEffect(() => {
    if (!wsOpen || !duelId) return
    wsRef.current?.send(JSON.stringify({ type: 'room_subscribe', duelId }))
    return () => {
      wsRef.current?.send(JSON.stringify({ type: 'room_unsubscribe', duelId }))
    }
  }, [wsOpen, duelId])

  useEffect(() => {
    if (!wsOpen || !deck) return
    const ids = deck.cards.map((c) => c.oracle_id)
    wsRef.current?.send(JSON.stringify({ type: 'oracle_subscribe', oracleIds: ids }))
    return () => {
      wsRef.current?.send(
        JSON.stringify({ type: 'oracle_unsubscribe', oracleIds: ids }),
      )
    }
  }, [wsOpen, deck])

  // ─── Step actions ─────────────────────────────────────────────────────────

  const findManager = useCallback(async () => {
    if (!account) return
    let cursor: { txDigest: string; eventSeq: string } | null | undefined = null
    for (let page = 0; page < 3; page++) {
      const evts = await client.queryEvents({
        query: {
          MoveEventType: `${DEEPBOOK_PKG}::predict_manager::PredictManagerCreated`,
        },
        limit: 50,
        order: 'descending',
        cursor,
      })
      for (const e of evts.data) {
        const p = e.parsedJson as { manager_id: string; owner: string }
        if (p.owner === account.address) return normalizeSuiObjectId(p.manager_id)
      }
      if (!evts.hasNextPage) break
      cursor = evts.nextCursor
    }
    return null
  }, [account])

  const readManagerBalance = useCallback(
    async (id: string) => {
      if (!account) return 0n
      const tx = new Transaction()
      tx.moveCall({
        target: `${DEEPBOOK_PKG}::predict_manager::balance`,
        typeArguments: [DUSDC_COIN_TYPE],
        arguments: [tx.object(id)],
      })
      const res = await client.devInspectTransactionBlock({
        sender: account.address,
        transactionBlock: tx,
      })
      const ret = res.results?.[0]?.returnValues?.[0]
      if (!ret) return 0n
      return BigInt(bcs.u64().parse(new Uint8Array(ret[0])))
    },
    [account],
  )

  const stepManager = useCallback(
    () =>
      runStep('manager', async () => {
        if (!account) throw new Error('connect wallet first')
        let id = await findManager()
        if (!id) {
          // Create one (sponsored allowlist has predict::create_manager)
          const tx = new Transaction()
          tx.moveCall({
            target: `${DEEPBOOK_PKG}::predict::create_manager`,
            arguments: [],
          })
          const res = await signAndExecute({ transaction: tx })
          await client.waitForTransaction({ digest: res.digest })
          onOutput({
            type: 'success',
            title: 'predict::create_manager',
            data: 'manager created',
            txDigest: res.digest,
          })
          id = await findManager()
        }
        if (!id) throw new Error('manager not found after create')
        setManagerId(id)
        const bal = await readManagerBalance(id)
        setManagerBalance(bal)
        if (bal < MIN_BALANCE) {
          // Top up to MIN_BALANCE
          const need = MIN_BALANCE - bal
          const coins = await client.getCoins({
            owner: account.address,
            coinType: DUSDC_COIN_TYPE,
          })
          if (coins.data.length === 0) {
            throw new Error(
              `need ≥ ${fmtDusdc(need)} dUSDC to deposit but wallet has none — top up via the SUI→dUSDC swap first`,
            )
          }
          const tx = new Transaction()
          const [primary, ...rest] = coins.data.map((c) => tx.object(c.coinObjectId))
          if (rest.length > 0) tx.mergeCoins(primary, rest)
          const [deposit] = tx.splitCoins(primary, [tx.pure.u64(need)])
          tx.moveCall({
            target: `${DEEPBOOK_PKG}::predict_manager::deposit`,
            typeArguments: [DUSDC_COIN_TYPE],
            arguments: [tx.object(id), deposit],
          })
          const res = await signAndExecute({ transaction: tx })
          await client.waitForTransaction({ digest: res.digest })
          onOutput({
            type: 'success',
            title: 'predict_manager::deposit',
            data: `deposited ${fmtDusdc(need)} dUSDC`,
            txDigest: res.digest,
          })
          setManagerBalance(await readManagerBalance(id))
        }
      }),
    [account, findManager, readManagerBalance, runStep, signAndExecute, onOutput],
  )

  const stepQueueJoin = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      onOutput({ type: 'error', title: 'queue_join', data: 'ws not connected' })
      return
    }
    setStatus('match', 'running')
    wsRef.current.send(JSON.stringify({ type: 'queue_join', tier }))
  }, [tier, setStatus, onOutput])

  const stepQueueLeave = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({ type: 'queue_leave' }))
    setStatus('match', 'pending')
  }, [setStatus])

  const stepSkipMatch = useCallback(() => {
    // Bypass matchmaking — useful for solo-creator demos. The user
    // still acts as `creator`; the second-tab share link still works.
    setMatchedRole('creator')
    setMatchedOpponent(null)
    setStatus('match', 'done')
  }, [setStatus])

  // ─── Challenger: poll for opponent's PENDING duel ─────────────────────
  //
  // Primary path is the WS `duel_assigned` push (fired by the indexer
  // the moment it sees DuelCreated from the matched creator). This
  // polling loop is the FALLBACK — covers backend restart between
  // match_found + DuelCreated, or any indexer hiccup that misses the
  // event.
  useEffect(() => {
    if (matchedRole !== 'challenger') return
    if (!matchedOpponent) return
    if (duelId) return // already found / joined

    let cancelled = false
    setPollStartedAt(Date.now())
    setPollAttempts(0)
    const poll = async () => {
      while (!cancelled && !duelId) {
        setLastPollAt(Date.now())
        setPollAttempts((n) => n + 1)
        try {
          const res = await fetch(
            `${CONFIG.serverHttpUrl}/duels/recent?limit=20&status=PENDING`,
          )
          if (res.ok) {
            const body = (await res.json()) as { duels: Array<{ id: string; creator: string }> }
            const match = body.duels.find(
              (d) => d.creator.toLowerCase() === matchedOpponent.toLowerCase(),
            )
            if (match) {
              setDuelId(match.id)
              setPollStartedAt(null)
              return
            }
          }
        } catch {
          // ignore — try next tick
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    void poll()
    return () => {
      cancelled = true
    }
  }, [matchedRole, matchedOpponent, duelId])

  /** Manual override for the duel id — useful when the WS push misses + polling is slow. */
  const applyManualDuelId = useCallback(() => {
    const id = manualDuelId.trim()
    if (!id.startsWith('0x') || id.length < 10) return
    setDuelId(normalizeSuiObjectId(id))
    setManualDuelId('')
  }, [manualDuelId])

  /**
   * Manual fallback for fetching the latest duel state. The indexer's
   * `room_state` WS push is the primary path — this is the escape
   * hatch when the push missed (e.g., creator's room_subscribe lost a
   * race against the indexer tick, or backend was restarted between
   * subscribe + DuelJoined).
   */
  const refreshDuelState = useCallback(async () => {
    if (!duelId) return
    try {
      const res = await fetch(
        `${CONFIG.serverHttpUrl}/duels/${encodeURIComponent(duelId)}`,
      )
      if (!res.ok) {
        onOutput({
          type: 'error',
          title: `GET /duels/${short(duelId, 6)}`,
          data: `status ${res.status} — indexer hasn't mirrored this duel yet, or the package id mismatches.`,
        })
        return
      }
      const body = (await res.json()) as RoomState
      setRoomState({ ...body, duelId } as unknown as RoomState)
      onOutput({
        type: 'success',
        title: 'manual refresh',
        data: `status=${body.status} · challenger=${body.challenger?.slice(0, 10) ?? '—'}…`,
      })
      // Also re-send room_subscribe in case the WS link dropped the
      // original — subscribeRoom on the backend is idempotent (Set.add).
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'room_subscribe', duelId }))
      }
    } catch (e) {
      onOutput({
        type: 'error',
        title: 'refresh failed',
        data: e instanceof Error ? e.message : String(e),
      })
    }
  }, [duelId, onOutput])

  // ─── Manual reveal (fallback when backend keeper is disabled) ────────
  //
  // `duel::reveal_deck` is permissionless on chain — any wallet can call
  // it as long as it provides the plaintext that hashes to the
  // committed `deck_hash`. Two paths to the plaintext:
  //
  //   1. Creator already has it in `deck.cards` (from /deckmaster/generate)
  //   2. Challenger reads the duel's `deck_hash` from chain + fetches
  //      plaintext from /deckmaster/reveal?hash=…
  const stepManualReveal = useCallback(
    () =>
      runStep('reveal', async () => {
        if (!duelId) throw new Error('no duelId')
        let cards: Array<{ oracle_id: string; strike: string }>
        if (deck) {
          cards = deck.cards
        } else {
          // Challenger path — pull deck_hash from chain object, then ask
          // backend for plaintext keyed by that hash.
          const obj = await client.getObject({
            id: duelId,
            options: { showContent: true },
          })
          if (obj.data?.content?.dataType !== 'moveObject')
            throw new Error('duel object not found on chain')
          const f = obj.data.content.fields as { deck_hash: number[] | string }
          const hashHex =
            typeof f.deck_hash === 'string'
              ? f.deck_hash.startsWith('0x')
                ? f.deck_hash
                : '0x' + f.deck_hash
              : '0x' +
                f.deck_hash
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join('')
          const res = await fetch(
            `${CONFIG.serverHttpUrl}/deckmaster/reveal?hash=${hashHex}`,
          )
          if (!res.ok) {
            throw new Error(
              `/deckmaster/reveal returned ${res.status} — server doesn't have the plaintext for hash ${hashHex.slice(0, 12)}… (server may have been restarted before the creator generated the deck).`,
            )
          }
          const body = (await res.json()) as {
            cards: Array<{ oracle_id: string; strike: string }>
          }
          cards = body.cards
        }
        const tx = new Transaction()
        txRevealDeck(
          tx,
          duelId,
          cards.map((c) => ({
            oracleId: c.oracle_id,
            strike: BigInt(c.strike),
          })),
          DUSDC_COIN_TYPE,
        )
        const res = await signAndExecute({ transaction: tx })
        await client.waitForTransaction({ digest: res.digest })
        onOutput({
          type: 'success',
          title: 'duel::reveal_deck',
          data: 'revealed manually (keeper bypass)',
          txDigest: res.digest,
        })
        // Refresh room_state from backend so cardsRevealed flips
        // without waiting for the next indexer tick.
        try {
          const r = await fetch(
            `${CONFIG.serverHttpUrl}/duels/${encodeURIComponent(duelId)}`,
          )
          if (r.ok) setRoomState((await r.json()) as RoomState)
        } catch {
          // not critical — WS push will catch up
        }
      }),
    [duelId, deck, runStep, signAndExecute, onOutput],
  )

  // ─── Challenger: join the duel once we've located it ─────────────────
  const stepJoin = useCallback(
    () =>
      runStep('create', async () => {
        if (!account || !duelId) throw new Error('duel id not located yet')
        const stakeAmount = STAKE_BY_TIER[tier]
        const coins = await client.getCoins({
          owner: account.address,
          coinType: DUSDC_COIN_TYPE,
        })
        if (coins.data.length === 0) throw new Error('no dUSDC in wallet for stake')
        const tx = new Transaction()
        const [primary, ...rest] = coins.data.map((c) => tx.object(c.coinObjectId))
        if (rest.length > 0) tx.mergeCoins(primary, rest)
        const [stake] = tx.splitCoins(primary, [tx.pure.u64(stakeAmount)])
        txJoinDuel(tx, duelId, stake, DUSDC_COIN_TYPE)
        const res = await signAndExecute({ transaction: tx })
        await client.waitForTransaction({ digest: res.digest })
        onOutput({
          type: 'success',
          title: 'duel::join_duel',
          data: `joined duel ${duelId}\nstake ${fmtDusdc(stakeAmount)} dUSDC`,
          txDigest: res.digest,
        })
        // Challenger has no "wait for join" step (they ARE the join).
        setStatus('wait_challenger', 'done')
      }),
    [account, duelId, runStep, signAndExecute, tier, onOutput, setStatus],
  )

  const stepDeck = useCallback(
    () =>
      runStep('deck', async () => {
        if (!account) throw new Error('connect wallet first')
        const res = await fetch(`${CONFIG.serverHttpUrl}/deckmaster/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            asset: 'BTC',
            tier: 'starter',
            sender: account.address,
          }),
        })
        if (!res.ok) {
          const txt = await res.text()
          throw new Error(`deckmaster ${res.status}: ${txt.slice(0, 200)}`)
        }
        const body = (await res.json()) as DeckResponse
        setDeck(body)
        onOutput({
          type: 'success',
          title: '/deckmaster/generate',
          data: JSON.stringify(body, null, 2),
        })
      }),
    [account, runStep, onOutput],
  )

  const stepCreate = useCallback(
    () =>
      runStep('create', async () => {
        if (!account || !deck) throw new Error('deck not ready')
        const stakeAmount = STAKE_BY_TIER[tier]
        const coins = await client.getCoins({
          owner: account.address,
          coinType: DUSDC_COIN_TYPE,
        })
        if (coins.data.length === 0) throw new Error('no dUSDC in wallet for stake')
        const tx = new Transaction()
        const [primary, ...rest] = coins.data.map((c) => tx.object(c.coinObjectId))
        if (rest.length > 0) tx.mergeCoins(primary, rest)
        const [stake] = tx.splitCoins(primary, [tx.pure.u64(stakeAmount)])
        // Use the backend's hash directly — it's already BCS(cards) →
        // sha2_256, and committing exactly that guarantees the keeper's
        // reveal succeeds without FE-side drift.
        txCreateDuel(tx, stake, hexToBytes(deck.hash), DUSDC_COIN_TYPE)
        const res = await signAndExecute({
          transaction: tx,
        })
        // Fullnode race: signAndExecute resolves on cert sign, but the
        // fullnode we read from may not have indexed the tx yet. Poll
        // until the digest is queryable before asking for objectChanges.
        await client.waitForTransaction({ digest: res.digest })
        const full = await client.getTransactionBlock({
          digest: res.digest,
          options: { showObjectChanges: true },
        })
        const created = (full.objectChanges ?? []).find(
          (c) => c.type === 'created' && c.objectType.includes('::duel::Duel<'),
        ) as { objectId: string } | undefined
        if (!created) throw new Error('Duel object not in objectChanges')
        const id = normalizeSuiObjectId(created.objectId)
        setDuelId(id)
        onOutput({
          type: 'success',
          title: 'duel::create_duel',
          data: `duel id ${id}\nstake ${fmtDusdc(stakeAmount)} dUSDC`,
          txDigest: res.digest,
        })
        setStatus('wait_challenger', 'active')
      }),
    [account, deck, tier, runStep, signAndExecute, setStatus, onOutput],
  )

  // ─── Manual settle + finalize (fallback when backend keeper is disabled) ─
  //
  // `duel::settle_card(duel, oracle, card_idx)` is permissionless on chain
  // — it just asserts the oracle has produced a settlement_price. Once
  // all 5 cards are settled, `duel::finalize(duel)` pays out the side
  // pot to the winner. We expose both as buttons so the demo doesn't
  // need the backend keeper running.
  const stepManualSettle = useCallback(
    (cardIdx: number) =>
      runStep('result', async () => {
        if (!duelId || !deck) throw new Error('no duel/deck')
        const card = deck.cards[cardIdx]
        if (!card) throw new Error('cardIdx out of range')
        const tx = new Transaction()
        tx.moveCall({
          target: `${CONFIG.flickyPackageId}::duel::settle_card`,
          typeArguments: [DUSDC_COIN_TYPE],
          arguments: [
            tx.object(duelId),
            tx.object(card.oracle_id),
            tx.pure.u64(BigInt(cardIdx)),
          ],
        })
        const res = await signAndExecute({ transaction: tx })
        await client.waitForTransaction({ digest: res.digest })
        onOutput({
          type: 'success',
          title: `duel::settle_card #${cardIdx}`,
          data: 'oracle settlement recorded on duel',
          txDigest: res.digest,
        })
        // Refresh room_state so settledCount + cardOutcomes flip
        try {
          const r = await fetch(
            `${CONFIG.serverHttpUrl}/duels/${encodeURIComponent(duelId)}`,
          )
          if (r.ok) setRoomState((await r.json()) as RoomState)
        } catch {
          // WS will catch up on the next indexer tick
        }
      }),
    [duelId, deck, runStep, signAndExecute, onOutput],
  )

  const stepManualFinalize = useCallback(
    () =>
      runStep('result', async () => {
        if (!duelId) throw new Error('no duel')
        const tx = new Transaction()
        tx.moveCall({
          target: `${CONFIG.flickyPackageId}::duel::finalize`,
          typeArguments: [DUSDC_COIN_TYPE],
          arguments: [tx.object(duelId)],
        })
        const res = await signAndExecute({ transaction: tx })
        await client.waitForTransaction({ digest: res.digest })
        onOutput({
          type: 'success',
          title: 'duel::finalize',
          data: 'side-pot paid to winner',
          txDigest: res.digest,
        })
        try {
          const r = await fetch(
            `${CONFIG.serverHttpUrl}/duels/${encodeURIComponent(duelId)}`,
          )
          if (r.ok) setRoomState((await r.json()) as RoomState)
        } catch {
          // ignore
        }
      }),
    [duelId, runStep, signAndExecute, onOutput],
  )

  const stepSwipe = useCallback(
    (cardIdx: number, isUp: boolean) =>
      runStep('swipe', async () => {
        if (!account || !deck || !duelId || !managerId)
          throw new Error('missing prerequisites for swipe')
        if (cardIdx < 0 || cardIdx >= deck.cards.length)
          throw new Error('cardIdx out of range')
        const card = deck.cards[cardIdx]
        const tx = new Transaction()
        // Build market_key for the chosen direction.
        //
        // `market_key::up(oracle_id: ID, expiry: u64, strike: u64)` takes
        // the oracle as a *pure* ID (address bytes), NOT an object ref.
        // Passing `tx.object(card.oracle_id)` here would also cause the
        // SDK to register the oracle as an Object input, then later
        // `predict::mint` (which wants `&OracleSVI`) would fail with
        // `arg_idx: 2, InvalidUsageOfPureArg` because the dedup
        // promoted the shared input to pure.
        const mk = tx.moveCall({
          target: `${DEEPBOOK_PKG}::market_key::${isUp ? 'up' : 'down'}`,
          arguments: [
            tx.pure.id(card.oracle_id),
            tx.pure.u64(BigInt(card.expiry)),
            tx.pure.u64(BigInt(card.strike)),
          ],
        })
        // Mint the Predict position. Signature is
        //   mint<T>(predict, manager, oracle, key, quantity, clock, ctx)
        // — clock is `&Clock` (object 0x6), ctx is auto-injected by the
        // SDK. Missing the clock arg trips "Incorrect number of arguments".
        tx.moveCall({
          target: `${DEEPBOOK_PKG}::predict::mint`,
          typeArguments: [DUSDC_COIN_TYPE],
          arguments: [
            tx.object(DEEPBOOK_OBJ),
            tx.object(managerId),
            tx.object(card.oracle_id),
            mk,
            tx.pure.u64(MINT_QUANTITY),
            tx.object(CONFIG.CLOCK_ID),
          ],
        })
        // Record the swipe atomically.
        txRecordSwipe(
          tx,
          duelId,
          managerId,
          card.oracle_id,
          cardIdx,
          isUp,
          MINT_QUANTITY,
          MINT_PREMIUM,
          DUSDC_COIN_TYPE,
        )
        const res = await signAndExecute({ transaction: tx })
        await client.waitForTransaction({ digest: res.digest })
        // Dedup: the backend indexer can publish `room_state` with this
        // swipe BEFORE our local append runs (it polls every ~3 s and
        // waitForTransaction blocks for the same fullnode it queries).
        // If the hydration effect already pushed cardIdx via the
        // chain payload, don't double-add — that would shift
        // `nextSwipeIdx` past the next real slot.
        setSwipeResults((prev) => {
          if (prev.some((s) => s.cardIdx === cardIdx)) return prev
          return [...prev, { cardIdx, isUp, digest: res.digest }].sort(
            (a, b) => a.cardIdx - b.cardIdx,
          )
        })
        onOutput({
          type: 'success',
          title: `swipe card ${cardIdx} ${isUp ? 'UP' : 'DOWN'}`,
          data: `mint + record_swipe atomic`,
          txDigest: res.digest,
        })
      }),
    [account, deck, duelId, managerId, runStep, signAndExecute, onOutput],
  )

  // Derived: next swipe card index per current wallet's role in the duel
  const myRole: 'creator' | 'challenger' | null = useMemo(() => {
    if (!roomState || !account) return null
    if (roomState.creator === account.address) return 'creator'
    if (roomState.challenger === account.address) return 'challenger'
    return null
  }, [roomState, account])

  // ─── Hydrate swipeResults from chain (F5 recovery + opponent sync) ──
  //
  // On refresh, `swipeResults` (local state) is empty even though the
  // player may have already landed swipes on chain. The backend
  // exposes them in `roomState.swipes` (sourced from the duel object).
  // When new chain-swipes arrive that aren't in `swipeResults` yet,
  // backfill so the PnL display + nextSwipeIdx counter line up.
  useEffect(() => {
    if (!roomState || !account || !myRole) return
    if (!roomState.swipes || roomState.swipes.length === 0) return
    const myKey: 'p0Swipe' | 'p1Swipe' =
      myRole === 'creator' ? 'p0Swipe' : 'p1Swipe'
    setSwipeResults((prev) => {
      const knownIdx = new Set(prev.map((s) => s.cardIdx))
      const additions: SwipeResult[] = []
      for (const s of roomState.swipes) {
        const mine = s[myKey]
        if (!mine) continue
        if (knownIdx.has(s.cardIdx)) continue
        additions.push({
          cardIdx: s.cardIdx,
          isUp: mine.isUp,
          // chain doesn't expose the originating tx digest — mark
          // hydrated entries so we don't lie about provenance.
          digest: '__hydrated__',
        })
      }
      if (additions.length === 0) return prev
      return [...prev, ...additions].sort((a, b) => a.cardIdx - b.cardIdx)
    })
  }, [roomState, account, myRole])

  const nextSwipeIdx = swipeResults.length

  const shareUrl = useMemo(() => {
    if (!duelId) return ''
    return `${window.location.origin}/?join=${duelId}`
  }, [duelId])

  // ─── Render helpers ───────────────────────────────────────────────────────

  const stepsList: Array<{ id: StepId; n: number; label: string }> = [
    { id: 'wallet', n: 1, label: 'Wallet' },
    { id: 'backend', n: 2, label: 'Backend WS' },
    { id: 'manager', n: 3, label: 'PredictManager' },
    { id: 'match', n: 4, label: 'Match' },
    { id: 'deck', n: 5, label: 'Generate Deck' },
    { id: 'create', n: 6, label: 'Create Duel' },
    { id: 'wait_challenger', n: 7, label: 'Wait Challenger' },
    { id: 'reveal', n: 8, label: 'Deck Revealed' },
    { id: 'swipe', n: 9, label: 'Swipe 5 Cards' },
    { id: 'result', n: 10, label: 'Result' },
  ]
  const doneCount = stepsList.filter((s) => stepStatuses[s.id] === 'done').length

  return (
    <div className="space-y-4">
      {/* ─── Header ────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            🎯 Flicky End-to-End Demo
          </h2>
          <p className="mt-1 text-xs text-gray-400">
            Real backend + on-chain calls. Wallet → manager → deposit → deck →
            create_duel → join (second tab) → 5 swipes → settle → payout.
            <br />
            <span className="text-gray-500">
              Progress is cached per-address — F5 resumes where you left off.
            </span>
          </p>
        </div>
        <button
          onClick={() => {
            if (!account) return
            if (!confirm('Reset E2E session for this wallet? On-chain state is unaffected.')) return
            localStorage.removeItem(SESSION_KEY(account.address))
            setManagerId(null)
            setManagerBalance(0n)
            setDeck(null)
            setDuelId(null)
            setRoomState(null)
            setSwipeResults([])
            setMatchedRole(null)
            setMatchedOpponent(null)
            setQueueSize(null)
            setStepStatuses({
              wallet: account ? 'done' : 'pending',
              backend: wsOpen ? 'done' : 'pending',
              manager: 'pending',
              match: 'pending',
              deck: 'pending',
              create: 'pending',
              wait_challenger: 'pending',
              reveal: 'pending',
              swipe: 'pending',
              result: 'pending',
            })
          }}
          disabled={!account}
          className="rounded border border-gray-700 bg-gray-850 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-40"
          title="Clears the cached session for this wallet (managerId, deck, duel id, swipe history)"
        >
          ↺ Reset session
        </button>
      </div>

      {/* ─── Progress ──────────────────────────────────────────────────── */}
      <div className="rounded border border-gray-800 bg-gray-900 p-3">
        <div className="mb-2 flex items-center justify-between text-xs text-gray-400">
          <span>
            Progress: <span className="text-gray-100">{doneCount} / {stepsList.length}</span>
          </span>
          <span>{Math.round((doneCount / stepsList.length) * 100)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded bg-gray-800">
          <div
            className="h-full bg-gradient-to-r from-emerald-500 to-blue-500 transition-all"
            style={{ width: `${(doneCount / stepsList.length) * 100}%` }}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          {stepsList.map((s) => (
            <span
              key={s.id}
              className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                stepStatuses[s.id] === 'done'
                  ? 'bg-emerald-700 text-emerald-100'
                  : stepStatuses[s.id] === 'running'
                    ? 'bg-blue-700 text-blue-100 animate-pulse'
                    : stepStatuses[s.id] === 'error'
                      ? 'bg-red-800 text-red-100'
                      : stepStatuses[s.id] === 'active'
                        ? 'bg-yellow-700 text-yellow-100'
                        : 'bg-gray-800 text-gray-500'
              }`}
            >
              {s.n}. {s.label}
            </span>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-800 bg-red-950/60 p-3 text-xs text-red-200">
          <div className="flex items-start justify-between gap-2">
            <div>
              <strong>Error:</strong> {error}
            </div>
            <button
              onClick={() => setError(null)}
              className="text-red-400 hover:text-red-200 shrink-0"
            >
              dismiss
            </button>
          </div>
          {/* Recovery shortcuts — most common errors have a quick fix. */}
          {(error.includes('EDuelNotPending') || error.includes('EAlreadyJoined')) && (
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => {
                  setDuelId(null)
                  setRoomState(null)
                  setStatus('create', 'pending')
                  setStatus('deck', matchedRole === 'challenger' ? 'pending' : stepStatuses.deck)
                  setError(null)
                  setManualDuelId('')
                }}
                className="rounded bg-yellow-700 px-2 py-1 text-xs text-white hover:bg-yellow-600"
              >
                Clear stale duel id (look for a fresh one)
              </button>
            </div>
          )}
          {error.includes('ECreatorCannotJoin') && (
            <div className="mt-2 text-[10px] text-red-300">
              Use a second wallet (different browser / incognito) to join.
              The on-chain contract enforces creator ≠ challenger.
            </div>
          )}
          {error.includes('EOracleNotLive') && (
            <div className="mt-2 text-[10px] text-red-300">
              The oracle for one of your cards has expired or settled
              already. Click "Regenerate" in step 5 to pick fresh oracles.
            </div>
          )}
        </div>
      )}

      {/* ─── Step 1: Wallet ───────────────────────────────────────────── */}
      <StepCard
        n={1}
        title="Wallet"
        status={stepStatuses.wallet}
        summary={account ? short(account.address, 8) : 'not connected'}
      >
        {account ? (
          <div className="font-mono text-xs text-emerald-300">
            ✓ {short(account.address, 10)}
          </div>
        ) : (
          <div className="text-xs text-yellow-300">
            Connect your wallet via the top-right button (zkLogin or extension).
          </div>
        )}
      </StepCard>

      {/* ─── Step 2: Backend WS ───────────────────────────────────────── */}
      <StepCard
        n={2}
        title="Backend WebSocket"
        status={stepStatuses.backend}
        summary={wsOpen ? 'connected' : 'disconnected'}
        desc="Server health check + live matchmaking + room state + oracle ticks. Must be reachable before chain calls so we can stream duel state back to the UI."
      >
        <div className="text-xs">
          <span className="text-gray-400">{CONFIG.serverWsUrl}</span>
          {' · '}
          <span className={wsOpen ? 'text-emerald-300' : 'text-red-400'}>
            {wsOpen ? 'connected' : 'disconnected'}
          </span>
        </div>
      </StepCard>

      {/* ─── Step 3: PredictManager ───────────────────────────────────── */}
      <StepCard
        n={3}
        title="PredictManager + deposit"
        status={stepStatuses.manager}
        summary={
          managerId
            ? `${short(managerId, 6)} · ${fmtDusdc(managerBalance)} dUSDC`
            : 'not set up'
        }
        desc="Auto-deposits up to 5 dUSDC if balance < gate. Required for every staked swipe (predict::mint debits it)."
      >
        {managerId ? (
          <div className="space-y-1 text-xs">
            <KV label="id" value={<span className="font-mono text-emerald-300">{short(managerId)}</span>} />
            <KV
              label="balance"
              value={
                <>
                  <span
                    className={
                      managerBalance >= MIN_BALANCE ? 'text-emerald-300' : 'text-yellow-300'
                    }
                  >
                    {fmtDusdc(managerBalance)} dUSDC
                  </span>
                  <span className="text-gray-500">  (need ≥ {fmtDusdc(MIN_BALANCE)})</span>
                </>
              }
            />
          </div>
        ) : (
          <div className="text-xs text-gray-400">
            We'll find your manager or create + deposit one.
          </div>
        )}
        <button
          onClick={stepManager}
          disabled={!account || busyStep === 'manager'}
          className="mt-2 rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
        >
          {busyStep === 'manager' ? 'Working…' : managerId ? 'Re-check / Top up' : 'Set up Manager'}
        </button>
      </StepCard>

      {/* ─── Step 4: Match (queue → match_found) ──────────────────────── */}
      <StepCard
        n={4}
        title="Match"
        status={stepStatuses.match}
        summary={
          matchedRole
            ? matchedOpponent
              ? `${matchedRole} vs ${short(matchedOpponent, 6)}`
              : `${matchedRole} (solo)`
            : queueSize !== null
              ? `queued · ${queueSize} waiting`
              : 'pick a tier'
        }
        desc="PRD §End-to-end flow #5: enter the queue, get paired with a real opponent. Both sides need a PredictManager balance ≥ 5 dUSDC."
      >
        {matchedRole ? (
          <div className="rounded border border-emerald-700 bg-emerald-950/30 p-2 text-xs">
            <div className="font-semibold text-emerald-300">
              ✓ Matched as <span className="uppercase">{matchedRole}</span>
            </div>
            {matchedOpponent && (
              <div className="mt-0.5 text-gray-300">
                opponent:{' '}
                <span className="font-mono text-emerald-300">
                  {short(matchedOpponent, 8)}
                </span>{' '}
                · tier {tier}
              </div>
            )}
            {!matchedOpponent && (
              <div className="mt-0.5 text-gray-400">
                Skipped queue — proceeding solo. Share link in step 7 to
                let another wallet join.
              </div>
            )}
          </div>
        ) : queueSize !== null ? (
          <div className="space-y-2 text-xs">
            <div className="rounded border border-blue-800 bg-blue-950/30 p-2 text-blue-200 animate-pulse">
              ⏳ In queue · tier <span className="font-semibold">{tier}</span>
              {' · '}
              {queueSize} player(s) waiting
            </div>
            <button
              onClick={stepQueueLeave}
              className="rounded border border-gray-700 bg-gray-850 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
            >
              Leave queue
            </button>
          </div>
        ) : (
          <div className="space-y-2 text-xs">
            <div className="flex items-center gap-2">
              <label className="text-gray-400">tier:</label>
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value as Tier)}
                className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-200"
              >
                {TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t === 'starter'
                      ? 'Starter · 1 dUSDC'
                      : t === 'casual'
                        ? 'Casual · 3 dUSDC'
                        : t === 'standard'
                          ? 'Standard · 5 dUSDC'
                          : 'High Roller · 10 dUSDC'}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <button
                onClick={stepQueueJoin}
                disabled={!wsOpen || stepStatuses.manager !== 'done'}
                className="flex-1 rounded bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-600 disabled:opacity-40"
              >
                Find Match
              </button>
              <button
                onClick={stepSkipMatch}
                className="rounded border border-gray-700 bg-gray-850 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
                title="Skip matchmaking — proceed as creator and share the duel link with a second wallet manually."
              >
                Skip (solo)
              </button>
            </div>
            <p className="text-[10px] text-gray-500">
              Open a second tab with another wallet to actually pair up,
              or click <strong>Skip</strong> to demo the creator flow only.
            </p>
          </div>
        )}
      </StepCard>

      {/* ─── Step 5: Generate Deck (creator) OR Wait (challenger) ───── */}
      <StepCard
        n={5}
        title={matchedRole === 'challenger' ? 'Wait for creator' : 'Generate deck'}
        status={stepStatuses.deck}
        summary={
          matchedRole === 'challenger'
            ? deck
              ? '✓ deck broadcast'
              : duelId
                ? '✓ duel detected'
                : 'polling…'
            : deck
              ? `5 cards · hash ${short(deck.hash, 6)}`
              : 'pending'
        }
        desc={
          matchedRole === 'challenger'
            ? "Creator generates the deck + commits the hash on chain. You wait — backend polls for their duel and auto-fills the id."
            : "Backend picks 5 nearest BTC oracles >10 min out, seeds strikes via PRG, commits sha2_256(BCS)."
        }
      >
        {matchedRole === 'challenger' ? (
          // ─── Challenger view ────────────────────────────────────────
          <div className="space-y-2 text-xs">
            {duelId ? (
              <div className="rounded border border-emerald-700 bg-emerald-950/30 p-2 text-emerald-300">
                ✓ Found opponent's duel:{' '}
                <span className="font-mono">{short(duelId, 10)}</span>
              </div>
            ) : (
              <>
                <div className="rounded border border-blue-800 bg-blue-950/30 p-2 text-blue-300 animate-pulse">
                  ⏳ Waiting for{' '}
                  <span className="font-mono">{short(matchedOpponent ?? '?', 6)}</span>
                  {' '}to call duel::create_duel…
                  {pollStartedAt !== null && (
                    <div className="mt-1 text-[10px] text-blue-400/80">
                      polling /duels/recent · {pollAttempts} attempts ·{' '}
                      elapsed{' '}
                      {Math.floor((Date.now() - pollStartedAt) / 1000)}s
                      {lastPollAt && (
                        <> · last poll {Math.floor((Date.now() - lastPollAt) / 1000)}s ago</>
                      )}
                    </div>
                  )}
                </div>
                {/* Manual paste fallback — for when WS push misses and
                    polling is too slow. Copy the duel id from the
                    creator's tab (step 7 share-link UI). */}
                <div>
                  <label className="block text-[10px] text-gray-500">
                    Stuck? Paste the duel id from creator's tab manually:
                  </label>
                  <div className="mt-1 flex gap-2">
                    <input
                      value={manualDuelId}
                      onChange={(e) => setManualDuelId(e.target.value.trim())}
                      onKeyDown={(e) => e.key === 'Enter' && applyManualDuelId()}
                      placeholder="0x…"
                      className="flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1 font-mono text-gray-200"
                    />
                    <button
                      onClick={applyManualDuelId}
                      disabled={!manualDuelId.trim().startsWith('0x')}
                      className="rounded border border-gray-700 bg-gray-850 px-2 py-1 text-gray-200 hover:bg-gray-800 disabled:opacity-40"
                    >
                      use
                    </button>
                  </div>
                </div>
              </>
            )}
            <p className="text-[10px] text-gray-500">
              Auto-detection priority: (1) WS{' '}
              <code className="text-gray-400">duel_assigned</code> push
              from indexer · (2) HTTP polling of{' '}
              <code className="text-gray-400">/duels/recent</code> every 2s ·
              (3) manual paste above.
            </p>
          </div>
        ) : (
          // ─── Creator view ───────────────────────────────────────────
          <>
            {deck ? (
              <div className="space-y-2 text-xs">
                <div>
                  <span className="text-gray-400">hash:</span>{' '}
                  <span className="font-mono text-emerald-300">{short(deck.hash, 10)}</span>
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                  {deck.cards.map((c, i) => (
                    <CardTile
                      key={i}
                      idx={i}
                      card={c}
                      tick={oracleTicks[c.oracle_id]}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-xs text-gray-400">Click below to call /deckmaster/generate.</div>
            )}
            <button
              onClick={stepDeck}
              disabled={!wsOpen || busyStep === 'deck'}
              className="mt-2 rounded bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-600 disabled:opacity-40"
            >
              {busyStep === 'deck' ? 'Working…' : deck ? 'Regenerate' : 'Generate Deck'}
            </button>
          </>
        )}
      </StepCard>

      {/* ─── Step 6: Create (creator) OR Join (challenger) ──────────── */}
      <StepCard
        n={6}
        title={matchedRole === 'challenger' ? 'Join duel' : 'Create duel'}
        status={stepStatuses.create}
        summary={duelId ? short(duelId, 6) : 'pending'}
        desc={
          matchedRole === 'challenger'
            ? `duel::join_duel — stake ${fmtDusdc(STAKE_BY_TIER[tier])} dUSDC into the creator's duel escrow.`
            : `duel::create_duel — escrow ${fmtDusdc(STAKE_BY_TIER[tier])} dUSDC, commit deck hash.`
        }
      >
        {duelId ? (
          <div className="text-xs">
            <KV label="duel id" value={<span className="font-mono text-emerald-300">{short(duelId, 10)}</span>} />
            {roomState && (
              <KV label="status" value={<StatusPill status={roomState.status} />} />
            )}
          </div>
        ) : (
          <div className="text-xs text-gray-400">
            {matchedRole === 'challenger'
              ? 'Waiting for opponent\'s duel to appear…'
              : 'Stake escrows on click.'}
          </div>
        )}
        {matchedRole === 'challenger' ? (
          <button
            onClick={stepJoin}
            disabled={
              !duelId ||
              busyStep === 'create' ||
              stepStatuses.create === 'done'
            }
            className="mt-2 rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
          >
            {busyStep === 'create'
              ? 'Working…'
              : stepStatuses.create === 'done'
                ? '✓ Joined'
                : 'Join Duel'}
          </button>
        ) : (
          <button
            onClick={stepCreate}
            disabled={!deck || !!duelId || busyStep === 'create'}
            className="mt-2 rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
          >
            {busyStep === 'create' ? 'Working…' : 'Create Duel'}
          </button>
        )}
      </StepCard>

      {/* ─── Step 7: Wait for Challenger (creator only) ─────────────── */}
      <StepCard
        n={7}
        title={matchedRole === 'challenger' ? 'Joined' : 'Wait for challenger'}
        status={stepStatuses.wait_challenger}
        summary={
          matchedRole === 'challenger'
            ? '✓ you are the challenger'
            : isChallengerJoined(roomState)
              ? `joined: ${short(roomState!.challenger, 6)}`
              : 'waiting'
        }
        desc={
          matchedRole === 'challenger'
            ? 'You already joined in step 6 — this step belongs to the creator side.'
            : 'A second wallet calls duel::join_duel. Share the link or wait for the matched challenger.'
        }
      >
        {matchedRole === 'challenger' ? (
          <div className="text-xs text-gray-400">
            n/a for challenger — proceed to reveal.
          </div>
        ) : duelId ? (
          <div className="space-y-2 text-xs">
            <div className="flex gap-2">
              <code className="flex-1 truncate rounded border border-gray-700 bg-gray-950 px-2 py-1 font-mono text-gray-300">
                {shareUrl}
              </code>
              <button
                onClick={() => navigator.clipboard.writeText(shareUrl)}
                className="rounded border border-gray-700 bg-gray-850 px-2 py-1 text-gray-200 hover:bg-gray-800"
              >
                copy link
              </button>
            </div>
            {isChallengerJoined(roomState) ? (
              <div className="rounded border border-emerald-700 bg-emerald-950/40 px-2 py-1.5 text-emerald-300">
                ✓ Challenger joined · <span className="font-mono">{short(roomState!.challenger, 8)}</span>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="flex items-center justify-between rounded border border-blue-800 bg-blue-950/30 px-2 py-1.5 text-blue-300">
                  <span className="animate-pulse">⏳ Waiting for opponent…</span>
                  <button
                    onClick={refreshDuelState}
                    className="rounded border border-gray-700 bg-gray-850 px-2 py-0.5 text-[10px] text-gray-200 hover:bg-gray-800"
                  >
                    🔄 Refresh state
                  </button>
                </div>
                <p className="text-[10px] text-gray-500">
                  Backend pushes <code>room_state</code> on every
                  indexer tick (3s). If the challenger has joined but
                  this banner is still showing, click <strong>Refresh
                  state</strong> — pulls latest from{' '}
                  <code>/duels/{`{id}`}</code> directly + re-sends
                  room_subscribe.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-gray-400">Create the duel first.</div>
        )}
      </StepCard>

      {/* ─── Step 8: Reveal ───────────────────────────────────────────── */}
      <StepCard
        n={8}
        title="Deck revealed"
        status={stepStatuses.reveal}
        summary={
          roomState?.cardsRevealed
            ? `${roomState.cardCount} cards on chain`
            : 'pending'
        }
        desc="Keeper auto-reveals when running. Otherwise reveal manually below — duel::reveal_deck is permissionless on chain."
      >
        {roomState?.cardsRevealed ? (
          <div className="text-xs text-emerald-300">
            ✓ Deck revealed ({roomState.cardCount} cards on chain)
          </div>
        ) : roomState?.status === 'ACTIVE' ? (
          <div className="space-y-2 text-xs">
            <div className="rounded border border-blue-800 bg-blue-950/30 p-2 text-blue-300 animate-pulse">
              ⏳ Waiting for keeper to call duel::reveal_deck…
            </div>
            <p className="text-[10px] text-gray-500">
              <strong className="text-gray-400">Keeper not running?</strong>{' '}
              In <code>apps/server/.env</code>, uncomment{' '}
              <code>KEEPER_SECRET_KEY</code> (any funded testnet
              wallet works) and restart the server. Or click below to
              reveal manually with your wallet — the contract verifies
              sha2_256(BCS(cards)) == committed deck_hash either way.
            </p>
            <div className="flex gap-2">
              <button
                onClick={stepManualReveal}
                disabled={busyStep === 'reveal'}
                className="rounded bg-indigo-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-600 disabled:opacity-40"
              >
                {busyStep === 'reveal' ? 'Revealing…' : '🔓 Reveal deck manually'}
              </button>
              <button
                onClick={refreshDuelState}
                className="rounded border border-gray-700 bg-gray-850 px-2 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
              >
                🔄 Refresh state
              </button>
            </div>
          </div>
        ) : (
          <div className="text-xs text-gray-400">
            Waiting for duel to go ACTIVE (challenger joins first).
          </div>
        )}
      </StepCard>

      {/* ─── Step 9: Swipe ────────────────────────────────────────────── */}
      <StepCard
        n={9}
        title="Swipe cards"
        status={stepStatuses.swipe}
        summary={`${swipeResults.length} / 5 swiped`}
        desc={`Each swipe = predict::mint(${fmtDusdc(MINT_QUANTITY)}) + duel::record_swipe atomic. Order enforced 0→4.`}
      >
        {deck && roomState?.cardsRevealed && myRole ? (
          <div className="space-y-2 text-xs">
            <div className="text-gray-400">
              You are <span className="text-gray-200">{myRole}</span> · next card{' '}
              <span className="text-gray-200">
                {nextSwipeIdx < 5 ? `#${nextSwipeIdx}` : '— done'}
              </span>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {deck.cards.map((c, i) => {
                const swipe = swipeResults[i]
                const outcome = roomState.cardOutcomes.find((o) => o.cardIdx === i)
                const tick = oracleTicks[c.oracle_id]
                return (
                  <SwipeTile
                    key={i}
                    idx={i}
                    card={c}
                    swipe={swipe}
                    outcome={outcome}
                    tick={tick}
                    isCurrent={i === nextSwipeIdx}
                    busy={busyStep === 'swipe'}
                    onUp={() => stepSwipe(i, true)}
                    onDown={() => stepSwipe(i, false)}
                  />
                )
              })}
            </div>
          </div>
        ) : (
          <div className="text-xs text-gray-400 animate-pulse">
            ⏳ Waiting for deck reveal + challenger join.
          </div>
        )}
      </StepCard>

      {/* ─── Step 10: Result ──────────────────────────────────────────── */}
      <StepCard
        n={10}
        title="Settlement + payout"
        status={stepStatuses.result}
        summary={
          roomState
            ? roomState.status === 'COMPLETE'
              ? 'duel complete'
              : `${roomState.settledCount} / ${roomState.cardCount} cards settled`
            : 'pending'
        }
        desc="Keeper settles each card as its oracle resolves, then bundles redeem×N + finalize."
      >
        {roomState ? (
          <div className="space-y-2 text-xs">
            {roomState.status !== 'COMPLETE' && (
              <div className="flex items-center justify-between gap-2">
                <div className="text-gray-400">
                  Cards settled:{' '}
                  <span className="text-gray-200">
                    {roomState.settledCount} / {roomState.cardCount}
                  </span>
                  {roomState.settledCount < roomState.cardCount && (
                    <span className="ml-2 animate-pulse text-blue-400">
                      ⏳ keeper polling oracles…
                    </span>
                  )}
                </div>
                <button
                  onClick={refreshDuelState}
                  className="rounded border border-gray-700 bg-gray-850 px-2 py-1 text-[10px] text-gray-300 hover:bg-gray-800"
                >
                  🔄 Refresh
                </button>
              </div>
            )}

            {/* Running PnL totals — settled PnL is definitive (contract
                math), unsettled cards mark-to-market against the live
                oracle forward vs strike + swipe direction. */}
            {(roomState.cardOutcomes.length > 0 ||
              roomState.swipes.length > 0) && (() => {
                const meSide: 'p0' | 'p1' =
                  myRole === 'challenger' ? 'p1' : 'p0'
                const oppSide: 'p0' | 'p1' =
                  myRole === 'challenger' ? 'p0' : 'p1'
                const settledIdx = new Set(
                  roomState.cardOutcomes.map((o) => o.cardIdx),
                )
                const liveCountFor = (side: 'p0' | 'p1') =>
                  roomState.swipes.filter((s) => {
                    if (settledIdx.has(s.cardIdx)) return false
                    const sw = side === 'p0' ? s.p0Swipe : s.p1Swipe
                    if (!sw) return false
                    const card = deck?.cards[s.cardIdx]
                    if (!card) return false
                    return oracleTicks[card.oracle_id] !== undefined
                  }).length
                return (
                  <div className="grid grid-cols-2 gap-2 rounded border border-gray-800 bg-gray-950 p-2 text-[11px]">
                    <PnlSummary
                      label={
                        myRole === 'creator'
                          ? 'You (creator)'
                          : myRole === 'challenger'
                            ? 'You (challenger)'
                            : 'Creator'
                      }
                      pnl={runningPnl(roomState, meSide, deck, oracleTicks)}
                      settledCount={roomState.settledCount}
                      totalCards={roomState.cardCount}
                      liveCount={liveCountFor(meSide)}
                      highlight
                    />
                    <PnlSummary
                      label="Opponent"
                      pnl={runningPnl(roomState, oppSide, deck, oracleTicks)}
                      settledCount={roomState.settledCount}
                      totalCards={roomState.cardCount}
                      liveCount={liveCountFor(oppSide)}
                    />
                  </div>
                )
              })()}

            {/* Per-card breakdown: show all 5 slots whether settled yet or not.
                For unsettled slots we still pull both players' swipes
                (incl. opponent's, real-time) from roomState.swipes. */}
            <div className="space-y-0.5">
              {Array.from({ length: roomState.cardCount }).map((_, cardIdx) => {
                const outcome = roomState.cardOutcomes.find(
                  (o) => o.cardIdx === cardIdx,
                )
                const pending = roomState.swipes.find(
                  (s) => s.cardIdx === cardIdx,
                )
                const meKey = myRole === 'challenger' ? 'p1' : 'p0'
                const oppKey = myRole === 'challenger' ? 'p0' : 'p1'
                const myKeyFull = `${meKey}Swipe` as 'p0Swipe' | 'p1Swipe'
                const oppKeyFull = `${oppKey}Swipe` as 'p0Swipe' | 'p1Swipe'
                const mySwipeOnChain =
                  (outcome && outcome[myKeyFull]) ||
                  (pending && pending[myKeyFull]) ||
                  null
                const oppSwipeOnChain =
                  (outcome && outcome[oppKeyFull]) ||
                  (pending && pending[oppKeyFull]) ||
                  null
                const mySwipeLocal = swipeResults.find(
                  (s) => s.cardIdx === cardIdx,
                )
                const myPnl = outcome
                  ? meKey === 'p0'
                    ? outcome.p0Pnl
                    : outcome.p1Pnl
                  : null
                const oppPnl = outcome
                  ? oppKey === 'p0'
                    ? outcome.p0Pnl
                    : outcome.p1Pnl
                  : null
                const card = deck?.cards[cardIdx]
                const tick = card ? oracleTicks[card.oracle_id] : undefined
                const myLivePnl = liveCardPnl(
                  mySwipeOnChain,
                  card?.strike,
                  tick?.forward,
                )
                const oppLivePnl = liveCardPnl(
                  oppSwipeOnChain,
                  card?.strike,
                  tick?.forward,
                )
                return (
                  <CardRow
                    key={cardIdx}
                    cardIdx={cardIdx}
                    outcome={outcome ?? null}
                    mySwipeLocal={mySwipeLocal ?? null}
                    mySwipeOnChain={mySwipeOnChain}
                    oppSwipeOnChain={oppSwipeOnChain}
                    myPnl={myPnl}
                    oppPnl={oppPnl}
                    myLivePnl={myLivePnl}
                    oppLivePnl={oppLivePnl}
                    strike={card?.strike}
                    forward={tick?.forward}
                    onSettle={() => stepManualSettle(cardIdx)}
                    settling={busyStep === 'result'}
                  />
                )
              })}
            </div>

            {/* Manual settle / finalize controls (keeper bypass). */}
            {roomState.status !== 'COMPLETE' && (
              <div className="space-y-1 rounded border border-gray-800 bg-gray-950 p-2 text-[10px] text-gray-400">
                <div>
                  <strong className="text-gray-300">Keeper not running?</strong> Once
                  an oracle resolves, click <em>Settle</em> on its card. After all
                  5 cards are settled, finalize to pay out the pot.
                </div>
                {roomState.settledCount === roomState.cardCount && (
                  <button
                    onClick={stepManualFinalize}
                    disabled={busyStep === 'result'}
                    className="mt-1 rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
                  >
                    {busyStep === 'result' ? 'Finalizing…' : '🏁 Finalize duel'}
                  </button>
                )}
              </div>
            )}

            {roomState.status === 'COMPLETE' && (
              <ResultBanner roomState={roomState} myRole={myRole} />
            )}
          </div>
        ) : (
          <div className="text-xs text-gray-400">Settlement once 5 cards swiped + oracles resolve.</div>
        )}
      </StepCard>
    </div>
  )
}

// ─── Sub-component: StepCard ────────────────────────────────────────────────
//
// Progressive disclosure:
//   - `done` steps collapse to a single-line header (click to re-expand)
//   - every other status (`pending`, `active`, `running`, `error`) renders
//     the full body so action buttons stay visible
//
// `pending` steps are NOT collapsed even though they don't have data yet —
// that's where the "Set up Manager" / "Generate Deck" / etc. buttons live,
// and hiding them strands the user with nothing to click.

function StepCard({
  n,
  title,
  status,
  desc,
  summary,
  children,
}: {
  n: number
  title: string
  status: StepStatus
  desc?: string
  summary?: string
  children: React.ReactNode
}) {
  const [forceExpanded, setForceExpanded] = useState(false)
  const icon =
    status === 'done'
      ? '✅'
      : status === 'running'
        ? '🔄'
        : status === 'error'
          ? '❌'
          : status === 'active'
            ? '🔵'
            : '⚪'
  const border =
    status === 'done'
      ? 'border-emerald-900/60'
      : status === 'running' || status === 'active'
        ? 'border-blue-700'
        : status === 'error'
          ? 'border-red-800'
          : 'border-gray-800'
  const bg =
    status === 'running' || status === 'active'
      ? 'bg-gray-900'
      : 'bg-gray-900/40'

  const collapsed = status === 'done' && !forceExpanded
  const clickable = status === 'done'

  return (
    <div className={`rounded border ${border} ${bg} ${collapsed ? 'p-2' : 'p-3'} transition-colors`}>
      <div
        className={`flex items-center justify-between ${clickable ? 'cursor-pointer' : ''}`}
        onClick={() => clickable && setForceExpanded((v) => !v)}
      >
        <h3 className="text-sm font-semibold text-gray-200">
          <span className="mr-1">{icon}</span>
          <span className="text-gray-500">{n}.</span> {title}
        </h3>
        {summary && (
          <span
            className={`text-[11px] ${
              status === 'done' ? 'text-emerald-300' : 'text-gray-500'
            }`}
          >
            {summary}
          </span>
        )}
      </div>
      {!collapsed && (
        <>
          {desc && (
            <p className="mt-1 text-[11px] leading-snug text-gray-500">{desc}</p>
          )}
          <div className="mt-2">{children}</div>
        </>
      )}
    </div>
  )
}

// ─── Sub-components for richer card / result UI ─────────────────────────────

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <span className="text-gray-400">{label}:</span> {value}
    </div>
  )
}

function StatusPill({ status }: { status: 'PENDING' | 'ACTIVE' | 'COMPLETE' }) {
  const cls =
    status === 'ACTIVE'
      ? 'bg-blue-800 text-blue-100'
      : status === 'COMPLETE'
        ? 'bg-emerald-800 text-emerald-100'
        : 'bg-gray-800 text-gray-300'
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>
      {status}
    </span>
  )
}

/** Compact card tile for the "Generate deck" view — just shows strike + live mark. */
function CardTile({
  idx,
  card,
  tick,
}: {
  idx: number
  card: DeckCard
  tick?: { spot: string; forward: string }
}) {
  const upMark = tick ? (BigInt(tick.spot) > BigInt(card.strike) ? 'UP' : 'DOWN') : '—'
  const upColor =
    upMark === 'UP'
      ? 'text-emerald-400'
      : upMark === 'DOWN'
        ? 'text-red-400'
        : 'text-gray-500'
  return (
    <div className="rounded border border-gray-700 bg-gray-950 p-2 text-center text-[10px]">
      <div className="text-gray-500">card {idx}</div>
      <div className="mt-1 font-semibold text-gray-200">
        ${(Number(card.strike) / 1e9).toFixed(0)}
      </div>
      <div className={`mt-0.5 text-[9px] ${upColor}`}>live {upMark}</div>
    </div>
  )
}

/**
 * Card tile used during the swipe phase. Adds: status pill (Active/Pending/Settled),
 * settle price when known, the player's chosen direction (if swiped),
 * inline UP/DOWN buttons for the current card.
 */
function SwipeTile({
  idx,
  card,
  swipe,
  outcome,
  tick,
  isCurrent,
  busy,
  onUp,
  onDown,
}: {
  idx: number
  card: DeckCard
  swipe: SwipeResult | undefined
  outcome?: { settlementPrice: string; upWon: boolean }
  tick?: { spot: string; forward: string }
  isCurrent: boolean
  busy: boolean
  onUp: () => void
  onDown: () => void
}) {
  const settled = !!outcome
  const upMark = tick
    ? BigInt(tick.spot) > BigInt(card.strike)
      ? 'UP'
      : 'DOWN'
    : '—'
  const border = settled
    ? 'border-purple-700 bg-purple-950/30'
    : swipe
      ? 'border-emerald-700 bg-emerald-950/30'
      : isCurrent
        ? 'border-blue-600 bg-blue-950/30'
        : 'border-gray-800 bg-gray-950'
  return (
    <div className={`rounded border ${border} p-2 text-center text-[10px]`}>
      <div className="flex items-center justify-between">
        <span className="text-gray-500">#{idx}</span>
        {settled ? (
          <span className="rounded bg-purple-800 px-1 py-px text-[8px] font-semibold text-purple-100">
            SET
          </span>
        ) : (
          <span className="text-[8px] text-gray-500">live</span>
        )}
      </div>
      <div className="mt-1 font-semibold text-gray-200">
        ${(Number(card.strike) / 1e9).toFixed(0)}
      </div>
      {settled ? (
        <div className="mt-0.5 text-[9px] text-purple-300">
          @ ${(Number(outcome.settlementPrice) / 1e9).toFixed(0)}
          <br />
          <span className={outcome.upWon ? 'text-emerald-400' : 'text-red-400'}>
            {outcome.upWon ? 'UP won' : 'DOWN won'}
          </span>
        </div>
      ) : (
        <div className="mt-0.5 text-[9px] text-gray-500">spot {upMark}</div>
      )}
      {swipe ? (
        <div
          className={`mt-1 text-[11px] font-semibold ${
            swipe.isUp ? 'text-emerald-300' : 'text-red-300'
          }`}
        >
          {swipe.isUp ? '⬆ UP' : '⬇ DOWN'}
        </div>
      ) : isCurrent ? (
        <div className="mt-1 flex gap-0.5">
          <button
            onClick={onUp}
            disabled={busy}
            className="flex-1 rounded bg-emerald-700 py-1 text-white hover:bg-emerald-600 disabled:opacity-40"
            title="Predict UP"
          >
            ⬆
          </button>
          <button
            onClick={onDown}
            disabled={busy}
            className="flex-1 rounded bg-red-700 py-1 text-white hover:bg-red-600 disabled:opacity-40"
            title="Predict DOWN"
          >
            ⬇
          </button>
        </div>
      ) : (
        <div className="mt-1 text-gray-600">—</div>
      )}
    </div>
  )
}

/**
 * Compact PnL card — shows a player's running PnL (settled cards are
 * definitive from the contract; unsettled-but-swiped cards are
 * marked-to-market against the live oracle forward vs strike). The
 * sub-label calls out the live portion so it's clear which slice
 * may flip once `settle_card` lands.
 */
function PnlSummary({
  label,
  pnl,
  settledCount,
  totalCards,
  liveCount,
  highlight,
}: {
  label: string
  pnl: bigint
  settledCount: number
  totalCards: number
  liveCount: number
  highlight?: boolean
}) {
  return (
    <div
      className={`rounded p-2 ${highlight ? 'border border-indigo-700 bg-indigo-950/30' : 'bg-gray-900'}`}
    >
      <div className="text-[10px] uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div
        className={`mt-1 font-mono text-base font-bold ${pnl > 0n ? 'text-emerald-300' : pnl < 0n ? 'text-red-300' : 'text-gray-300'}`}
      >
        {pnl >= 0n ? '+' : ''}
        {(Number(pnl) / 1_000_000).toFixed(4)} dUSDC
      </div>
      <div className="mt-0.5 text-[10px] text-gray-500">
        {settledCount}/{totalCards} settled
        {liveCount > 0 ? ` · ${liveCount} live (mark-to-market)` : ''}
      </div>
    </div>
  )
}

/**
 * Per-card row inside the settlement table. Two render modes:
 *   - settled: strike, settlement price, who won, both sides' swipe
 *     directions + each side's actual PnL (payout − premium).
 *   - unsettled-but-swiped: each side's swipe direction + a *live PnL*
 *     computed off the current oracle forward vs strike (so if the
 *     forward is currently above the strike, an UP swipe shows green
 *     `+(quantity − premium)`; a DOWN swipe shows red `−premium`).
 *     Updates every oracle tick — flips colors as price moves.
 */
function CardRow({
  cardIdx,
  outcome,
  mySwipeLocal,
  mySwipeOnChain,
  oppSwipeOnChain,
  myPnl,
  oppPnl,
  myLivePnl,
  oppLivePnl,
  strike,
  forward,
  onSettle,
  settling,
}: {
  cardIdx: number
  outcome: RoomState['cardOutcomes'][number] | null
  mySwipeLocal: { isUp: boolean } | null
  mySwipeOnChain: { isUp: boolean; quantity: string; premium: string } | null
  oppSwipeOnChain: { isUp: boolean; quantity: string; premium: string } | null
  myPnl: string | null
  oppPnl: string | null
  myLivePnl: bigint | null
  oppLivePnl: bigint | null
  strike: string | undefined
  forward: string | undefined
  onSettle: () => void
  settling: boolean
}) {
  const settled = outcome !== null
  const arrowOf = (isUp: boolean | undefined) =>
    isUp === undefined ? '—' : isUp ? '⬆' : '⬇'
  const myArrow = arrowOf(
    mySwipeOnChain ? mySwipeOnChain.isUp : mySwipeLocal?.isUp,
  )
  const oppArrow = arrowOf(oppSwipeOnChain?.isUp)
  const pnlClass = (p: bigint | null) =>
    p !== null && p > 0n
      ? 'text-emerald-300'
      : p !== null && p < 0n
        ? 'text-red-300'
        : 'text-gray-500'
  const fmtBigPnl = (p: bigint | null) =>
    p === null
      ? '—'
      : (p >= 0n ? '+' : '') + (Number(p) / 1_000_000).toFixed(4)
  return (
    <div className="grid grid-cols-12 items-center gap-2 rounded bg-gray-950 px-2 py-1.5 text-[11px]">
      <span className="col-span-1 font-mono text-gray-500">#{cardIdx}</span>
      {settled ? (
        <>
          <span className="col-span-2 text-gray-400">
            ${(Number(outcome.strike) / 1e9).toFixed(0)}
          </span>
          <span className="col-span-2 text-gray-300">
            → ${(Number(outcome.settlementPrice) / 1e9).toFixed(0)}
          </span>
          <span className="col-span-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${outcome.upWon ? 'bg-emerald-800 text-emerald-100' : 'bg-red-900 text-red-100'}`}
            >
              {outcome.upWon ? 'UP' : 'DOWN'}
            </span>
          </span>
          <span className="col-span-2 text-right">
            <span className="text-gray-500">you {myArrow} </span>
            <span className={pnlClass(myPnl !== null ? BigInt(myPnl) : null)}>
              {fmtPnl(myPnl)}
            </span>
          </span>
          <span className="col-span-3 text-right">
            <span className="text-gray-500">opp {oppArrow} </span>
            <span className={pnlClass(oppPnl !== null ? BigInt(oppPnl) : null)}>
              {fmtPnl(oppPnl)}
            </span>
          </span>
        </>
      ) : (
        <>
          {/* unsettled — show strike vs live, comparison badge, both sides' swipe + live PnL.
              The badge makes the math transparent: "live > strike → UP" means anyone who
              swiped UP is currently winning, anyone who swiped DOWN is losing. */}
          <span className="col-span-2 text-gray-400">
            {strike ? `$${(Number(strike) / 1e9).toFixed(0)}` : '—'}
          </span>
          <span className="col-span-2 text-gray-500">
            {forward ? `→ $${(Number(forward) / 1e9).toFixed(0)}` : '…'}
          </span>
          <span className="col-span-2">
            {strike && forward ? (
              <span
                className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                  BigInt(forward) >= BigInt(strike)
                    ? 'bg-emerald-900/60 text-emerald-200'
                    : 'bg-red-900/60 text-red-200'
                }`}
                title={`live ${BigInt(forward) >= BigInt(strike) ? '>=' : '<'} strike → ${BigInt(forward) >= BigInt(strike) ? 'UP' : 'DOWN'} winning`}
              >
                {BigInt(forward) >= BigInt(strike) ? '⬆ leading' : '⬇ leading'}
              </span>
            ) : (
              <span className="text-gray-600">…</span>
            )}
          </span>
          <span className="col-span-2 text-right">
            <span className="text-gray-500">you {myArrow} </span>
            <span className={pnlClass(myLivePnl)}>{fmtBigPnl(myLivePnl)}</span>
          </span>
          <span className="col-span-2 text-right">
            <span className="text-gray-500">opp {oppArrow} </span>
            <span className={pnlClass(oppLivePnl)}>{fmtBigPnl(oppLivePnl)}</span>
          </span>
          <span className="col-span-1 text-right">
            <button
              onClick={onSettle}
              disabled={settling}
              className="rounded bg-indigo-700 px-2 py-1 text-[10px] font-semibold text-white hover:bg-indigo-600 disabled:opacity-40"
            >
              {settling ? '…' : 'Settle'}
            </button>
          </span>
        </>
      )}
    </div>
  )
}

/** Celebratory banner when the duel finalizes — shows your role outcome + pot. */
function ResultBanner({
  roomState,
  myRole,
}: {
  roomState: RoomState
  myRole: 'creator' | 'challenger' | null
}) {
  const p0Net = BigInt(roomState.p0Payout) + BigInt(roomState.p1Premium)
  const p1Net = BigInt(roomState.p1Payout) + BigInt(roomState.p0Premium)
  const tie = p0Net === p1Net
  const p0Won = !tie && p0Net > p1Net
  const winnerRole = tie ? null : p0Won ? 'creator' : 'challenger'
  const youWon = myRole === winnerRole && !tie
  const pot = BigInt(roomState.p0Payout) + BigInt(roomState.p1Payout)
  const yourPayout =
    myRole === 'creator'
      ? BigInt(roomState.p0Payout)
      : myRole === 'challenger'
        ? BigInt(roomState.p1Payout)
        : 0n
  const banner = tie
    ? {
        bg: 'border-yellow-700 bg-yellow-950/40',
        emoji: '🤝',
        title: 'Tie — stakes refunded',
        sub: `Both players' real PnL equal. Each side got back ${fmtDusdc(BigInt(roomState.p0Payout))} dUSDC.`,
      }
    : youWon
      ? {
          bg: 'border-emerald-600 bg-emerald-950/40',
          emoji: '🏆',
          title: 'You won the pot!',
          sub: `+${fmtDusdc(yourPayout)} dUSDC paid to your wallet on chain.`,
        }
      : {
          bg: 'border-red-700 bg-red-950/40',
          emoji: '💀',
          title: 'You lost the side-pot',
          sub: `Winner took ${fmtDusdc(pot)} dUSDC. Your Predict positions still redeem separately into your manager.`,
        }
  return (
    <div className={`rounded border ${banner.bg} p-3`}>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl">{banner.emoji}</span>
        <span className="text-base font-bold text-gray-100">{banner.title}</span>
      </div>
      <p className="mt-1 text-[11px] text-gray-300">{banner.sub}</p>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded bg-gray-950 p-2">
          <div className="text-gray-500">creator (p0)</div>
          <div className="text-gray-200">payout {fmtDusdc(BigInt(roomState.p0Payout))}</div>
          <div className="text-gray-500">premium {fmtDusdc(BigInt(roomState.p0Premium))}</div>
        </div>
        <div className="rounded bg-gray-950 p-2">
          <div className="text-gray-500">challenger (p1)</div>
          <div className="text-gray-200">payout {fmtDusdc(BigInt(roomState.p1Payout))}</div>
          <div className="text-gray-500">premium {fmtDusdc(BigInt(roomState.p1Premium))}</div>
        </div>
      </div>
    </div>
  )
}
