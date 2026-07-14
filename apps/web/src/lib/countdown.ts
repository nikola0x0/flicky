/**
 * Format a remaining duration (ms) as a compact, days-aware countdown:
 *   ≥ 1 day  → "18d 4h"
 *   ≥ 1 hour → "4h 32m"
 *   < 1 hour → "12:07"  (mm:ss)
 *   ≤ 0      → "ended"
 */
export function fmtCountdown(ms: number): string {
  if (ms <= 0) return "ended"
  const totalSec = Math.floor(ms / 1000)
  const d = Math.floor(totalSec / 86_400)
  const h = Math.floor((totalSec % 86_400) / 3_600)
  const m = Math.floor((totalSec % 3_600) / 60)
  const s = totalSec % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}:${String(s).padStart(2, "0")}`
}
