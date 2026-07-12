#!/usr/bin/env python3
"""
Remove background from images locally using rembg.

This is the logo-creator skill's local fallback for background removal
when the image-gen tool's remove_bg action (BRIA RMBG 2.0 via Replicate)
produces poor results or is unavailable.

First run will download the model (~170MB). Subsequent runs are instant.

Usage:
    python3 remove_bg.py <input_path> <output_path>
    python3 remove_bg.py <input_path>                  # outputs to <input>-transparent.png
    python3 remove_bg.py --batch <dir>                  # process all images in directory

Requirements:
    pip install rembg pillow onnxruntime
"""

import sys
import os
from pathlib import Path

try:
    from rembg import remove
    from PIL import Image
    HAS_REMBG = True
except ImportError:
    HAS_REMBG = False


def remove_background(input_path: str, output_path: str | None = None) -> str:
    """Remove background from a single image. Returns output path."""
    if not HAS_REMBG:
        print("Error: rembg not installed. Run: pip install rembg pillow onnxruntime")
        sys.exit(1)

    if not os.path.exists(input_path):
        print(f"Error: File not found: {input_path}")
        sys.exit(1)

    if output_path is None:
        stem = Path(input_path).stem
        parent = Path(input_path).parent
        output_path = str(parent / f"{stem}-transparent.png")

    img = Image.open(input_path).convert("RGBA")
    result = remove(img)

    # Ensure output directory exists
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    result.save(output_path, "PNG")

    in_size = os.path.getsize(input_path) / 1024
    out_size = os.path.getsize(output_path) / 1024
    print(f"  {Path(input_path).name} ({in_size:.0f}KB) -> {Path(output_path).name} ({out_size:.0f}KB)")
    return output_path


def batch_remove(directory: str) -> list[str]:
    """Remove backgrounds from all images in a directory."""
    exts = {".png", ".jpg", ".jpeg", ".webp"}
    results = []
    for f in sorted(os.listdir(directory)):
        if Path(f).suffix.lower() in exts and "-transparent" not in f:
            input_path = os.path.join(directory, f)
            output_path = os.path.join(directory, f"{Path(f).stem}-transparent.png")
            results.append(remove_background(input_path, output_path))
    return results


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    if not HAS_REMBG:
        print("Error: rembg not installed.")
        print("Install: pip install rembg pillow onnxruntime")
        sys.exit(1)

    if sys.argv[1] == "--batch":
        if len(sys.argv) < 3:
            print("Usage: python3 remove_bg.py --batch <directory>")
            sys.exit(1)
        results = batch_remove(sys.argv[2])
        print(f"\nDone! {len(results)} images processed.")
    else:
        input_path = sys.argv[1]
        output_path = sys.argv[2] if len(sys.argv) > 2 else None
        remove_background(input_path, output_path)
        print("Done!")


if __name__ == "__main__":
    main()
