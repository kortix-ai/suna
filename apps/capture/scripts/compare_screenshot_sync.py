#!/usr/bin/env python3
"""Check screenshot/action/screenshot synchronization in two processed traces."""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
import sys
from pathlib import Path
from typing import Any


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number}: expected JSON object")
            events.append(value)
    return events


def event_type(event: dict[str, Any]) -> str:
    return str(event.get("type") or "")


def timestamp(event: dict[str, Any]) -> float:
    value = event.get("timestamp", 0.0)
    return float(value) if isinstance(value, (int, float)) else 0.0

def start_timestamp(event: dict[str, Any]) -> float:
    value = event.get("start_timestamp")
    return float(value) if isinstance(value, (int, float)) else timestamp(event)


def is_screenshot(event: dict[str, Any]) -> bool:
    return event_type(event) == "screenshot"


def is_action(event: dict[str, Any]) -> bool:
    return event_type(event) not in {"", "screenshot", "a11y+screenshot", "sleep"}


def triples(events: list[dict[str, Any]]) -> list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]]:
    result: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    for index, event in enumerate(events):
        if not is_action(event):
            continue
        before = next((events[pos] for pos in range(index - 1, -1, -1) if is_screenshot(events[pos])), None)
        after = next((events[pos] for pos in range(index + 1, len(events)) if is_screenshot(events[pos])), None)
        if before and after:
            result.append((before, event, after))
    return result


def payload(event: dict[str, Any]) -> dict[str, Any]:
    value = event.get("args") or event.get("data") or {}
    return value if isinstance(value, dict) else {}


def image_payload(event: dict[str, Any]) -> str | None:
    value = payload(event).get("image")
    return value if isinstance(value, str) and value else None


def load_image(event: dict[str, Any]):
    try:
        from PIL import Image
    except ImportError:
        return None

    image = image_payload(event)
    if not image:
        return None
    try:
        return Image.open(io.BytesIO(base64.b64decode(image))).convert("RGB")
    except Exception:
        return None


def dhash(image: Any, size: int = 16) -> list[bool]:
    resized = image.convert("L").resize((size + 1, size))
    pixels = list(resized.getdata())
    bits: list[bool] = []
    for y in range(size):
        row = pixels[y * (size + 1) : (y + 1) * (size + 1)]
        bits.extend(row[x] > row[x + 1] for x in range(size))
    return bits


def hamming(left: list[bool], right: list[bool]) -> int:
    return sum(a != b for a, b in zip(left, right))


def rmse(left: Any, right: Any) -> float:
    from PIL import ImageChops, ImageStat

    size = (320, 200)
    left = left.resize(size)
    right = right.resize(size)
    diff = ImageChops.difference(left, right)
    stat = ImageStat.Stat(diff)
    return math.sqrt(sum(value * value for value in stat.rms) / len(stat.rms))


def visual_metrics(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any] | None:
    left_image = load_image(left)
    right_image = load_image(right)
    if left_image is None or right_image is None:
        return None
    return {
        "hash_distance": hamming(dhash(left_image), dhash(right_image)),
        "rmse": round(rmse(left_image, right_image), 3),
    }


def max_after_gap_for_action(action: str, args: argparse.Namespace) -> float:
    if action == "drag":
        return args.drag_max_after_gap
    return args.max_after_gap

def max_gap_delta_for_action(action: str, args: argparse.Namespace) -> float:
    if action == "drag":
        return args.drag_max_gap_delta
    return args.max_gap_delta


def visual_equivalent(metrics: dict[str, Any] | None, args: argparse.Namespace) -> bool:
    if not metrics:
        return False
    return (
        metrics.get("hash_distance", math.inf) <= args.max_visual_hash_distance
        and metrics.get("rmse", math.inf) <= args.max_visual_rmse
    )


def before_gap_pass(
    rust_before_gap: float,
    python_before_gap: float,
    before_gap_delta: float,
    before_visual: dict[str, Any] | None,
    args: argparse.Namespace,
    max_gap_delta: float,
) -> bool:
    if rust_before_gap > args.max_before_gap or python_before_gap > args.max_before_gap:
        return False
    return before_gap_delta <= max_gap_delta or visual_equivalent(before_visual, args)


def create_montage(
    rows: list[dict[str, Any]],
    rust_triples: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]],
    python_triples: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]],
    output: Path,
) -> None:
    from PIL import Image, ImageDraw

    thumb_size = (256, 160)
    row_height = 202
    width = 4 * thumb_size[0] + 5 * 12
    height = max(1, len(rows)) * row_height + 12
    canvas = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(canvas)

    for y, row, rust, python in zip(range(12, height, row_height), rows, rust_triples, python_triples):
        rust_before, rust_action, rust_after = rust
        python_before, python_action, python_after = python
        draw.text(
            (12, y),
            (
                f"{row['index']}. {event_type(rust_action)} "
                f"R {row['rust_before_gap']:.2f}/{row['rust_after_gap']:.2f}s "
                f"P {row['python_before_gap']:.2f}/{row['python_after_gap']:.2f}s"
            ),
            fill=(0, 0, 0),
        )
        for column, (label, event) in enumerate(
            [
                ("rust before", rust_before),
                ("rust after", rust_after),
                ("python before", python_before),
                ("python after", python_after),
            ]
        ):
            image = load_image(event)
            if image is None:
                continue
            x = 12 + column * (thumb_size[0] + 12)
            draw.text((x, y + 18), label, fill=(32, 32, 32))
            canvas.paste(image.resize(thumb_size), (x, y + 42))

    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, quality=90)


def compare(args: argparse.Namespace) -> dict[str, Any]:
    rust = triples(read_jsonl(Path(args.rust_preprocessed)))
    python = triples(read_jsonl(Path(args.python_preprocessed)))
    rows: list[dict[str, Any]] = []

    for index, (rust_triple, python_triple) in enumerate(zip(rust, python), 1):
        rust_before, rust_action, rust_after = rust_triple
        python_before, python_action, python_after = python_triple
        rust_before_gap = start_timestamp(rust_action) - timestamp(rust_before)
        rust_after_gap = timestamp(rust_after) - timestamp(rust_action)
        python_before_gap = start_timestamp(python_action) - timestamp(python_before)
        python_after_gap = timestamp(python_after) - timestamp(python_action)
        action = event_type(rust_action)
        max_after_gap = max_after_gap_for_action(action, args)
        max_gap_delta = max_gap_delta_for_action(action, args)
        strict = True
        row = {
            "index": index,
            "rust_action": action,
            "python_action": event_type(python_action),
            "strict": strict,
            "max_after_gap": max_after_gap,
            "max_gap_delta": max_gap_delta,
            "rust_before_gap": round(rust_before_gap, 3),
            "rust_after_gap": round(rust_after_gap, 3),
            "python_before_gap": round(python_before_gap, 3),
            "python_after_gap": round(python_after_gap, 3),
            "before_gap_delta": round(abs(rust_before_gap - python_before_gap), 3),
            "after_gap_delta": round(abs(rust_after_gap - python_after_gap), 3),
            "before_visual": visual_metrics(rust_before, python_before),
            "after_visual": visual_metrics(rust_after, python_after),
        }
        row["after_gap_pass"] = (
            not strict
            or (
                rust_after_gap <= max_after_gap
                and python_after_gap <= max_after_gap
                and row["after_gap_delta"] <= max_gap_delta
            )
        )
        row["before_visual_equivalent"] = visual_equivalent(row["before_visual"], args)
        row["before_gap_pass"] = not strict or before_gap_pass(
            rust_before_gap,
            python_before_gap,
            row["before_gap_delta"],
            row["before_visual"],
            args,
            max_gap_delta,
        )
        rows.append(row)

    strict_rows = [row for row in rows if row["strict"]]
    summary = {
        "status": "pass"
        if rust
        and python
        and len(rust) == len(python)
        and all(row["after_gap_pass"] and row["before_gap_pass"] for row in strict_rows)
        else "fail",
        "rust_triples": len(rust),
        "python_triples": len(python),
        "aligned_triples": len(rows),
        "thresholds": {
            "max_after_gap": args.max_after_gap,
            "drag_max_after_gap": args.drag_max_after_gap,
            "max_gap_delta": args.max_gap_delta,
            "drag_max_gap_delta": args.drag_max_gap_delta,
            "max_before_gap": args.max_before_gap,
            "max_before_delta": args.max_before_delta,
            "max_visual_hash_distance": args.max_visual_hash_distance,
            "max_visual_rmse": args.max_visual_rmse,
        },
        "rows": rows,
        "notes": [
            "sleep rows are diagnostic and excluded from action alignment",
            "before gaps are measured to action start_timestamp when present",
            "drag rows allow longer after gaps and inter-stack gap deltas because processors can choose different valid screenshots inside a longer drag window",
            "before screenshot timing deltas may pass when both before frames are visually equivalent and each stack is within max_before_gap",
        ],
    }

    if args.montage:
        create_montage(rows, rust[: len(rows)], python[: len(rows)], Path(args.montage))
        summary["montage"] = args.montage

    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rust-preprocessed", required=True)
    parser.add_argument("--python-preprocessed", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--montage")
    parser.add_argument("--max-after-gap", type=float, default=0.6)
    parser.add_argument("--drag-max-after-gap", type=float, default=1.25)
    parser.add_argument("--max-gap-delta", type=float, default=0.4)
    parser.add_argument("--drag-max-gap-delta", type=float, default=1.1)
    parser.add_argument("--max-before-gap", type=float, default=2.8)
    parser.add_argument("--max-before-delta", type=float, default=0.4)
    parser.add_argument("--max-visual-hash-distance", type=int, default=4)
    parser.add_argument("--max-visual-rmse", type=float, default=5.0)
    args = parser.parse_args()

    summary = compare(args)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(output)
    return 0 if summary["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
