#!/usr/bin/env python3
"""One-time: slice the 160x160-grid food sprite sheets into individual
transparent PNG tiles for the avatar picker.

Requires Pillow (`pip install Pillow`). macOS `sips --cropOffset` proved
unreliable for a clean grid crop (it center-cropped the all-zero-offset
tile and mangled a boundary tile), so we crop deterministically with PIL.
"""
import os

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))  # apps/web
SRC = os.path.join(ROOT, "public", "assets", "avatar_icons")
OUT = os.path.join(ROOT, "public", "avatars")
TILE = 160

# (sheet filename, cols, rows, ids in reading order left->right, top->bottom)
SHEETS = [
    (
        "Foodstuffs-big.png", 5, 4,
        [
            "apple", "orange", "cherries", "pear", "banana",
            "strawberry", "blueberries", "grapes", "mushroom-brown", "mushroom-red",
            "steak-raw", "drumstick-raw", "egg", "bacon-raw", "fish-raw",
            "steak", "drumstick", "fried-egg", "bacon", "fish",
        ],
    ),
    (
        "Foodstuffs2-big.png", 5, 4,
        [
            "peach", "avocado", "lemon", "watermelon", "coconut",
            "raspberry", "blackberry", "acorn", "toadstool", "mushroom-yellow",
            "ham", "chicken-raw", "wheat", "shrimp", "fish-blue",
            "roast-leg", "roast-chicken", "milk", "crab", "garlic",
        ],
    ),
    (
        "Extra-Stuffbig.png", 2, 2,
        [
            "sugar", "bread",
            "salt", "pepper",
        ],
    ),
]


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    count = 0
    for sheet, cols, rows, names in SHEETS:
        img = Image.open(os.path.join(SRC, sheet)).convert("RGBA")
        assert img.width == cols * TILE and img.height == rows * TILE, (
            f"{sheet} is {img.size}, expected {(cols * TILE, rows * TILE)}"
        )
        assert len(names) == cols * rows, (
            f"{sheet}: {len(names)} names for {cols * rows} cells"
        )
        i = 0
        for r in range(rows):
            for c in range(cols):
                box = (c * TILE, r * TILE, (c + 1) * TILE, (r + 1) * TILE)
                img.crop(box).save(os.path.join(OUT, names[i] + ".png"))
                i += 1
                count += 1
    print(f"tiles written: {count}")


if __name__ == "__main__":
    main()
