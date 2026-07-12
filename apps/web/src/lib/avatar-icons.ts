/**
 * Avatar icon manifest — the 44 pixel-art food tiles sliced from the
 * sprite sheets in public/assets/avatar_icons/ (see
 * apps/web/scripts/slice-avatars.py). Each tile is a transparent
 * 160x160 PNG served from /avatars/<id>.png and rendered centered on
 * the gradient PlayerAvatar. Order here is the display order in the
 * picker.
 */
export type AvatarCategory =
  | "fruit"
  | "mushroom"
  | "meat"
  | "seafood"
  | "pantry"

export type AvatarIcon = {
  id: string
  category: AvatarCategory
}

export const AVATAR_ICONS: readonly AvatarIcon[] = [
  { id: "apple", category: "fruit" },
  { id: "orange", category: "fruit" },
  { id: "cherries", category: "fruit" },
  { id: "pear", category: "fruit" },
  { id: "banana", category: "fruit" },
  { id: "strawberry", category: "fruit" },
  { id: "blueberries", category: "fruit" },
  { id: "grapes", category: "fruit" },
  { id: "peach", category: "fruit" },
  { id: "avocado", category: "fruit" },
  { id: "lemon", category: "fruit" },
  { id: "watermelon", category: "fruit" },
  { id: "coconut", category: "fruit" },
  { id: "raspberry", category: "fruit" },
  { id: "blackberry", category: "fruit" },
  { id: "acorn", category: "fruit" },
  { id: "mushroom-brown", category: "mushroom" },
  { id: "mushroom-red", category: "mushroom" },
  { id: "toadstool", category: "mushroom" },
  { id: "mushroom-yellow", category: "mushroom" },
  { id: "steak-raw", category: "meat" },
  { id: "steak", category: "meat" },
  { id: "drumstick-raw", category: "meat" },
  { id: "drumstick", category: "meat" },
  { id: "bacon-raw", category: "meat" },
  { id: "bacon", category: "meat" },
  { id: "ham", category: "meat" },
  { id: "chicken-raw", category: "meat" },
  { id: "roast-leg", category: "meat" },
  { id: "roast-chicken", category: "meat" },
  { id: "egg", category: "meat" },
  { id: "fried-egg", category: "meat" },
  { id: "fish-raw", category: "seafood" },
  { id: "fish", category: "seafood" },
  { id: "fish-blue", category: "seafood" },
  { id: "shrimp", category: "seafood" },
  { id: "crab", category: "seafood" },
  { id: "wheat", category: "pantry" },
  { id: "milk", category: "pantry" },
  { id: "garlic", category: "pantry" },
  { id: "sugar", category: "pantry" },
  { id: "bread", category: "pantry" },
  { id: "salt", category: "pantry" },
  { id: "pepper", category: "pantry" },
]

export const AVATAR_CATEGORY_LABELS: Record<AvatarCategory, string> = {
  fruit: "Fruit",
  mushroom: "Mushrooms",
  meat: "Meat",
  seafood: "Seafood",
  pantry: "Pantry",
}

const ICON_IDS = new Set(AVATAR_ICONS.map((i) => i.id))

export function isValidIconId(id: unknown): id is string {
  return typeof id === "string" && ICON_IDS.has(id)
}

export function iconSrc(id: string): string {
  return `/avatars/${id}.png`
}
