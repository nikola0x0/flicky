import type { ReactNode } from "react"
import { DESIGN_H, DESIGN_W, useDeviceFit } from "@/hooks/use-device-fit"

/**
 * Shell for the game UI, shared by the game routes and the profile screen.
 *
 *   - Phones: the device is the screen — render full-bleed (no pixel frame,
 *     no checker border), since simulating a phone bezel on a phone is noise.
 *   - Larger screens: show the pixel-cabinet device centered on the animated
 *     checker, uniformly `zoom`-scaled to fit with margin. `zoom` scales the
 *     content AND the layout box, so flex-centering stays correct and the whole
 *     game grows/shrinks together (no tiny island on 4K, no edge-to-edge fill
 *     on a laptop) without per-component responsive work.
 *
 * `className` carries the frame's own background (e.g. the PvP checker-dark).
 * Render modals/overlays as siblings of <DeviceFrame>, never children, so the
 * desktop `zoom` doesn't scale full-screen overlays.
 */
export function DeviceFrame({
  className = "",
  children,
}: {
  className?: string
  children: ReactNode
}) {
  const { mode, scale } = useDeviceFit()

  if (mode === "mobile") {
    return (
      <div
        className={`relative isolate flex h-dvh w-full flex-col overflow-hidden font-pixel text-white ${className}`}
      >
        {children}
      </div>
    )
  }

  return (
    <div className="bg-checker flex min-h-dvh w-full items-center justify-center overflow-hidden">
      <div
        className={`pixel-frame relative isolate flex flex-col overflow-hidden rounded-3xl font-pixel text-white ${className}`}
        style={{ width: DESIGN_W, height: DESIGN_H, zoom: scale }}
      >
        {children}
      </div>
    </div>
  )
}
