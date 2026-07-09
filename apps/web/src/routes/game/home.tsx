import { useCurrentAccount } from "@mysten/dapp-kit-react"
import { MyMatchTile } from "@/components/my-match-tile"
import { PlayerHeroCard } from "@/components/player-hero-card"

export default function GameHome() {
  const account = useCurrentAccount()
  const address = account?.address
  return (
    <div className="relative isolate flex min-h-full flex-col items-center gap-4 px-4 py-6">
      {/* Full-page lobby background. Top fades FROM the header color
          (#151837) so the boundary with the FrameHeader is seamless;
          bottom fades INTO navy (#1b2548) so cards don't fight the
          busy art at the page edge. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-cover bg-top bg-no-repeat [image-rendering:pixelated]"
        style={{
          backgroundImage:
            "linear-gradient(180deg, #151837 0%, rgba(21,24,55,0) 18%, rgba(27,37,72,0) 70%, #1b2548 100%), url(/assets/home/home-bg.png)",
        }}
      />
      <h1 className="text-4xl tracking-[0.2em] uppercase">home</h1>
      {address && <PlayerHeroCard address={address} />}
      <MyMatchTile />
    </div>
  )
}
