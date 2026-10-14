#!/usr/bin/env python3
"""Stdlib smoke tests for compare_screenshot_sync.py."""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

from compare_screenshot_sync import before_gap_pass, compare


def main() -> int:
    test_start_timestamp_controls_before_gap_for_drag()
    test_strict_action_fails_when_after_screenshot_is_late()
    test_sleep_rows_do_not_shift_action_alignment()
    test_visual_equivalent_before_frames_allow_static_timing_delta()
    print("compare_screenshot_sync tests passed")
    return 0


def test_start_timestamp_controls_before_gap_for_drag() -> None:
    with tempfile.TemporaryDirectory(prefix="kortix-sync-test-") as tmp:
        tmp_dir = Path(tmp)
        rust = tmp_dir / "rust.jsonl"
        python = tmp_dir / "python.jsonl"
        write_jsonl(
            rust,
            [
                screenshot(9.0, "rust-before"),
                action("drag", 10.8, start=10.0),
                screenshot(11.9, "rust-after"),
            ],
        )
        write_jsonl(
            python,
            [
                screenshot(9.05, "python-before"),
                action("drag", 10.85, start=10.05),
                screenshot(11.95, "python-after"),
            ],
        )

        summary = compare(args(rust, python, max_before_gap=1.1))

    assert summary["status"] == "pass", summary
    assert summary["rows"][0]["rust_before_gap"] == 1.0
    assert summary["rows"][0]["python_before_gap"] == 1.0
    assert summary["rows"][0]["rust_after_gap"] == 1.1
    assert summary["rows"][0]["python_after_gap"] == 1.1


def test_strict_action_fails_when_after_screenshot_is_late() -> None:
    with tempfile.TemporaryDirectory(prefix="kortix-sync-test-") as tmp:
        tmp_dir = Path(tmp)
        rust = tmp_dir / "rust.jsonl"
        python = tmp_dir / "python.jsonl"
        late_trace = [
            screenshot(0.0, "before"),
            action("click", 1.0),
            screenshot(1.8, "after"),
        ]
        write_jsonl(rust, late_trace)
        write_jsonl(python, late_trace)

        summary = compare(args(rust, python, max_after_gap=0.6))

    assert summary["status"] == "fail", summary
    assert summary["rows"][0]["after_gap_pass"] is False
    assert summary["rows"][0]["before_gap_pass"] is True


def test_sleep_rows_do_not_shift_action_alignment() -> None:
    with tempfile.TemporaryDirectory(prefix="kortix-sync-test-") as tmp:
        tmp_dir = Path(tmp)
        rust = tmp_dir / "rust.jsonl"
        python = tmp_dir / "python.jsonl"
        write_jsonl(
            rust,
            [
                screenshot(0.0, "before-click"),
                action("sleep", 0.01),
                action("click", 1.0),
                screenshot(1.1, "after-click"),
                action("sleep", 1.11),
                action("press", 1.4),
                screenshot(1.5, "after-press"),
            ],
        )
        write_jsonl(
            python,
            [
                screenshot(0.0, "before-click"),
                action("click", 1.0),
                screenshot(1.1, "after-click"),
                action("press", 1.4),
                screenshot(1.5, "after-press"),
            ],
        )

        summary = compare(args(rust, python))

    assert summary["status"] == "pass", summary
    assert summary["aligned_triples"] == 2
    assert [row["rust_action"] for row in summary["rows"]] == ["click", "press"]

def test_visual_equivalent_before_frames_allow_static_timing_delta() -> None:
    values = args(Path("rust.jsonl"), Path("python.jsonl"))

    assert before_gap_pass(
        0.1,
        1.5,
        1.4,
        {"hash_distance": 1, "rmse": 2.0},
        values,
        max_gap_delta=0.4,
    )
    assert not before_gap_pass(
        0.1,
        1.5,
        1.4,
        {"hash_distance": 10, "rmse": 20.0},
        values,
        max_gap_delta=0.4,
    )

def args(rust: Path, python: Path, **overrides: float) -> argparse.Namespace:
    values = {
        "rust_preprocessed": str(rust),
        "python_preprocessed": str(python),
        "max_after_gap": 0.6,
        "drag_max_after_gap": 1.25,
        "max_gap_delta": 0.4,
        "drag_max_gap_delta": 1.1,
        "max_before_gap": 2.8,
        "max_before_delta": 0.4,
        "max_visual_hash_distance": 4,
        "max_visual_rmse": 5.0,
        "montage": None,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


def write_jsonl(path: Path, events: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(event, separators=(",", ":")) + "\n" for event in events),
        encoding="utf-8",
    )


def screenshot(timestamp: float, label: str) -> dict:
    return {
        "type": "screenshot",
        "timestamp": timestamp,
        "args": {"image": label, "width": 100, "height": 100, "encoding": "jpg"},
    }


def action(action_type: str, timestamp: float, start: float | None = None) -> dict:
    event = {"type": action_type, "timestamp": timestamp, "args": {}}
    if start is not None:
        event["start_timestamp"] = start
    return event


if __name__ == "__main__":
    raise SystemExit(main())
