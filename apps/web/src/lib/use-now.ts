import { useEffect, useState } from "react"

/**
 * Re-renders on an interval, returning the current epoch ms. The single
 * shared 1-Hz ticker for live countdowns / clocks (season countdown, swipe
 * window, match clock) instead of each component re-implementing the
 * `setInterval(() => setNow(Date.now()), …)` dance.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
