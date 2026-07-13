/**
 * Server-side mirror of the web avatar-icon id set
 * (apps/web/src/lib/avatar-icons.ts). Used to validate `POST /avatar` so
 * only real icon ids ever reach `player_profile` — no arbitrary data can
 * be stored. Keep the two lists in lockstep (same mirror discipline as
 * predict.ts ↔ web funding.ts); `avatar-icons.test.ts` asserts the count
 * so drift is caught.
 */
export const AVATAR_ICON_IDS: ReadonlySet<string> = new Set([
  "apple",
  "orange",
  "cherries",
  "pear",
  "banana",
  "strawberry",
  "blueberries",
  "grapes",
  "peach",
  "avocado",
  "lemon",
  "watermelon",
  "coconut",
  "raspberry",
  "blackberry",
  "acorn",
  "mushroom-brown",
  "mushroom-red",
  "toadstool",
  "mushroom-yellow",
  "steak-raw",
  "steak",
  "drumstick-raw",
  "drumstick",
  "bacon-raw",
  "bacon",
  "ham",
  "chicken-raw",
  "roast-leg",
  "roast-chicken",
  "egg",
  "fried-egg",
  "fish-raw",
  "fish",
  "fish-blue",
  "shrimp",
  "crab",
  "wheat",
  "milk",
  "garlic",
  "sugar",
  "bread",
  "salt",
  "pepper",
])

export function isValidIconId(id: unknown): id is string {
  return typeof id === "string" && AVATAR_ICON_IDS.has(id)
}
