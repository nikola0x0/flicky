import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { AVATAR_ICONS, iconSrc } from "@/lib/avatar-icons"
import { addressToGradient } from "@/lib/avatar-gradient"
import { getAvatarIcon, setAvatarIcon } from "@/lib/avatar-store"

/**
 * Grid picker for the 44 food avatar icons. Opened from the profile
 * "change avatar" button. The first tile is the "gradient only" choice —
 * your bare gradient with an ✕, which removes the icon. Selecting any
 * tile persists it and closes. Styled to match the game's modals
 * (pixel-frame shell + font-pixel + hidden scrollbar with a bottom fade).
 */
export function AvatarPickerModal({
  open,
  address,
  onClose,
}: {
  open: boolean
  address: string
  onClose: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Whether there's more content below the fold — drives the bottom fade.
  const [hasMore, setHasMore] = useState(false)

  const measure = () => {
    const el = scrollRef.current
    if (!el) return
    setHasMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4)
  }

  // Escape-to-close + body-scroll lock, matching the game's other modals.
  // Also take a first fade measurement once the grid has laid out.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    const raf = requestAnimationFrame(measure)
    document.body.style.overflow = "hidden"
    window.addEventListener("keydown", onKey)
    return () => {
      cancelAnimationFrame(raf)
      document.body.style.overflow = ""
      window.removeEventListener("keydown", onKey)
    }
  }, [open, onClose])

  if (!open) return null
  const current = getAvatarIcon(address)
  const gradient = addressToGradient(address)

  const choose = (id: string | null) => {
    setAvatarIcon(address, id)
    onClose()
  }

  const tileBase =
    "grid aspect-square place-items-center rounded-md p-1.5 transition-colors"
  // Selection is a chunky INSET border (drawn inside the tile) so it reads
  // as a pixel border and is never clipped by the scroll container at the
  // grid edges. A black inner ring + blue outer gives the pixel-art look.
  const tileSelected =
    "bg-[#4094fb]/25 shadow-[inset_0_0_0_2px_#0b1228,inset_0_0_0_5px_#7eb6ff]"
  const tileIdle = "bg-white/5 hover:bg-white/15"

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="avatar-title"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="pixel-frame relative flex max-h-[80vh] w-full max-w-sm flex-col rounded-3xl bg-[#1b2548] font-pixel text-white"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          className="absolute top-3 right-3 z-10 grid size-8 place-items-center text-xl text-white/55 hover:text-white"
        >
          ✕
        </button>

        <header className="shrink-0 px-6 pt-8 pb-4 text-center">
          <h2 id="avatar-title" className="text-3xl tracking-[0.16em] uppercase">
            choose icon
          </h2>
        </header>

        {/* Scroll body: scrollbar hidden (game convention) with a bottom
            fade that clears once you reach the end. */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            onScroll={measure}
            className="grid h-full grid-cols-5 gap-2.5 overflow-y-auto px-6 pt-1 pb-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {/* Gradient-only / remove-icon tile */}
            <button
              type="button"
              aria-label="gradient only (remove icon)"
              onClick={() => choose(null)}
              className={`${tileBase} ${current === null ? tileSelected : tileIdle}`}
            >
              <span className="relative size-full">
                <span
                  aria-hidden
                  className="pixel-avatar absolute inset-0"
                  style={{ background: gradient }}
                />
                <span className="absolute inset-0 grid place-items-center">
                  <img
                    src="/icons/delete.png"
                    alt=""
                    aria-hidden
                    className="w-1/2 [image-rendering:pixelated] [filter:drop-shadow(0_1px_1px_rgba(0,0,0,0.7))]"
                  />
                </span>
              </span>
            </button>

            {AVATAR_ICONS.map((icon) => (
              <button
                key={icon.id}
                type="button"
                aria-label={icon.id}
                onClick={() => choose(icon.id)}
                className={`${tileBase} ${current === icon.id ? tileSelected : tileIdle}`}
              >
                <img
                  src={iconSrc(icon.id)}
                  alt=""
                  className="size-full [image-rendering:pixelated]"
                />
              </button>
            ))}
          </div>
          <div
            aria-hidden
            className={`pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-3xl bg-gradient-to-t from-[#1b2548] to-transparent transition-opacity duration-200 ${
              hasMore ? "opacity-100" : "opacity-0"
            }`}
          />
        </div>
      </div>
    </div>,
    document.body
  )
}
