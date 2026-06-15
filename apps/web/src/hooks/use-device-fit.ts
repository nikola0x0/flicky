import { useEffect, useState } from "react"

/**
 * Sizing strategy for the mobile-frame game shell.
 *
 *   - "mobile"  → the device IS the screen: render full-bleed, no frame.
 *   - "desktop" → show the pixel "device" centered on the checker, uniformly
 *                 zoomed (content and all) to fit the viewport with margin, so
 *                 the whole game scales like browser zoom instead of sitting
 *                 tiny on 2K/4K or filling a laptop edge-to-edge.
 */
export interface DeviceFit {
  mode: "mobile" | "desktop"
  scale: number
}

// Design size the in-frame UI is authored against (must match DeviceFrame).
export const DESIGN_W = 440
export const DESIGN_H = 900

// Below this viewport width the device is the screen — go full-bleed.
const MOBILE_MAX_W = 700
// Breathing room around the simulated device on desktop.
const MARGIN = 32
// Keep the device from getting cramped or absurdly large.
const MIN_SCALE = 0.55
const MAX_SCALE = 2.25

function measure(): DeviceFit {
  if (typeof window === "undefined") return { mode: "desktop", scale: 1 }
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (vw < MOBILE_MAX_W) return { mode: "mobile", scale: 1 }
  const raw = Math.min(
    (vw - MARGIN * 2) / DESIGN_W,
    (vh - MARGIN * 2) / DESIGN_H,
  )
  return { mode: "desktop", scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, raw)) }
}

export function useDeviceFit(): DeviceFit {
  const [fit, setFit] = useState<DeviceFit>(measure)
  useEffect(() => {
    const onResize = () => setFit(measure())
    onResize()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  return fit
}
