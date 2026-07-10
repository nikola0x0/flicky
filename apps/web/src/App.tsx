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
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
  useWallets,
} from "@mysten/dapp-kit-react"
import { useFlickySign } from "@/lib/use-flicky-sign"
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
  buildCreateDuelDusdcTx,
  buildCreateDuelTx,
  buildJoinDuelDusdcTx,
  buildJoinDuelTx,
  buildRevealDeckTx,
  buildFinalizeTx,
  buildSwipeTx,
  computeDeckHash,
  fetchDuel,
  fetchOracleSvi,
  findLatestOracleSvi,
  listDuelIds,
  oracleStrikes,
  resolveCreatedDuelId,
  type DeckCard,
  type DuelState,
  type OracleSviInfo,
} from "@/lib/flicky"
import {
  DEEPBOOK,
  buildCreateManagerTx,
  buildDepositDusdcTx,
  buildStakedSwipeTx,
  waitForCreatedManagerId,
  findPredictManager,
  getManagerDusdcBalance,
  getWalletDusdcBalance,
  writeManagerCache,
} from "@/lib/deepbook"

// Deckmaster HTTP endpoint. Defaults to the local server during dev.
const DECKMASTER_BASE_URL =
  import.meta.env.VITE_DECKMASTER_URL ?? "http://localhost:3001"

// ─── stake tier presets ─────────────────────────────────────────────────────

type Tier = "free" | "staked"

interface StakeTier {
  label: string
  blurb: string
  amount: bigint
  coinType: string
}

const FREE_TIERS: StakeTier[] = [
  {
    label: "Practice",
    blurb: "0.01 SUI",
    amount: 10_000_000n,
    coinType: CONFIG.stakeType,
  },
  {
    label: "Standard",
    blurb: "0.05 SUI",
    amount: 50_000_000n,
    coinType: CONFIG.stakeType,
  },
  {
    label: "High Roller",
    blurb: "0.10 SUI",
    amount: 100_000_000n,
    coinType: CONFIG.stakeType,
  },
]

// PRD §Stake tiers (staked mode): 1 / 5 / 10 dUSDC.
const STAKED_TIERS: StakeTier[] = [
  {
    label: "Practice",
    blurb: "1 dUSDC",
    amount: 1_000_000n,
    coinType: DEEPBOOK.dusdcType,
  },
  {
    label: "Standard",
    blurb: "5 dUSDC",
    amount: 5_000_000n,
    coinType: DEEPBOOK.dusdcType,
  },
  {
    label: "High Roller",
    blurb: "10 dUSDC",
    amount: 10_000_000n,
    coinType: DEEPBOOK.dusdcType,
  },
]

// Swipe-phase pacing
const SWIPE_PHASE_MS = 60_000
const SPEED_FAST_MAX_MS = 5_000
const SPEED_NORMAL_MAX_MS = 20_000

const EXPLORER = "https://suiscan.xyz/testnet"
/** Wallet-style explorer page: shows owned objects + tx history. */
const addressUrl = (id: string) => `${EXPLORER}/address/${id}`
/** Object-style page anchored on tx-blocks tab — gives a duel/oracle/
 *  package a useful default landing showing all transactions touching it. */
const objectUrl = (id: string) => `${EXPLORER}/object/${id}/tx-blocks`
const txExplorerUrl = (digest: string) => `${EXPLORER}/tx/${digest}`

function ExplorerLink({
  href,
  children,
}: {
  href: string
  children: ReactNode
}) {
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

function fmtDusdc(micro: bigint): string {
  return `${(Number(micro) / 1e6).toFixed(2)} dUSDC`
}

/** Pick the right formatter for whichever coin type the duel is staked in. */
function fmtStake(amount: bigint, coinType: string): string {
  return coinType === DEEPBOOK.dusdcType ? fmtDusdc(amount) : fmtSui(amount)
}

function shortId(id: string, len = 6): string {
  return id.length > len * 2 + 2 ? `${id.slice(0, len)}…${id.slice(-len)}` : id
}

// ─── wallet button (custom-styled replacement for dapp-kit ConnectButton) ───

/**
 * Two states:
 *   - disconnected → opens a modal listing available wallets
 *   - connected → opens a dropdown with copy / explorer / disconnect
 */
function WalletButton() {
  const account = useCurrentAccount()
  const [modalOpen, setModalOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  if (!account) {
    return (
      <>
        <Button
          size="sm"
          onClick={() => setModalOpen(true)}
          className="h-9 px-4 text-base font-medium tracking-[-0.005em]"
        >
          connect wallet
        </Button>
        {modalOpen && <WalletModal onClose={() => setModalOpen(false)} />}
      </>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={() => setMenuOpen((v) => !v)}
        className="flex h-9 items-center gap-2 rounded-md border border-hairline bg-surface-1 px-3 text-base font-medium tracking-[-0.005em] transition hover:bg-surface-2"
      >
        <span className="inline-block h-2 w-2 rounded-full bg-primary" />
        <span className="font-mono text-[12px]">
          {shortId(account.address, 4)}
        </span>
        <span className="text-xs text-ink-subtle">▾</span>
      </button>
      {menuOpen && (
        <WalletMenu
          address={account.address}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  )
}

function WalletModal({ onClose }: { onClose: () => void }) {
  const wallets = useWallets()
  const dAppKit = useDAppKit()
  const [busyWallet, setBusyWallet] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const isPending = busyWallet !== null

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  async function pick(name: string) {
    const wallet = wallets.find((w) => w.name === name)
    if (!wallet) return
    setBusyWallet(name)
    setError(null)
    try {
      await dAppKit.connectWallet({ wallet })
      onClose()
    } catch (e) {
      // error surfaces below
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setBusyWallet(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-t-xl border border-hairline bg-surface-1 p-5 shadow-2xl sm:rounded-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-[-0.01em]">
            Connect wallet
          </h2>
          <button
            onClick={onClose}
            className="text-xl leading-none text-ink-subtle hover:text-foreground"
            aria-label="close"
          >
            ×
          </button>
        </div>
        {wallets.length === 0 ? (
          <p className="text-base text-ink-subtle">
            No Sui wallets detected. Install{" "}
            <a
              href="https://chromewebstore.google.com/detail/sui-wallet/opcgpfmipidbgpenhmajoajpbobppdil"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline decoration-dotted"
            >
              Sui Wallet
            </a>{" "}
            or{" "}
            <a
              href="https://suiet.app"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline decoration-dotted"
            >
              Suiet
            </a>{" "}
            and reload.
          </p>
        ) : (
          <div className="space-y-1.5">
            {wallets.map((w) => (
              <button
                key={w.name}
                onClick={() => pick(w.name)}
                disabled={isPending}
                className="group flex w-full items-center gap-3 rounded-md border border-hairline bg-transparent px-3 py-2 text-left transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {w.icon ? (
                  <img
                    src={w.icon}
                    alt=""
                    className="h-7 w-7 rounded-md object-cover"
                  />
                ) : (
                  <div className="h-7 w-7 rounded-md bg-surface-3" />
                )}
                <span className="flex-1 text-base font-medium">{w.name}</span>
                {busyWallet === w.name && (
                  <span className="text-sm text-ink-subtle">connecting…</span>
                )}
              </button>
            ))}
          </div>
        )}
        {error && (
          <p className="mt-3 rounded border-l-2 border-red-500 bg-red-500/5 p-2 text-sm text-red-500">
            {error.message}
          </p>
        )}
        <p className="mt-4 text-xs text-ink-tertiary">
          By connecting, you authorize this app to read your address. No
          transactions are sent until you confirm them.
        </p>
      </div>
    </div>
  )
}

function WalletMenu({
  address,
  onClose,
}: {
  address: string
  onClose: () => void
}) {
  const dAppKit = useDAppKit()
  const [copied, setCopied] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Click outside / Escape to close.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  async function copy() {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // ignore
    }
  }

  return (
    <div
      ref={menuRef}
      className="absolute top-11 right-0 z-40 w-64 overflow-hidden rounded-lg border border-hairline bg-surface-1 shadow-2xl"
    >
      <div className="border-b border-hairline px-3 py-2.5">
        <div className="text-xs font-medium tracking-[0.06em] text-ink-subtle uppercase">
          Connected
        </div>
        <code className="mt-1 block font-mono text-xs break-all">
          {address}
        </code>
      </div>
      <div className="p-1">
        <MenuItem onClick={copy}>
          <span>📋</span>
          <span>{copied ? "copied!" : "copy address"}</span>
        </MenuItem>
        <a
          href={addressUrl(address)}
          target="_blank"
          rel="noreferrer"
          onClick={onClose}
          className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-base transition hover:bg-surface-2"
        >
          <span>🔍</span>
          <span>open in explorer</span>
        </a>
        <MenuItem
          onClick={async () => {
            await dAppKit.disconnectWallet()
            onClose()
          }}
          tone="danger"
        >
          <span>⏻</span>
          <span>disconnect</span>
        </MenuItem>
      </div>
    </div>
  )
}

function MenuItem({
  children,
  onClick,
  tone,
}: {
  children: ReactNode
  onClick: () => void
  tone?: "danger"
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-base transition hover:bg-surface-2 ${
        tone === "danger" ? "text-red-400 hover:text-red-300" : ""
      }`}
    >
      {children}
    </button>
  )
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
  sender?: string
): Promise<{ cards: DeckCard[]; hash: Uint8Array }> {
  try {
    // The server discovers live oracles itself and auto-sizes the deck to
    // supply (3–5). We send a size band; `cards.length` is the authoritative
    // deck size and must be passed to `create_duel`. `oracleId`/`reference`
    // are only used by the client-side fallback below.
    const res = await fetch(`${DECKMASTER_BASE_URL}/deckmaster/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        asset: "BTC",
        sender,
        minDeckSize: 3,
        maxDeckSize: 5,
      }),
    })
    if (!res.ok) throw new Error(`deckmaster ${res.status}`)
    const body = (await res.json()) as {
      cards: Array<{ expiry_market_id: string; strike: string }>
      hash: string
      deckSize?: number
      liveOracleCount?: number
    }
    const cards: DeckCard[] = body.cards.map((c) => ({
      oracleId: c.expiry_market_id,
      strike: BigInt(c.strike),
    }))
    const hashHex = body.hash.replace(/^0x/, "")
    const hash = new Uint8Array(
      hashHex.match(/.{2}/g)!.map((b) => parseInt(b, 16))
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

function speedMultiplier(ms: number): {
  label: string
  mult: number
  tone: "good" | "ok" | "warn"
} {
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
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-3xl items-center justify-between p-4 sm:p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.03em]">
            <span className="text-primary">flicky</span>
          </h1>
          <p className="text-sm tracking-[-0.005em] text-ink-subtle">
            swipe BTC binaries · PvP on Sui testnet
          </p>
        </div>
        <WalletButton />
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
      <CardContent className="py-12 text-center text-base text-muted-foreground">
        Connect a Sui testnet wallet to play.
      </CardContent>
    </Card>
  )
}

function Footer() {
  return (
    <p className="pt-4 text-center text-sm text-muted-foreground">
      package <code>{shortId(CONFIG.packageId)}</code>{" "}
      <ExplorerLink href={objectUrl(CONFIG.packageId)}>
        flicky on chain
      </ExplorerLink>
    </p>
  )
}

// ─── oracle strip (always visible) ──────────────────────────────────────────

function useOracle() {
  const client = useCurrentClient()
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
    <Card className="border-hairline bg-surface-1">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4 text-base">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium tracking-[0.06em] text-ink-subtle uppercase">
            BTC
          </span>
          {oracle ? (
            <>
              <span className="text-xl font-semibold tabular-nums">
                {fmtUsd(oracle.spot)}
              </span>
              <span className="text-sm text-muted-foreground">
                fwd {fmtUsd(oracle.forward)}
              </span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">connecting…</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-sm">
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
            <ExplorerLink href={objectUrl(oracleId)}>
              {shortId(oracleId)}
            </ExplorerLink>
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
  const client = useCurrentClient()
  const queryClient = useQueryClient()
  const { mutateAsync: signAndExec, isPending } = useFlickySign()
  const { oracleId, oracle } = useOracle()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [tier, setTier] = useState<Tier>("free")

  const duelsQuery = useQuery({
    queryKey: ["duels"],
    queryFn: () => listDuelIds(client, 10),
    refetchInterval: 6_000,
  })

  // Probe the player's dUSDC wallet balance + PredictManager state up
  // front, regardless of which tier is currently selected. The Predict
  // setup checklist is surfaced as a persistent panel in the Lobby so
  // the player can fund ahead of switching to Staked — discovery should
  // not be gated behind a tier toggle.
  const dusdcQuery = useQuery({
    queryKey: ["dusdc-balance", address],
    queryFn: () => getWalletDusdcBalance(client, address),
    refetchInterval: 8_000,
  })
  const managerQuery = useQuery({
    queryKey: ["predict-manager", address],
    queryFn: () => findPredictManager(client, address),
    refetchInterval: 12_000,
  })
  const managerBalanceQuery = useQuery({
    queryKey: ["predict-manager-balance", managerQuery.data?.id],
    queryFn: () =>
      managerQuery.data
        ? getManagerDusdcBalance(client, managerQuery.data.id)
        : Promise.resolve(0n),
    enabled: !!managerQuery.data,
    refetchInterval: 10_000,
  })
  const stakedReady =
    !!managerQuery.data && (managerBalanceQuery.data ?? 0n) > 0n

  async function createDuel(stake: StakeTier) {
    if (!oracleId || !oracle) return
    setBusy(true)
    setErr(null)
    try {
      const ref = oracle.settlementPrice ?? oracle.forward
      const deck = await requestDeck(oracleId, ref, address)

      // The server auto-sizes the deck to live oracle supply, so the
      // on-chain `deck_size` must be the actual card count — not a fixed 5,
      // or reveal will mismatch the hash when fewer oracles are live.
      const deckSize = deck.cards.length
      const tx =
        stake.coinType === DEEPBOOK.dusdcType
          ? await buildCreateDuelDusdcTx(
              client,
              address,
              deck.hash,
              stake.amount,
              stake.coinType,
              deckSize
            )
          : buildCreateDuelTx(deck.hash, stake.amount, stake.coinType, deckSize)

      const res = await signAndExec({ transaction: tx })
      const duelId = await resolveCreatedDuelId(client, res.digest)
      queryClient.invalidateQueries({ queryKey: ["duels"] })
      if (duelId) onEnterDuel(duelId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const tiers = tier === "free" ? FREE_TIERS : STAKED_TIERS

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
          {/* Tier toggle */}
          <div className="inline-flex rounded-md bg-muted p-0.5 text-sm">
            <button
              onClick={() => setTier("free")}
              className={`rounded px-3 py-1 transition ${
                tier === "free"
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground"
              }`}
            >
              Free · SUI
            </button>
            <button
              onClick={() => setTier("staked")}
              className={`rounded px-3 py-1 transition ${
                tier === "staked"
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground"
              }`}
            >
              Staked · dUSDC
            </button>
          </div>

          <DepositPanel address={address} walletBalance={dusdcQuery.data} />

          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {tiers.map((t) => {
              const insufficientWallet =
                tier === "staked" &&
                dusdcQuery.data !== undefined &&
                dusdcQuery.data < t.amount
              const blocked =
                tier === "staked" && (!stakedReady || insufficientWallet)
              const reason = !stakedReady
                ? "complete setup above"
                : insufficientWallet
                  ? `need ${fmtStake(t.amount, t.coinType)}`
                  : null
              return (
                <button
                  key={t.label}
                  disabled={isPending || busy || !oracle || blocked}
                  onClick={() => createDuel(t)}
                  title={reason ?? undefined}
                  className="group flex flex-col rounded-lg border border-input bg-background p-3 text-left transition hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50 sm:p-4"
                >
                  <span className="text-sm tracking-wide text-muted-foreground uppercase">
                    {t.label}
                  </span>
                  <span className="mt-1 text-base font-semibold sm:text-lg">
                    {t.blurb}
                  </span>
                  <span className="mt-2 text-sm text-muted-foreground">
                    {reason ? (
                      <span className="text-amber-500">{reason}</span>
                    ) : (
                      <>pot {fmtStake(t.amount * 2n, t.coinType)}</>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
          {err && (
            <p className="rounded border-l-2 border-red-500 bg-red-500/5 p-2 text-sm text-red-500">
              {err}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            your wallet:{" "}
            <ExplorerLink href={addressUrl(address)}>
              {shortId(address)}
            </ExplorerLink>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recent duels</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {duelsQuery.isLoading && (
            <p className="text-base text-muted-foreground">loading…</p>
          )}
          {duelsQuery.data?.length === 0 && (
            <p className="text-base text-muted-foreground">
              no duels yet. be the first.
            </p>
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

/**
 * PRD §Funding the wallet: inline panel that shows the player's address +
 * dUSDC wallet balance + copy button + "send dUSDC from any wallet" hint.
 * No on-ramp, no faucet — same as PRD ("Deposit screen as the only money-in
 * path"). Without zkLogin we use the connected wallet's address; with
 * zkLogin (Phase 3.x) this becomes the zkLogin-derived address.
 */
/** Default first-time deposit nudge — 1 dUSDC covers ~10 swipes at 2%/card stake. */
const DEFAULT_DEPOSIT_DUSDC = 1n

/**
 * Staked-tier onboarding checklist. Surfaces the two prerequisites for
 * real `predict::mint` swipes:
 *   ① PredictManager exists (one-time `predict::create_manager`)
 *   ② Manager holds enough dUSDC to mint positions
 *
 * Both steps emit transactions through the sponsor-or-fallback path so
 * players who only hold dUSDC can still onboard without SUI for gas.
 */
function DepositPanel({
  address,
  walletBalance,
}: {
  address: string
  walletBalance: bigint | undefined
}) {
  const client = useCurrentClient()
  const queryClient = useQueryClient()
  const { mutateAsync: signAndExec } = useFlickySign()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState<"create" | "deposit" | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [depositAmount, setDepositAmount] = useState("1")
  // Inline tx feedback. Auto-clears after 10s so the panel doesn't
  // pile up old confirmations. Each new action overwrites previous.
  const [toast, setToast] = useState<{
    kind: "create" | "deposit"
    digest: string
    label: string
  } | null>(null)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 10_000)
    return () => clearTimeout(t)
  }, [toast])

  const managerQuery = useQuery({
    queryKey: ["predict-manager", address],
    queryFn: () => findPredictManager(client, address),
    refetchInterval: 12_000,
  })
  const managerBalanceQuery = useQuery({
    queryKey: ["predict-manager-balance", managerQuery.data?.id],
    queryFn: () =>
      managerQuery.data
        ? getManagerDusdcBalance(client, managerQuery.data.id)
        : Promise.resolve(0n),
    enabled: !!managerQuery.data,
    refetchInterval: 10_000,
  })

  async function copy() {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable; user can select manually
    }
  }

  async function createManager() {
    setBusy("create")
    setErr(null)
    setToast(null)
    try {
      const res = await signAndExec({ transaction: buildCreateManagerTx() })
      // Wait for indexing + read the tx's created objects so we can
      // pre-populate the query cache with the new manager id instead of
      // waiting for the next 12s refetch tick. UI updates within ~1s of
      // tx finality.
      const newManagerId = await waitForCreatedManagerId(client, res.digest)
      if (newManagerId) {
        // Persist to localStorage so F5 / next session doesn't pay the
        // event-scan cost and so the UI shows the manager id immediately
        // before any RPC roundtrip completes.
        writeManagerCache(address, newManagerId)
        queryClient.setQueryData(["predict-manager", address], {
          id: newManagerId,
        })
      } else {
        // Fallback if the digest's objectChanges didn't surface — refetch
        // forces an immediate event-scan rather than waiting for the
        // polling interval.
        await queryClient.refetchQueries({
          queryKey: ["predict-manager", address],
        })
      }
      setToast({
        kind: "create",
        digest: res.digest,
        label: "PredictManager created",
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function deposit() {
    if (!managerQuery.data) return
    const dec = Number(depositAmount)
    if (!Number.isFinite(dec) || dec <= 0) {
      setErr("enter a positive dUSDC amount")
      return
    }
    const micro = BigInt(Math.floor(dec * 1_000_000))
    if (walletBalance !== undefined && micro > walletBalance) {
      setErr("not enough dUSDC in wallet")
      return
    }
    setBusy("deposit")
    setErr(null)
    setToast(null)
    try {
      const tx = await buildDepositDusdcTx(
        client,
        address,
        managerQuery.data.id,
        micro
      )
      const res = await signAndExec({ transaction: tx })
      await client.core.waitForTransaction({ digest: res.digest })
      // Force immediate refetch instead of waiting for the polling tick.
      await Promise.all([
        queryClient.refetchQueries({
          queryKey: ["predict-manager-balance", managerQuery.data.id],
        }),
        queryClient.refetchQueries({
          queryKey: ["dusdc-balance", address],
        }),
      ])
      setToast({
        kind: "deposit",
        digest: res.digest,
        label: `Deposited ${fmtDusdc(micro)}`,
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const hasManager = !!managerQuery.data
  const managerBalance = managerBalanceQuery.data ?? 0n
  const hasManagerBalance = managerBalance > 0n

  return (
    <div className="space-y-3 rounded-md border border-dashed border-muted/60 bg-muted/20 p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="tracking-wide text-muted-foreground uppercase">
          {hasManager ? "Predict wallet" : "Predict setup"}
        </span>
        <span className="text-xs text-muted-foreground">
          {hasManager ? "ready for Staked duels" : "two one-time steps"}
        </span>
      </div>

      {/* ─── Step ① PredictManager ─── */}
      <ChecklistRow
        done={hasManager}
        index={1}
        title="PredictManager"
        detail={
          hasManager ? (
            <a
              href={objectUrl(managerQuery.data!.id)}
              target="_blank"
              rel="noreferrer"
              className="font-mono underline-offset-2 hover:underline"
              title={managerQuery.data!.id}
            >
              {shortId(managerQuery.data!.id)} ↗
            </a>
          ) : (
            "one-time `predict::create_manager` — gasless via sponsor"
          )
        }
        action={
          !hasManager && (
            <Button
              size="sm"
              variant="default"
              disabled={busy !== null}
              onClick={createManager}
              className="h-7 px-2 text-sm"
            >
              {busy === "create" ? "creating…" : "Create"}
            </Button>
          )
        }
      />

      {/* ─── Step ② Manager balance ─── */}
      <ChecklistRow
        done={hasManagerBalance}
        index={2}
        title="dUSDC in manager"
        detail={
          hasManager ? (
            <span className="font-mono">{fmtDusdc(managerBalance)}</span>
          ) : (
            <span className="opacity-60">unlocked after step ①</span>
          )
        }
        action={
          hasManager && (
            <div className="flex items-center gap-1">
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                disabled={busy !== null}
                className="h-7 w-16 rounded border bg-background px-2 text-right font-mono text-sm"
                aria-label="dUSDC amount to deposit"
              />
              <Button
                size="sm"
                variant={hasManagerBalance ? "outline" : "default"}
                disabled={busy !== null || !hasManager}
                onClick={deposit}
                className="h-7 px-2 text-sm"
              >
                {busy === "deposit" ? "…" : "Deposit"}
              </Button>
            </div>
          )
        }
      />

      {toast && (
        <div className="flex items-center justify-between gap-2 rounded border-l-2 border-emerald-500 bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-600">
          <span className="flex items-center gap-1.5">
            <span aria-hidden>✓</span>
            <span>{toast.label}</span>
          </span>
          <a
            href={txExplorerUrl(toast.digest)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs underline-offset-2 hover:underline"
            title={toast.digest}
          >
            {shortId(toast.digest)} ↗
          </a>
        </div>
      )}

      <div className="border-t border-dashed pt-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">
            wallet dUSDC:{" "}
            <strong className="font-mono text-foreground">
              {walletBalance !== undefined ? fmtDusdc(walletBalance) : "…"}
            </strong>
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <code className="flex-1 truncate rounded border bg-background px-2 py-1 font-mono text-xs">
            {address}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={copy}
            className="h-7 px-2 text-sm"
          >
            {copied ? "copied!" : "copy"}
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          dUSDC has no testnet faucet — receive from another wallet that has
          some. Default deposit ({Number(DEFAULT_DEPOSIT_DUSDC)} dUSDC) covers ~
          {Number(DEFAULT_DEPOSIT_DUSDC) * 10} swipes.
        </p>
        {err && <p className="mt-1 text-xs break-all text-red-500">{err}</p>}
      </div>
    </div>
  )
}

function ChecklistRow({
  done,
  index,
  title,
  detail,
  action,
}: {
  done: boolean
  index: number
  title: string
  detail: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            done
              ? "bg-emerald-500/15 text-emerald-500"
              : "bg-muted text-muted-foreground"
          }`}
          aria-hidden
        >
          {done ? "✓" : index}
        </span>
        <div className="min-w-0">
          <div className="font-medium text-foreground">{title}</div>
          <div className="truncate text-xs text-muted-foreground">{detail}</div>
        </div>
      </div>
      {action}
    </div>
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
  const client = useCurrentClient()
  const { data: d } = useQuery({
    queryKey: ["duel", duelId],
    queryFn: () => fetchDuel(client, duelId),
    refetchInterval: 5_000,
  })
  if (!d) return null

  const mine = d.creator === address || d.challenger === address
  const statusColor: Record<
    typeof d.status,
    "default" | "secondary" | "outline"
  > = {
    PENDING: "outline",
    ACTIVE: "default",
    COMPLETE: "secondary",
  }
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center justify-between rounded p-2 text-left transition hover:bg-muted/50"
    >
      <div className="text-base">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{shortId(duelId)}</span>
          <Badge variant={statusColor[d.status]}>{d.status}</Badge>
          {mine && <Badge variant="outline">yours</Badge>}
        </div>
        <div className="text-sm text-muted-foreground">
          pot {fmtStake(d.p0Stake + d.p1Stake, d.stakeCoinType)} · settled{" "}
          {d.settledCount.toString()}/5
        </div>
      </div>
      <span className="text-sm text-muted-foreground">→</span>
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
  const client = useCurrentClient()
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
            className="text-base text-muted-foreground hover:text-foreground"
          >
            ← lobby
          </button>
          <ExplorerLink href={objectUrl(duelId)}>
            {shortId(duelId)}
          </ExplorerLink>
        </div>
      </CardHeader>
      <CardContent>
        {!d ? (
          <p className="py-12 text-center text-base text-muted-foreground">
            loading…
          </p>
        ) : (
          <PhaseDispatcher
            duel={d}
            address={address}
            duelId={duelId}
            oracle={oracle}
          />
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
  const myNextIdx = isCreator
    ? Number(duel.p0NextCardIdx)
    : Number(duel.p1NextCardIdx)
  const opponentNextIdx = isCreator
    ? Number(duel.p1NextCardIdx)
    : Number(duel.p0NextCardIdx)
  const allSwiped = myNextIdx === 5 && opponentNextIdx === 5

  if (duel.status === "COMPLETE") {
    return <ResultView duel={duel} address={address} />
  }
  if (duel.status === "PENDING") {
    if (isCreator) return <WaitingForOpponentView duel={duel} duelId={duelId} />
    return <JoinView duel={duel} duelId={duelId} address={address} />
  }
  // ACTIVE
  if (!isPlayer) {
    return <SpectatorView duel={duel} />
  }
  // Between join_duel and reveal_deck the duel is ACTIVE but `cards` is
  // empty. Don't route into SwipingView yet — it would dereference
  // duel.cards[0] and crash. Show a transient reveal-pending state.
  if (duel.cards.length === 0) {
    return (
      <RevealingView
        duelId={duelId}
        deckHashHex={duel.deckHashHex}
        stakeCoinType={duel.stakeCoinType}
      />
    )
  }
  if (myNextIdx < 5) {
    return (
      <SwipingView
        duel={duel}
        duelId={duelId}
        oracle={oracle}
        myNextIdx={myNextIdx}
        isCreator={isCreator}
        address={address}
      />
    )
  }
  if (!allSwiped) {
    return (
      <LockupView myNextIdx={myNextIdx} opponentNextIdx={opponentNextIdx} />
    )
  }
  if (oracle && oracle.settlementPrice === null) {
    return (
      <LockupView myNextIdx={myNextIdx} opponentNextIdx={opponentNextIdx} />
    )
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
        <span className="inline-block h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
      <div className="space-y-1">
        <div className="text-lg font-semibold">matching…</div>
        <div className="text-sm text-muted-foreground">{elapsed}s elapsed</div>
      </div>
      <p className="text-base text-muted-foreground">
        you staked{" "}
        <strong className="text-foreground">
          {fmtStake(duel.p0Stake, duel.stakeCoinType)}
        </strong>
        .{" "}
        {duel.stakeCoinType === DEEPBOOK.dusdcType
          ? "no bot fill on staked tier — waiting for a human."
          : "bot auto-fills after ~5s if no human joins."}
      </p>
      {showShareEscape && (
        <div className="space-y-1 pt-3">
          <p className="text-sm text-muted-foreground">
            still no opponent. share manually:
          </p>
          <code className="block rounded bg-muted p-2 text-sm break-all">
            {duelId}
          </code>
        </div>
      )}
      <p className="pt-2 text-sm text-muted-foreground">
        pot when full {fmtStake(duel.p0Stake * 2n, duel.stakeCoinType)}
      </p>
    </div>
  )
}

function JoinView({
  duel,
  duelId,
  address,
}: {
  duel: DuelState
  duelId: string
  address: string
}) {
  const client = useCurrentClient()
  const { mutateAsync: signAndExec, isPending } = useFlickySign()
  const queryClient = useQueryClient()
  const [err, setErr] = useState<string | null>(null)
  const isDusdc = duel.stakeCoinType === DEEPBOOK.dusdcType

  // Probe the deckmaster service for plaintext keyed by the deck hash.
  // If the service has lost the plaintext (server restart with old in-mem
  // store, or a duel created against a different deckmaster) no one can
  // reveal post-join and the duel is bricked — refuse to join in that
  // case so stake doesn't get locked into a dead duel.
  const plaintextQuery = useQuery({
    queryKey: ["deckmaster-reveal", duel.deckHashHex],
    queryFn: async () => {
      const res = await fetch(
        `${DECKMASTER_BASE_URL}/deckmaster/reveal?hash=${encodeURIComponent(duel.deckHashHex)}`
      )
      if (res.status === 404) return { available: false as const }
      if (!res.ok) throw new Error(`reveal lookup failed: ${res.status}`)
      return { available: true as const }
    },
    retry: false,
    staleTime: 10_000,
  })
  const plaintextMissing = plaintextQuery.data?.available === false

  // PredictManager gate for dUSDC duels — every staked swipe bundles
  // `predict::mint` which requires the joiner's manager to exist + hold
  // dUSDC. Block the join here so the player isn't trapped mid-duel
  // unable to swipe.
  const managerQuery = useQuery({
    queryKey: ["predict-manager", address],
    queryFn: () => findPredictManager(client, address),
    enabled: isDusdc,
    refetchInterval: 12_000,
  })
  const managerBalanceQuery = useQuery({
    queryKey: ["predict-manager-balance", managerQuery.data?.id],
    queryFn: () =>
      managerQuery.data
        ? getManagerDusdcBalance(client, managerQuery.data.id)
        : Promise.resolve(0n),
    enabled: isDusdc && !!managerQuery.data,
    refetchInterval: 10_000,
  })
  const needsManager = isDusdc && !managerQuery.data && !managerQuery.isLoading
  const needsDeposit =
    isDusdc &&
    !!managerQuery.data &&
    (managerBalanceQuery.data ?? 0n) === 0n &&
    !managerBalanceQuery.isLoading

  async function join() {
    setErr(null)
    try {
      const tx = isDusdc
        ? await buildJoinDuelDusdcTx(
            client,
            address,
            duelId,
            duel.p0Stake,
            duel.stakeCoinType
          )
        : buildJoinDuelTx(duelId, duel.p0Stake, duel.stakeCoinType)
      await signAndExec({ transaction: tx })
      queryClient.invalidateQueries({ queryKey: ["duel", duelId] })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const stake = fmtStake(duel.p0Stake, duel.stakeCoinType)
  const stakedBlocked = needsManager || needsDeposit
  const blockReason = plaintextMissing
    ? "deck unrevealable"
    : needsManager
      ? "setup required"
      : needsDeposit
        ? "deposit dUSDC first"
        : null
  return (
    <div className="space-y-3 py-4 text-center">
      <Badge variant="outline">open duel</Badge>
      <p className="text-base text-muted-foreground">
        creator staked <strong>{stake}</strong>. match it to start swiping.
      </p>
      {isDusdc && stakedBlocked && (
        <div className="rounded border-l-2 border-amber-500/30 bg-amber-500/5 p-2 text-left text-sm text-amber-600">
          <strong>Staked-tier setup required</strong>
          <div className="mt-1 text-xs opacity-90">
            {needsManager
              ? "You don't have a PredictManager yet — every staked swipe bundles `predict::mint` against it. Go back to the lobby and complete step ① of the Staked-tier setup."
              : "Your PredictManager has 0 dUSDC. Deposit some via the lobby's Staked-tier setup so each swipe can mint a Predict position."}
          </div>
        </div>
      )}
      <Button
        size="lg"
        onClick={join}
        disabled={
          isPending ||
          plaintextMissing ||
          plaintextQuery.isLoading ||
          stakedBlocked
        }
        className="w-full"
      >
        {blockReason ?? `join · stake ${stake}`}
      </Button>
      {plaintextMissing && (
        <p className="text-sm text-muted-foreground">
          deckmaster lost this duel's plaintext (server restart). ask the
          creator to re-create the duel.
        </p>
      )}
      {err && (
        <p className="rounded border-l-2 border-red-500 bg-red-500/5 p-2 text-left text-sm text-red-500">
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
  address,
}: {
  duel: DuelState
  duelId: string
  oracle: OracleSviInfo | undefined
  myNextIdx: number
  isCreator: boolean
  address: string
}) {
  const client = useCurrentClient()
  const { mutateAsync: signAndExec, isPending } = useFlickySign()
  const queryClient = useQueryClient()
  const now = useNow(250)
  const card = duel.cards[myNextIdx]
  // Contract no longer tracks per-player "last swipe ms" — the new design
  // bounds the whole match with a single 10-min `SWIPE_WINDOW_MS` from
  // `started_at_ms`. Per-card pacing UI uses join-time as the baseline.
  const baselineMs = Number(duel.startedAtMs)
  const elapsedMs = Math.max(0, now - baselineMs)
  const timerMs = Math.max(0, SWIPE_PHASE_MS - elapsedMs)
  const speed = speedMultiplier(elapsedMs)
  const [err, setErr] = useState<string | null>(null)

  // For dUSDC duels, look up the player's PredictManager. Per PRD
  // §Match-anatomy step 2 every staked swipe is an atomic PTB combining
  // `predict::mint` + `duel::record_swipe`, so the manager (and its
  // dUSDC balance) is a hard prerequisite — the Lobby / JoinView gates
  // enforce that, and SwipingView refuses to swipe if either ever falls
  // back to null (defence in depth).
  const isDusdc = duel.stakeCoinType === DEEPBOOK.dusdcType
  const managerQuery = useQuery({
    queryKey: ["predict-manager", address],
    queryFn: () => findPredictManager(client, address),
    enabled: isDusdc,
    staleTime: 30_000,
  })
  const managerBalanceQuery = useQuery({
    queryKey: ["predict-manager-balance", managerQuery.data?.id],
    queryFn: () =>
      managerQuery.data
        ? getManagerDusdcBalance(client, managerQuery.data.id)
        : Promise.resolve(0n),
    enabled: isDusdc && !!managerQuery.data,
    staleTime: 10_000,
  })
  // Quantity to mint per swipe — small relative to the duel stake so the
  // manager doesn't drain across 5 cards. 10% of stake / 5 = 2% per card.
  const mintQuantity = (duel.p0Stake * 2n) / 100n
  const managerReady =
    !isDusdc ||
    (!!managerQuery.data && (managerBalanceQuery.data ?? 0n) >= mintQuantity)

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
        let tx
        if (isDusdc) {
          // Hard requirement: dUSDC duel ⇒ manager + balance ⇒ bundled
          // mint. The Lobby + JoinView gates make this the steady-state
          // truth; this branch only fires if state drifted (e.g. manager
          // withdrew all dUSDC mid-duel).
          if (!managerQuery.data) {
            throw new Error(
              "PredictManager missing — return to lobby to create one"
            )
          }
          if ((managerBalanceQuery.data ?? 0n) < mintQuantity) {
            throw new Error(
              `Manager balance below per-card mint (${fmtDusdc(mintQuantity)}). Deposit more dUSDC.`
            )
          }
          if (!oracle) {
            throw new Error("Oracle not loaded")
          }
          // Premium + p_swiped are snapshotted on-chain by the contract
          // (via predict::get_trade_amounts inside record_swipe) — the FE
          // only supplies the mint quantity.
          tx = buildStakedSwipeTx({
            duelId,
            oracleSviId: card.oracleId,
            managerId: managerQuery.data.id,
            oracleExpiry: oracle.expiry,
            strike: card.strike,
            isUp,
            quantity: mintQuantity,
            cardIdx: myNextIdx,
          })
        } else {
          // Legacy non-staked path (free/SUI duels) — PRD has
          // replaced this with Practice Mode (server-only). The
          // builder needs a manager + quantity for the new contract;
          // this branch is effectively dead code in the staked-only world.
          tx = buildSwipeTx({
            duelId,
            managerId: managerQuery.data?.id ?? "0x0",
            oracleId: card.oracleId,
            cardIdx: myNextIdx,
            isUp,
            quantity: 1n,
            stakeCoinType: duel.stakeCoinType,
          })
        }
        await signAndExec({ transaction: tx })
        queryClient.invalidateQueries({ queryKey: ["duel", duelId] })
        queryClient.invalidateQueries({
          queryKey: ["predict-manager-balance", managerQuery.data?.id],
        })
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        setDrag({ x: 0, active: false, flying: null })
      }
    },
    [
      duelId,
      card.oracleId,
      card.strike,
      myNextIdx,
      duel.stakeCoinType,
      isDusdc,
      managerQuery.data,
      managerBalanceQuery.data,
      oracle,
      mintQuantity,
      signAndExec,
      queryClient,
    ]
  )

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (isPending || drag.flying || !managerReady) return
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
    flyOff ??
    (drag.x === 0 ? "" : `translateX(${drag.x}px) rotate(${rotate}deg)`)

  const overlayProgress = Math.min(
    1,
    Math.abs(drag.x) / (w * DRAG_COMMIT_FRACTION)
  )
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
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          card <strong className="text-foreground">{myNextIdx + 1}</strong>/5
          {isDusdc && managerReady && (
            <span
              className="ml-2 rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs tracking-wide text-emerald-500 uppercase"
              title={`mints ${fmtDusdc(mintQuantity)} per swipe into your PredictManager`}
            >
              + predict mint
            </span>
          )}
        </span>
        <span className={speedColor}>
          {speed.label} {speed.tone === "good" && "⚡"}
        </span>
        <span
          className="font-mono text-base tabular-nums"
          title="decide window for this card — resets after each swipe"
        >
          {timerSec}s
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all duration-300"
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
          className={`relative cursor-grab overflow-hidden rounded-xl border border-hairline bg-surface-1 p-6 shadow-[0_1px_0_0_var(--surface-3)_inset,0_24px_64px_-32px_rgba(0,0,0,0.6)] active:cursor-grabbing ${
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
            <div className="absolute top-4 right-4 rotate-12 rounded border-2 border-emerald-500 px-2 py-0.5 text-lg font-black text-emerald-500 uppercase">
              ↑ UP
            </div>
          )}
          {drag.x < -20 && (
            <div className="absolute top-4 left-4 -rotate-12 rounded border-2 border-red-500 px-2 py-0.5 text-lg font-black text-red-500 uppercase">
              ↓ DOWN
            </div>
          )}

          <div className="text-xs font-medium tracking-[0.06em] text-ink-subtle uppercase">
            BTC at expiry
          </div>
          <div className="mt-3 text-5xl font-semibold tracking-[-0.04em] tabular-nums sm:text-6xl">
            {fmtUsd(card.strike)}
          </div>
          <div className="mt-2 text-base tracking-[-0.01em] text-muted-foreground">
            will BTC settle{" "}
            <strong className="font-semibold text-foreground">above</strong>{" "}
            this strike?
          </div>
          {oracle && (
            <div className="mt-4 flex justify-between border-t pt-3 text-sm text-muted-foreground">
              <span>
                now{" "}
                <strong className="text-foreground">
                  {fmtUsd(oracle.spot)}
                </strong>
              </span>
              <span>
                fwd{" "}
                <strong className="text-foreground">
                  {fmtUsd(oracle.forward)}
                </strong>
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
          <p className="mt-3 text-center text-sm text-muted-foreground">
            ← swipe DOWN · swipe UP →
          </p>
        )}
      </div>

      {/* button fallback (a11y + non-touch) */}
      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="outline"
          size="lg"
          disabled={isPending || !!drag.flying || !managerReady}
          onClick={() => {
            setDrag({ x: -200, active: false, flying: "down" })
            swipe(false)
          }}
          className="h-16 text-base"
        >
          <div className="flex flex-col">
            <span>↓ DOWN</span>
            <span className="text-sm font-normal text-muted-foreground">
              ≤ {fmtUsd(card.strike)}
            </span>
          </div>
        </Button>
        <Button
          size="lg"
          disabled={isPending || !!drag.flying || !managerReady}
          onClick={() => {
            setDrag({ x: 200, active: false, flying: "up" })
            swipe(true)
          }}
          className="h-16 text-base"
        >
          <div className="flex flex-col">
            <span>↑ UP</span>
            <span className="text-sm font-normal text-primary-foreground/80">
              &gt; {fmtUsd(card.strike)}
            </span>
          </div>
        </Button>
      </div>

      {isDusdc && !managerReady && (
        <p className="rounded border-l-2 border-amber-500 bg-amber-500/5 p-2 text-sm text-amber-600">
          {managerQuery.data
            ? `Manager balance below per-card mint (${fmtDusdc(mintQuantity)}). Deposit more dUSDC via the lobby setup.`
            : "PredictManager not found. Return to the lobby and complete Staked-tier setup."}
        </p>
      )}

      <p className="text-center text-sm text-muted-foreground">
        decide fast: 0–5s = 1.5× · 5–20s = 1.0× · 20–60s = 0.75×
      </p>

      {err && (
        <p className="rounded border-l-2 border-red-500 bg-red-500/5 p-2 text-sm text-red-500">
          {err}
        </p>
      )}
    </div>
  )
}

/**
 * Status is ACTIVE but deck hasn't been revealed yet — keeper races to
 * call `reveal_deck` once it sees DuelJoined. Usually clears in 5–15 s.
 * If it sticks (keeper down / unfunded), this view exposes a manual
 * reveal: any address can call `reveal_deck` since the contract verifies
 * sha2_256(bcs(cards)) == duel.deck_hash. We pull the plaintext from
 * the deckmaster service by hash, then sign reveal from the current tab.
 */
function RevealingView({
  duelId,
  deckHashHex,
  stakeCoinType,
}: {
  duelId: string
  deckHashHex: string
  stakeCoinType: string
}) {
  const { mutateAsync: signAndExec, isPending } = useFlickySign()
  const queryClient = useQueryClient()
  const [err, setErr] = useState<string | null>(null)

  const plaintextQuery = useQuery<DeckCard[] | null>({
    queryKey: ["deckmaster-reveal", deckHashHex],
    queryFn: async () => {
      const res = await fetch(
        `${DECKMASTER_BASE_URL}/deckmaster/reveal?hash=${encodeURIComponent(deckHashHex)}`
      )
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`reveal lookup failed: ${res.status}`)
      const body = (await res.json()) as {
        cards: Array<{ expiry_market_id: string; strike: string }>
      }
      return body.cards.map((c) => ({
        oracleId: c.expiry_market_id,
        strike: BigInt(c.strike),
      }))
    },
    // Keep polling — keeper may still land first, in which case the
    // duel object update will route us out of this view automatically.
    refetchInterval: 4_000,
    retry: false,
  })

  const cards = plaintextQuery.data ?? null

  async function manualReveal() {
    if (!cards) return
    setErr(null)
    try {
      const tx = buildRevealDeckTx(duelId, cards, stakeCoinType)
      await signAndExec({ transaction: tx })
      queryClient.invalidateQueries({ queryKey: ["duel", duelId] })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-4 py-8 text-center">
      <div className="flex justify-center">
        <span className="inline-block h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
      <p className="text-lg font-semibold tracking-[-0.01em]">
        revealing deck…
      </p>
      <p className="text-base text-muted-foreground">
        the keeper pushes the plaintext on-chain once the challenger joins.
        usually clears within a few seconds.
      </p>
      {cards && (
        <div className="space-y-2 pt-2">
          <p className="text-sm text-muted-foreground">
            keeper looks slow — you can reveal manually.
          </p>
          <Button onClick={manualReveal} disabled={isPending} size="sm">
            {isPending ? "revealing…" : "reveal now"}
          </Button>
        </div>
      )}
      {err && (
        <p className="text-sm break-all text-destructive" role="alert">
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
      <p className="text-base text-muted-foreground">
        swipes are locked. the deck settles when BTC's oracle resolves.
      </p>
      <div className="flex justify-center gap-6 pt-2 text-sm text-muted-foreground">
        <span>
          you <strong className="text-foreground">{myNextIdx}</strong>/5
        </span>
        <span>
          opponent{" "}
          <strong className="text-foreground">{opponentNextIdx}</strong>/5
        </span>
      </div>
    </div>
  )
}

function SettlingView({ duel, duelId }: { duel: DuelState; duelId: string }) {
  const { mutateAsync: signAndExec, isPending } = useFlickySign()
  const client = useCurrentClient()
  const queryClient = useQueryClient()
  const [err, setErr] = useState<string | null>(null)
  const [digest, setDigest] = useState<string | null>(null)

  async function settle() {
    setErr(null)
    try {
      // Two-phase: settle_card × deck_size reads both players' Predict
      // managers for anti-replay (and that card's oracle for the
      // settlement_price), then finalize compares the accumulated PnL.
      // All chained into one PTB by `buildFinalizeTx`.
      const [p0Manager, p1Manager] = await Promise.all([
        findPredictManager(client, duel.creator),
        findPredictManager(client, duel.challenger),
      ])
      if (!p0Manager || !p1Manager)
        throw new Error("could not resolve both players' PredictManagers")
      const tx = buildFinalizeTx(
        duelId,
        duel.cards,
        p0Manager.id,
        p1Manager.id,
        duel.stakeCoinType
      )
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
      <p className="text-base text-muted-foreground">
        the keeper auto-closes settled duels — payouts appear within ~10s.
      </p>
      <details className="mx-auto max-w-sm text-left text-sm text-muted-foreground">
        <summary className="cursor-pointer text-center underline-offset-2 hover:underline">
          impatient? settle manually
        </summary>
        <div className="mt-3 space-y-2">
          <Button
            size="sm"
            onClick={settle}
            disabled={isPending}
            className="w-full"
          >
            settle + finalize
          </Button>
          {digest && (
            <p>
              tx{" "}
              <ExplorerLink href={txExplorerUrl(digest)}>
                {shortId(digest)}
              </ExplorerLink>
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
  // Contract picks the winner by comparing `payout_0 + premium_1` vs
  // `payout_1 + premium_0`. That's equivalent to comparing each side's
  // net PnL `payout - premium`, which is also what we show in the UI.
  const myScore = isCreator
    ? duel.p0Payout - duel.p0Premium
    : duel.p1Payout - duel.p1Premium
  const oppScore = isCreator
    ? duel.p1Payout - duel.p1Premium
    : duel.p0Payout - duel.p0Premium
  const tie = myScore === oppScore
  const won = !tie && myScore > oppScore
  const lost = !tie && myScore < oppScore

  const total = duel.p0Stake + duel.p1Stake
  const myPayout = won
    ? total
    : tie
      ? isCreator
        ? duel.p0Stake
        : duel.p1Stake
      : 0n

  const banner = won
    ? { emoji: "🏆", text: "you won", tone: "text-emerald-500" }
    : lost
      ? { emoji: "💀", text: "you lost", tone: "text-red-500" }
      : { emoji: "🤝", text: "tie", tone: "text-amber-500" }

  // Per-card outcome — needs the strike + settlement + your swipe. We
  // treat `cardsSettled[i] = false` as "no proof yet" (null settle).
  const myCards = useMemo(() => {
    const swipes = isCreator ? duel.p0Swipes : duel.p1Swipes
    return duel.cards.map((c, i) => {
      const swipe = swipes[i]
      const settled = duel.cardsSettled[i] === true
      const settle = settled ? duel.cardSettlementPrices[i] : null
      const actualUp = settle !== null && settle > c.strike
      const correct = swipe !== null && actualUp === swipe.isUp
      return { card: c, swipe, settle, actualUp, correct }
    })
  }, [duel, isCreator])

  // Share-card: snapshot of the captureRef'd div as a PNG download.
  const captureRef = useRef<HTMLDivElement>(null)
  const [sharing, setSharing] = useState(false)
  async function shareCard() {
    if (!captureRef.current) return
    setSharing(true)
    try {
      const { toPng } = await import("html-to-image")
      const dataUrl = await toPng(captureRef.current, {
        pixelRatio: 2,
        backgroundColor:
          getComputedStyle(document.body).backgroundColor || "#000",
        cacheBust: true,
      })
      const a = document.createElement("a")
      a.href = dataUrl
      a.download = `flicky-${won ? "won" : tie ? "tie" : "lost"}-${duel.id.slice(2, 10)}.png`
      a.click()
    } catch (e) {
      console.error("share-card", e)
    } finally {
      setSharing(false)
    }
  }

  return (
    <div className="space-y-5">
      <div ref={captureRef} className="space-y-5 rounded-lg bg-card p-2">
        <div className="space-y-2 py-6 text-center">
          <div className="text-6xl">{banner.emoji}</div>
          <div
            className={`text-3xl font-semibold tracking-[-0.02em] uppercase ${banner.tone}`}
          >
            {banner.text}
          </div>
          {myPayout > 0n && (
            <div className="text-base text-muted-foreground">
              payout{" "}
              <strong className="text-foreground">
                {fmtStake(myPayout, duel.stakeCoinType)}
              </strong>
            </div>
          )}
        </div>

        <Separator />

        <div className="grid grid-cols-2 gap-3 text-base">
          <div className="rounded bg-muted/40 p-3">
            <div className="text-sm text-muted-foreground">your score</div>
            <div className="text-2xl font-semibold tabular-nums">
              {(Number(myScore) / 1e9).toFixed(2)}
            </div>
          </div>
          <div className="rounded bg-muted/40 p-3">
            <div className="text-sm text-muted-foreground">opponent</div>
            <div className="text-2xl font-semibold tabular-nums">
              {(Number(oppScore) / 1e9).toFixed(2)}
            </div>
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-sm tracking-wide text-muted-foreground uppercase">
            cards
          </h3>
          <div className="space-y-1.5">
            {myCards.map((m, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded bg-muted/30 p-2 text-base"
              >
                <div>
                  <span className="text-muted-foreground">card {i + 1} · </span>
                  <span className="tabular-nums">{fmtUsd(m.card.strike)}</span>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  {m.swipe ? (
                    <span className="text-muted-foreground">
                      you {m.swipe.isUp ? "↑" : "↓"}
                    </span>
                  ) : (
                    <span className="text-muted-foreground italic">
                      no swipe
                    </span>
                  )}
                  <span>
                    settled{" "}
                    <strong>
                      {m.settle !== null ? (m.actualUp ? "↑" : "↓") : "—"}
                    </strong>
                  </span>
                  <Badge
                    variant={
                      !m.swipe ? "outline" : m.correct ? "default" : "secondary"
                    }
                    className={
                      !m.swipe
                        ? "text-ink-subtle"
                        : m.correct
                          ? "bg-emerald-500/20 text-emerald-500"
                          : "bg-red-500/15 text-red-400"
                    }
                  >
                    {!m.swipe ? "—" : m.correct ? "✓" : "✗"}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Button
        variant="outline"
        size="sm"
        disabled={sharing}
        onClick={shareCard}
        className="w-full"
      >
        {sharing ? "rendering…" : "↓ share-card (PNG)"}
      </Button>
    </div>
  )
}

function SpectatorView({ duel }: { duel: DuelState }) {
  return (
    <div className="space-y-3 py-4 text-center">
      <Badge variant="secondary">spectating</Badge>
      <p className="text-base text-muted-foreground">
        you're not a player in this duel. pot{" "}
        {fmtStake(duel.p0Stake + duel.p1Stake, duel.stakeCoinType)}.
      </p>
      <div className="grid grid-cols-2 gap-3 text-base">
        <div className="rounded bg-muted/40 p-3">
          <div className="text-sm text-muted-foreground">creator net</div>
          <div className="font-semibold">
            {fmtStake(duel.p0Payout - duel.p0Premium, duel.stakeCoinType)}
          </div>
        </div>
        <div className="rounded bg-muted/40 p-3">
          <div className="text-sm text-muted-foreground">challenger net</div>
          <div className="font-semibold">
            {fmtStake(duel.p1Payout - duel.p1Premium, duel.stakeCoinType)}
          </div>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        swipes {Number(duel.p0NextCardIdx)}/{Number(duel.deckSize)} ·{" "}
        {Number(duel.p1NextCardIdx)}/{Number(duel.deckSize)} · settled{" "}
        {duel.settledCount.toString()}/5
      </p>
    </div>
  )
}
