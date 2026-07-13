import { useEffect, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router"
import { useModalSfx } from "@/lib/sound"

type ModeInfo = {
  id: string
  title: string
  tagline: string
  icon: string
  banner: string
  to: string
  headerStyle: CSSProperties
}

const MODES: ModeInfo[] = [
  {
    id: "practice",
    title: "Practice",
    tagline: "Familiarize yourself with bots. No pressure.",
    icon: "/icons/joystick.png",
    banner: "/banners/mode-practice.png",
    to: "/game/practice",
    headerStyle: { backgroundColor: "#3a8a4a" },
  },
]

export interface ModeModalProps {
  open: boolean
  onClose: () => void
}

export function ModeModal({ open, onClose }: ModeModalProps) {
  useModalSfx(open)
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.body.style.overflow = "hidden"
    window.addEventListener("keydown", handleKey)
    return () => {
      document.body.style.overflow = ""
      window.removeEventListener("keydown", handleKey)
    }
  }, [open, onClose])

  if (!open) return null

  const jumpTo = (to: string) => {
    onClose()
    navigate(to)
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mode-title"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="pixel-frame relative w-full max-w-sm rounded-3xl bg-[#1b2548] font-pixel text-white"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          className="absolute top-3 right-3 z-10 grid size-7 place-items-center text-2xl text-white/55 hover:text-white"
        >
          ✕
        </button>

        <header className="px-6 pt-7 pb-3 text-center">
          <h2 id="mode-title" className="text-2xl tracking-[0.18em] uppercase">
            modes
          </h2>
        </header>

        <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-5 pb-6">
          {MODES.map((m) => (
            <ModeCard key={m.id} info={m} onSelect={() => jumpTo(m.to)} />
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}

function ModeCard({
  info,
  onSelect,
}: {
  info: ModeInfo
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="pixel-tile block w-full overflow-hidden text-left"
    >
      <div
        className="flex items-center gap-3 px-3 py-2.5"
        style={info.headerStyle}
      >
        <img
          src={info.icon}
          alt=""
          aria-hidden
          className="size-7 shrink-0 [image-rendering:pixelated]"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg tracking-[0.14em] text-white uppercase">
            {info.title}
          </div>
          <div className="truncate text-[14px] text-white/80">
            {info.tagline}
          </div>
        </div>
      </div>

      <div className="relative">
        <img
          src={info.banner}
          alt=""
          className="block aspect-[16/7] w-full object-cover [image-rendering:pixelated]"
        />
      </div>
    </button>
  )
}
