/**
 * Address-seeded 2-color gradient — the identity fill behind every player
 * avatar. Deterministic: the first 8 hex chars of the address map to two
 * HSL hues, so the same address always yields the same gradient. Passing
 * no address gives a neutral placeholder.
 */
export function addressToGradient(address?: string): string {
  if (!address) {
    return "linear-gradient(135deg, #94a3b8, #475569)"
  }
  const hex = address.toLowerCase().replace(/^0x/, "")
  const h1 = parseInt(hex.slice(0, 4) || "0", 16) % 360
  const h2 = parseInt(hex.slice(4, 8) || "0", 16) % 360
  return `linear-gradient(135deg, hsl(${h1}, 78%, 60%), hsl(${h2}, 82%, 50%))`
}
