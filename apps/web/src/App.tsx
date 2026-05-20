/**
 * Minimal smoke-test UI for the cleaned-up libs after Phase 1. Exercises:
 *   - findLatestOracleSvi + fetchOracleSvi
 *   - buildCreateDuelTx / buildJoinDuelTx / buildSwipeTx / buildSettleAndFinalizeTx
 *   - listDuelIds + fetchDuel
 *
 * Real PRD-spec gameplay UI (3 stake buttons → matchmaking → swipe phase →
 * lockup → share card) ships in Phase 3.
 */
import { useState, type ReactNode } from "react"
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

import { CONFIG } from "@/lib/config"
import {
  buildCreateDuelTx,
  buildJoinDuelTx,
  buildSettleAndFinalizeTx,
  buildSwipeTx,
  fetchDuel,
  fetchOracleSvi,
  findLatestOracleSvi,
  listDuelIds,
  oracleStrikes,
} from "@/lib/flicky"

const EXPLORER = "https://suiscan.xyz/testnet"
const obj = (id: string) => `${EXPLORER}/object/${id}`

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
  return `$${(Number(n9) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function fmtSui(mist: bigint): string {
  return `${(Number(mist) / 1e9).toFixed(4)} SUI`
}

function shortId(id: string, len = 8): string {
  return id.length > len * 2 + 2 ? `${id.slice(0, len)}…${id.slice(-len)}` : id
}

export default function App() {
  const account = useCurrentAccount()

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">flicky · phase 1 smoke test</h1>
        <ConnectButton />
      </header>
      <p className="text-muted-foreground text-sm">
        Package <code>{shortId(CONFIG.packageId)}</code> on testnet. Real PRD-spec UI ships in
        phase 3 — this view exists to exercise the rewritten libs.
      </p>

      <OraclePanel />
      {account && <LobbyPanel address={account.address} />}
    </div>
  )
}

function OraclePanel() {
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>BTC oracle (DeepBook OracleSVI)</CardTitle>
        <CardDescription>
          {oracleIdQuery.data ? (
            <ExplorerLink href={obj(oracleIdQuery.data)}>
              {shortId(oracleIdQuery.data)}
            </ExplorerLink>
          ) : (
            "discovering…"
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {oracleQuery.data ? (
          <>
            <div>
              spot <strong>{fmtUsd(oracleQuery.data.spot)}</strong> · forward{" "}
              <strong>{fmtUsd(oracleQuery.data.forward)}</strong>
            </div>
            <div>
              expiry{" "}
              <span className="text-muted-foreground">
                {new Date(Number(oracleQuery.data.expiry)).toLocaleString()}
              </span>
            </div>
            <div>
              status{" "}
              <Badge variant={oracleQuery.data.isActive ? "default" : "secondary"}>
                {oracleQuery.data.settlementPrice !== null
                  ? `settled @ ${fmtUsd(oracleQuery.data.settlementPrice)}`
                  : oracleQuery.data.isActive
                    ? "active"
                    : "inactive"}
              </Badge>
            </div>
          </>
        ) : (
          <span className="text-muted-foreground">loading…</span>
        )}
      </CardContent>
    </Card>
  )
}

function LobbyPanel({ address }: { address: string }) {
  const client = useSuiClient()
  const queryClient = useQueryClient()
  const { mutateAsync: signAndExec, isPending } = useSignAndExecuteTransaction()
  const [stakeMist, setStakeMist] = useState<string>(CONFIG.defaultStakeMist.toString())
  const [status, setStatus] = useState<string>("")

  const oracleIdQuery = useQuery({
    queryKey: ["oracle-id"],
    queryFn: () => findLatestOracleSvi(client),
    staleTime: 60_000,
  })
  const oracleQuery = useQuery({
    queryKey: ["oracle", oracleIdQuery.data],
    queryFn: () => fetchOracleSvi(client, oracleIdQuery.data!),
    enabled: !!oracleIdQuery.data,
  })
  const duelsQuery = useQuery({
    queryKey: ["duels"],
    queryFn: () => listDuelIds(client, 20),
    staleTime: 10_000,
  })

  async function createDuel() {
    if (!oracleQuery.data || !oracleIdQuery.data) return
    const ref = oracleQuery.data.settlementPrice ?? oracleQuery.data.forward
    const strikes = oracleStrikes(ref)
    setStatus("submitting create_duel…")
    try {
      const tx = buildCreateDuelTx(oracleIdQuery.data, strikes, BigInt(stakeMist))
      const res = await signAndExec({ transaction: tx })
      setStatus(`created — tx ${shortId(res.digest)}`)
      queryClient.invalidateQueries({ queryKey: ["duels"] })
    } catch (e) {
      setStatus(`error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lobby</CardTitle>
        <CardDescription>
          your address <ExplorerLink href={obj(address)}>{shortId(address)}</ExplorerLink>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-sm font-medium">stake (mist, 1e9 = 1 SUI)</label>
            <Input
              type="text"
              value={stakeMist}
              onChange={(e) => setStakeMist(e.target.value)}
            />
          </div>
          <Button onClick={createDuel} disabled={isPending || !oracleQuery.data}>
            create duel
          </Button>
        </div>
        {status && <p className="text-muted-foreground text-sm">{status}</p>}

        <Separator />

        <div>
          <h3 className="mb-2 text-sm font-semibold">recent duels</h3>
          {duelsQuery.isLoading && (
            <p className="text-muted-foreground text-sm">loading…</p>
          )}
          {duelsQuery.data && duelsQuery.data.length === 0 && (
            <p className="text-muted-foreground text-sm">none yet</p>
          )}
          {duelsQuery.data?.map((id) => (
            <DuelRow key={id} duelId={id} address={address} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function DuelRow({ duelId, address }: { duelId: string; address: string }) {
  const client = useSuiClient()
  const queryClient = useQueryClient()
  const { mutateAsync: signAndExec } = useSignAndExecuteTransaction()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string>("")

  const duelQuery = useQuery({
    queryKey: ["duel", duelId],
    queryFn: () => fetchDuel(client, duelId),
    refetchInterval: 3_000,
  })

  if (!duelQuery.data) return null
  const d = duelQuery.data
  const isCreator = d.creator === address
  const isChallenger = d.challenger === address
  const isPlayer = isCreator || isChallenger
  const myNextIdx = isCreator ? Number(d.p0NextCardIdx) : Number(d.p1NextCardIdx)

  async function action(label: string, buildTx: () => Promise<unknown> | unknown) {
    setBusy(true)
    setMsg(`${label}…`)
    try {
      const tx = await Promise.resolve(buildTx())
      const res = await signAndExec({ transaction: tx as never })
      setMsg(`${label} ok — ${shortId(res.digest)}`)
      queryClient.invalidateQueries({ queryKey: ["duel", duelId] })
    } catch (e) {
      setMsg(`error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-muted/30 mt-2 rounded p-3 text-sm">
      <div className="flex items-center justify-between">
        <ExplorerLink href={obj(duelId)}>{shortId(duelId)}</ExplorerLink>
        <Badge>{d.status}</Badge>
      </div>
      <div className="text-muted-foreground mt-1">
        p0 {fmtSui(d.p0Stake)} · p1 {fmtSui(d.p1Stake)} · settled{" "}
        {d.settledCount.toString()}/5
      </div>
      <div className="text-muted-foreground">
        scores p0 <strong>{(Number(d.p0Score) / 1e9).toFixed(3)}</strong> · p1{" "}
        <strong>{(Number(d.p1Score) / 1e9).toFixed(3)}</strong>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {d.status === "PENDING" && !isCreator && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              action("join_duel", () =>
                buildJoinDuelTx(duelId, d.p0Stake, d.stakeCoinType),
              )
            }
          >
            join ({fmtSui(d.p0Stake)})
          </Button>
        )}
        {d.status === "ACTIVE" && isPlayer && myNextIdx < 5 && (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                action("swipe UP", () =>
                  buildSwipeTx(
                    duelId,
                    d.cards[myNextIdx].oracleId,
                    myNextIdx,
                    true,
                    d.stakeCoinType,
                  ),
                )
              }
            >
              swipe card {myNextIdx} UP
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                action("swipe DOWN", () =>
                  buildSwipeTx(
                    duelId,
                    d.cards[myNextIdx].oracleId,
                    myNextIdx,
                    false,
                    d.stakeCoinType,
                  ),
                )
              }
            >
              swipe card {myNextIdx} DOWN
            </Button>
          </>
        )}
        {d.status === "ACTIVE" && d.settledCount === 0n && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              action("settle+finalize", () =>
                buildSettleAndFinalizeTx(duelId, d.cards[0].oracleId, d.stakeCoinType),
              )
            }
          >
            settle + finalize
          </Button>
        )}
      </div>
      {msg && <p className="text-muted-foreground mt-2 text-xs">{msg}</p>}
    </div>
  )
}
