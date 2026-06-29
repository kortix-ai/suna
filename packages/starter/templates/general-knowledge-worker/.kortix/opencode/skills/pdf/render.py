"""Render PDF pages as PNG images.

Usage:
    python render.py <input.pdf> <output_dir>
"""

import sys
from pathlib import Path

from pdf2image import convert_from_path

RENDER_DPI = 200
MAX_DIMENSION = 1000


def render(pdf_path: str, output_dir: str) -> None:
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    pages = convert_from_path(pdf_path, dpi=RENDER_DPI)
    for idx, img in enumerate(pages):
        w, h = img.size
        if w > MAX_DIMENSION or h > MAX_DIMENSION:
            ratio = min(MAX_DIMENSION / w, MAX_DIMENSION / h)
            img = img.resize((int(w * ratio), int(h * ratio)))

        dest = out / f"page_{idx + 1}.png"
        img.save(str(dest))
        print(f"page {idx + 1} → {dest} ({img.size[0]}x{img.size[1]})")

    print(f"{len(pages)} pages rendered to {output_dir}")


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: render.py <input.pdf> <output_dir>")
        sys.exit(1)
    render(sys.argv[1], sys.argv[2])


if __name__ == "__main__":
    main()
