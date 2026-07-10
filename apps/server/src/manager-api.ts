/**
 * GET /manager?owner=0x… — resolve an address's AccountWrapper id (+ its
 * dUSDC balance).
 *
 * Single source of truth for owner→wrapper resolution. The web client
 * calls this instead of deriving `(AccountRegistry, owner)` itself, so
 * the DB-cached lookup lives in exactly one place
 * (predict.ts::deriveWrapperFor). A `wrapper: null` is authoritative —
 * `derived_wrapper_exists` returned false, so null means "no wrapper
 * exists yet", NOT "the lookup failed". That lets the client safely
 * decide whether to bootstrap one without minting a duplicate.
 */
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils"
import { getSuiClient } from "./lib/sui"
import { deriveWrapperFor, readAccountBalance } from "./predict"
import { json } from "./lib/http"

export async function handleManagerRequest(
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== "/manager" || req.method !== "GET") return null

  const ownerRaw = url.searchParams.get("owner")
  if (!ownerRaw) return json({ error: "missing ?owner=0x…" }, 400)

  let owner: string
  try {
    owner = normalizeSuiAddress(ownerRaw)
    if (!isValidSuiAddress(owner)) throw new Error("bad address")
  } catch {
    return json({ error: "invalid owner address" }, 400)
  }

  try {
    const client = getSuiClient()
    const wrapper = await deriveWrapperFor(client, owner)
    if (!wrapper) return json({ ok: true, owner, wrapper: null, balance: null })
    const balance = await readAccountBalance(client, owner, wrapper)
    return json({ ok: true, owner, wrapper, balance: balance.toString() })
  } catch (e) {
    return json(
      {
        error: "wrapper lookup failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      500,
    )
  }
}
