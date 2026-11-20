"""Rasterise the plugin icon so the marketplace gets a bitmap.

awesome-dsh-plugin rejects SVG icons, so this draws the same mark (stopwatch +
bell on a dark rounded tile) at 512x512 and 192x192 with Pillow.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "assets"

BG_TOP = (20, 36, 59)
BG_BOTTOM = (11, 18, 32)
TRACK = (30, 51, 80)
RING_TOP = (90, 209, 255)
RING_BOTTOM = (47, 124, 246)
HAND = (232, 244, 255)
STEM = (159, 182, 208)
BELL = (255, 207, 92)


def lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))  # type: ignore[return-value]


def rounded_tile(size: int, radius: int) -> Image.Image:
    """Vertical gradient clipped to a rounded square, drawn 4x then downsampled."""
    scale = 4
    big = size * scale
    grad = Image.new("RGB", (big, big))
    draw = ImageDraw.Draw(grad)
    for y in range(big):
        draw.line([(0, y), (big, y)], fill=lerp(BG_TOP, BG_BOTTOM, y / (big - 1)))

    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=radius * scale, fill=255)

    tile = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    tile.paste(grad, (0, 0), mask)
    return tile.resize((size, size), Image.LANCZOS)


def arc(draw: ImageDraw.ImageDraw, box, start: float, end: float, color, width: int) -> None:
    draw.arc(box, start=start, end=end, fill=color, width=width)


def draw_icon(size: int) -> Image.Image:
    scale = 4
    canvas = rounded_tile(size, round(size * 0.219)).convert("RGBA")
    layer = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    unit = size * scale / 512.0

    def px(value: float) -> float:
        return value * unit

    # Clock face: dark ring plus a cyan progress arc over the first quadrant.
    cx, cy, radius = px(248), px(262), px(128)
    box = [cx - radius, cy - radius, cx + radius, cy + radius]
    arc(draw, box, start=0, end=360, color=TRACK, width=round(px(26)))
    steps = 40
    for i in range(steps):
        a0 = -90 + i * (110 / steps)
        arc(
            draw,
            box,
            start=a0,
            end=a0 + (110 / steps) + 0.8,
            color=lerp(RING_TOP, RING_BOTTOM, i / (steps - 1)),
            width=round(px(26)),
        )

    # Hands.
    draw.line([(cx, cy), (cx, cy - px(76))], fill=HAND, width=round(px(22)))
    draw.line([(cx, cy), (cx + px(54), cy + px(38))], fill=HAND, width=round(px(22)))
    draw.ellipse(
        [cx - px(15), cy - px(15), cx + px(15), cy + px(15)],
        fill=HAND,
    )

    # Crown.
    draw.line([(cx, cy - radius), (cx, cy - radius - px(22))], fill=STEM, width=round(px(18)))
    draw.line(
        [(cx - px(34), cy - radius - px(22)), (cx + px(34), cy - radius - px(22))],
        fill=STEM,
        width=round(px(18)),
    )

    # Bell, tucked into the top-right corner of the tile: dome, skirt, lip, clapper.
    draw.rounded_rectangle(
        [px(359), px(110), px(449), px(190)],
        radius=round(px(36)),
        fill=BELL,
    )
    draw.polygon(
        [
            (px(359), px(186)),
            (px(449), px(186)),
            (px(464), px(212)),
            (px(344), px(212)),
        ],
        fill=BELL,
    )
    draw.rounded_rectangle(
        [px(338), px(210), px(470), px(224)],
        radius=round(px(7)),
        fill=BELL,
    )
    draw.ellipse([px(394), px(224), px(414), px(244)], fill=BELL)

    layer = layer.resize((size, size), Image.LANCZOS)
    canvas.alpha_composite(layer)
    return canvas


def main() -> int:
    for size in (512, 192):
        target = OUT / f"icon-{size}.png"
        draw_icon(size).save(target, "PNG", optimize=True)
        print(f"wrote {target} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
