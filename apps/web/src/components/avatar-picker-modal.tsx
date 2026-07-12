import { createPortal } from "react-dom"
import {
  AVATAR_CATEGORY_LABELS,
  AVATAR_ICONS,
  iconSrc,
  type AvatarCategory,
} from "@/lib/avatar-icons"
import { getAvatarIcon, setAvatarIcon } from "@/lib/avatar-store"
import { PlayerAvatar } from "@/components/player-avatar"

const CATEGORY_ORDER: AvatarCategory[] = [
  "fruit",
  "mushroom",
  "meat",
  "seafood",
  "pantry",
]

/**
 * Grid picker for the 44 food avatar icons. Opened from the profile
 * "change avatar" button. Selecting an icon persists it (per address) and
 * closes; "Gradient only" clears the selection.
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
  if (!open) return null
  const current = getAvatarIcon(address)

  const choose = (id: string | null) => {
    setAvatarIcon(address, id)
    onClose()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-sm flex-col gap-4 overflow-hidden rounded-xl bg-[#1b2548] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <PlayerAvatar address={address} size={56} />
          <div className="flex-1">
            <p className="text-sm tracking-wider text-white">
              Choose your icon
            </p>
            <button
              type="button"
              onClick={() => choose(null)}
              className="text-xs text-white/55 underline-offset-2 hover:text-white hover:underline"
            >
              Gradient only
            </button>
          </div>
          <button
            type="button"
            aria-label="close"
            onClick={onClose}
            className="px-1 text-white/55 hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto pr-1">
          {CATEGORY_ORDER.map((cat) => (
            <section key={cat} className="flex flex-col gap-2">
              <h3 className="text-[10px] tracking-wider text-white/45 uppercase">
                {AVATAR_CATEGORY_LABELS[cat]}
              </h3>
              <div className="grid grid-cols-5 gap-2">
                {AVATAR_ICONS.filter((i) => i.category === cat).map((icon) => (
                  <button
                    key={icon.id}
                    type="button"
                    aria-label={icon.id}
                    onClick={() => choose(icon.id)}
                    className={`grid aspect-square place-items-center rounded-lg bg-white/5 p-1.5 transition-colors hover:bg-white/15 ${
                      current === icon.id ? "ring-2 ring-[#4094fb]" : ""
                    }`}
                  >
                    <img
                      src={iconSrc(icon.id)}
                      alt=""
                      className="size-full [image-rendering:pixelated]"
                    />
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
