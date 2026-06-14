/**
 * HTTP read endpoints over the indexer's SQLite mirror.
 *
 *   GET /duels/recent?limit=20[&status=PENDING|ACTIVE|COMPLETE]
 *   GET /duels/{id}
 *
 * These never hit Sui RPC — they read whatever the indexer has already
 * mirrored. Freshness is bounded by `INDEXER_POLL_INTERVAL_MS`
 * (default 3 s). Frontend that needs strictly-fresh data should still
 * `getObject` directly; this is for listings / dashboards / share pages.
 */
import { getDuel, listRecentDuels, type DuelRow } from "./db"
import { json } from "./lib/http"

function toWire(d: DuelRow) {
  return {
    id: d.id,
    status: d.status,
    stakeCoinType: d.stakeCoinType,
    creator: d.creator,
    challenger: d.challenger,
    cardsRevealed: d.cardsRevealed,
    cardCount: d.cardCount,
    settledCount: d.settledCount,
    p0Payout: d.p0Payout,
    p0Premium: d.p0Premium,
    p1Payout: d.p1Payout,
    p1Premium: d.p1Premium,
    startedAtMs: d.startedAtMs,
    cardOutcomes: d.cardOutcomes,
    swipes: d.swipes,
    cards: d.cards,
    lastUpdatedMs: d.lastUpdatedMs,
  }
}

export async function handleDuelsRequest(
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/duels/recent" && req.method === "GET") {
    const limitRaw = url.searchParams.get("limit")
    const limit = Math.min(100, Math.max(1, Number(limitRaw ?? 20)))
    const statusRaw = url.searchParams.get("status")
    const status =
      statusRaw === "PENDING" || statusRaw === "ACTIVE" || statusRaw === "COMPLETE"
        ? statusRaw
        : undefined
    // `player` returns only duels where the address is creator OR
    // challenger. Lets the UI build "My Duels" lists without pulling
    // the global feed and filtering client-side.
    const playerRaw = url.searchParams.get("player")
    const player =
      playerRaw && playerRaw.startsWith("0x") ? playerRaw : undefined
    try {
      const duels = (await listRecentDuels(limit, status, player)).map(toWire)
      return json({ duels })
    } catch (e) {
      return json(
        { error: "duels read failed", detail: e instanceof Error ? e.message : String(e) },
        500,
      )
    }
  }

  if (url.pathname.startsWith("/duels/") && req.method === "GET") {
    const id = decodeURIComponent(url.pathname.slice("/duels/".length))
    if (!id.startsWith("0x")) return json({ error: "bad duel id" }, 400)
    try {
      const d = await getDuel(id)
      if (!d) return json({ error: "duel not mirrored yet" }, 404)
      return json(toWire(d))
    } catch (e) {
      return json(
        { error: "duel read failed", detail: e instanceof Error ? e.message : String(e) },
        500,
      )
    }
  }

  return null
}
