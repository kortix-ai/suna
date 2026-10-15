#!/usr/bin/env python3
"""Render a visual review sheet from one processed recording trace."""

from __future__ import annotations

import argparse
import textwrap
from pathlib import Path

from compare_screenshot_sync import read_jsonl, start_timestamp, timestamp, triples
from render_trace_review_sheet import action_summary, draw_panel, parse_crop


def render(args: argparse.Namespace) -> None:
    from PIL import Image, ImageDraw

    preprocessed = Path(args.preprocessed)
    rows = triples(read_jsonl(preprocessed))
    if args.max_rows:
        rows = rows[: args.max_rows]
    if not rows:
        raise SystemExit("no screenshot/action/screenshot triples found")

    crop = parse_crop(args.crop)
    panel_width = args.panel_width
    panel_height = args.panel_height
    margin = 18
    header_height = 58
    row_height = header_height + panel_height + margin
    width = margin + (2 * panel_width) + margin
    height = margin + len(rows) * row_height
    canvas = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(canvas)

    for row_index, (before, action, after) in enumerate(rows):
        top = margin + row_index * row_height
        before_gap = start_timestamp(action) - timestamp(before)
        after_gap = timestamp(after) - timestamp(action)
        title = (
            f"{row_index + 1}. {action_summary(action)} "
            f"before={before_gap:.2f}s after={after_gap:.2f}s"
        )
        for offset, text in enumerate(textwrap.wrap(title, width=96)):
            draw.text((margin, top + offset * 15), text, fill=(0, 0, 0))

        y = top + header_height
        draw_panel(draw, canvas, before, "before", margin, y, panel_width, panel_height, crop)
        draw_panel(
            draw,
            canvas,
            after,
            "after",
            margin + panel_width,
            y,
            panel_width,
            panel_height,
            crop,
        )

    output = (
        Path(args.output)
        if args.output
        else preprocessed.with_name(f"{preprocessed.stem}_review_sheet.jpg")
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, quality=args.quality)
    print(output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preprocessed", help="Processed JSONL trace to render")
    parser.add_argument("--output", help="Output image path. Defaults beside the input trace")
    parser.add_argument("--crop", help="Optional crop box: left,top,right,bottom")
    parser.add_argument("--panel-width", type=int, default=560)
    parser.add_argument("--panel-height", type=int, default=360)
    parser.add_argument("--max-rows", type=int)
    parser.add_argument("--quality", type=int, default=92)
    render(parser.parse_args())


if __name__ == "__main__":
    main()
