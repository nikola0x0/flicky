/**
 * GET /manager?owner=0x… — resolve an address's PredictManager id.
 *
 * Single source of truth for owner→manager resolution. The web client
 * calls this instead of walking `PredictManagerCreated` events itself, so
 * the DB-cached, unbounded lookup lives in exactly one place
 * (predict.ts::findManagerFor). A `managerId: null` is authoritative —
 * the server scans the full event stream, so null means "no manager
 * exists yet", NOT "buried past a scan cap". That lets the client safely
 * decide whether to bootstrap one without minting a duplicate.
 */
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils"
import { getSuiClient } from "./lib/sui"
import { findManagerFor } from "./predict"
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
    const managerId = await findManagerFor(getSuiClient(), owner)
    return json({ ok: true, owner, managerId })
  } catch (e) {
    return json(
      {
        error: "manager lookup failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      500,
    )
  }
}
