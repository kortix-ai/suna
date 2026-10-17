#!/usr/bin/env python3
"""Print screenshot FPS and pipeline timing metrics for one recording."""

from __future__ import annotations

import argparse
import json
import math
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


def payload(event: dict[str, Any]) -> dict[str, Any]:
    value = event.get("args") or event.get("data") or {}
    return value if isinstance(value, dict) else {}


def timestamp(event: dict[str, Any]) -> float:
    value = event.get("timestamp")
    return float(value) if isinstance(value, (int, float)) else 0.0


def screenshots(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [event for event in events if event_type(event) == "screenshot"]


def numeric_values(events: list[dict[str, Any]], key: str) -> list[float]:
    values: list[float] = []
    for event in screenshots(events):
        value = payload(event).get(key)
        if isinstance(value, (int, float)):
            values.append(float(value))
    return values


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil((len(ordered) - 1) * fraction)))
    return ordered[index]


def cadence(events: list[dict[str, Any]]) -> dict[str, float | int | None]:
    shots = screenshots(events)
    gaps = [
        timestamp(current) - timestamp(previous)
        for previous, current in zip(shots, shots[1:])
    ]
    if not gaps:
        return {
            "screenshots": len(shots),
            "avg_gap": None,
            "min_gap": None,
            "max_gap": None,
            "fps": None,
        }
    total = sum(gaps)
    return {
        "screenshots": len(shots),
        "avg_gap": total / len(gaps),
        "min_gap": min(gaps),
        "max_gap": max(gaps),
        "fps": len(gaps) / total if total > 0 else None,
    }


def fmt_seconds(value: float | int | None) -> str:
    return f"{float(value):.3f}s" if isinstance(value, (int, float)) else "n/a"


def fmt_fps(value: float | int | None) -> str:
    return f"{float(value):.2f}" if isinstance(value, (int, float)) else "n/a"


def print_cadence(label: str, events: list[dict[str, Any]]) -> None:
    stats = cadence(events)
    print(
        f"{label}: screenshots={stats['screenshots']} "
        f"fps={fmt_fps(stats['fps'])} "
        f"avg_gap={fmt_seconds(stats['avg_gap'])} "
        f"min_gap={fmt_seconds(stats['min_gap'])} "
        f"max_gap={fmt_seconds(stats['max_gap'])}"
    )


def print_metric(label: str, values: list[float], unit: str = "ms") -> None:
    if not values:
        print(f"{label}: n/a")
        return
    p50 = percentile(values, 0.50)
    p95 = percentile(values, 0.95)
    print(
        f"{label}: count={len(values)} "
        f"avg={sum(values) / len(values):.1f}{unit} "
        f"p50={p50:.1f}{unit} "
        f"p95={p95:.1f}{unit} "
        f"max={max(values):.1f}{unit}"
    )


def print_capture_producer(raw_events: list[dict[str, Any]]) -> None:
    shots = screenshots(raw_events)
    frame_ids = numeric_values(raw_events, "frame_id")
    if not shots or not frame_ids:
        print("capture_producer: n/a")
        return
    first_id = int(min(frame_ids))
    last_id = int(max(frame_ids))
    produced = last_id - first_id + 1
    start_values = numeric_values(raw_events, "capture_started_timestamp")
    start_ts = min(start_values) if start_values else timestamp(shots[0])
    end_ts = timestamp(shots[-1])
    elapsed = max(0.0, end_ts - start_ts)
    fps = (produced - 1) / elapsed if elapsed > 0 and produced > 1 else None
    print(
        "capture_producer: "
        f"frames={produced} "
        f"encoded={len(shots)} "
        f"fps={fmt_fps(fps)} "
        f"elapsed={fmt_seconds(elapsed)}"
    )


def newest_recording_file(directory: Path, suffix: str) -> Path:
    candidates = sorted(directory.glob(f"*{suffix}"), key=lambda path: path.stat().st_mtime)
    if not candidates:
        raise SystemExit(f"no *{suffix} found in {directory}")
    return candidates[-1]


def analyze(raw_path: Path, processed_path: Path | None) -> None:
    raw_events = read_jsonl(raw_path)
    print(f"raw: {raw_path}")
    print_cadence("raw_screenshot_events", raw_events)
    print_capture_producer(raw_events)
    print_metric("capture_duration", numeric_values(raw_events, "capture_duration_ms"))
    print_metric("queue_wait", numeric_values(raw_events, "queue_wait_ms"))
    print_metric("encode_duration", numeric_values(raw_events, "encode_duration_ms"))
    print_metric("target_interval", numeric_values(raw_events, "target_interval_ms"))

    limited = sum(
        1
        for event in screenshots(raw_events)
        if payload(event).get("capture_limited") is True
    )
    dropped = numeric_values(raw_events, "dropped_raw_frames")
    queue_depth = numeric_values(raw_events, "raw_queue_depth")
    print(f"capture_limited_frames={limited}/{len(screenshots(raw_events))}")
    print(f"dropped_raw_frames={int(max(dropped)) if dropped else 0}")
    print(f"max_raw_queue_depth={int(max(queue_depth)) if queue_depth else 0}")

    if processed_path and processed_path.exists():
        processed_events = read_jsonl(processed_path)
        print(f"processed: {processed_path}")
        print_cadence("processed_screenshot_events", processed_events)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("raw", help="Raw JSONL file or recording directory")
    parser.add_argument("--preprocessed", help="Optional preprocessed JSONL file")
    args = parser.parse_args()

    raw_path = Path(args.raw)
    processed_path = Path(args.preprocessed) if args.preprocessed else None
    if raw_path.is_dir():
        directory = raw_path
        raw_path = newest_recording_file(directory, "_raw.jsonl")
        if processed_path is None:
            try:
                processed_path = newest_recording_file(directory, "_preprocessed.jsonl")
            except SystemExit:
                processed_path = None

    analyze(raw_path, processed_path)


if __name__ == "__main__":
    main()
