#!/usr/bin/env python3
"""
Build a macOS Big Sur-style app icon for the Kortix desktop shell.

Reads the iOS App Icon master (which has the canonical Kortix K mark on a
cream background) and produces a dark-variant 1024×1024 PNG at
`src-tauri/icons/source.png` ready to feed to `tauri icon`.

Spec, from Apple's HIG and the Big Sur icon template:
  • 1024×1024 canvas, 100px transparent gutter on all sides
  • 824×824 squircle, 185.4 corner radius
  • Drop shadow: 28px Gaussian blur, 12px Y offset, black 50% (Apple spec)
  • Subtle inner top-edge specular highlight (Mail.app-style bevel)
  • Soft linear gloss overlay: white ~10% at top fading to 0 by mid-height
  • Dark variant: charcoal vertical gradient (#262628 → #0a0a0c), white K mark

Usage:
    python3 apps/desktop/scripts/build-icon.py
    pnpm --filter @kortix/desktop icons src-tauri/icons/source.png

Requires: Pillow (`pip install Pillow`).
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageChops

REPO = Path(__file__).resolve().parents[3]
IOS_ICON = REPO / "apps/mobile/ios/Kortix/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png"
OUT = REPO / "apps/desktop/src-tauri/icons/source.png"

CANVAS = 1024
INSET = 100
INNER = CANVAS - 2 * INSET  # 824
RADIUS = 185


def vgradient(w: int, h: int, top: tuple[int, int, int], bot: tuple[int, int, int]) -> Image.Image:
    grad = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(h - 1, 1)
        grad.putpixel((0, y), tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return grad.resize((w, h))


def main() -> None:
    # 1. Extract the K silhouette from the iOS icon (cream BG, black K).
    ios = Image.open(IOS_ICON).convert("L").resize((INNER, INNER), Image.LANCZOS)
    k_mask = ios.point(lambda p: 255 if p < 128 else 0).convert("L")

    # 2. Dark squircle background.
    bg_rgb = vgradient(INNER, INNER, top=(38, 38, 40), bot=(10, 10, 12))
    sq_mask = Image.new("L", (INNER, INNER), 0)
    ImageDraw.Draw(sq_mask).rounded_rectangle((0, 0, INNER, INNER), radius=RADIUS, fill=255)
    bg = Image.new("RGBA", (INNER, INNER), (0, 0, 0, 0))
    bg.paste(bg_rgb, (0, 0), sq_mask)

    # 3. White K on top of the squircle.
    k_layer = Image.new("RGBA", (INNER, INNER), (245, 245, 247, 0))
    k_layer.paste((245, 245, 247, 255), (0, 0), k_mask)
    bg = Image.alpha_composite(bg, k_layer)

    # 4. Specular top-edge bevel.
    spec = Image.new("RGBA", (INNER, INNER), (0, 0, 0, 0))
    ImageDraw.Draw(spec).rounded_rectangle(
        (1, 1, INNER - 2, INNER - 2),
        radius=RADIUS - 1,
        outline=(255, 255, 255, 130),
        width=2,
    )
    fade = Image.new("L", (INNER, INNER), 0)
    for y in range(INNER):
        t = y / INNER
        a = int(255 * max(0, 1 - t / 0.35) ** 1.4) if t < 0.35 else 0
        ImageDraw.Draw(fade).line([(0, y), (INNER, y)], fill=a)
    spec.putalpha(ImageChops.multiply(spec.split()[3], fade))
    spec_masked = Image.new("RGBA", (INNER, INNER), (0, 0, 0, 0))
    spec_masked.paste(spec, (0, 0), sq_mask)
    bg = Image.alpha_composite(bg, spec_masked)

    # 5. Soft gloss sheen across the upper half.
    gloss_alpha = Image.new("L", (INNER, INNER), 0)
    for y in range(INNER):
        t = y / INNER
        a = int(28 * max(0, 1 - t / 0.55)) if t < 0.55 else 0
        ImageDraw.Draw(gloss_alpha).line([(0, y), (INNER, y)], fill=a)
    gloss = Image.new("RGBA", (INNER, INNER), (255, 255, 255, 0))
    gloss.putalpha(gloss_alpha)
    gloss_masked = Image.new("RGBA", (INNER, INNER), (0, 0, 0, 0))
    gloss_masked.paste(gloss, (0, 0), sq_mask)
    bg = Image.alpha_composite(bg, gloss_masked)

    # 6. Drop shadow + final composite.
    final = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(shadow).rounded_rectangle(
        (INSET, INSET + 12, CANVAS - INSET, CANVAS - INSET + 12),
        radius=RADIUS,
        fill=128,
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=28))
    shadow_layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow_layer.putalpha(shadow)
    final = Image.alpha_composite(final, shadow_layer)
    final.paste(bg, (INSET, INSET), bg)
    final.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT} {final.size}")


if __name__ == "__main__":
    main()
