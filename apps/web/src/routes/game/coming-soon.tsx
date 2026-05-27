/**
 * Placeholder for routes that are scaffolded in the nav but not yet
 * implemented (rank, inventory). Renders centered "coming soon" copy
 * inside the game frame's <Outlet />.
 */
export default function ComingSoon() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <img
        src="/icons/clear.png"
        alt=""
        aria-hidden
        className="size-16 [image-rendering:pixelated]"
      />
      <p className="text-xl tracking-[0.2em] text-white uppercase">
        coming soon
      </p>
      <p className="text-base text-white/55">check back later</p>
    </div>
  )
}
