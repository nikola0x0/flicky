import {
  buildDeck,
  fetchDeck,
  hashToHex,
  knownHashCount,
  rememberDeck,
} from "./deckmaster"
import { handleSponsorRequest } from "./sponsor"

const PORT = Number(process.env.PORT ?? 3001)

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  })
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url)

    // /sponsor has its own CORS rules (origin allowlist via env). Check it
    // BEFORE the wildcard CORS preflight below.
    const sponsored = await handleSponsorRequest(req)
    if (sponsored) return sponsored

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    if (url.pathname === "/health") {
      return json({ ok: true, decks: knownHashCount() })
    }

    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req)
      if (upgraded) return
      return new Response("upgrade failed", { status: 400 })
    }

    if (url.pathname === "/deckmaster/generate" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | { oracle_id?: string; reference?: string }
        | null
      if (!body?.oracle_id || !body.reference) {
        return json({ error: "oracle_id + reference required" }, 400)
      }
      const reference = BigInt(body.reference)
      if (reference <= 0n) {
        return json({ error: "reference must be > 0" }, 400)
      }
      const deck = buildDeck(body.oracle_id, reference)
      const hex = rememberDeck(deck.hash, deck.cards)
      return json({
        cards: deck.cards.map((c) => ({
          oracle_id: c.oracle_id,
          strike: c.strike.toString(),
        })),
        hash: hex,
      })
    }

    if (url.pathname === "/deckmaster/reveal" && req.method === "GET") {
      const hash = url.searchParams.get("hash")
      if (!hash) return json({ error: "hash param required" }, 400)
      const cards = fetchDeck(hash)
      if (!cards) return json({ error: "unknown hash" }, 404)
      return json({
        cards: cards.map((c) => ({
          oracle_id: c.oracle_id,
          strike: c.strike.toString(),
        })),
        hash: hash.toLowerCase(),
      })
    }

    return new Response("flicky server", { status: 200, headers: CORS_HEADERS })
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "hello" }))
    },
    message(ws, message) {
      ws.send(message)
    },
    close() {},
  },
})

console.log(`flicky server listening on http://localhost:${server.port}`)
console.log(`  POST /deckmaster/generate  body: { oracle_id, reference }`)
console.log(`  GET  /deckmaster/reveal    ?hash=0x...`)
console.log(`  POST /sponsor              body: { action: "create" | "execute", ... }`)
if (!process.env.ENOKI_PRIVATE_KEY) {
  console.log(
    `  [sponsor]                 ENOKI_PRIVATE_KEY not set → /sponsor will 503`,
  )
}

// Re-export for bot/keeper that import in-process.
export { buildDeck, fetchDeck, hashToHex }
