import { useEffect, useState, type ReactNode } from "react"
import {
  ConnectButton,
  useCurrentAccount,
  useSuiClient,
  useSignAndExecuteTransaction,
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
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  ASSETS,
  CONFIG,
  ORACLE_SOURCES,
  sourceLabel,
  type AssetSymbol,
  type OracleSource,
} from "@/lib/config"
import {
  buildCreateDuelDeepbookTx,
  buildCreateDuelTx,
  buildDefaultStrikes,
  buildJoinDuelTx,
  buildSettleAndFinalizeDeepbookTx,
  buildSettleAndFinalizeTx,
  buildSwipeDeepbookTx,
  buildSwipeTx,
  deepbookStrikes,
  discoverActiveFlickyOracles,
  fetchDeepbookOracle,
  fetchDuel,
  fetchOracleSpot,
  findLatestDeepbookOracle,
  impliedProbabilityUp,
  isDeepbookOracle,
  listDuelIds,
  type DuelState,
} from "@/lib/flicky"
import {
  buildCreateManagerTx,
  buildDepositDusdcTx,
  buildStakedSwipeTx,
  findPredictManager,
  fmtDusdc,
  getManagerDusdcBalance,
  getWalletDusdcBalance,
} from "@/lib/deepbook"

const EXPLORER = "https://suiscan.xyz/testnet"
const obj = (id: string) => `${EXPLORER}/object/${id}`
const txUrl = (digest: string) => `${EXPLORER}/tx/${digest}`

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
  return `$${(Number(n9) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function fmtSui(mist: bigint): string {
  return `${(Number(mist) / 1e9).toFixed(4)} SUI`
}

/** Format a raw stake amount using the duel's stake coin type for decimals. */
function fmtStake(amount: bigint, stakeCoinType: string): string {
  return stakeCoinType.endsWith("::dusdc::DUSDC")
    ? fmtDusdc(amount)
    : fmtSui(amount)
}

function fmtPct(p9: bigint): string {
  return `${(Number(p9) / 1e7).toFixed(1)}%`
}

function fmtCountdown(expiryMs: bigint, now: number): string {
  const remain = Math.max(0, Number(expiryMs) - now)
  if (remain === 0) return "expired"
  const totalSec = Math.floor(remain / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min >= 60) {
    const hr = Math.floor(min / 60)
    return `${hr}h ${min % 60}m`
  }
  return `${min}m ${sec.toString().padStart(2, "0")}s`
}

function fmtScore(s: bigint): string {
  return (Number(s) / 1e9).toFixed(3)
}

function shortAddr(a: string): string {
  if (a === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    return "—"
  }
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function App() {
  const account = useCurrentAccount()
  const [activeDuelId, setActiveDuelId] = useState<string | null>(null)

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Flicky</h1>
            <p className="text-xs text-muted-foreground">
              Tinder-style PvP prediction duels on Sui testnet
            </p>
          </div>
          <ConnectButton />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-6">
        {!account ? (
          <ConnectPrompt />
        ) : activeDuelId ? (
          <DuelView
            duelId={activeDuelId}
            onBack={() => setActiveDuelId(null)}
            address={account.address}
          />
        ) : (
          <Lobby address={account.address} onOpenDuel={setActiveDuelId} />
        )}
      </main>
    </div>
  )
}

function ConnectPrompt() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect a Sui wallet</CardTitle>
        <CardDescription>
          You&apos;ll need testnet SUI to stake. Get some from{" "}
          <a
            className="underline"
            href="https://discord.gg/sui"
            target="_blank"
            rel="noreferrer"
          >
            the Sui Discord faucet
          </a>
          .
        </CardDescription>
      </CardHeader>
    </Card>
  )
}

function Lobby({
  address,
  onOpenDuel,
}: {
  address: string
  onOpenDuel: (id: string) => void
}) {
  const client = useSuiClient()
  const qc = useQueryClient()
  const { mutateAsync: signAndExecute, isPending: creating } =
    useSignAndExecuteTransaction()

  const [selectedSource, setSelectedSource] = useState<OracleSource>("DEEPBOOK_BTC")
  const [stakeCurrency, setStakeCurrency] = useState<"SUI" | "DUSDC">("SUI")
  const [stakeAmountInput, setStakeAmountInput] = useState<string>("0.01")

  // PredictManager state (needed when stakeCurrency = "DUSDC")
  const managerQ = useQuery({
    queryKey: ["predict-manager", address],
    queryFn: () => findPredictManager(client, address),
    refetchInterval: 10_000,
  })
  const managerBalanceQ = useQuery({
    queryKey: ["manager-balance", managerQ.data?.id],
    queryFn: () => getManagerDusdcBalance(client, managerQ.data!.id),
    enabled: !!managerQ.data,
    refetchInterval: 10_000,
  })

  const flickyOraclesQ = useQuery({
    queryKey: ["oracles-active", CONFIG.packageId],
    queryFn: async () => {
      // Dynamic discovery: query OracleCreated events for the latest ACTIVE
      // oracle per asset. Rotation-keeper daemon creates new oracles on its
      // own schedule, so we never have to update config.ts when one rotates.
      const found = await discoverActiveFlickyOracles(client)
      const result: Record<
        AssetSymbol,
        { id: string; spot: bigint; expiry: bigint; isSettled: boolean } | null
      > = { BTC: null, ETH: null, SOL: null, SUI: null }
      for (const asset of ASSETS) {
        const o = found[asset]
        if (!o) continue
        result[asset] = {
          id: o.id,
          spot: o.spot,
          expiry: o.expiry,
          isSettled: o.isSettled,
        }
      }
      return result
    },
    refetchInterval: 10_000,
  })

  const deepbookOracleQ = useQuery({
    queryKey: ["deepbook-oracle"],
    queryFn: async () => {
      const id = await findLatestDeepbookOracle(client)
      return await fetchDeepbookOracle(client, id)
    },
    refetchInterval: 30_000,
  })

  const duelsQ = useQuery({
    queryKey: ["duels", CONFIG.packageId],
    queryFn: async () => {
      const ids = await listDuelIds(client, 20)
      const states = await Promise.all(
        ids.map(async (id) => {
          try {
            return await fetchDuel(client, id)
          } catch {
            return null
          }
        }),
      )
      return states.filter((d): d is DuelState => d !== null)
    },
    refetchInterval: 5_000,
  })

  // Stake amount in token base units. SUI is 9-decimal (mist), dUSDC is
  // 6-decimal. The Move type system (`Duel<T>`) doesn't care about decimals;
  // we just need to convert the UI string correctly per currency.
  const stakeDecimals = stakeCurrency === "SUI" ? 9 : 6
  const stakeAmount = (() => {
    const n = Number(stakeAmountInput)
    if (!isFinite(n) || n <= 0) return CONFIG.defaultStakeMist
    return BigInt(Math.round(n * 10 ** stakeDecimals))
  })()
  const minStake = stakeCurrency === "SUI" ? CONFIG.minStakeMist : 1_000n
  const stakeValid = stakeAmount >= minStake
  // dUSDC needs an existing PredictManager + enough balance in it
  const dusdcReady =
    stakeCurrency === "SUI" ||
    (!!managerQ.data && (managerBalanceQ.data ?? 0n) >= stakeAmount)
  const DUSDC_TYPE =
    "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC"
  const stakeCoinType = stakeCurrency === "SUI" ? CONFIG.stakeType : DUSDC_TYPE
  const managerSource =
    stakeCurrency === "DUSDC" && managerQ.data
      ? {
          managerId: managerQ.data.id,
          predictPackage: CONFIG.deepbookPredictPackageId,
        }
      : null

  const now = useNow(1_000)

  // Selected source must be ACTIVE (not settled, not past expiry) for a
  // fair duel. Mirrors the on-chain `EOracleNotLive` guard at swipe time.
  const selectedOk = (() => {
    if (selectedSource === "DEEPBOOK_BTC") {
      const db = deepbookOracleQ.data
      if (!db) return false
      return db.isActive && db.settlementPrice === null && Number(db.expiry) > now
    }
    const o = flickyOraclesQ.data?.[selectedSource]
    if (!o) return false
    return !o.isSettled && Number(o.expiry) > now
  })()

  async function handleCreate() {
    if (!stakeValid || !selectedOk || !dusdcReady) return
    let tx
    if (selectedSource === "DEEPBOOK_BTC") {
      const db = deepbookOracleQ.data
      if (!db) return
      const ref = db.settlementPrice ?? db.forward
      const strikes = deepbookStrikes(ref)
      tx = buildCreateDuelDeepbookTx(
        db.id,
        strikes,
        stakeAmount,
        stakeCoinType,
        managerSource,
      )
    } else {
      const oracleData = flickyOraclesQ.data?.[selectedSource]
      if (!oracleData) return
      const strikes = await buildDefaultStrikes(client, oracleData.id)
      tx = buildCreateDuelTx(
        oracleData.id,
        strikes,
        stakeAmount,
        stakeCoinType,
        managerSource,
      )
    }
    const res = await signAndExecute({ transaction: tx })
    await client.waitForTransaction({ digest: res.digest })
    qc.invalidateQueries({ queryKey: ["duels"] })
  }

  async function handleJoin(duel: DuelState) {
    // For dUSDC duels the joiner also needs a PredictManager with balance.
    // We always use whatever the duel was created with (encoded in
    // stakeCoinType). The manager source kicks in only when the duel is
    // dUSDC AND the joiner has a manager.
    const isDusdcDuel = duel.stakeCoinType.endsWith("::dusdc::DUSDC")
    const joinSource =
      isDusdcDuel && managerQ.data
        ? {
            managerId: managerQ.data.id,
            predictPackage: CONFIG.deepbookPredictPackageId,
          }
        : null
    const tx = buildJoinDuelTx(
      duel.id,
      duel.p0Stake,
      duel.stakeCoinType,
      joinSource,
    )
    const res = await signAndExecute({ transaction: tx })
    await client.waitForTransaction({ digest: res.digest })
    qc.invalidateQueries({ queryKey: ["duels"] })
    onOpenDuel(duel.id)
  }

  const duels = duelsQ.data ?? []
  const myDuels = duels.filter(
    (d) => d.creator === address || d.challenger === address,
  )
  const openDuels = duels.filter(
    (d) => d.status === "PENDING" && d.creator !== address,
  )

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Oracles (testnet)</CardTitle>
          <CardDescription>
            BTC available via both DeepBook&apos;s real on-chain oracle and Flicky&apos;s
            extension. ETH/SOL/SUI via Flicky only — DeepBook doesn&apos;t yet
            support them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {(() => {
              const db = deepbookOracleQ.data
              const dbActive =
                !!db &&
                db.isActive &&
                db.settlementPrice === null &&
                Number(db.expiry) > now
              return (
                <div
                  className={
                    "rounded border p-3 " +
                    (dbActive
                      ? "border-2 border-primary/40 bg-primary/5"
                      : "border-dashed border-muted-foreground/30 opacity-60")
                  }
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">BTC</span>
                    <Badge className="text-[10px]">DeepBook</Badge>
                  </div>
                  <div className="mt-1 font-mono text-sm">
                    {db ? fmtUsd(db.settlementPrice ?? db.forward) : "—"}
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {!db
                      ? "loading…"
                      : db.settlementPrice !== null
                        ? "settled — unfair, hidden"
                        : !db.isActive
                          ? "inactive"
                          : Number(db.expiry) <= now
                            ? "expired"
                            : `expires in ${fmtCountdown(db.expiry, now)}`}
                  </div>
                </div>
              )
            })()}
            {ASSETS.map((asset) => {
              const o = flickyOraclesQ.data?.[asset]
              const active = !!o && !o.isSettled && Number(o.expiry) > now
              return (
                <div
                  key={asset}
                  className={
                    "rounded border p-3 " +
                    (active ? "" : "border-dashed border-muted-foreground/30 opacity-60")
                  }
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{asset}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      Flicky
                    </Badge>
                  </div>
                  <div className="mt-1 font-mono text-sm">
                    {o ? fmtUsd(o.spot) : "—"}
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {!o
                      ? "loading…"
                      : o.isSettled
                        ? "settled"
                        : Number(o.expiry) <= now
                          ? "expired — needs settle"
                          : `expires in ${fmtCountdown(o.expiry, now)}`}
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <PredictAccount address={address} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create a duel</CardTitle>
          <CardDescription>
            Pick the oracle to predict against and your stake (per side). Deck
            = 5 strikes spaced around spot.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="source" className="text-xs">
                Oracle
              </Label>
              <select
                id="source"
                value={selectedSource}
                onChange={(e) => setSelectedSource(e.target.value as OracleSource)}
                className="h-9 rounded-md border bg-background px-3 text-sm"
              >
                {ORACLE_SOURCES.map((s) => {
                  const sourceActive =
                    s === "DEEPBOOK_BTC"
                      ? (() => {
                          const db = deepbookOracleQ.data
                          return (
                            !!db &&
                            db.isActive &&
                            db.settlementPrice === null &&
                            Number(db.expiry) > now
                          )
                        })()
                      : (() => {
                          const o = flickyOraclesQ.data?.[s]
                          return !!o && !o.isSettled && Number(o.expiry) > now
                        })()
                  return (
                    <option key={s} value={s} disabled={!sourceActive}>
                      {sourceLabel(s)}
                      {sourceActive ? "" : " (inactive)"}
                    </option>
                  )
                })}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="currency" className="text-xs">
                Currency
              </Label>
              <select
                id="currency"
                value={stakeCurrency}
                onChange={(e) =>
                  setStakeCurrency(e.target.value as "SUI" | "DUSDC")
                }
                className="h-9 rounded-md border bg-background px-3 text-sm"
              >
                <option value="SUI">SUI (gas wallet)</option>
                <option value="DUSDC">dUSDC (via PredictManager)</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="stake" className="text-xs">
                Stake ({stakeCurrency === "SUI" ? "SUI" : "dUSDC"})
              </Label>
              <Input
                id="stake"
                type="number"
                value={stakeAmountInput}
                onChange={(e) => setStakeAmountInput(e.target.value)}
                min={stakeCurrency === "SUI" ? "0.001" : "0.001"}
                step="0.001"
                className="h-9 w-32"
              />
            </div>
            <Button
              onClick={handleCreate}
              disabled={creating || !stakeValid || !selectedOk || !dusdcReady}
            >
              {creating ? "creating…" : "Create duel"}
            </Button>
            {!selectedOk && (
              <p className="text-xs text-muted-foreground">
                Selected oracle isn&apos;t ACTIVE — pick another or refresh.
              </p>
            )}
            {stakeCurrency === "DUSDC" && !managerQ.data && (
              <p className="text-xs text-rose-500">
                dUSDC stake needs a PredictManager. Set one up in the DeepBook
                Predict card above.
              </p>
            )}
            {stakeCurrency === "DUSDC" &&
              managerQ.data &&
              (managerBalanceQ.data ?? 0n) < stakeAmount && (
                <p className="text-xs text-rose-500">
                  PredictManager has {fmtDusdc(managerBalanceQ.data ?? 0n)} —
                  needs {fmtDusdc(stakeAmount)}.
                </p>
              )}
          </div>
          {!stakeValid && (
            <p className="mt-2 text-xs text-rose-500">
              Stake must be at least{" "}
              {stakeCurrency === "SUI"
                ? fmtSui(CONFIG.minStakeMist)
                : fmtDusdc(1_000n)}
              .
            </p>
          )}
        </CardContent>
      </Card>

      <div>
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Your duels
        </h2>
      </div>
      <div className="flex flex-col gap-2">
        {myDuels.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No duels yet. Create one to start.
          </p>
        )}
        {myDuels.map((d) => (
          <DuelRow
            key={d.id}
            duel={d}
            address={address}
            onOpen={() => onOpenDuel(d.id)}
          />
        ))}
      </div>

      <Separator />

      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        Open lobby
      </h2>
      <div className="flex flex-col gap-2">
        {openDuels.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No open duels waiting for a challenger.
          </p>
        )}
        {openDuels.map((d) => {
          const isDusdc = d.stakeCoinType.endsWith("::dusdc::DUSDC")
          const joinReady =
            !isDusdc ||
            (!!managerQ.data && (managerBalanceQ.data ?? 0n) >= d.p0Stake)
          return (
            <Card key={d.id}>
              <CardContent className="flex items-center justify-between gap-2 py-4">
                <div className="text-sm">
                  <div className="font-mono text-xs text-muted-foreground">
                    {d.id.slice(0, 10)}…
                  </div>
                  <div>
                    Created by{" "}
                    <span className="font-mono">{shortAddr(d.creator)}</span>
                  </div>
                  <div className="text-muted-foreground">
                    Stake: {fmtStake(d.p0Stake, d.stakeCoinType)}
                  </div>
                  {isDusdc && !joinReady && (
                    <div className="text-amber-600 text-xs">
                      {!managerQ.data
                        ? "Needs a PredictManager with dUSDC to join."
                        : `Manager has ${fmtDusdc(managerBalanceQ.data ?? 0n)}; needs ${fmtDusdc(d.p0Stake)}.`}
                    </div>
                  )}
                </div>
                <Button
                  onClick={() => handleJoin(d)}
                  disabled={creating || !joinReady}
                >
                  Join ({fmtStake(d.p0Stake, d.stakeCoinType)})
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

function DuelRow({
  duel,
  address,
  onOpen,
}: {
  duel: DuelState
  address: string
  onOpen: () => void
}) {
  const role = duel.creator === address ? "creator" : "challenger"
  const statusVariant: "default" | "secondary" | "outline" =
    duel.status === "ACTIVE" ? "default" : duel.status === "COMPLETE" ? "outline" : "secondary"
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-2 py-4">
        <div className="text-sm">
          <div className="font-mono text-xs text-muted-foreground">
            {duel.id.slice(0, 10)}…
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant}>{duel.status}</Badge>
            <span className="text-muted-foreground">you are {role}</span>
          </div>
          {duel.status === "PENDING" && (
            <div className="text-muted-foreground">waiting for challenger…</div>
          )}
          {duel.status === "ACTIVE" && (
            <div className="text-muted-foreground">
              swiped {role === "creator" ? Number(duel.p0NextCardIdx) : Number(duel.p1NextCardIdx)}/5 ·
              opponent {role === "creator" ? Number(duel.p1NextCardIdx) : Number(duel.p0NextCardIdx)}/5
            </div>
          )}
        </div>
        <Button variant="outline" onClick={onOpen}>
          Open
        </Button>
      </CardContent>
    </Card>
  )
}

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
  const qc = useQueryClient()
  const { mutateAsync: signAndExecute, isPending: txPending } =
    useSignAndExecuteTransaction()

  const duelQ = useQuery({
    queryKey: ["duel", duelId],
    queryFn: () => fetchDuel(client, duelId),
    refetchInterval: 3_000,
  })

  const duel = duelQ.data
  const role: "p0" | "p1" | "spectator" = duel
    ? duel.creator === address
      ? "p0"
      : duel.challenger === address
        ? "p1"
        : "spectator"
    : "spectator"

  const oracleId = duel?.cards[0]?.oracleId ?? ""
  const isDeepbook = oracleId !== "" && isDeepbookOracle(oracleId)

  const flickyOracleQ = useQuery({
    queryKey: ["oracle", oracleId],
    queryFn: () => fetchOracleSpot(client, oracleId),
    refetchInterval: 5_000,
    enabled: !!duel && oracleId !== "" && !isDeepbook,
  })
  const deepbookOracleQ = useQuery({
    queryKey: ["deepbook-oracle", oracleId],
    queryFn: () => fetchDeepbookOracle(client, oracleId),
    refetchInterval: 5_000,
    enabled: !!duel && oracleId !== "" && isDeepbook,
  })

  // Unified oracle state for the active-match UI.
  const oracleView = isDeepbook
    ? deepbookOracleQ.data
      ? {
          spot:
            deepbookOracleQ.data.settlementPrice ?? deepbookOracleQ.data.forward,
          expiry: deepbookOracleQ.data.expiry,
          isSettled: deepbookOracleQ.data.settlementPrice !== null,
        }
      : null
    : (flickyOracleQ.data ?? null)

  const myNext = duel
    ? role === "p0"
      ? Number(duel.p0NextCardIdx)
      : Number(duel.p1NextCardIdx)
    : 0
  const currentCard = duel && myNext < 5 ? duel.cards[myNext] : null

  // DeepBook oracles don't expose implied_probability_up publicly; skip pUp
  // fetch for them and let the UI show "—".
  const pUpQ = useQuery({
    queryKey: ["pup", oracleId, currentCard?.strike.toString()],
    queryFn: () => impliedProbabilityUp(client, oracleId, currentCard!.strike),
    enabled: !!currentCard && duel?.status === "ACTIVE" && !isDeepbook,
    refetchInterval: 5_000,
  })

  // For DeepBook duels, check if the player has a PredictManager. If they
  // do, we upgrade swipes to "staked" mode that ALSO mints a real Predict
  // position. Without a manager, fall back to record-swipe-only.
  const managerQ = useQuery({
    queryKey: ["predict-manager", address],
    queryFn: () => findPredictManager(client, address),
    enabled: isDeepbook && duel?.status === "ACTIVE",
  })

  async function handleSwipe(isUp: boolean) {
    if (!duel || !currentCard) return
    let tx
    if (isDeepbook && managerQ.data && deepbookOracleQ.data) {
      // Staked-tier swipe: atomic predict::mint + record_swipe_deepbook.
      // Quantity is in dUSDC micro-units (6 decimals). 10_000 = 0.01 dUSDC
      // notional payout if correct.
      const STAKED_QUANTITY = 10_000n
      tx = buildStakedSwipeTx({
        flickyPackageId: CONFIG.packageId,
        duelId,
        oracleSviId: oracleId,
        managerId: managerQ.data.id,
        oracleExpiry: deepbookOracleQ.data.expiry,
        strike: currentCard.strike,
        isUp,
        quantity: STAKED_QUANTITY,
        cardIdx: myNext,
        stakeType: CONFIG.stakeType,
      })
    } else if (isDeepbook) {
      tx = buildSwipeDeepbookTx(duelId, oracleId, myNext, isUp, duel.stakeCoinType)
    } else {
      tx = buildSwipeTx(duelId, oracleId, myNext, isUp, duel.stakeCoinType)
    }
    const res = await signAndExecute({ transaction: tx })
    await client.waitForTransaction({ digest: res.digest })
    qc.invalidateQueries({ queryKey: ["duel", duelId] })
  }

  async function handleFinalize() {
    if (!duel) return
    const tx = isDeepbook
      ? buildSettleAndFinalizeDeepbookTx(duelId, oracleId, duel.stakeCoinType)
      : buildSettleAndFinalizeTx(duelId, oracleId, duel.stakeCoinType)
    const res = await signAndExecute({ transaction: tx })
    await client.waitForTransaction({ digest: res.digest })
    qc.invalidateQueries({ queryKey: ["duel", duelId] })
  }

  const now = useNow(2_000)
  const expired = oracleView ? Number(oracleView.expiry) <= now : false

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          ← Back to lobby
        </Button>
        <div className="flex items-center gap-2">
          {duel && <Badge>{duel.status}</Badge>}
          {isDeepbook && <Badge variant="secondary">DeepBook</Badge>}
        </div>
      </div>
      {duel && (
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          Verify on Sui Explorer:{" "}
          <ExplorerLink href={obj(duelId)}>duel object</ExplorerLink>
          <ExplorerLink href={obj(oracleId)}>
            oracle ({isDeepbook ? "DeepBook OracleSVI" : "FlickyOracle"})
          </ExplorerLink>
        </div>
      )}

      {!duel ? (
        <p className="text-sm text-muted-foreground">loading duel…</p>
      ) : duel.status === "PENDING" ? (
        <Card>
          <CardHeader>
            <CardTitle>Waiting for challenger</CardTitle>
            <CardDescription>
              Share the duel ID with a friend to have them join:
              <code className="ml-1 font-mono text-xs">{duelId}</code>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm">
              Pot will be {fmtStake(duel.p0Stake * 2n, duel.stakeCoinType)}{" "}
              once joined.
            </p>
          </CardContent>
        </Card>
      ) : duel.status === "COMPLETE" ? (
        <ResultView duel={duel} address={address} />
      ) : (
        <ActiveMatch
          duel={duel}
          role={role}
          oracleSpot={oracleView?.spot ?? null}
          oracleSettled={oracleView?.isSettled ?? false}
          oracleExpired={expired}
          oracleExpiryMs={oracleView?.expiry ?? null}
          isDeepbook={isDeepbook}
          currentCard={currentCard}
          pUp={pUpQ.data}
          onSwipe={handleSwipe}
          onFinalize={handleFinalize}
          busy={txPending}
        />
      )}
    </div>
  )
}

function ActiveMatch({
  duel,
  role,
  oracleSpot,
  oracleSettled,
  oracleExpired,
  oracleExpiryMs,
  isDeepbook,
  currentCard,
  pUp,
  onSwipe,
  onFinalize,
  busy,
}: {
  duel: DuelState
  role: "p0" | "p1" | "spectator"
  oracleSpot: bigint | null
  oracleSettled: boolean
  oracleExpired: boolean
  oracleExpiryMs: bigint | null
  isDeepbook: boolean
  currentCard: { oracleId: string; strike: bigint } | null
  pUp: bigint | undefined
  onSwipe: (isUp: boolean) => void
  onFinalize: () => void
  busy: boolean
}) {
  const now = useNow(1_000)
  const myProgress = role === "p0" ? Number(duel.p0NextCardIdx) : Number(duel.p1NextCardIdx)
  const oppProgress = role === "p0" ? Number(duel.p1NextCardIdx) : Number(duel.p0NextCardIdx)
  const myScore = role === "p0" ? duel.p0Score : duel.p1Score
  const oppScore = role === "p0" ? duel.p1Score : duel.p0Score
  const bothDone = myProgress === 5 && oppProgress === 5
  // Swipes only valid while oracle is still live. Mirrors EOracleNotLive guard.
  const liveForSwipe = !oracleSettled && !oracleExpired

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="grid grid-cols-2 gap-4 py-4 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">You ({role})</div>
            <div className="font-mono">{myProgress}/5 swiped</div>
            <div className="text-muted-foreground">score: {fmtScore(myScore)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Opponent</div>
            <div className="font-mono">{oppProgress}/5 swiped</div>
            <div className="text-muted-foreground">score: {fmtScore(oppScore)}</div>
          </div>
        </CardContent>
      </Card>

      {currentCard ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-baseline justify-between">
              <span className="flex items-center gap-2">
                Card {myProgress + 1} / 5
                {isDeepbook && <Badge>DeepBook</Badge>}
              </span>
              <span className="font-mono text-base text-muted-foreground">
                {oracleSpot !== null ? fmtUsd(oracleSpot) : "—"} spot
              </span>
            </CardTitle>
            {oracleExpiryMs !== null && (
              <div className="text-xs text-muted-foreground">
                {liveForSwipe
                  ? `Swipe window closes in ${fmtCountdown(oracleExpiryMs, now)}`
                  : "Oracle expired — waiting for settle"}
              </div>
            )}
            <CardDescription>
              At expiry, will price settle above{" "}
              <span className="font-mono font-medium text-foreground">
                {fmtUsd(currentCard.strike)}
              </span>
              ?
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {pUp !== undefined ? (
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-2">
                  <div className="text-muted-foreground">YES (UP)</div>
                  <div className="font-mono font-medium">{fmtPct(pUp)}</div>
                </div>
                <div className="rounded border border-rose-500/30 bg-rose-500/10 p-2">
                  <div className="text-muted-foreground">NO (DOWN)</div>
                  <div className="font-mono font-medium">
                    {fmtPct(1_000_000_000n - pUp)}
                  </div>
                </div>
              </div>
            ) : isDeepbook ? (
              <p className="text-xs text-muted-foreground">
                p(UP) computed on-chain at swipe time (DeepBook&apos;s SVI
                readers aren&apos;t public for client-side preview).
              </p>
            ) : null}
            {!liveForSwipe && (
              <p className="text-xs text-rose-500">
                Oracle is no longer ACTIVE — swipes will be rejected on-chain.
                Wait for settle + finalize.
              </p>
            )}
            <div className="flex gap-2">
              <Button
                onClick={() => onSwipe(false)}
                disabled={busy || role === "spectator" || !liveForSwipe}
                variant="outline"
                className="flex-1 border-rose-500/50 hover:bg-rose-500/10"
              >
                NO (DOWN)
              </Button>
              <Button
                onClick={() => onSwipe(true)}
                disabled={busy || role === "spectator" || !liveForSwipe}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700"
              >
                YES (UP)
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>You&apos;ve swiped all 5 cards</CardTitle>
            <CardDescription>
              {oppProgress < 5
                ? "Waiting for the opponent to finish swiping…"
                : !oracleExpired
                  ? `Waiting for oracle to expire…`
                  : !oracleSettled
                    ? "Waiting for the keeper to settle the oracle…"
                    : "Oracle settled. Ready to finalize."}
            </CardDescription>
          </CardHeader>
          {bothDone && oracleSettled && (
            <CardContent>
              <Button onClick={onFinalize} disabled={busy}>
                Settle cards + finalize
              </Button>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  )
}

function ResultView({ duel, address }: { duel: DuelState; address: string }) {
  const client = useSuiClient()
  const youWon =
    (duel.p0Score > duel.p1Score && duel.creator === address) ||
    (duel.p1Score > duel.p0Score && duel.challenger === address)
  const tied = duel.p0Score === duel.p1Score

  // After finalize the stakes on the Duel object are zero. Pull the
  // DuelFinalized + per-card CardSettled events so the result view can show
  // accurate payouts and link to each on-chain tx for verification.
  const eventsQ = useQuery({
    queryKey: ["duel-events", duel.id],
    queryFn: async () => {
      const [finalized, settledCards, swiped] = await Promise.all([
        client.queryEvents({
          query: { MoveEventType: `${CONFIG.packageId}::duel::DuelFinalized` },
          limit: 50,
          order: "descending",
        }),
        client.queryEvents({
          query: { MoveEventType: `${CONFIG.packageId}::duel::CardSettled` },
          limit: 50,
          order: "descending",
        }),
        client.queryEvents({
          query: { MoveEventType: `${CONFIG.packageId}::duel::SwipeRecorded` },
          limit: 100,
          order: "descending",
        }),
      ])
      const finalEv = finalized.data.find(
        (e) => (e.parsedJson as { duel_id?: string })?.duel_id === duel.id,
      )
      const finalParsed = finalEv?.parsedJson as
        | {
            payout_to_p0: string
            payout_to_p1: string
            winner: string
            p0_score: string
            p1_score: string
          }
        | undefined

      const settleByCard = new Map<
        number,
        {
          digest: string
          settlement: bigint
          p0Score: bigint
          p1Score: bigint
        }
      >()
      for (const e of settledCards.data) {
        const p = e.parsedJson as {
          duel_id: string
          card_idx: string
          settlement_price: string
          p0_card_score: string
          p1_card_score: string
        }
        if (p.duel_id !== duel.id) continue
        settleByCard.set(Number(p.card_idx), {
          digest: e.id.txDigest,
          settlement: BigInt(p.settlement_price),
          p0Score: BigInt(p.p0_card_score),
          p1Score: BigInt(p.p1_card_score),
        })
      }

      const swipesByCard = new Map<
        string,
        { digest: string; player: string }
      >()
      for (const e of swiped.data) {
        const p = e.parsedJson as {
          duel_id: string
          card_idx: string
          player: string
        }
        if (p.duel_id !== duel.id) continue
        swipesByCard.set(`${p.card_idx}:${p.player}`, {
          digest: e.id.txDigest,
          player: p.player,
        })
      }

      return {
        finalize: finalEv
          ? {
              digest: finalEv.id.txDigest,
              payoutP0: BigInt(finalParsed!.payout_to_p0),
              payoutP1: BigInt(finalParsed!.payout_to_p1),
              winner: finalParsed!.winner,
            }
          : null,
        settleByCard,
        swipesByCard,
      }
    },
  })
  const finalizeQ = { data: eventsQ.data?.finalize ?? null }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>
            {tied ? "Tie — stakes refunded" : youWon ? "You won!" : "You lost"}
          </CardTitle>
          {finalizeQ.data && (
            <CardDescription>
              Payouts: creator{" "}
              {fmtStake(finalizeQ.data.payoutP0, duel.stakeCoinType)} ·
              challenger{" "}
              {fmtStake(finalizeQ.data.payoutP1, duel.stakeCoinType)}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">
                {shortAddr(duel.creator)} (creator)
              </div>
              <div className="font-mono font-medium">
                {fmtScore(duel.p0Score)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">
                {shortAddr(duel.challenger)} (challenger)
              </div>
              <div className="font-mono font-medium">
                {fmtScore(duel.p1Score)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-card breakdown</CardTitle>
          <CardDescription>
            Each row links to its on-chain `CardSettled` event tx so you can
            verify the settlement price + per-card score directly on Sui
            Explorer.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 font-mono text-xs">
          <div className="grid grid-cols-7 gap-2 text-muted-foreground">
            <div>#</div>
            <div>strike</div>
            <div>settle</div>
            <div>creator</div>
            <div className="text-right">score</div>
            <div>challenger</div>
            <div className="text-right">score</div>
          </div>
          {duel.cards.map((c, i) => {
            const settle = duel.cardSettlements[i]
            const p0 = duel.p0Swipes[i]
            const p1 = duel.p1Swipes[i]
            const settleEv = eventsQ.data?.settleByCard.get(i)
            return (
              <div key={i} className="grid grid-cols-7 gap-2">
                <div>
                  {settleEv ? (
                    <ExplorerLink href={txUrl(settleEv.digest)}>{i}</ExplorerLink>
                  ) : (
                    i
                  )}
                </div>
                <div>{fmtUsd(c.strike)}</div>
                <div>{settle !== null ? fmtUsd(settle) : "—"}</div>
                <div>{p0 ? (p0.isUp ? "UP " : "DOWN") : "—"}</div>
                <div className="text-right">
                  {settleEv ? fmtScore(settleEv.p0Score) : "—"}
                </div>
                <div>{p1 ? (p1.isUp ? "UP " : "DOWN") : "—"}</div>
                <div className="text-right">
                  {settleEv ? fmtScore(settleEv.p1Score) : "—"}
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {finalizeQ.data && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">On-chain verification</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-xs">
            <div>
              Finalize tx:{" "}
              <ExplorerLink href={txUrl(finalizeQ.data.digest)}>
                {finalizeQ.data.digest.slice(0, 10)}…
              </ExplorerLink>
              {" — "}
              winner address{" "}
              {finalizeQ.data.winner ===
              "0x0000000000000000000000000000000000000000000000000000000000000000" ? (
                <span className="text-muted-foreground">(tie)</span>
              ) : (
                <ExplorerLink href={obj(finalizeQ.data.winner)}>
                  {shortAddr(finalizeQ.data.winner)}
                </ExplorerLink>
              )}
            </div>
            <div className="text-muted-foreground">
              Duel object: <ExplorerLink href={obj(duel.id)}>{duel.id.slice(0, 10)}…</ExplorerLink>
              {" · "}
              Each card&apos;s strike & player swipe are signed individually
              on-chain — click the # column above to see the per-card settle tx.
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/**
 * DeepBook Predict setup status. Shows whether the connected wallet has a
 * `PredictManager` and how much dUSDC is in the wallet. The staked-tier
 * swipe PTB (predict::mint + record_swipe_deepbook) needs both before it
 * can succeed on-chain.
 */
function PredictAccount({ address }: { address: string }) {
  const client = useSuiClient()
  const qc = useQueryClient()
  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction()

  const managerQ = useQuery({
    queryKey: ["predict-manager", address],
    queryFn: () => findPredictManager(client, address),
    refetchInterval: 10_000,
  })
  const walletQ = useQuery({
    queryKey: ["dusdc-balance", address],
    queryFn: () => getWalletDusdcBalance(client, address),
    refetchInterval: 10_000,
  })
  const managerBalanceQ = useQuery({
    queryKey: ["manager-balance", managerQ.data?.id],
    queryFn: () => getManagerDusdcBalance(client, managerQ.data!.id),
    enabled: !!managerQ.data,
    refetchInterval: 10_000,
  })

  async function handleCreate() {
    const res = await signAndExecute({ transaction: buildCreateManagerTx() })
    await client.waitForTransaction({ digest: res.digest })
    qc.invalidateQueries({ queryKey: ["predict-manager", address] })
  }

  async function handleDeposit() {
    const mgr = managerQ.data
    if (!mgr) return
    const all = walletQ.data ?? 0n
    if (all === 0n) return
    const tx = await buildDepositDusdcTx(client, address, mgr.id, all)
    const res = await signAndExecute({ transaction: tx })
    await client.waitForTransaction({ digest: res.digest })
    qc.invalidateQueries({ queryKey: ["dusdc-balance", address] })
    qc.invalidateQueries({ queryKey: ["manager-balance"] })
  }

  const hasManager = !!managerQ.data
  const wallet = walletQ.data ?? 0n
  const inManager = managerBalanceQ.data ?? 0n
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          DeepBook Predict
          <Badge variant={hasManager ? "default" : "secondary"} className="text-[10px]">
            {hasManager ? "READY" : "SETUP NEEDED"}
          </Badge>
        </CardTitle>
        <CardDescription>
          One-time setup so staked-tier swipes can co-mint real DeepBook
          Predict positions alongside the in-game duel record.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded border p-2">
            <div className="text-muted-foreground">PredictManager</div>
            <div className="font-mono">
              {managerQ.isLoading
                ? "loading…"
                : hasManager
                  ? (
                      <ExplorerLink href={obj(managerQ.data!.id)}>
                        {managerQ.data!.id.slice(0, 10)}…
                      </ExplorerLink>
                    )
                  : "—"}
            </div>
          </div>
          <div className="rounded border p-2">
            <div className="text-muted-foreground">Wallet dUSDC</div>
            <div className="font-mono">{fmtDusdc(wallet)}</div>
          </div>
          <div className="rounded border p-2 col-span-2">
            <div className="text-muted-foreground">In PredictManager</div>
            <div className="font-mono">
              {hasManager ? fmtDusdc(inManager) : "—"}{" "}
              <span className="text-[10px] text-muted-foreground">
                (used as duel stake when currency = dUSDC)
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!hasManager ? (
            <Button onClick={handleCreate} disabled={isPending}>
              {isPending ? "creating…" : "Setup PredictManager"}
            </Button>
          ) : (
            <Button
              onClick={handleDeposit}
              disabled={isPending || wallet === 0n}
              variant="outline"
            >
              {isPending ? "depositing…" : `Deposit ${fmtDusdc(wallet)} into manager`}
            </Button>
          )}
        </div>
        {hasManager && wallet === 0n && (
          <p className="text-xs text-muted-foreground">
            No dUSDC in wallet. Testnet dUSDC has no public faucet; you need
            an existing source to top up before staked swipes work.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
