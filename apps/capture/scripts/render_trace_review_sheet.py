#!/usr/bin/env python3
"""Render a large visual review sheet from Rust/Python processed trace artifacts."""

from __future__ import annotations

import argparse
import textwrap
from pathlib import Path
from typing import Any

from compare_screenshot_sync import event_type, load_image, payload, read_jsonl, triples


def parse_crop(value: str | None) -> tuple[int, int, int, int] | None:
    if not value:
        return None
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("--crop must be left,top,right,bottom")
    try:
        left, top, right, bottom = [int(part) for part in parts]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--crop values must be integers") from exc
    if right <= left or bottom <= top:
        raise argparse.ArgumentTypeError("--crop right/bottom must exceed left/top")
    return left, top, right, bottom


def action_summary(action: dict[str, Any]) -> str:
    action_type = event_type(action)
    args = payload(action)
    if action_type == "typewrite":
        text = str(args.get("text", ""))
        return f'typewrite "{text}"'
    if action_type == "press":
        count = args.get("count")
        suffix = f" x{count}" if isinstance(count, int) and count > 1 else ""
        lock_state = args.get("lock_state")
        state_suffix = f" {lock_state}" if lock_state in {"on", "off"} else ""
        return f"press {args.get('key', '')}{state_suffix}{suffix}"
    if action_type == "hotkey":
        keys = args.get("keys") or []
        return "hotkey " + "+".join(format_key_label(key) for key in keys)
    if action_type == "click":
        clicks = args.get("clicks", 1)
        button = args.get("button", "left")
        mods = args.get("modifiers") or []
        suffix = f" mods={mods}" if mods else ""
        return f"{button} click x{clicks}{suffix}"
    if action_type == "drag":
        mods = args.get("modifiers") or []
        return (
            "drag "
            f"{args.get('start_x')},{args.get('start_y')} -> "
            f"{args.get('end_x')},{args.get('end_y')} "
            f"mods={mods}"
        )
    if action_type == "scroll":
        return f"scroll clicks={args.get('clicks')}"
    return action_type


def format_key_label(key: Any) -> str:
    text = str(key)
    if text == " ":
        return "space"
    if text == "\t":
        return "tab"
    if text == "\n":
        return "enter"
    return text


def fit_image(image: Any, size: tuple[int, int]) -> Any:
    from PIL import ImageOps

    return ImageOps.contain(image, size)


def draw_panel(draw: Any, canvas: Any, event: dict[str, Any], label: str, x: int, y: int, width: int, height: int, crop: tuple[int, int, int, int] | None) -> None:
    from PIL import Image

    label_height = 24
    image = load_image(event)
    if image is None:
        draw.rectangle((x, y + label_height, x + width, y + height), outline=(220, 220, 220))
        draw.text((x + 8, y + label_height + 8), "missing image", fill=(160, 0, 0))
        draw.text((x + 8, y + 5), label, fill=(32, 32, 32))
        return

    if crop:
        image = image.crop(crop)
    fitted = fit_image(image, (width, height - label_height))
    background = Image.new("RGB", (width, height - label_height), "white")
    offset = ((width - fitted.width) // 2, (height - label_height - fitted.height) // 2)
    background.paste(fitted, offset)
    draw.text((x + 8, y + 5), label, fill=(32, 32, 32))
    canvas.paste(background, (x, y + label_height))
    draw.rectangle((x, y + label_height, x + width, y + height), outline=(220, 220, 220))


def render(args: argparse.Namespace) -> None:
    from PIL import Image, ImageDraw

    artifact_dir = Path(args.artifact_dir)
    rust_triples = triples(read_jsonl(artifact_dir / "rust-preprocessed.jsonl"))
    python_triples = triples(read_jsonl(artifact_dir / "python-preprocessed.jsonl"))
    row_count = min(len(rust_triples), len(python_triples))
    if args.max_rows:
        row_count = min(row_count, args.max_rows)
    if row_count == 0:
        raise SystemExit("no screenshot/action/screenshot triples found")

    crop = parse_crop(args.crop)
    panel_width = args.panel_width
    panel_height = args.panel_height
    margin = 18
    header_height = 54
    row_height = header_height + panel_height + margin
    width = margin + (2 * panel_width) + margin + (2 * panel_width) + margin
    height = margin + row_count * row_height
    canvas = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(canvas)

    for row_index in range(row_count):
        rust_before, rust_action, rust_after = rust_triples[row_index]
        python_before, python_action, python_after = python_triples[row_index]
        top = margin + row_index * row_height
        draw.text(
            (margin, top),
            f"{row_index + 1}. rust {action_summary(rust_action)} | python {action_summary(python_action)}",
            fill=(0, 0, 0),
        )
        for offset, text in enumerate(textwrap.wrap("Rust before/after", width=48)):
            draw.text((margin, top + 18 + offset * 14), text, fill=(80, 80, 80))
        right_group_x = margin + (2 * panel_width) + margin
        for offset, text in enumerate(textwrap.wrap("Python before/after", width=48)):
            draw.text((right_group_x, top + 18 + offset * 14), text, fill=(80, 80, 80))

        y = top + header_height
        draw_panel(draw, canvas, rust_before, "rust before", margin, y, panel_width, panel_height, crop)
        draw_panel(draw, canvas, rust_after, "rust after", margin + panel_width, y, panel_width, panel_height, crop)
        draw_panel(draw, canvas, python_before, "python before", right_group_x, y, panel_width, panel_height, crop)
        draw_panel(draw, canvas, python_after, "python after", right_group_x + panel_width, y, panel_width, panel_height, crop)

    output = Path(args.output) if args.output else artifact_dir / "trace-review-sheet.jpg"
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, quality=args.quality)
    print(output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact_dir", help="Directory containing rust/python preprocessed JSONL artifacts")
    parser.add_argument("--output", help="Output image path. Defaults to artifact_dir/trace-review-sheet.jpg")
    parser.add_argument("--crop", help="Optional crop box: left,top,right,bottom")
    parser.add_argument("--panel-width", type=int, default=520)
    parser.add_argument("--panel-height", type=int, default=340)
    parser.add_argument("--max-rows", type=int)
    parser.add_argument("--quality", type=int, default=92)
    render(parser.parse_args())


if __name__ == "__main__":
    main()
