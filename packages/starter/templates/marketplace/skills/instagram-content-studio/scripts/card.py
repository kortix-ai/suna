#!/usr/bin/env python3
"""Compose an Instagram story (1080x1920) or feed image (1080x1350) as a JPEG.

    python3 card.py spec.json out.jpg

spec: {"kind": "story"|"post", "image": "<path or https URL>", "title": "...", "text": "...",
       "kicker": "...", "credit": "...", "handle": "@brand", "focus": [0.5, 0.5],
       "bakedText": false, "accent": "#F4CE68"}
"""
import io, json, sys, textwrap, urllib.request
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

SIZES = {"story": (1080, 1920), "post": (1080, 1350)}
SAFE = {"story": (250, 340), "post": (60, 60)}          # top / bottom px kept free of text

def font(bold, size):
    for name in (["DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf"] if bold else ["DejaVuSans.ttf", "LiberationSans-Regular.ttf"]):
        try: return ImageFont.truetype(name, size)
        except OSError: pass
    return ImageFont.load_default()

def load(src):
    data = urllib.request.urlopen(urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0"}), timeout=120).read() \
        if src.startswith("http") else open(src, "rb").read()
    return ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")

def cover(img, size, focus):
    W, H = size; s = max(W / img.width, H / img.height)
    img = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
    x = min(max(round(img.width * focus[0] - W / 2), 0), img.width - W)
    y = min(max(round(img.height * focus[1] - H / 2), 0), img.height - H)
    return img.crop((x, y, x + W, y + H))

def wrap(draw, text, f, width):
    lines, line = [], ""
    for word in text.split():
        trial = (line + " " + word).strip()
        if draw.textlength(trial, font=f) <= width: line = trial
        else: lines.append(line); line = word
    return lines + ([line] if line else [])

def main():
    spec, out = json.load(open(sys.argv[1])), sys.argv[2]
    kind = spec["kind"]; W, H = SIZES[kind]; top, bottom = SAFE[kind]
    img = cover(load(spec["image"]), (W, H), spec.get("focus", [0.5, 0.5]))
    accent = spec.get("accent", "#F4CE68")
    if not spec.get("bakedText"):
        # dark gradient under the text block so it reads on any photo
        grad = Image.new("L", (1, H)); grad.putdata([int(235 * max(0, (y - H * 0.45) / (H * 0.55))) for y in range(H)])
        img = Image.composite(Image.new("RGB", (W, H), (8, 10, 20)), img, grad.resize((W, H)))
    d = ImageDraw.Draw(img); M = 72; maxw = W - 2 * M
    y = H - bottom
    credit = spec.get("credit", "")
    if credit:
        fc = font(False, 26); y -= 40; d.text((M, y), credit, font=fc, fill=(200, 200, 205))
    if not spec.get("bakedText"):
        ft, fb, fk = font(True, 76 if kind == "story" else 64), font(False, 38), font(True, 30)
        body = wrap(d, spec.get("text", ""), fb, maxw)
        title = wrap(d, spec["title"], ft, maxw)
        y -= 24 + len(body) * 52
        for i, l in enumerate(body): d.text((M, y + i * 52), l, font=fb, fill=(235, 235, 240))
        y -= 20 + len(title) * (ft.size + 10)
        for i, l in enumerate(title): d.text((M, y + i * (ft.size + 10)), l, font=ft, fill="white")
        if spec.get("kicker"):
            y -= 56; d.text((M, y), spec["kicker"].upper(), font=fk, fill=accent)
        if y < top: sys.exit(f"text block reaches y={y}, above the safe top {top}: shorten title/text")
    if spec.get("handle"):
        fh = font(True, 28); d.text((W - M - d.textlength(spec["handle"], font=fh), top - 60 if kind == "story" else 40), spec["handle"], font=fh, fill="white")
    img.save(out, "JPEG", quality=92, optimize=True)
    print(json.dumps({"out": out, "size": [W, H]}))

if __name__ == "__main__":
    main()
