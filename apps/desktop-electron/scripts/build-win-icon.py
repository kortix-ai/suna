#!/usr/bin/env python3
"""Build build/icon.ico, the Windows app icon, from apps/web/public/favicon.svg.

favicon.svg is the source of every Kortix app icon (kortix-brand brandmark.md,
Q39): the dark symbol on the light #F8F8F8 rounded tile, which keeps contrast
on a light and a dark taskbar. Each size is rasterized from the vector, not
downscaled from one bitmap, so 16, 20 and 24 px stay crisp. The tile sits
inside a 1/16 margin, the padding Windows app icons keep around their plate.

Needs rsvg-convert (librsvg) and Pillow:
  python3 apps/desktop-electron/scripts/build-win-icon.py
"""
import io
import pathlib
import subprocess

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[3]
SOURCE = ROOT / "apps/web/public/favicon.svg"
TARGET = ROOT / "apps/desktop-electron/build/icon.ico"
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]


def frame(size: int) -> Image.Image:
    margin = round(size / 16)
    inner = size - 2 * margin
    png = subprocess.run(
        ["rsvg-convert", "-w", str(inner), "-h", str(inner), str(SOURCE)],
        check=True,
        capture_output=True,
    ).stdout
    tile = Image.open(io.BytesIO(png)).convert("RGBA")
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(tile, (margin, margin), tile)
    return canvas


frames = [frame(s) for s in SIZES]
largest = frames[-1]
largest.save(TARGET, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
print(f"wrote {TARGET.relative_to(ROOT)}: {', '.join(map(str, SIZES))} px")
