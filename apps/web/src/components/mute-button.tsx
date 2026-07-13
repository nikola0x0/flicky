import { PixelButton } from "@/components/pixel-button"
import { toggleMuted, useMuted } from "@/lib/sound"

/**
 * Header speaker toggle — one tap kills/restores ALL game audio (sfx +
 * music). Persists across sessions via lib/sound's localStorage flag.
 * Mirrors <MenuButton>'s square bordered-pixel look.
 */
export function MuteButton({ className = "" }: { className?: string }) {
  const muted = useMuted()
  return (
    <PixelButton
      variant="bordered"
      aria-label={muted ? "unmute sounds" : "mute sounds"}
      aria-pressed={muted}
      onClick={toggleMuted}
      className={`size-10 !p-0 ${className}`}
    >
      <span className="relative grid place-items-center">
        <img
          src="/icons/sound.png"
          alt=""
          aria-hidden
          className={`size-6 [image-rendering:pixelated] ${
            muted ? "opacity-40 grayscale" : ""
          }`}
        />
        {muted && (
          <span
            aria-hidden
            className="absolute h-[3px] w-7 -rotate-45 bg-rose-400 shadow-[0_1px_0_#000]"
          />
        )}
      </span>
    </PixelButton>
  )
}
