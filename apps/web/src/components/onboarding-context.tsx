/**
 * OnboardingContext — global state for the spotlight tutorial system.
 *
 * Wraps the game layout so any child can start/advance/skip a tour without
 * prop-drilling. The tour is persisted via localStorage so a player only
 * sees it once. Steps can specify a `route` to auto-navigate across pages.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useLocation, useNavigate } from "react-router"
import { TOURS, type TourId, type TourStep } from "@/lib/tour-steps"

interface OnboardingState {
  /** Currently active tour, or null if nothing is playing. */
  tourId: TourId | null
  /** Current step index within the active tour. */
  stepIndex: number
  /** The step definitions for the active tour (empty when idle). */
  steps: TourStep[]
  /** Whether a tour is currently active. */
  active: boolean
  /** Start a tour if it hasn't been seen yet. */
  startTour: (id: TourId) => void
  /** Force-start a tour even if it was already seen (replay). */
  replayTour: (id: TourId) => void
  /** Advance to the next step, or finish if this was the last. */
  next: () => void
  /** Skip / dismiss the current tour entirely. */
  skip: () => void
  /** Check whether a specific tour has been completed before. */
  hasSeen: (id: TourId) => boolean
}

const STORAGE_PREFIX = "onboarding_seen_"

function seenKey(id: TourId): string {
  return `${STORAGE_PREFIX}${id}`
}

const OnboardingContext = createContext<OnboardingState | null>(null)

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [tourId, setTourId] = useState<TourId | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const navigate = useNavigate()
  const location = useLocation()
  /** Tracks whether we just navigated for a tour step (to avoid re-triggering). */
  const navigatedForStep = useRef(false)
  /** Use a ref for tourId so callbacks don't depend on tourId state
   *  (avoids identity churn that cancels timers in consumer effects). */
  const tourIdRef = useRef<TourId | null>(null)

  const steps = tourId ? TOURS[tourId] : []
  const active = tourId !== null && stepIndex < steps.length

  const hasSeen = useCallback((id: TourId) => {
    return localStorage.getItem(seenKey(id)) === "true"
  }, [])

  const markSeen = useCallback((id: TourId) => {
    localStorage.setItem(seenKey(id), "true")
  }, [])

  // Keep tourIdRef in sync.
  useEffect(() => {
    tourIdRef.current = tourId
  }, [tourId])

  const startTour = useCallback(
    (id: TourId) => {
      if (hasSeen(id)) return
      // Don't interrupt a running tour.
      if (tourIdRef.current !== null) return
      tourIdRef.current = id
      setTourId(id)
      setStepIndex(0)
    },
    [hasSeen] // No tourId dep → stable identity → won't cancel consumer timers
  )

  const replayTour = useCallback((id: TourId) => {
    tourIdRef.current = id
    setTourId(id)
    setStepIndex(0)
  }, [])

  /** Complete the tour and mark it as seen (user finished or explicitly skipped). */
  const finish = useCallback(() => {
    if (tourIdRef.current) markSeen(tourIdRef.current)
    tourIdRef.current = null
    setTourId(null)
    setStepIndex(0)
  }, [markSeen])

  /** Silently cancel the tour WITHOUT marking it as seen.
   *  Used by the auto-dismiss logic when elements can't be found. */
  const cancel = useCallback(() => {
    tourIdRef.current = null
    setTourId(null)
    setStepIndex(0)
  }, [])

  const next = useCallback(() => {
    if (!active) return
    if (stepIndex + 1 >= steps.length) {
      finish()
    } else {
      const nextStep = steps[stepIndex + 1]
      // If the next step is on a different route, navigate there first.
      if (nextStep?.route && nextStep.route !== location.pathname) {
        navigatedForStep.current = true
        navigate(nextStep.route)
      }
      setStepIndex((i) => i + 1)
    }
  }, [active, stepIndex, steps, finish, location.pathname, navigate])

  const skip = useCallback(() => {
    finish()
  }, [finish])

  // When the tour is active and the current step specifies a route,
  // navigate to that route if we're not already there.
  useEffect(() => {
    if (!active) return
    const step = steps[stepIndex]
    if (!step?.route) return

    if (step.route !== location.pathname) {
      // Avoid double-navigation if `next()` already navigated.
      if (!navigatedForStep.current) {
        navigate(step.route)
      }
    }
    navigatedForStep.current = false
  }, [active, steps, stepIndex, location.pathname, navigate])

  // If the target element for the current step doesn't exist in the DOM,
  // poll until it appears. If it never shows up, CANCEL the tour without
  // marking it as seen — so the player will see it on their next visit.
  useEffect(() => {
    if (!active) return
    const step = steps[stepIndex]
    if (!step) return
    // If it's already in the DOM, nothing to do.
    if (document.getElementById(step.targetId)) return

    let attempts = 0
    const MAX_ATTEMPTS = 12 // 12 × 400ms = 4.8s total patience
    const interval = setInterval(() => {
      attempts++
      const el = document.getElementById(step.targetId)
      if (el) {
        clearInterval(interval)
        return
      }
      if (attempts >= MAX_ATTEMPTS) {
        clearInterval(interval)
        // Skip this step, or cancel the tour if it's the last step.
        // Use `cancel` (not `finish`) so the tour is NOT marked as "seen"
        // — the user never actually saw it.
        if (stepIndex + 1 < steps.length) {
          setStepIndex((i) => i + 1)
        } else {
          cancel()
        }
      }
    }, 400)
    return () => clearInterval(interval)
  }, [active, steps, stepIndex, cancel, steps.length])

  return (
    <OnboardingContext.Provider
      value={{
        tourId,
        stepIndex,
        steps,
        active,
        startTour,
        replayTour,
        next,
        skip,
        hasSeen,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  )
}

export function useOnboardingContext(): OnboardingState {
  const ctx = useContext(OnboardingContext)
  if (!ctx) {
    throw new Error(
      "useOnboardingContext must be used within OnboardingProvider"
    )
  }
  return ctx
}
