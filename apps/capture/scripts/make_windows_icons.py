#!/usr/bin/env python3
"""Windows icons for Kortix Capture: the Capture mark on a Fluent-style tile.

    python3 apps/capture/scripts/make_windows_icons.py [--sheet out.png]

Writes assets/icons/windows/: app.ico (16-256 px), app-256.png (the window icon),
tray.png and trayIdle.png (64 px). The mark is the one in assets/icons/app-1024.png:
a white ring and a white dot. macOS keeps app-1024.png (its own squircle grid).

Windows differs from macOS: the tile fills the canvas (no 10 % grid margin), the
corners are a plain small radius, and every size is drawn on its own pixel grid so
16 and 24 px stay sharp. A 1 px lighter edge keeps the dark tile visible on a dark
taskbar. Needs Pillow.
"""
import argparse
import pathlib

from PIL import Image, ImageDraw

INK = (18, 18, 21, 255)  # #121215, the brand ink (favicon.svg)
EDGE = (64, 64, 72, 255)  # the tile's edge on a dark taskbar
MARK = (255, 255, 255, 255)
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
SS = 16  # supersampling factor

# The mark relative to the tile width, measured on app-1024.png (tile 824 px):
# ring outside 257, ring inside 184, dot 113.
RING_OUT, RING_IN, DOT = 0.312, 0.223, 0.137


def geometry(size):
    """Tile margin and corner radius, and the three radii, in pixels for this size."""
    margin = max(1, round(size / 32))
    tile = size - 2 * margin
    radius = max(2, round(tile * 0.16))
    if size <= 24:
        # Small sizes: whole-pixel ring and gap, or the dot and ring blur into one disc.
        ring_out = round(tile * RING_OUT * 2) / 2 + 0.5
        gap = 1.5 if size < 20 else 2.0
        return margin, radius, ring_out, ring_out - 1.5, max(1.5, ring_out - 1.5 - gap)
    return margin, radius, tile * RING_OUT, tile * RING_IN, tile * DOT


def draw(size, dot=True):
    margin, radius, r1, r2, r3 = geometry(size)
    big = size * SS
    im = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    box = [margin * SS, margin * SS, (size - margin) * SS - 1, (size - margin) * SS - 1]
    edge = max(1, size // 64) * SS
    d.rounded_rectangle(box, radius=radius * SS, fill=EDGE)
    inner = [box[0] + edge, box[1] + edge, box[2] - edge, box[3] - edge]
    d.rounded_rectangle(inner, radius=max(1, radius * SS - edge), fill=INK)
    c = big / 2

    def disc(r, color):
        d.ellipse([c - r * SS, c - r * SS, c + r * SS - 1, c + r * SS - 1], fill=color)

    disc(r1, MARK)
    disc(r2, INK)
    if dot:
        disc(r3, MARK)
    return im.resize((size, size), Image.BOX)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", help="also write a contact sheet (light and dark taskbar) here")
    a = ap.parse_args()
    out = pathlib.Path(__file__).resolve().parent.parent / "assets" / "icons" / "windows"
    out.mkdir(parents=True, exist_ok=True)
    frames = [draw(s) for s in SIZES]
    frames[-1].save(out / "app.ico", format="ICO", sizes=[(s, s) for s in SIZES],
                    append_images=frames[:-1])
    frames[-1].save(out / "app-256.png")
    draw(64).save(out / "tray.png")
    draw(64, dot=False).save(out / "trayIdle.png")
    print("wrote", out)
    if a.sheet:
        scale = 4
        w = max(sum(s + 24 for s in SIZES), sum(s * scale + 24 for s in SIZES[:6])) + 24
        sheet = Image.new("RGBA", (w, 2 * (256 + 48) + 2 * (max(SIZES[:6]) * scale + 48)), (0, 0, 0, 255))
        rows = [((243, 243, 243, 255), "light"), ((32, 32, 32, 255), "dark")]
        y = 0
        for bg, _ in rows:
            # 1:1 row, then the small sizes enlarged 4x (nearest) to show the pixel grid.
            band = Image.new("RGBA", (w, 256 + 48), bg)
            x = 24
            for f in frames:
                band.alpha_composite(f, (x, 24 + 256 - f.size[1]))
                x += f.size[0] + 24
            sheet.alpha_composite(band, (0, y)); y += band.size[1]
            zoom_h = max(SIZES[:6]) * scale + 48
            band = Image.new("RGBA", (w, zoom_h), bg)
            x = 24
            for f in frames[:6]:
                z = f.resize((f.size[0] * scale, f.size[1] * scale), Image.NEAREST)
                band.alpha_composite(z, (x, 24))
                x += z.size[0] + 24
            sheet.alpha_composite(band, (0, y)); y += band.size[1]
        sheet.save(a.sheet)
        print("wrote", a.sheet)


if __name__ == "__main__":
    main()
