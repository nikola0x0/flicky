import {
  ACTIVE_NETWORK,
  AVAILABLE_NETWORKS,
  setNetwork,
  type FlickyNetwork,
} from "@/lib/network"

/**
 * Per-network colouring. Mainnet gets the warning-amber treatment so the
 * active chain is never ambiguous — on mainnet a swipe would spend real
 * money.
 */
const NETWORK_STYLE: Record<FlickyNetwork, { dot: string; text: string }> = {
  testnet: { dot: "bg-[#7ec8e3]", text: "text-[#7ec8e3]" },
  mainnet: { dot: "bg-[#f5a524]", text: "text-[#f5a524]" },
}

const NETWORK_BLURB: Record<FlickyNetwork, string> = {
  testnet: "free test coins. full game.",
  mainnet: "real funds. duels not live yet.",
}

/**
 * Network picker for the settings menu. Selecting a different network
 * persists the choice and reloads the page — `CONFIG`, the dApp Kit client,
 * and the WS socket are all pinned per page load (see `lib/network.ts`).
 *
 * Renders nothing when the deploy only offers one network
 * (`VITE_SUI_NETWORKS=testnet`), so a single-network build has no dead
 * control in its menu.
 */
export function NetworkSetting() {
  if (AVAILABLE_NETWORKS.length < 2) return null

  return (
    <div className="flex flex-col gap-2.5 rounded-2xl bg-black/25 p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm tracking-[0.18em] text-white/70 uppercase">
          <img
            src="/icons/world.png"
            alt=""
            aria-hidden
            className="size-4 [image-rendering:pixelated]"
          />
          network
        </span>
        <span className="text-xs text-white/45">reloads on switch</span>
      </div>

      <div className="flex flex-col gap-2">
        {AVAILABLE_NETWORKS.map((net) => (
          <NetworkOption
            key={net}
            network={net}
            active={net === ACTIVE_NETWORK}
            onSelect={() => setNetwork(net)}
          />
        ))}
      </div>
    </div>
  )
}

function NetworkOption({
  network,
  active,
  onSelect,
}: {
  network: FlickyNetwork
  active: boolean
  onSelect: () => void
}) {
  const style = NETWORK_STYLE[network]

  // The active row isn't a target — `.pixel-tile:hover` still matches a
  // disabled button, so without `no-hover` the current network lights up
  // with the white selection outline as if it were clickable. Hover styling
  // is left entirely to `.pixel-tile`; layering an opacity transition on top
  // fought with its brightness filter and read as a flicker.
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={active}
      aria-current={active ? "true" : undefined}
      className={`pixel-tile flex w-full items-center gap-2.5 px-3 py-2.5 text-left ${
        active
          ? "no-hover cursor-default bg-white/[0.07]"
          : "cursor-pointer bg-transparent"
      }`}
    >
      <span
        aria-hidden
        className={`size-2.5 shrink-0 rounded-full ${style.dot} ${
          active ? "" : "opacity-45"
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className={`text-base tracking-[0.14em] uppercase ${style.text}`}>
          {network}
        </div>
        <div className="truncate text-[13px] text-white/55">
          {NETWORK_BLURB[network]}
        </div>
      </div>
      {active && (
        <span className="shrink-0 text-[11px] tracking-[0.12em] text-white/45 uppercase">
          active
        </span>
      )}
    </button>
  )
}
