#!/usr/bin/env python3
"""Validate Windows Rust/Python accessibility JSONL artifacts."""

from __future__ import annotations

import argparse
import base64
import io
import json
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


def get_path(value: Any, path: list[str]) -> Any:
    current = value
    for part in path:
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def children(node: dict[str, Any]) -> list[dict[str, Any]]:
    value = node.get("children")
    return [child for child in value if isinstance(child, dict)] if isinstance(value, list) else []


def count_nodes(node: dict[str, Any]) -> int:
    own = 1 if node.get("name") or node.get("class_name") else 0
    return own + sum(count_nodes(child) for child in children(node))


def iter_nodes(node: dict[str, Any]):
    yield node
    for child in children(node):
        yield from iter_nodes(child)


def max_depth(node: dict[str, Any]) -> int:
    node_children = children(node)
    if not node_children:
        return 1
    return 1 + max(max_depth(child) for child in node_children)


def is_taskbar(node: dict[str, Any]) -> bool:
    return (
        node.get("class_name") == "Shell_TrayWnd"
        or node.get("friendly_class_name") == "Tray"
        or node.get("name") == "Taskbar"
    )


def primary_window(windows: list[dict[str, Any]]) -> dict[str, Any] | None:
    return next((window for window in windows if not is_taskbar(window)), None)


def decode_image(image: str):
    from PIL import Image

    return Image.open(io.BytesIO(base64.b64decode(image))).convert("RGB")


def dhash(image: str) -> int:
    img = decode_image(image).convert("L").resize((9, 8))
    bits = 0
    for y in range(8):
        for x in range(8):
            bits <<= 1
            if img.getpixel((x, y)) > img.getpixel((x + 1, y)):
                bits |= 1
    return bits


def hamming(left: int, right: int) -> int:
    return (left ^ right).bit_count()


def validate_bbox(
    prefix: str,
    node: dict[str, Any],
    screen_width: float | None,
    screen_height: float | None,
) -> list[str]:
    bbox = node.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4:
        return [f"{prefix}: missing or empty bbox"]
    if not all(isinstance(value, (int, float)) for value in bbox):
        return [f"{prefix}: bbox has non-numeric coordinates"]

    left, top, right, bottom = (float(value) for value in bbox)
    if right <= left or bottom <= top:
        return [f"{prefix}: bbox has non-positive size"]

    if screen_width is None or screen_height is None:
        return []
    if right <= 0 or bottom <= 0 or left >= screen_width or top >= screen_height:
        return [f"{prefix}: bbox is outside the visible screen"]
    return []


def validate_stack(name: str, events: list[dict[str, Any]], min_events: int) -> dict[str, Any]:
    issues: list[str] = []
    if len(events) < min_events:
        issues.append(f"{name}: expected at least {min_events} a11y event(s), found {len(events)}")

    event_summaries: list[dict[str, Any]] = []
    hashes: list[int] = []
    for index, event in enumerate(events):
        prefix = f"{name}[{index}]"
        if event_type(event) != "a11y+screenshot":
            issues.append(f"{prefix}: unexpected type {event_type(event)!r}")
        if "event_screenshot_hash" in event:
            issues.append(f"{prefix}: temporary event_screenshot_hash leaked into JSONL")

        metadata = get_path(event, ["data", "a11y", "metadata"])
        if not isinstance(metadata, dict):
            issues.append(f"{prefix}: missing data.a11y.metadata")
            metadata = {}
        platform = str(metadata.get("platform") or "")
        if platform.lower() != "windows":
            issues.append(f"{prefix}: expected Windows metadata platform, found {platform!r}")
        for key in ("timestamp", "collection_time_seconds", "screen_width", "screen_height"):
            if not isinstance(metadata.get(key), (int, float)):
                issues.append(f"{prefix}: metadata.{key} is missing or not numeric")
        screen_width = (
            metadata.get("screen_width")
            if isinstance(metadata.get("screen_width"), (int, float))
            else None
        )
        screen_height = (
            metadata.get("screen_height")
            if isinstance(metadata.get("screen_height"), (int, float))
            else None
        )

        windows_value = get_path(event, ["data", "a11y", "windows_data"])
        windows = [window for window in windows_value if isinstance(window, dict)] if isinstance(windows_value, list) else []
        if not windows:
            issues.append(f"{prefix}: windows_data is empty or missing")

        screenshot = get_path(event, ["data", "screenshot"])
        image = screenshot.get("image") if isinstance(screenshot, dict) else None
        if not isinstance(image, str) or not image:
            issues.append(f"{prefix}: screenshot image is missing")
        else:
            try:
                hashes.append(dhash(image))
            except Exception as exc:  # noqa: BLE001 - report malformed artifact context.
                issues.append(f"{prefix}: screenshot image did not decode: {exc}")

        primary = primary_window(windows)
        primary_nodes = count_nodes(primary) if primary else 0
        if primary is None:
            issues.append(f"{prefix}: no primary non-taskbar window")
        elif primary_nodes < 15:
            issues.append(f"{prefix}: primary window has {primary_nodes} nodes, expected >= 15")

        for window_index, window in enumerate(windows):
            for key in ("name", "class_name", "friendly_class_name", "bbox", "children"):
                if key not in window:
                    issues.append(f"{prefix}.windows_data[{window_index}]: missing {key}")
            for node_index, node in enumerate(iter_nodes(window)):
                issues.extend(
                    validate_bbox(
                        f"{prefix}.windows_data[{window_index}].node[{node_index}]",
                        node,
                        screen_width,
                        screen_height,
                    )
                )

        event_summaries.append(
            {
                "timestamp": event.get("timestamp"),
                "end_timestamp": event.get("end_timestamp"),
                "window_count": len(windows),
                "primary_name": primary.get("name") if primary else None,
                "primary_class_name": primary.get("class_name") if primary else None,
                "primary_node_count": primary_nodes,
                "max_depth": max((max_depth(window) for window in windows), default=0),
                "screenshot_width": screenshot.get("width") if isinstance(screenshot, dict) else None,
                "screenshot_height": screenshot.get("height") if isinstance(screenshot, dict) else None,
            }
        )

    duplicate_pairs = []
    for index, left in enumerate(hashes):
        for other_index, right in enumerate(hashes[:index]):
            distance = hamming(left, right)
            if distance < 20:
                duplicate_pairs.append({"left": other_index, "right": index, "distance": distance})
    if duplicate_pairs and len(events) > 1:
        issues.append(f"{name}: found accepted screenshot dHash pairs below distance 20")

    return {
        "count": len(events),
        "events": event_summaries,
        "duplicate_pairs_below_20": duplicate_pairs,
        "issues": issues,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rust-a11y", type=Path, required=True)
    parser.add_argument("--python-a11y", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--min-events", type=int, default=1)
    args = parser.parse_args()

    rust_events = read_jsonl(args.rust_a11y)
    python_events = read_jsonl(args.python_a11y)
    rust = validate_stack("rust", rust_events, args.min_events)
    python = validate_stack("python", python_events, args.min_events)

    issues = [*rust["issues"], *python["issues"]]
    summary = {
        "status": "ok" if not issues else "failed",
        "rust": rust,
        "python": python,
        "issues": issues,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(
        "A11Y_COMPARE "
        f"status={summary['status']} rust_events={rust['count']} python_events={python['count']}"
    )
    return 0 if not issues else 1


if __name__ == "__main__":
    raise SystemExit(main())
