/**
 * Flicky game UI — phased state machine driven by on-chain duel state.
 *
 *   Lobby ─→ WaitingForOpponent ─→ Swiping ─→ Lockup ─→ Settling ─→ Result
 *           (creator side)         (5 cards,            (call settle
 *                                   per-card timer)      + finalize)
 *
 *   Lobby ─→ Joining ─→ Swiping ─→ Lockup ─→ Settling ─→ Result
 *           (challenger side)
 *
 * Every phase reads from `fetchDuel(client, duelId)` polled every 3 s. The
 * derived phase + per-player view comes from `d.status`, `myNextCardIdx`,
 * `settledCount`, and the oracle's `settlementPrice`.
 *
 * This is a Phase 2 MVP UI — single-asset (BTC), single-stake-coin (SUI),
 * no zkLogin, no sponsored gas, no matchmaking. Real PRD multiplayer
 * loop is Phase 3.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import {
  ConnectButton,
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Badge } from "@workspace/ui/components/badge"
import { Separator } from "@workspace/ui/components/separator"

import { CONFIG } from "@/lib/config"
import {
  buildCreateDuelTx,
  buildJoinDuelTx,
  buildSettleAndFinalizeTx,
  buildSwipeTx,
  computeDeckHash,
  fetchDuel,
  fetchOracleSvi,
  findLatestOracleSvi,
  listDuelIds,
  oracleStrikes,
  type DeckCard,
  type DuelState,
  type OracleSviInfo,
} from "@/lib/flicky"

// Deckmaster HTTP endpoint. Defaults to the local server during dev.
const DECKMASTER_BASE_URL =
  import.meta.env.VITE_DECKMASTER_URL ?? "http://localhost:3001"

// ─── stake tier presets (free tier — SUI mist; staked tier is Phase 3) ─────

interface StakeTier {
  label: string
  blurb: string
  mist: bigint
}

const STAKE_TIERS: StakeTier[] = [
  { label: "Practice", blurb: "0.01 SUI", mist: 10_000_000n },
  { label: "Standard", blurb: "0.05 SUI", mist: 50_000_000n },
  { label: "High Roller", blurb: "0.10 SUI", mist: 100_000_000n },
]

// Swipe-phase pacing
const SWIPE_PHASE_MS = 60_000
const SPEED_FAST_MAX_MS = 5_000
const SPEED_NORMAL_MAX_MS = 20_000

const EXPLORER = "https://suiscan.xyz/testnet"
const objUrl = (id: string) => `${EXPLORER}/object/${id}`
const txExplorerUrl = (digest: string) => `${EXPLORER}/tx/${digest}`

function ExplorerLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline decoration-dotted underline-offset-2 hover:opacity-80"
    >
      {children}↗
    </a>
  )
}

function fmtUsd(n9: bigint): string {
  return `$${(Number(n9) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

function fmtSui(mist: bigint): string {
  return `${(Number(mist) / 1e9).toFixed(4)} SUI`
}

function shortId(id: string, len = 6): string {
  return id.length > len * 2 + 2 ? `${id.slice(0, len)}…${id.slice(-len)}` : id
}

/**
 * Request a Deckmaster-generated deck from the server. Falls back to
 * client-side generation (less robust — the keeper won't have plaintext
 * for reveal, so reveal must come from this browser tab) if the server is
 * unreachable.
 */
async function requestDeck(
  oracleId: string,
  reference: bigint,
): Promise<{ cards: DeckCard[]; hash: Uint8Array }> {
  try {
    const res = await fetch(`${DECKMASTER_BASE_URL}/deckmaster/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        oracle_id: oracleId,
        reference: reference.toString(),
      }),
    })
    if (!res.ok) throw new Error(`deckmaster ${res.status}`)
    const body = (await res.json()) as {
      cards: Array<{ oracle_id: string; strike: string }>
      hash: string
    }
    const cards: DeckCard[] = body.cards.map((c) => ({
      oracleId: c.oracle_id,
      strike: BigInt(c.strike),
    }))
    const hashHex = body.hash.replace(/^0x/, "")
    const hash = new Uint8Array(
      hashHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
    )
    return { cards, hash }
  } catch {
    // Fallback: generate locally. The keeper won't have plaintext, so
    // reveal must run from this tab via buildRevealDeckTx (not implemented
    // in the lobby UI — Phase 3.5).
    const cards: DeckCard[] = oracleStrikes(reference).map((strike) => ({
      oracleId,
      strike,
    }))
    const hash = await computeDeckHash(cards)
    return { cards, hash }
  }
}

function speedMultiplier(ms: number): { label: string; mult: number; tone: "good" | "ok" | "warn" } {
  if (ms <= SPEED_FAST_MAX_MS) return { label: "1.5×", mult: 1.5, tone: "good" }
  if (ms <= SPEED_NORMAL_MAX_MS) return { label: "1.0×", mult: 1.0, tone: "ok" }
  return { label: "0.75×", mult: 0.75, tone: "warn" }
}

// Used for the swipe-phase countdown — re-renders once per second.
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

// ─── top-level ──────────────────────────────────────────────────────────────

export default function App() {
  const account = useCurrentAccount()
  const [selectedDuel, setSelectedDuel] = useState<string | null>(null)

  return (
    <div className="bg-background min-h-screen">
      <header className="mx-auto flex max-w-3xl items-center justify-between p-4 sm:p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="text-primary">flicky</span>
          </h1>
          <p className="text-muted-foreground text-xs">
            swipe BTC binaries · PvP on Sui testnet
          </p>
        </div>
        <ConnectButton />
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 pb-12 sm:px-6">
        <OracleStrip />
        {account ? (
          selectedDuel ? (
            <DuelView
              duelId={selectedDuel}
              address={account.address}
              onBack={() => setSelectedDuel(null)}
            />
          ) : (
            <Lobby address={account.address} onEnterDuel={setSelectedDuel} />
          )
        ) : (
          <ConnectPrompt />
        )}

        <Footer />
      </main>
    </div>
  )
}

function ConnectPrompt() {
  return (
    <Card className="border-dashed">
      <CardContent className="text-muted-foreground py-12 text-center text-sm">
        Connect a Sui testnet wallet to play.
      </CardContent>
    </Card>
  )
}

function Footer() {
  return (
    <p className="text-muted-foreground pt-4 text-center text-xs">
      package <code>{shortId(CONFIG.packageId)}</code>{" "}
      <ExplorerLink href={objUrl(CONFIG.packageId)}>flicky on chain</ExplorerLink>
    </p>
  )
}

// ─── oracle strip (always visible) ──────────────────────────────────────────

function useOracle() {
  const client = useSuiClient()
  const oracleIdQuery = useQuery({
    queryKey: ["oracle-id"],
    queryFn: () => findLatestOracleSvi(client),
    staleTime: 60_000,
  })
  const oracleQuery = useQuery({
    queryKey: ["oracle", oracleIdQuery.data],
    queryFn: () => fetchOracleSvi(client, oracleIdQuery.data!),
    enabled: !!oracleIdQuery.data,
    refetchInterval: 5_000,
  })
  return { oracleId: oracleIdQuery.data, oracle: oracleQuery.data }
}

function OracleStrip() {
  const { oracleId, oracle } = useOracle()
  const now = useNow(5_000)

  return (
    <Card className="bg-muted/30 border-none">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm">
        <div className="flex items-baseline gap-2">
          <span className="text-muted-foreground text-xs uppercase tracking-wide">BTC</span>
          {oracle ? (
            <>
              <span className="text-xl font-semibold tabular-nums">
                {fmtUsd(oracle.spot)}
              </span>
              <span className="text-muted-foreground text-xs">
                fwd {fmtUsd(oracle.forward)}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground text-xs">connecting…</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs">
          {oracle && (
            <Badge variant={oracle.isActive ? "default" : "secondary"}>
              {oracle.settlementPrice !== null
                ? `settled ${fmtUsd(oracle.settlementPrice)}`
                : oracle.isActive
                  ? expiresIn(oracle, now)
                  : "inactive"}
            </Badge>
          )}
          {oracleId && (
            <ExplorerLink href={objUrl(oracleId)}>{shortId(oracleId)}</ExplorerLink>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function expiresIn(o: OracleSviInfo, now: number): string {
  const ms = Number(o.expiry) - now
  if (ms <= 0) return "expired"
  const min = Math.floor(ms / 60_000)
  const sec = Math.floor((ms % 60_000) / 1000)
  return `${min}m${sec.toString().padStart(2, "0")}s left`
}

// ─── lobby ──────────────────────────────────────────────────────────────────

function Lobby({
  address,
  onEnterDuel,
}: {
  address: string
  onEnterDuel: (id: string) => void
}) {
  const client = useSuiClient()
  const queryClient = useQueryClient()
  const { mutateAsync: signAndExec, isPending } = useSignAndExecuteTransaction()
  const { oracleId, oracle } = useOracle()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const duelsQuery = useQuery({
    queryKey: ["duels"],
    queryFn: () => listDuelIds(client, 10),
    refetchInterval: 6_000,
  })

  async function createDuel(stakeMist: bigint) {
    if (!oracleId || !oracle) return
    setBusy(true)
    setErr(null)
    try {
      // 1. Ask Deckmaster for a deck. Server stores plaintext keyed by hash
      //    so the keeper can reveal once a challenger joins.
      const ref = oracle.settlementPrice ?? oracle.forward
      const deck = await requestDeck(oracleId, ref)

      const tx = buildCreateDuelTx(deck.hash, stakeMist)
      const res = await signAndExec({ transaction: tx })
      const full = await client.waitForTransaction({
        digest: res.digest,
        options: { showObjectChanges: true },
      })
      const created = full.objectChanges?.find(
        (c) => c.type === "created" && c.objectType.includes("::duel::Duel<"),
      )
      queryClient.invalidateQueries({ queryKey: ["duels"] })
      if (created?.type === "created") onEnterDuel(created.objectId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Pick your stake</CardTitle>
          <CardDescription>
            you stake · opponent matches · winner takes the pot
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {STAKE_TIERS.map((t) => (
              <button
                key={t.label}
                disabled={isPending || busy || !oracle}
                onClick={() => createDuel(t.mist)}
                className="border-input bg-background hover:border-primary hover:bg-primary/5 group flex flex-col rounded-lg border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 sm:p-4"
              >
                <span className="text-muted-foreground text-xs uppercase tracking-wide">
                  {t.label}
                </span>
                <span className="mt-1 text-base font-semibold sm:text-lg">{t.blurb}</span>
                <span className="text-muted-foreground mt-2 text-xs">
                  pot {fmtSui(t.mist * 2n)}
                </span>
              </button>
            ))}
          </div>
          {err && (
            <p className="rounded border-l-2 border-red-500 bg-red-500/5 p-2 text-xs text-red-500">
              {err}
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            your wallet:{" "}
            <ExplorerLink href={objUrl(address)}>{shortId(address)}</ExplorerLink>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recent duels</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {duelsQuery.isLoading && (
            <p className="text-muted-foreground text-sm">loading…</p>
          )}
          {duelsQuery.data?.length === 0 && (
            <p className="text-muted-foreground text-sm">no duels yet. be the first.</p>
          )}
          {duelsQuery.data?.map((id) => (
            <DuelSummary
              key={id}
              duelId={id}
              address={address}
              onOpen={() => onEnterDuel(id)}
            />
          ))}
        </CardContent>
      </Card>
    </>
  )
}

function DuelSummary({
  duelId,
  address,
  onOpen,
}: {
  duelId: string
  address: string
  onOpen: () => void
}) {
  const client = useSuiClient()
  const { data: d } = useQuery({
    queryKey: ["duel", duelId],
    queryFn: () => fetchDuel(client, duelId),
    refetchInterval: 5_000,
  })
  if (!d) return null

  const mine = d.creator === address || d.challenger === address
  const statusColor: Record<typeof d.status, "default" | "secondary" | "outline"> = {
    PENDING: "outline",
    ACTIVE: "default",
    COMPLETE: "secondary",
  }
  return (
    <button
      onClick={onOpen}
      className="hover:bg-muted/50 flex w-full items-center justify-between rounded p-2 text-left transition"
    >
      <div className="text-sm">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">{shortId(duelId)}</span>
          <Badge variant={statusColor[d.status]}>{d.status}</Badge>
          {mine && <Badge variant="outline">yours</Badge>}
        </div>
        <div className="text-muted-foreground text-xs">
          pot {fmtSui(d.p0Stake + d.p1Stake)} · settled {d.settledCount.toString()}/5
        </div>
      </div>
      <span className="text-muted-foreground text-xs">→</span>
    </button>
  )
}

// ─── duel view (phase dispatcher) ───────────────────────────────────────────

function DuelView({
  duelId,
  address,
  onBack,
}: {
  duelId: string
  address: string
  onBack: () => void
}) {
  const client = useSuiClient()
  const { oracle } = useOracle()
  const duelQuery = useQuery({
    queryKey: ["duel", duelId],
    queryFn: () => fetchDuel(client, duelId),
    refetchInterval: 2_000,
  })
  const d = duelQuery.data

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <button
            onClick={onBack}
            className="text-muted-foreground hover:text-foreground text-sm"
          >
            ← lobby
          </button>
          <ExplorerLink href={objUrl(duelId)}>{shortId(duelId)}</ExplorerLink>
        </div>
      </CardHeader>
      <CardContent>
        {!d ? (
          <p className="text-muted-foreground py-12 text-center text-sm">loading…</p>
        ) : (
          <PhaseDispatcher duel={d} address={address} duelId={duelId} oracle={oracle} />
        )}
      </CardContent>
    </Card>
  )
}

function PhaseDispatcher({
  duel,
  address,
  duelId,
  oracle,
}: {
  duel: DuelState
  address: string
  duelId: string
  oracle: OracleSviInfo | undefined
}) {
  const isCreator = duel.creator === address
  const isChallenger = duel.challenger === address
  const isPlayer = isCreator || isChallenger
  const myNextIdx = isCreator ? Number(duel.p0NextCardIdx) : Number(duel.p1NextCardIdx)
  const opponentNextIdx = isCreator
    ? Number(duel.p1NextCardIdx)
    : Number(duel.p0NextCardIdx)
  const allSwiped = myNextIdx === 5 && opponentNextIdx === 5

  if (duel.status === "COMPLETE") {
    return <ResultView duel={duel} address={address} />
  }
  if (duel.status === "PENDING") {
    if (isCreator) return <WaitingForOpponentView duel={duel} duelId={duelId} />
    return <JoinView duel={duel} duelId={duelId} />
  }
  // ACTIVE
  if (!isPlayer) {
    return <SpectatorView duel={duel} />
  }
  if (myNextIdx < 5) {
    return (
      <SwipingView
        duel={duel}
        duelId={duelId}
        oracle={oracle}
        myNextIdx={myNextIdx}
        isCreator={isCreator}
      />
    )
  }
  if (!allSwiped) {
    return <LockupView myNextIdx={myNextIdx} opponentNextIdx={opponentNextIdx} />
  }
  if (oracle && oracle.settlementPrice === null) {
    return <LockupView myNextIdx={myNextIdx} opponentNextIdx={opponentNextIdx} />
  }
  return <SettlingView duel={duel} duelId={duelId} />
}

// ─── phases ─────────────────────────────────────────────────────────────────

function WaitingForOpponentView({
  duel,
  duelId,
}: {
  duel: DuelState
  duelId: string
}) {
  const now = useNow(1000)
  // PENDING duels have started_at_ms == 0 (set only on join_duel). Track
  // elapsed from when this view mounted — close enough for a spinner.
  const [mountedAt] = useState(() => Date.now())
  const elapsed = Math.max(0, Math.floor((now - mountedAt) / 1000))
  const showShareEscape = elapsed > 30
  return (
    <div className="space-y-4 py-8 text-center">
      <div className="flex justify-center">
        <span className="border-primary inline-block h-12 w-12 animate-spin rounded-full border-4 border-t-transparent" />
      </div>
      <div className="space-y-1">
        <div className="text-lg font-semibold">matching…</div>
        <div className="text-muted-foreground text-xs">{elapsed}s elapsed</div>
      </div>
      <p className="text-muted-foreground text-sm">
        you staked <strong className="text-foreground">{fmtSui(duel.p0Stake)}</strong>.
        bot auto-fills after ~5s if no human joins.
      </p>
      {showShareEscape && (
        <div className="space-y-1 pt-3">
          <p className="text-muted-foreground text-xs">
            still no opponent. share manually:
          </p>
          <code className="bg-muted block break-all rounded p-2 text-xs">{duelId}</code>
        </div>
      )}
      <p className="text-muted-foreground pt-2 text-xs">
        pot when full {fmtSui(duel.p0Stake * 2n)}
      </p>
    </div>
  )
}

function JoinView({ duel, duelId }: { duel: DuelState; duelId: string }) {
  const { mutateAsync: signAndExec, isPending } = useSignAndExecuteTransaction()
  const queryClient = useQueryClient()
  const [err, setErr] = useState<string | null>(null)

  async function join() {
    setErr(null)
    try {
      const tx = buildJoinDuelTx(duelId, duel.p0Stake, duel.stakeCoinType)
      await signAndExec({ transaction: tx })
      queryClient.invalidateQueries({ queryKey: ["duel", duelId] })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-3 py-4 text-center">
      <Badge variant="outline">open duel</Badge>
      <p className="text-muted-foreground text-sm">
        creator staked <strong>{fmtSui(duel.p0Stake)}</strong>. match it to start swiping.
      </p>
      <Button size="lg" onClick={join} disabled={isPending} className="w-full">
        join · stake {fmtSui(duel.p0Stake)}
      </Button>
      {err && (
        <p className="rounded border-l-2 border-red-500 bg-red-500/5 p-2 text-left text-xs text-red-500">
          {err}
        </p>
      )}
    </div>
  )
}

// Threshold (px) past which a drag commits a swipe. Computed from card width
// at drag start so it stays proportional across screen sizes.
const DRAG_COMMIT_FRACTION = 0.3
// Max rotation applied to the card during drag, in degrees per cardWidth/2 px.
const DRAG_MAX_ROTATE_DEG = 18

function SwipingView({
  duel,
  duelId,
  oracle,
  myNextIdx,
  isCreator,
}: {
  duel: DuelState
  duelId: string
  oracle: OracleSviInfo | undefined
  myNextIdx: number
  isCreator: boolean
}) {
  const { mutateAsync: signAndExec, isPending } = useSignAndExecuteTransaction()
  const queryClient = useQueryClient()
  const now = useNow(250)
  const card = duel.cards[myNextIdx]
  const baselineMs = Number(
    isCreator ? duel.p0LastSwipeOrStartMs : duel.p1LastSwipeOrStartMs,
  )
  const elapsedMs = Math.max(0, now - baselineMs)
  const timerMs = Math.max(0, SWIPE_PHASE_MS - elapsedMs)
  const speed = speedMultiplier(elapsedMs)
  const [err, setErr] = useState<string | null>(null)

  // ── drag state ────────────────────────────────────────────────────────
  const cardRef = useRef<HTMLDivElement>(null)
  const dragStartX = useRef(0)
  const cardWidth = useRef(0)
  const [drag, setDrag] = useState<{
    x: number
    active: boolean
    flying: null | "up" | "down"
  }>({ x: 0, active: false, flying: null })

  // Reset drag whenever we move to a new card (myNextIdx changes).
  useEffect(() => {
    setDrag({ x: 0, active: false, flying: null })
    setErr(null)
  }, [myNextIdx])

  const swipe = useCallback(
    async (isUp: boolean) => {
      setErr(null)
      try {
        const tx = buildSwipeTx(duelId, card.oracleId, myNextIdx, isUp, duel.stakeCoinType)
        await signAndExec({ transaction: tx })
        queryClient.invalidateQueries({ queryKey: ["duel", duelId] })
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        // Failed mid-flight: snap the card back to center.
        setDrag({ x: 0, active: false, flying: null })
      }
    },
    [duelId, card.oracleId, myNextIdx, duel.stakeCoinType, signAndExec, queryClient],
  )

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (isPending || drag.flying) return
    cardWidth.current = cardRef.current?.offsetWidth ?? 320
    dragStartX.current = e.clientX
    setDrag({ x: 0, active: true, flying: null })
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.active) return
    setDrag((d) => ({ ...d, x: e.clientX - dragStartX.current }))
  }
  function onPointerUp() {
    if (!drag.active) return
    const w = cardWidth.current || 320
    const threshold = w * DRAG_COMMIT_FRACTION
    if (drag.x > threshold) {
      setDrag({ x: drag.x, active: false, flying: "up" })
      swipe(true)
    } else if (drag.x < -threshold) {
      setDrag({ x: drag.x, active: false, flying: "down" })
      swipe(false)
    } else {
      setDrag({ x: 0, active: false, flying: null })
    }
  }

  // Visual transform during drag/flying.
  const flyOff =
    drag.flying === "up"
      ? `translateX(150%) rotate(${DRAG_MAX_ROTATE_DEG + 6}deg)`
      : drag.flying === "down"
        ? `translateX(-150%) rotate(${-(DRAG_MAX_ROTATE_DEG + 6)}deg)`
        : null
  const w = cardWidth.current || 320
  const rotate = (drag.x / (w / 2)) * DRAG_MAX_ROTATE_DEG
  const transform =
    flyOff ?? (drag.x === 0 ? "" : `translateX(${drag.x}px) rotate(${rotate}deg)`)

  const overlayProgress = Math.min(1, Math.abs(drag.x) / (w * DRAG_COMMIT_FRACTION))
  const upOverlay = drag.x > 0 ? overlayProgress : 0
  const downOverlay = drag.x < 0 ? overlayProgress : 0

  const timerSec = Math.ceil(timerMs / 1000)
  const timerPct = (timerMs / SWIPE_PHASE_MS) * 100
  const speedColor =
    speed.tone === "good"
      ? "text-emerald-500"
      : speed.tone === "warn"
        ? "text-amber-500"
        : "text-muted-foreground"

  return (
    <div className="space-y-4">
      {/* phase header */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          card <strong className="text-foreground">{myNextIdx + 1}</strong>/5
        </span>
        <span className={speedColor}>
          {speed.label} {speed.tone === "good" && "⚡"}
        </span>
        <span className="font-mono text-sm tabular-nums">{timerSec}s</span>
      </div>
      <div className="bg-muted h-1.5 overflow-hidden rounded-full">
        <div
          className="bg-primary h-full transition-all duration-300"
          style={{ width: `${timerPct}%` }}
        />
      </div>

      {/* card container — touch-action: none disables browser scroll while dragging */}
      <div className="relative select-none" style={{ touchAction: "none" }}>
        <div
          ref={cardRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className={`bg-card relative cursor-grab overflow-hidden rounded-xl border p-6 shadow-sm active:cursor-grabbing ${
            drag.active ? "" : "transition-transform duration-300 ease-out"
          } ${drag.flying ? "pointer-events-none" : ""}`}
          style={{ transform, willChange: "transform" }}
        >
          {/* swipe-direction overlays — fade in with drag distance */}
          <div
            className="pointer-events-none absolute inset-0 rounded-xl bg-emerald-500/20"
            style={{ opacity: upOverlay }}
          />
          <div
            className="pointer-events-none absolute inset-0 rounded-xl bg-red-500/20"
            style={{ opacity: downOverlay }}
          />
          {/* Direction badge that appears on whichever side is committing */}
          {drag.x > 20 && (
            <div className="absolute right-4 top-4 rotate-12 rounded border-2 border-emerald-500 px-2 py-0.5 text-lg font-black uppercase text-emerald-500">
              ↑ UP
            </div>
          )}
          {drag.x < -20 && (
            <div className="absolute left-4 top-4 -rotate-12 rounded border-2 border-red-500 px-2 py-0.5 text-lg font-black uppercase text-red-500">
              ↓ DOWN
            </div>
          )}

          <div className="text-muted-foreground text-xs uppercase tracking-wide">
            BTC at expiry
          </div>
          <div className="mt-3 text-4xl font-bold tabular-nums sm:text-5xl">
            {fmtUsd(card.strike)}
          </div>
          <div className="text-muted-foreground mt-1 text-sm">
            will BTC settle{" "}
            <strong className="text-foreground">above</strong> this strike?
          </div>
          {oracle && (
            <div className="text-muted-foreground mt-4 flex justify-between border-t pt-3 text-xs">
              <span>
                now <strong className="text-foreground">{fmtUsd(oracle.spot)}</strong>
              </span>
              <span>
                fwd <strong className="text-foreground">{fmtUsd(oracle.forward)}</strong>
              </span>
              <span>
                {oracle.spot > card.strike ? (
                  <span className="text-emerald-500">
                    ↑ {fmtUsd(oracle.spot - card.strike)} above
                  </span>
                ) : (
                  <span className="text-red-500">
                    ↓ {fmtUsd(card.strike - oracle.spot)} below
                  </span>
                )}
              </span>
            </div>
          )}
        </div>

        {/* hint shown only on card 1 before any drag */}
        {myNextIdx === 0 && drag.x === 0 && !drag.flying && (
          <p className="text-muted-foreground mt-3 text-center text-xs">
            ← swipe DOWN · swipe UP →
          </p>
        )}
      </div>

      {/* button fallback (a11y + non-touch) */}
      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="outline"
          size="lg"
          disabled={isPending || !!drag.flying}
          onClick={() => {
            setDrag({ x: -200, active: false, flying: "down" })
            swipe(false)
          }}
          className="h-16 text-base"
        >
          <div className="flex flex-col">
            <span>↓ DOWN</span>
            <span className="text-muted-foreground text-xs font-normal">
              ≤ {fmtUsd(card.strike)}
            </span>
          </div>
        </Button>
        <Button
          size="lg"
          disabled={isPending || !!drag.flying}
          onClick={() => {
            setDrag({ x: 200, active: false, flying: "up" })
            swipe(true)
          }}
          className="h-16 text-base"
        >
          <div className="flex flex-col">
            <span>↑ UP</span>
            <span className="text-primary-foreground/80 text-xs font-normal">
              &gt; {fmtUsd(card.strike)}
            </span>
          </div>
        </Button>
      </div>

      <p className="text-muted-foreground text-center text-xs">
        decide fast: 0–5s = 1.5× · 5–20s = 1.0× · 20–60s = 0.75×
      </p>

      {err && (
        <p className="rounded border-l-2 border-red-500 bg-red-500/5 p-2 text-xs text-red-500">
          {err}
        </p>
      )}
    </div>
  )
}

function LockupView({
  myNextIdx,
  opponentNextIdx,
}: {
  myNextIdx: number
  opponentNextIdx: number
}) {
  const allSwiped = myNextIdx === 5 && opponentNextIdx === 5
  return (
    <div className="space-y-4 py-6 text-center">
      <Badge variant="outline">lockup phase</Badge>
      <p className="text-2xl">🔒</p>
      <p className="text-lg">
        {allSwiped
          ? "watching the oracle tick toward settlement…"
          : "waiting for opponent to finish swiping…"}
      </p>
      <p className="text-muted-foreground text-sm">
        swipes are locked. the deck settles when BTC's oracle resolves.
      </p>
      <div className="text-muted-foreground flex justify-center gap-6 pt-2 text-xs">
        <span>
          you <strong className="text-foreground">{myNextIdx}</strong>/5
        </span>
        <span>
          opponent <strong className="text-foreground">{opponentNextIdx}</strong>/5
        </span>
      </div>
    </div>
  )
}

function SettlingView({ duel, duelId }: { duel: DuelState; duelId: string }) {
  const { mutateAsync: signAndExec, isPending } = useSignAndExecuteTransaction()
  const queryClient = useQueryClient()
  const [err, setErr] = useState<string | null>(null)
  const [digest, setDigest] = useState<string | null>(null)

  async function settle() {
    setErr(null)
    try {
      const tx = buildSettleAndFinalizeTx(duelId, duel.cards[0].oracleId, duel.stakeCoinType)
      const res = await signAndExec({ transaction: tx })
      setDigest(res.digest)
      queryClient.invalidateQueries({ queryKey: ["duel", duelId] })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-4 py-6 text-center">
      <Badge variant="default">oracle settled</Badge>
      <p className="text-lg">paying out…</p>
      <p className="text-muted-foreground text-sm">
        the keeper auto-closes settled duels — payouts appear within ~10s.
      </p>
      <details className="text-muted-foreground mx-auto max-w-sm text-left text-xs">
        <summary className="cursor-pointer text-center underline-offset-2 hover:underline">
          impatient? settle manually
        </summary>
        <div className="mt-3 space-y-2">
          <Button size="sm" onClick={settle} disabled={isPending} className="w-full">
            settle + finalize
          </Button>
          {digest && (
            <p>
              tx <ExplorerLink href={txExplorerUrl(digest)}>{shortId(digest)}</ExplorerLink>
            </p>
          )}
          {err && (
            <p className="rounded border-l-2 border-red-500 bg-red-500/5 p-2 text-red-500">
              {err}
            </p>
          )}
        </div>
      </details>
    </div>
  )
}

function ResultView({ duel, address }: { duel: DuelState; address: string }) {
  const isCreator = duel.creator === address
  const myScore = isCreator ? duel.p0Score : duel.p1Score
  const oppScore = isCreator ? duel.p1Score : duel.p0Score
  const tie = duel.p0Score === duel.p1Score
  const won = !tie && myScore > oppScore
  const lost = !tie && myScore < oppScore

  const total = duel.p0Stake + duel.p1Stake
  const myPayout = won ? total : tie ? (isCreator ? duel.p0Stake : duel.p1Stake) : 0n

  const banner = won
    ? { emoji: "🏆", text: "you won", tone: "text-emerald-500" }
    : lost
      ? { emoji: "💀", text: "you lost", tone: "text-red-500" }
      : { emoji: "🤝", text: "tie", tone: "text-amber-500" }

  // Per-card outcome — needs the strike + settlement + your swipe
  const myCards = useMemo(() => {
    const swipes = isCreator ? duel.p0Swipes : duel.p1Swipes
    return duel.cards.map((c, i) => {
      const swipe = swipes[i]
      const settle = duel.cardSettlements[i]
      const actualUp = settle !== null && settle > c.strike
      const correct = swipe !== null && actualUp === swipe.isUp
      return { card: c, swipe, settle, actualUp, correct }
    })
  }, [duel, isCreator])

  return (
    <div className="space-y-5">
      <div className="space-y-2 py-6 text-center">
        <div className="text-5xl">{banner.emoji}</div>
        <div className={`text-2xl font-bold uppercase tracking-wide ${banner.tone}`}>
          {banner.text}
        </div>
        {myPayout > 0n && (
          <div className="text-muted-foreground text-sm">
            payout <strong className="text-foreground">{fmtSui(myPayout)}</strong>
          </div>
        )}
      </div>

      <Separator />

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="bg-muted/40 rounded p-3">
          <div className="text-muted-foreground text-xs">your score</div>
          <div className="text-2xl font-semibold tabular-nums">
            {(Number(myScore) / 1e9).toFixed(2)}
          </div>
        </div>
        <div className="bg-muted/40 rounded p-3">
          <div className="text-muted-foreground text-xs">opponent</div>
          <div className="text-2xl font-semibold tabular-nums">
            {(Number(oppScore) / 1e9).toFixed(2)}
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
          cards
        </h3>
        <div className="space-y-1.5">
          {myCards.map((m, i) => (
            <div
              key={i}
              className="bg-muted/30 flex items-center justify-between rounded p-2 text-sm"
            >
              <div>
                <span className="text-muted-foreground">card {i + 1} · </span>
                <span className="tabular-nums">{fmtUsd(m.card.strike)}</span>
              </div>
              <div className="flex items-center gap-3 text-xs">
                {m.swipe ? (
                  <span className="text-muted-foreground">
                    you {m.swipe.isUp ? "↑" : "↓"}
                  </span>
                ) : (
                  <span className="text-muted-foreground italic">no swipe</span>
                )}
                <span>
                  settled{" "}
                  <strong>
                    {m.settle !== null ? (m.actualUp ? "↑" : "↓") : "—"}
                  </strong>
                </span>
                <Badge
                  variant={m.correct ? "default" : "secondary"}
                  className={m.correct ? "bg-emerald-500/20 text-emerald-500" : ""}
                >
                  {m.correct ? "✓" : "✗"}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function SpectatorView({ duel }: { duel: DuelState }) {
  return (
    <div className="space-y-3 py-4 text-center">
      <Badge variant="secondary">spectating</Badge>
      <p className="text-muted-foreground text-sm">
        you're not a player in this duel. pot {fmtSui(duel.p0Stake + duel.p1Stake)}.
      </p>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="bg-muted/40 rounded p-3">
          <div className="text-muted-foreground text-xs">creator</div>
          <div className="font-semibold">
            {(Number(duel.p0Score) / 1e9).toFixed(2)}
          </div>
        </div>
        <div className="bg-muted/40 rounded p-3">
          <div className="text-muted-foreground text-xs">challenger</div>
          <div className="font-semibold">
            {(Number(duel.p1Score) / 1e9).toFixed(2)}
          </div>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        swipes {Number(duel.p0NextCardIdx)}/5 · {Number(duel.p1NextCardIdx)}/5 · settled{" "}
        {duel.settledCount.toString()}/5
      </p>
    </div>
  )
}
