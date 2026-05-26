#!/usr/bin/env python3
"""
Compose logos by combining symbol images with Google Fonts text.

Renders HTML compositions to PNG via Playwright. Produces:
- Logomark (symbol only, cleaned up)
- Wordmark (text only, styled with Google Font)
- Combination marks (symbol + text in various layouts)

Usage:
    python3 compose_logo.py <config_json>

Config JSON format:
{
    "brand_name": "Acme",
    "symbol_path": "logos/acme/round-1/logomark-arrow.png",
    "output_dir": "logos/acme/composed/",
    "font_family": "Inter",
    "font_weight": 700,
    "text_color": "#000000",
    "accent_color": "#3B82F6",
    "tagline": "Build the future",
    "letter_spacing": "0.02em",
    "text_transform": "none",
    "layouts": ["wordmark", "combo-horizontal", "combo-vertical", "combo-icon-right"],
    "background": "#ffffff"
}

CLI mode:
    python3 compose_logo.py --brand "Acme" --symbol path.png --output-dir out/ \
        --font "Space Grotesk" --weight 700 --color "#1a1a2e" --layouts all
"""

import sys
import os
import json
import argparse
import tempfile
import base64
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("Error: playwright required. Install: pip install playwright && playwright install chromium")
    sys.exit(1)

try:
    from PIL import Image
    import numpy as np
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


# Layout dimensions (width x height) — designed for good proportions at each layout
LAYOUT_SIZES = {
    "wordmark":          (1600, 400),
    "wordmark-tagline":  (1600, 500),
    "combo-horizontal":  (2000, 600),
    "combo-vertical":    (1000, 1200),
    "combo-icon-right":  (2000, 600),
    "logomark":          (800, 800),
}

ALL_LAYOUTS = ["logomark", "wordmark", "wordmark-tagline", "combo-horizontal", "combo-vertical", "combo-icon-right"]


def autocrop_symbol(path: str, padding_pct: float = 0.08) -> str:
    """Auto-crop whitespace/transparency from a symbol image.

    Returns path to cropped image (saves as -cropped.png next to original).
    The cropped image is padded by padding_pct of the content size and
    placed in a square canvas.
    """
    if not HAS_PIL:
        print("  Warning: PIL not available, skipping auto-crop")
        return path

    img = Image.open(path).convert("RGBA")
    arr = np.array(img)

    # Find non-transparent, non-white pixels
    if arr.shape[2] == 4:
        # Has alpha — use alpha channel
        mask = arr[:, :, 3] > 20  # not nearly transparent
    else:
        # No alpha — find non-white
        mask = (arr[:, :, 0] < 240) | (arr[:, :, 1] < 240) | (arr[:, :, 2] < 240)

    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)

    if not np.any(rows) or not np.any(cols):
        return path

    rmin, rmax = np.where(rows)[0][[0, -1]]
    cmin, cmax = np.where(cols)[0][[0, -1]]

    # Crop to content
    cropped = img.crop((cmin, rmin, cmax + 1, rmax + 1))

    # Add proportional padding and make square
    cw, ch = cropped.size
    padding = int(max(cw, ch) * padding_pct)
    size = max(cw, ch) + padding * 2

    # Create square canvas (transparent)
    square = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x = (size - cw) // 2
    y = (size - ch) // 2
    square.paste(cropped, (x, y))

    out_path = str(Path(path).with_suffix("")) + "-cropped.png"
    square.save(out_path, "PNG")
    print(f"  Auto-cropped symbol: {img.size[0]}x{img.size[1]} -> {size}x{size} (content {cw}x{ch})")
    return out_path


def symbol_to_data_uri(path: str) -> str:
    """Convert symbol image to base64 data URI."""
    ext = Path(path).suffix.lower()
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".webp": "image/webp", ".svg": "image/svg+xml"}.get(ext, "image/png")
    with open(path, "rb") as f:
        return f"data:{mime};base64,{base64.b64encode(f.read()).decode('ascii')}"


def build_html(config: dict, layout: str) -> str:
    """Build HTML for a specific logo layout."""
    brand = config["brand_name"]
    font = config.get("font_family", "Inter")
    weight = config.get("font_weight", 700)
    color = config.get("text_color", "#000000")
    tagline = config.get("tagline", "")
    letter_spacing = config.get("letter_spacing", "0.02em")
    text_transform = config.get("text_transform", "none")
    bg = config.get("background", "#ffffff")
    symbol_uri = ""
    if config.get("symbol_path") and os.path.exists(config["symbol_path"]):
        symbol_uri = symbol_to_data_uri(config["symbol_path"])

    w, h = config.get("sizes", {}).get(layout, LAYOUT_SIZES.get(layout, (1200, 400)))

    # Google Fonts import — request the specific weight + 400 for tagline
    font_url_name = font.replace(" ", "+")
    weights = sorted(set([400, weight]))
    weight_str = ";".join(str(w) for w in weights)
    font_import = f'@import url("https://fonts.googleapis.com/css2?family={font_url_name}:wght@{weight_str}&display=swap");'

    # --- Proportion system ---
    # These are tuned to produce visually balanced logos.

    if layout == "logomark":
        symbol_sz = int(h * 0.65)
        inner = f'''
            <div class="center">
                <img src="{symbol_uri}" style="width:{symbol_sz}px;height:{symbol_sz}px;object-fit:contain;" />
            </div>
        '''

    elif layout == "wordmark":
        fsize = int(h * 0.30)
        inner = f'''
            <div class="center">
                <span class="brand" style="font-size:{fsize}px;">{brand}</span>
            </div>
        '''

    elif layout == "wordmark-tagline":
        fsize = int(h * 0.26)
        tag_size = int(fsize * 0.32)
        gap = int(fsize * 0.25)
        tag_text = tagline if tagline else "Your tagline here"
        inner = f'''
            <div class="center" style="flex-direction:column;gap:{gap}px;">
                <span class="brand" style="font-size:{fsize}px;">{brand}</span>
                <span class="tagline" style="font-size:{tag_size}px;">{tag_text}</span>
            </div>
        '''

    elif layout == "combo-horizontal":
        # Symbol is the hero. Text complements it.
        symbol_sz = int(h * 0.70)
        fsize = int(symbol_sz * 0.40)
        tag_size = int(fsize * 0.32)
        gap = int(symbol_sz * 0.20)
        tag_mt = int(tag_size * 0.25)
        inner = f'''
            <div class="center" style="gap:{gap}px;">
                <img src="{symbol_uri}" style="width:{symbol_sz}px;height:{symbol_sz}px;object-fit:contain;" />
                <div style="display:flex;flex-direction:column;justify-content:center;">
                    <span class="brand" style="font-size:{fsize}px;line-height:1.05;">{brand}</span>
                    {'<span class="tagline" style="font-size:' + str(tag_size) + 'px;margin-top:' + str(tag_mt) + 'px;">' + tagline + '</span>' if tagline else ''}
                </div>
            </div>
        '''

    elif layout == "combo-vertical":
        symbol_sz = int(h * 0.42)
        fsize = int(symbol_sz * 0.35)
        tag_size = int(fsize * 0.34)
        gap = int(symbol_sz * 0.12)
        inner = f'''
            <div class="center" style="flex-direction:column;gap:{gap}px;">
                <img src="{symbol_uri}" style="width:{symbol_sz}px;height:{symbol_sz}px;object-fit:contain;" />
                <span class="brand" style="font-size:{fsize}px;">{brand}</span>
                {'<span class="tagline" style="font-size:' + str(tag_size) + 'px;">' + tagline + '</span>' if tagline else ''}
            </div>
        '''

    elif layout == "combo-icon-right":
        symbol_sz = int(h * 0.70)
        fsize = int(symbol_sz * 0.40)
        tag_size = int(fsize * 0.32)
        gap = int(symbol_sz * 0.20)
        tag_mt = int(tag_size * 0.25)
        inner = f'''
            <div class="center" style="gap:{gap}px;">
                <div style="display:flex;flex-direction:column;justify-content:center;">
                    <span class="brand" style="font-size:{fsize}px;line-height:1.05;">{brand}</span>
                    {'<span class="tagline" style="font-size:' + str(tag_size) + 'px;margin-top:' + str(tag_mt) + 'px;">' + tagline + '</span>' if tagline else ''}
                </div>
                <img src="{symbol_uri}" style="width:{symbol_sz}px;height:{symbol_sz}px;object-fit:contain;" />
            </div>
        '''
    else:
        raise ValueError(f"Unknown layout: {layout}")

    return f'''<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
    {font_import}
    * {{ margin:0; padding:0; box-sizing:border-box; }}
    body {{
        width:{w}px;
        height:{h}px;
        background:{bg};
        overflow:hidden;
        display:flex;
        align-items:center;
        justify-content:center;
    }}
    .center {{
        display:flex;
        align-items:center;
        justify-content:center;
        width:100%;
        height:100%;
    }}
    .brand {{
        font-family:'{font}',sans-serif;
        font-weight:{weight};
        color:{color};
        letter-spacing:{letter_spacing};
        text-transform:{text_transform};
        white-space:nowrap;
    }}
    .tagline {{
        font-family:'{font}',sans-serif;
        font-weight:400;
        color:{color};
        opacity:0.5;
        letter-spacing:0.1em;
        text-transform:uppercase;
        white-space:nowrap;
    }}
</style>
</head>
<body>
{inner}
</body>
</html>'''


def render_all_to_png(layouts_html: list[tuple[str, str, int, int]]):
    """Render multiple HTML layouts to PNG using a single Playwright browser instance.

    layouts_html: list of (html_content, output_path, width, height)
    """
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for html, outpath, w, h in layouts_html:
            with tempfile.NamedTemporaryFile(suffix=".html", delete=False, mode="w") as f:
                f.write(html)
                tmp_html = f.name
            try:
                page = browser.new_page(viewport={"width": w, "height": h})
                page.goto(f"file://{tmp_html}")
                page.wait_for_timeout(1500)
                page.screenshot(path=outpath, type="png")
                page.close()
            finally:
                os.unlink(tmp_html)
        browser.close()


def compose_all(config: dict) -> list[str]:
    """Compose all requested layouts and return list of output paths."""
    output_dir = config.get("output_dir", "logos/composed/")
    os.makedirs(output_dir, exist_ok=True)

    layouts = config.get("layouts", ALL_LAYOUTS)
    if layouts == "all" or layouts == ["all"]:
        layouts = list(ALL_LAYOUTS)

    # Skip tagline layout if no tagline
    if not config.get("tagline") and "wordmark-tagline" in layouts:
        layouts = [l for l in layouts if l != "wordmark-tagline"]

    # Auto-crop symbol to remove whitespace padding from AI-generated images
    has_symbol = config.get("symbol_path") and os.path.exists(config.get("symbol_path", ""))
    if has_symbol:
        cropped = autocrop_symbol(config["symbol_path"])
        config = {**config, "symbol_path": cropped}
        has_symbol = True

    if not has_symbol:
        symbol_layouts = {"logomark", "combo-horizontal", "combo-vertical", "combo-icon-right"}
        skipped = [l for l in layouts if l in symbol_layouts]
        layouts = [l for l in layouts if l not in symbol_layouts]
        if skipped:
            print(f"  Skipping layouts (no symbol): {', '.join(skipped)}")

    brand_slug = config["brand_name"].lower().replace(" ", "-")

    # Build all HTML and queue for rendering
    render_queue = []
    output_paths = []

    for layout in layouts:
        w, h = config.get("sizes", {}).get(layout, LAYOUT_SIZES.get(layout, (1200, 400)))
        html = build_html(config, layout)
        filename = f"{brand_slug}-{layout}.png"
        outpath = os.path.join(output_dir, filename)
        render_queue.append((html, outpath, w, h))
        output_paths.append((layout, outpath, w, h))
        print(f"  Queued {layout} ({w}x{h})")

    print(f"  Rendering {len(render_queue)} layouts...", flush=True)
    render_all_to_png(render_queue)

    for layout, outpath, w, h in output_paths:
        size_kb = os.path.getsize(outpath) / 1024
        print(f"  OK {layout} -> {outpath} ({size_kb:.0f}KB)")

    return [p for _, p, _, _ in output_paths]


def main():
    parser = argparse.ArgumentParser(description="Compose logo layouts from symbol + Google Fonts text.")
    parser.add_argument("config_or_brand", nargs="?", help="Path to config JSON, or brand name with --flags")
    parser.add_argument("--brand", help="Brand name")
    parser.add_argument("--symbol", help="Path to symbol/logomark image")
    parser.add_argument("--output-dir", default="logos/composed/", help="Output directory")
    parser.add_argument("--font", default="Inter", help="Google Font family name")
    parser.add_argument("--weight", type=int, default=700, help="Font weight")
    parser.add_argument("--color", default="#000000", help="Text color")
    parser.add_argument("--accent", default=None, help="Accent color")
    parser.add_argument("--bg", default="#ffffff", help="Background color")
    parser.add_argument("--tagline", default="", help="Optional tagline")
    parser.add_argument("--letter-spacing", default="0.02em", help="Letter spacing")
    parser.add_argument("--text-transform", default="none", choices=["none", "uppercase", "lowercase"])
    parser.add_argument("--layouts", default="all", help="Comma-separated layouts or 'all'")
    args = parser.parse_args()

    if args.config_or_brand and os.path.isfile(args.config_or_brand):
        with open(args.config_or_brand) as f:
            config = json.load(f)
    elif args.brand or args.config_or_brand:
        brand = args.brand or args.config_or_brand
        layouts = args.layouts.split(",") if args.layouts != "all" else "all"
        config = {
            "brand_name": brand,
            "symbol_path": args.symbol or "",
            "output_dir": args.output_dir,
            "font_family": args.font,
            "font_weight": args.weight,
            "text_color": args.color,
            "accent_color": args.accent or args.color,
            "background": args.bg,
            "tagline": args.tagline,
            "letter_spacing": args.letter_spacing,
            "text_transform": args.text_transform,
            "layouts": layouts,
        }
    else:
        parser.print_help()
        sys.exit(1)

    print(f"Composing logos for '{config['brand_name']}'")
    print(f"  Font: {config.get('font_family', 'Inter')} @ {config.get('font_weight', 700)}")
    print(f"  Color: {config.get('text_color')} on {config.get('background', '#ffffff')}")
    print(f"  Symbol: {config.get('symbol_path') or '(none)'}")
    print(f"  Output: {config.get('output_dir')}")
    print()

    outputs = compose_all(config)
    print(f"\nDone! {len(outputs)} compositions created.")
    return outputs


if __name__ == "__main__":
    main()
