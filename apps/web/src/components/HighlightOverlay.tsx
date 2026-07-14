/**
 * SpotlightOverlay — renders **inside the DeviceFrame** (no portal) so the
 * dark backdrop + tooltip stay within the game's visible area on desktop.
 *
 * Uses `clip-path: polygon(...)` to carve a rectangular hole around the
 * target element, so the highlighted control remains fully visible and
 * interactive while everything else is dimmed.
 *
 * All coordinates are relative to the DeviceFrame's bounding box, not the
 * full browser viewport, so the spotlight aligns correctly when the frame
 * is `zoom`-scaled and centered on desktop.
 */
import { useEffect, useState, useCallback, useRef } from "react"
import { useLocation } from "react-router"
import { useOnboardingContext } from "@/components/onboarding-context"

/** Padding around the target element for the spotlight cutout. */
const PAD = 8
/** Gap between the target and the tooltip. */
const TOOLTIP_GAP = 12
/**
 * How long to wait after a route change before measuring elements.
 * Must exceed the route-swipe animation duration (260ms in globals.css).
 */
const ROUTE_SETTLE_MS = 380

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

export function SpotlightOverlay() {
  const { active, steps, stepIndex, next, skip } = useOnboardingContext()
  const step = active ? steps[stepIndex] : null
  const [rect, setRect] = useState<Rect | null>(null)
  const rafRef = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const location = useLocation()

  /**
   * Track whether the page is "settling" after a route transition.
   * During this period, we hide the overlay to avoid showing it at
   * stale/mid-animation coordinates.
   */
  const [settling, setSettling] = useState(false)
  const prevPathRef = useRef(location.pathname)

  useEffect(() => {
    if (location.pathname !== prevPathRef.current) {
      prevPathRef.current = location.pathname
      // Route changed — enter settling mode.
      setSettling(true)
      setRect(null)
      const t = setTimeout(() => setSettling(false), ROUTE_SETTLE_MS)
      return () => clearTimeout(t)
    }
  }, [location.pathname])

  /** Get the DeviceFrame container's bounding rect. */
  const getFrameRect = useCallback((): DOMRect | null => {
    const root = rootRef.current
    if (!root) return null
    const frame = root.closest(".pixel-frame") ?? root.parentElement
    return frame?.getBoundingClientRect() ?? null
  }, [])

  /** Get the CSS zoom factor applied to the pixel-frame on desktop. */
  const getZoom = useCallback((): number => {
    const frame = rootRef.current?.closest(".pixel-frame") as HTMLElement | null
    return frame ? parseFloat(frame.style.zoom || "1") : 1
  }, [])

  /** Measure the target element relative to the DeviceFrame container. */
  const measure = useCallback(() => {
    if (!step) {
      setRect(null)
      return
    }
    const el = document.getElementById(step.targetId)
    if (!el) {
      setRect(null)
      return
    }
    const elRect = el.getBoundingClientRect()
    const frameRect = getFrameRect()

    if (frameRect) {
      const zoom = getZoom()
      setRect({
        top: (elRect.top - frameRect.top) / zoom,
        left: (elRect.left - frameRect.left) / zoom,
        width: elRect.width / zoom,
        height: elRect.height / zoom,
      })
    } else {
      // Mobile fallback — frame IS the viewport, no zoom.
      setRect({
        top: elRect.top,
        left: elRect.left,
        width: elRect.width,
        height: elRect.height,
      })
    }
  }, [step, getFrameRect, getZoom])

  // Measure on step change, but wait if the page is settling.
  useEffect(() => {
    if (!step || settling) return

    // Initial measure — use a generous delay to catch late-mounting elements.
    const t = setTimeout(measure, 80)

    // Re-measure on scroll or resize.
    const onReflow = () => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(measure)
    }
    window.addEventListener("scroll", onReflow, true)
    window.addEventListener("resize", onReflow)

    // ResizeObserver on the target itself.
    const el = document.getElementById(step.targetId)
    let ro: ResizeObserver | undefined
    if (el) {
      ro = new ResizeObserver(onReflow)
      ro.observe(el)
    }

    return () => {
      clearTimeout(t)
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener("scroll", onReflow, true)
      window.removeEventListener("resize", onReflow)
      ro?.disconnect()
    }
  }, [step, measure, settling])

  // When settling finishes, force a fresh measure.
  useEffect(() => {
    if (!settling && step) {
      const t = setTimeout(measure, 50)
      return () => clearTimeout(t)
    }
  }, [settling, step, measure])

  // Scroll target into view when the step changes.
  useEffect(() => {
    if (!step || settling) return
    const el = document.getElementById(step.targetId)
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }, [step, settling])

  // Don't render while settling (route transition in progress) or no data.
  if (!active || !step || !rect || settling) return null

  const totalSteps = steps.length
  const placement = step.placement ?? "bottom"

  // Get frame dimensions for tooltip positioning.
  const frameRect = getFrameRect()
  const zoom = getZoom()
  const frameW = frameRect ? frameRect.width / zoom : window.innerWidth
  const frameH = frameRect ? frameRect.height / zoom : window.innerHeight

  const tt = computeTooltipPos(rect, placement, frameW, frameH)

  return (
    <div ref={rootRef} className="spotlight-root" aria-hidden>
      {/* Transparent click-to-skip surface */}
      <div className="spotlight-backdrop" onClick={skip} />

      {/* Glow ring around the target */}
      <div
        className="spotlight-ring"
        style={{
          top: rect.top - PAD,
          left: rect.left - PAD,
          width: rect.width + PAD * 2,
          height: rect.height + PAD * 2,
        }}
      />

      {/* Tooltip */}
      <div
        className="spotlight-tooltip"
        style={{
          top: tt.top,
          left: tt.left,
          maxWidth: tt.maxWidth,
          transform: tt.transform,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="spotlight-tooltip-text">{step.description}</p>

        {/* Step dots */}
        <div className="spotlight-dots">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <span
              key={i}
              className={`spotlight-dot ${i === stepIndex ? "active" : ""}`}
            />
          ))}
        </div>

        {/* Actions */}
        <div className="spotlight-actions">
          <button type="button" onClick={skip} className="spotlight-btn skip">
            Skip
          </button>
          <button type="button" onClick={next} className="spotlight-btn next">
            {stepIndex + 1 >= totalSteps ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Compute tooltip top/left/transform based on placement and frame bounds. */
function computeTooltipPos(
  r: Rect,
  placement: "top" | "bottom" | "left" | "right",
  frameW: number,
  frameH: number
): { top: number; left: number; maxWidth: number; transform: string } {
  const tooltipWidth = Math.min(280, frameW - 24)

  let top: number
  let left: number
  let transform = "none"

  switch (placement) {
    case "top":
      // Position the tooltip's BOTTOM edge above the target.
      // `top` points to just above the target; translateY(-100%) lifts the
      // tooltip so its bottom edge sits at that anchor point.
      top = r.top - PAD - TOOLTIP_GAP
      left = r.left + r.width / 2 - tooltipWidth / 2
      transform = "translateY(-100%)"
      // If that would push the tooltip above the frame, flip to bottom.
      // (We can't know exact height, but if the anchor is near the top this
      // is a reasonable heuristic — a 140px tooltip needs anchor > 148.)
      if (top < 148) {
        top = r.top + r.height + PAD + TOOLTIP_GAP
        transform = "none"
      }
      break
    case "bottom":
      top = r.top + r.height + PAD + TOOLTIP_GAP
      left = r.left + r.width / 2 - tooltipWidth / 2
      // If that would push the tooltip below the frame, flip to top.
      if (top > frameH - 148) {
        top = r.top - PAD - TOOLTIP_GAP
        transform = "translateY(-100%)"
      }
      break
    case "left":
      top = r.top + r.height / 2
      left = r.left - PAD - TOOLTIP_GAP - tooltipWidth
      transform = "translateY(-50%)"
      if (left < 8) {
        left = r.left + r.width + PAD + TOOLTIP_GAP
      }
      break
    case "right":
      top = r.top + r.height / 2
      left = r.left + r.width + PAD + TOOLTIP_GAP
      transform = "translateY(-50%)"
      break
  }

  // Clamp horizontally within the frame.
  left = Math.max(12, Math.min(left, frameW - tooltipWidth - 12))

  return { top, left, maxWidth: tooltipWidth, transform }
}
