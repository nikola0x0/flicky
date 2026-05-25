/**
 * My Duels — list every duel where the connected wallet is creator or
 * challenger, show its current state, and let the player redeem any
 * winning positions back into their PredictManager.
 *
 * Data path:
 *   GET /duels/recent?player=<addr>&limit=50
 *   → list of duels (most recent first), each with cardOutcomes + swipes
 *
 * Redeem path (per duel):
 *   For each settled card the player swiped CORRECTLY, build one
 *   `predict::redeem_permissionless(predict, manager, oracle, mk, qty)`
 *   call in a single PTB. Sign once, drains all wins back into the
 *   player's PredictManager balance.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { CONFIG, DUSDC_TYPE } from '../../config'

const DUSDC_COIN_TYPE = DUSDC_TYPE(CONFIG.dusdcPackageId)

type PanelOutput = {
  type: 'success' | 'error' | 'info'
  title: string
  data: string
  txDigest?: string
}

interface Props {
  onOutput: (o: PanelOutput) => void
}

type Status = 'PENDING' | 'ACTIVE' | 'COMPLETE'

interface DuelLite {
  id: string
  status: Status
  creator: string
  challenger: string
  cardsRevealed: boolean
  cardCount: number
  settledCount: number
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
  swipes: Array<{
    cardIdx: number
    p0Swipe: { isUp: boolean; quantity: string; premium: string } | null
    p1Swipe: { isUp: boolean; quantity: string; premium: string } | null
  }>
}

function fmtDusdc(micro: bigint | string): string {
  const n = typeof micro === 'string' ? BigInt(micro) : micro
  return (Number(n) / 1_000_000).toFixed(4)
}

function shortAddr(a: string): string {
  if (a.length < 12) return a
  return a.slice(0, 6) + '…' + a.slice(-4)
}

function roleOf(d: DuelLite, addr: string): 'creator' | 'challenger' | null {
  if (d.creator === addr) return 'creator'
  if (d.challenger === addr) return 'challenger'
  return null
}

/**
 * Net Predict PnL of one side, derived from per-card outcomes. The
 * contract's `finalize` decides the winner by comparing
 *   val0 = p0_payout + p1_premium
 *   val1 = p1_payout + p0_premium
 * which algebraically simplifies to comparing `p0_net` vs `p1_net`
 * where `pX_net = sum(pX_pnl over settled cards) = payout − premium`.
 *
 * We sum from `cardOutcomes` (computed by the indexer from each
 * swipe + settlement) instead of reading `pX_payout/premium` off the
 * Duel object directly — those cumulative fields can lag or read as
 * 0 on older deployed-contract versions, while the per-card PnL is
 * always self-derivable from swipes the indexer already has.
 */
function sideNet(
  d: DuelLite,
  side: 'p0' | 'p1',
): bigint {
  let n = 0n
  for (const o of d.cardOutcomes) {
    const p = side === 'p0' ? o.p0Pnl : o.p1Pnl
    if (p !== null) n += BigInt(p)
  }
  return n
}

/**
 * Duel side-pot delta from the connected wallet's POV: positive ⇒
 * `finalize` paid the whole pot to you, negative ⇒ to opponent, zero
 * ⇒ tie (each side got their stake back).
 *
 * Equivalent to `myNet − oppNet` (= val0 − val1 in the contract).
 */
function netResult(d: DuelLite, role: 'creator' | 'challenger'): bigint {
  const my = role === 'creator' ? 'p0' : 'p1'
  const opp = role === 'creator' ? 'p1' : 'p0'
  return sideNet(d, my) - sideNet(d, opp)
}

/**
 * Identify settled cards where the connected wallet swiped in the
 * winning direction but hasn't redeemed yet. Returns one entry per
 * unredeemed winning position. (We can't tell from the duel object
 * alone whether a position has already been redeemed — the position
 * lives on the PredictManager, not the Duel. So we conservatively
 * surface every winning swipe and let the on-chain `redeem` no-op
 * gracefully if it's already been claimed.)
 */
function winningPositions(
  d: DuelLite,
  role: 'creator' | 'challenger',
): Array<{
  cardIdx: number
  strike: string
  oracleId: string | null
  isUp: boolean
  quantity: string
}> {
  const myKey = role === 'creator' ? 'p0Swipe' : 'p1Swipe'
  const out: Array<{
    cardIdx: number
    strike: string
    oracleId: string | null
    isUp: boolean
    quantity: string
  }> = []
  for (const o of d.cardOutcomes) {
    const mySwipe = o[myKey]
    if (!mySwipe) continue
    if (mySwipe.isUp !== o.upWon) continue
    out.push({
      cardIdx: o.cardIdx,
      strike: o.strike,
      // outcomes don't carry oracle_id directly; the redeem path needs
      // it. Caller resolves via on-chain duel read.
      oracleId: null,
      isUp: mySwipe.isUp,
      quantity: mySwipe.quantity,
    })
  }
  return out
}

export default function MyDuelsPanel({ onOutput }: Props) {
  const account = useCurrentAccount()
  const client = useSuiClient()
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction()
  const [duels, setDuels] = useState<DuelLite[]>([])
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'ALL' | Status>('ALL')
  const [redeemingId, setRedeemingId] = useState<string | null>(null)

  const fetchDuels = useCallback(async () => {
    if (!account?.address) {
      setDuels([])
      return
    }
    setLoading(true)
    try {
      const params = new URLSearchParams({
        player: account.address,
        limit: '50',
      })
      if (statusFilter !== 'ALL') params.set('status', statusFilter)
      const r = await fetch(`${CONFIG.serverHttpUrl}/duels/recent?${params}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = (await r.json()) as { duels: DuelLite[] }
      setDuels(body.duels)
    } catch (e) {
      onOutput({
        type: 'error',
        title: 'fetch my duels',
        data: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setLoading(false)
    }
  }, [account?.address, statusFilter, onOutput])

  // Initial + periodic refresh so PENDING/ACTIVE state stays current
  // without the user spamming the Refresh button.
  useEffect(() => {
    fetchDuels()
    const h = setInterval(fetchDuels, 15_000)
    return () => clearInterval(h)
  }, [fetchDuels])

  const handleRedeem = useCallback(
    async (d: DuelLite) => {
      if (!account?.address) return
      const role = roleOf(d, account.address)
      if (!role) {
        onOutput({
          type: 'error',
          title: 'redeem',
          data: 'not a participant in this duel',
        })
        return
      }
      const wins = winningPositions(d, role)
      if (wins.length === 0) {
        onOutput({
          type: 'info',
          title: 'redeem',
          data: 'no winning positions to redeem in this duel',
        })
        return
      }
      // Each redeem needs: oracle object id + market_key (oracle_id, expiry,
      // strike). cardOutcomes carries strike but not oracle_id or expiry, so
      // we read those from the on-chain Duel.cards[i] vector.
      setRedeemingId(d.id)
      try {
        const obj = await client.getObject({
          id: d.id,
          options: { showContent: true },
        })
        if (obj.data?.content?.dataType !== 'moveObject')
          throw new Error('duel object not found on chain')
        const f = obj.data.content.fields as {
          cards: Array<{ fields: { oracle_id: string; strike: string } }>
        }
        const oracleIds = wins.map((w) => f.cards[w.cardIdx]?.fields?.oracle_id)
        if (oracleIds.some((id) => !id))
          throw new Error('one or more card oracle_ids missing on duel object')
        const oracleObjs = await client.multiGetObjects({
          ids: oracleIds as string[],
          options: { showContent: true },
        })
        const expiryById: Record<string, string> = {}
        for (const o of oracleObjs) {
          if (o.data?.content?.dataType !== 'moveObject') continue
          const ff = o.data.content.fields as { expiry?: string }
          if (ff.expiry !== undefined) expiryById[o.data.objectId] = ff.expiry
        }
        // Look up the player's PredictManager by scanning the
        // PredictManagerCreated event stream. There's no dedicated
        // backend endpoint for this (and the server's 404 page would
        // return HTML, breaking JSON.parse).
        let managerId: string | null = null
        const evts = await client.queryEvents({
          query: {
            MoveEventType: `${CONFIG.predictPackageId}::predict::PredictManagerCreated`,
          },
          limit: 50,
          order: 'descending',
        })
        for (const e of evts.data) {
          const p = e.parsedJson as { manager_id?: string; owner?: string }
          if (p.owner === account.address && p.manager_id) {
            managerId = p.manager_id
            break
          }
        }
        if (!managerId)
          throw new Error(
            'no PredictManager found for this wallet — create one first',
          )
        const tx = new Transaction()
        for (let i = 0; i < wins.length; i++) {
          const w = wins[i]
          const oracleId = oracleIds[i] as string
          const expiry = expiryById[oracleId]
          if (!expiry) {
            throw new Error(`oracle ${oracleId} expiry not readable`)
          }
          const mk = tx.moveCall({
            target: `${CONFIG.predictPackageId}::market_key::${w.isUp ? 'up' : 'down'}`,
            arguments: [
              tx.pure.id(oracleId),
              tx.pure.u64(BigInt(expiry)),
              tx.pure.u64(BigInt(w.strike)),
            ],
          })
          tx.moveCall({
            target: `${CONFIG.predictPackageId}::predict::redeem_permissionless`,
            typeArguments: [DUSDC_COIN_TYPE],
            arguments: [
              tx.object(CONFIG.predictObjectId),
              tx.object(managerId),
              tx.object(oracleId),
              mk,
              tx.pure.u64(BigInt(w.quantity)),
              tx.object('0x6'),
            ],
          })
        }
        const res = await signAndExecute({ transaction: tx })
        await client.waitForTransaction({ digest: res.digest })
        onOutput({
          type: 'success',
          title: `redeem ${wins.length} winning position(s)`,
          data: `duel ${shortAddr(d.id)} → drained ${wins.length} position(s) back into your PredictManager`,
          txDigest: res.digest,
        })
        // Optimistic refresh so the row updates immediately.
        fetchDuels()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // The contract no-ops gracefully when a position is already
        // redeemed (zero quantity) — surface a friendlier message.
        if (msg.includes('EZeroQuantity') || /\babort code: 3\b/.test(msg)) {
          onOutput({
            type: 'info',
            title: 'redeem',
            data: 'all winning positions for this duel already redeemed',
          })
        } else {
          onOutput({
            type: 'error',
            title: 'redeem',
            data: msg,
          })
        }
      } finally {
        setRedeemingId(null)
      }
    },
    [account?.address, client, signAndExecute, onOutput, fetchDuels],
  )

  const myAddr = account?.address ?? ''

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-gray-100">My Duels</h2>
          <p className="text-xs text-gray-500">
            {myAddr ? `Wallet ${shortAddr(myAddr)}` : 'Connect a wallet'} ·
            results + redeem
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'ALL' | Status)}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
          >
            <option value="ALL">All</option>
            <option value="PENDING">Pending</option>
            <option value="ACTIVE">Active</option>
            <option value="COMPLETE">Complete</option>
          </select>
          <button
            onClick={fetchDuels}
            disabled={loading || !myAddr}
            className="rounded border border-gray-700 bg-gray-850 px-3 py-1 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-40"
          >
            {loading ? 'Loading…' : '🔄 Refresh'}
          </button>
        </div>
      </header>

      {!myAddr ? (
        <div className="rounded border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
          Connect your wallet to view your duels.
        </div>
      ) : duels.length === 0 ? (
        <div className="rounded border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
          {loading
            ? 'Loading your duels…'
            : 'No duels found for this wallet yet. Run an E2E flow to create one.'}
        </div>
      ) : (
        <div className="space-y-3">
          {duels.map((d) => {
            const role = roleOf(d, myAddr)
            if (!role) return null
            const net = netResult(d, role)
            const myNet = sideNet(d, role === 'creator' ? 'p0' : 'p1')
            const oppNet = sideNet(d, role === 'creator' ? 'p1' : 'p0')
            const wins = winningPositions(d, role)
            const oppAddr = role === 'creator' ? d.challenger : d.creator
            const isComplete = d.status === 'COMPLETE'
            const outcomeColor = isComplete
              ? net > 0n
                ? 'text-emerald-300'
                : net < 0n
                  ? 'text-red-300'
                  : 'text-yellow-300'
              : 'text-gray-400'
            const outcomeLabel = isComplete
              ? net > 0n
                ? '🏆 Win'
                : net < 0n
                  ? '💀 Loss'
                  : '🤝 Tie'
              : d.status === 'ACTIVE'
                ? 'In progress'
                : 'Pending'
            return (
              <div
                key={d.id}
                className="rounded border border-gray-800 bg-gray-900 p-3 text-xs"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className={`font-bold ${outcomeColor}`}>
                        {outcomeLabel}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${d.status === 'COMPLETE' ? 'bg-gray-800 text-gray-300' : d.status === 'ACTIVE' ? 'bg-blue-900/50 text-blue-300' : 'bg-yellow-900/40 text-yellow-300'}`}
                      >
                        {d.status}
                      </span>
                      <span className="text-gray-500">
                        you as {role}
                      </span>
                    </div>
                    <div className="font-mono text-[10px] text-gray-500">
                      {d.id}
                    </div>
                    <div className="text-gray-400">
                      vs {shortAddr(oppAddr)} · {d.settledCount}/{d.cardCount}{' '}
                      cards settled
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-wide text-gray-500">
                      Side-pot Δ (vs opp)
                    </div>
                    <div
                      className={`font-mono text-base font-bold ${net > 0n ? 'text-emerald-300' : net < 0n ? 'text-red-300' : 'text-gray-300'}`}
                    >
                      {net >= 0n ? '+' : ''}
                      {fmtDusdc(net)} dUSDC
                    </div>
                    <div className="mt-0.5 text-[10px] text-gray-500">
                      you {myNet >= 0n ? '+' : ''}
                      {fmtDusdc(myNet)} · opp {oppNet >= 0n ? '+' : ''}
                      {fmtDusdc(oppNet)}
                    </div>
                  </div>
                </div>

                {/* Per-card breakdown — both sides, so the user can see
                    where the duel was won/tied/lost. */}
                {d.cardOutcomes.length > 0 && (
                  <div className="mt-2 space-y-0.5 border-t border-gray-800 pt-2">
                    {d.cardOutcomes.map((o) => {
                      const my = role === 'creator' ? o.p0Swipe : o.p1Swipe
                      const opp = role === 'creator' ? o.p1Swipe : o.p0Swipe
                      const myPnl = role === 'creator' ? o.p0Pnl : o.p1Pnl
                      const oppPnl = role === 'creator' ? o.p1Pnl : o.p0Pnl
                      const myWon = my && my.isUp === o.upWon
                      const oppWon = opp && opp.isUp === o.upWon
                      const pnlClass = (p: string | null) =>
                        p && BigInt(p) > 0n
                          ? 'text-emerald-300'
                          : p && BigInt(p) < 0n
                            ? 'text-red-300'
                            : 'text-gray-500'
                      const fmtP = (p: string | null) =>
                        p === null
                          ? '—'
                          : (BigInt(p) >= 0n ? '+' : '') + fmtDusdc(p)
                      return (
                        <div
                          key={o.cardIdx}
                          className="grid grid-cols-12 items-center gap-1 text-[10px]"
                        >
                          <span className="col-span-1 font-mono text-gray-500">
                            #{o.cardIdx}
                          </span>
                          <span className="col-span-2 text-gray-400">
                            ${(Number(o.strike) / 1e9).toFixed(0)} → $
                            {(Number(o.settlementPrice) / 1e9).toFixed(0)}
                          </span>
                          <span className="col-span-2">
                            <span
                              className={`rounded px-1 py-0.5 text-[9px] ${o.upWon ? 'bg-emerald-900/60 text-emerald-200' : 'bg-red-900/60 text-red-200'}`}
                            >
                              {o.upWon ? 'UP won' : 'DOWN won'}
                            </span>
                          </span>
                          <span className="col-span-3 whitespace-nowrap">
                            <span className="text-gray-500">you </span>
                            <span className="text-gray-200">
                              {my ? (my.isUp ? '⬆' : '⬇') : '—'}
                            </span>
                            <span className="ml-1 text-gray-600">
                              {myWon ? '✓' : my ? '✗' : ''}
                            </span>
                            <span className={`ml-1 font-mono ${pnlClass(myPnl)}`}>
                              {fmtP(myPnl)}
                            </span>
                          </span>
                          <span className="col-span-4 whitespace-nowrap text-right">
                            <span className="text-gray-500">opp </span>
                            <span className="text-gray-200">
                              {opp ? (opp.isUp ? '⬆' : '⬇') : '—'}
                            </span>
                            <span className="ml-1 text-gray-600">
                              {oppWon ? '✓' : opp ? '✗' : ''}
                            </span>
                            <span className={`ml-1 font-mono ${pnlClass(oppPnl)}`}>
                              {fmtP(oppPnl)}
                            </span>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Two distinct payouts to surface:
                  *   1. Side-pot — paid automatically by `duel::finalize`
                  *      to the winner (val0 vs val1). Already in your
                  *      wallet by the time this row shows COMPLETE.
                  *   2. Predict positions — each correct swipe mints a
                  *      binary position into your PredictManager; you
                  *      must redeem it back to get the quantity out.
                  *      `redeem_permissionless` no-ops on zero-balance
                  *      positions (so double-clicking is safe). */}
                {isComplete && (
                  <div className="mt-2 space-y-1 border-t border-gray-800 pt-2 text-[10px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-gray-400">
                        🪙 Side-pot:{' '}
                        {net > 0n
                          ? `won — entire pot (stakes 2×) auto-paid by finalize`
                          : net < 0n
                            ? `lost — opponent took the pot`
                            : `tie — your stake refunded`}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-gray-400">
                        🎟️ Predict positions:{' '}
                        {wins.length > 0
                          ? `${wins.length} winning · ${fmtDusdc(
                              wins.reduce(
                                (s, w) => s + BigInt(w.quantity),
                                0n,
                              ),
                            )} dUSDC redeemable`
                          : 'none to redeem from this duel'}
                      </span>
                      {wins.length > 0 && (
                        <button
                          onClick={() => handleRedeem(d)}
                          disabled={redeemingId !== null}
                          className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
                        >
                          {redeemingId === d.id
                            ? 'Redeeming…'
                            : `💰 Redeem ${wins.length}`}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
