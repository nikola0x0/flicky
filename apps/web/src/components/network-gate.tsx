import { ACTIVE_NETWORK, setNetwork } from "@/lib/network"
import { PixelButton } from "@/components/pixel-button"

/**
 * Shown in place of a route's content when the active network can't run the
 * duel engine.
 *
 * DeepBook Predict — which every money path depends on (the staked-tier
 * mint, Deckmaster's market discovery, the oracle stream, the keeper's
 * settlement prices) — is deployed on testnet only. Until it ships to
 * mainnet there is nothing on mainnet to swipe against, so rather than let
 * a player queue into a duel that can never settle, the affected routes
 * render this and offer a one-tap way back to testnet.
 *
 * Gated by `DUELS_ENABLED` (lib/config.ts), which is derived from whether
 * the network's Predict + flicky package ids actually resolve. Supplying
 * the `_MAINNET` env vars is what turns this off — there is no separate
 * flag to remember to flip.
 */
export function NetworkGate({
  what = "duels",
  reason = "flicky runs on deepbook predict, which is still testnet-only.",
}: {
  /** Noun for the headline, e.g. "duels", "practice", "the shop". */
  what?: string
  /** Why this route can't run here. Defaults to the Predict explanation. */
  reason?: string
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-8 pb-24 text-center">
      <img
        src="/icons/swords.png"
        alt=""
        aria-hidden
        className="size-16 opacity-40 [image-rendering:pixelated]"
      />

      <div className="flex flex-col gap-3">
        <p className="text-2xl leading-tight tracking-[0.12em] text-white uppercase">
          {what} aren't live on {ACTIVE_NETWORK} yet
        </p>
        <p className="text-lg leading-relaxed text-white/60">
          {reason} switch back to testnet to play.
        </p>
      </div>

      <PixelButton
        onClick={() => setNetwork("testnet")}
        className="h-14 px-10 text-xl"
      >
        switch to testnet
      </PixelButton>
    </div>
  )
}
