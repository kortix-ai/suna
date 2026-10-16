#!/usr/bin/env python3
"""Validate Daytona Windows resource-soak summary JSON files."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


def add_error(errors: list[str], message: str) -> None:
    errors.append(message)


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


def nested(data: dict[str, Any], *keys: str) -> Any:
    value: Any = data
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def check_threshold(
    errors: list[str],
    metrics: dict[str, Any],
    thresholds: dict[str, Any],
    metric_key: str,
    threshold_key: str,
) -> None:
    metric = number(metrics.get(metric_key))
    threshold = number(thresholds.get(threshold_key))
    if metric is None:
        add_error(errors, f"missing numeric metric {metric_key}")
        return
    if threshold is not None and metric > threshold:
        add_error(errors, f"{metric_key}={metric} exceeds {threshold_key}={threshold}")


def validate_summary(path: Path, require_pass: bool) -> list[str]:
    errors: list[str] = []
    try:
        data = json.loads(path.read_text())
    except Exception as exc:  # pragma: no cover - used as CLI guard
        return [f"failed to parse JSON: {exc}"]

    if require_pass:
        if data.get("status") != "ok":
            add_error(errors, f"status is {data.get('status')!r}, expected 'ok'")
        if data.get("pass") is not True:
            add_error(errors, "summary pass is not true")
        pass_keys = ["resource_pass", "backend_pass", "recording_events_pass", "manifest_pass"]
        if data.get("a11y_pass") is not None:
            pass_keys.append("a11y_pass")
        for key in pass_keys:
            if data.get(key) is not True:
                add_error(errors, f"{key} is not true")

    metrics = data.get("metrics")
    thresholds = data.get("thresholds")
    command = data.get("command")
    idle_only = isinstance(command, dict) and command.get("idle_only") is True
    require_a11y = isinstance(command, dict) and command.get("require_a11y") is True
    if not isinstance(metrics, dict):
        add_error(errors, "missing metrics object")
        metrics = {}
    if not isinstance(thresholds, dict):
        add_error(errors, "missing thresholds object")
        thresholds = {}

    check_threshold(errors, metrics, thresholds, "max_working_set_mib", "max_working_set_mib")
    check_threshold(errors, metrics, thresholds, "working_set_growth_mib", "max_working_set_growth_mib")
    check_threshold(errors, metrics, thresholds, "avg_cpu_percent", "max_avg_cpu_percent")

    sample_count = number(data.get("sample_count"))
    if sample_count is None or sample_count <= 0:
        add_error(errors, "sample_count must be positive")

    recording = data.get("recording")
    if not isinstance(recording, dict):
        add_error(errors, "missing recording object")
        recording = {}
    required_recording_counts = ["raw_event_count", "processed_event_count", "screenshot_count"]
    if not idle_only:
        required_recording_counts.append("non_sleep_action_count")
    for key in required_recording_counts:
        count = number(recording.get(key))
        if count is None or count <= 0:
            add_error(errors, f"recording.{key} must be positive")
    if require_a11y and not idle_only:
        raw_a11y_count = number(recording.get("raw_a11y_event_count")) or 0
        accepted_a11y_count = number(recording.get("a11y_event_count")) or 0
        if raw_a11y_count <= 0 and accepted_a11y_count <= 0:
            add_error(errors, "recording.raw_a11y_event_count or recording.a11y_event_count must be positive")

    manifest = data.get("manifest_validation")
    if not isinstance(manifest, dict):
        add_error(errors, "missing manifest_validation object")
    else:
        expected_manifest_status = "skipped" if idle_only else "pass"
        if manifest.get("status") != expected_manifest_status:
            add_error(errors, f"manifest_validation.status is {manifest.get('status')!r}")
        expected_actions = manifest.get("expected_action_validation")
        if isinstance(expected_actions, dict):
            if expected_actions.get("status") != "pass":
                add_error(errors, f"expected_action_validation.status is {expected_actions.get('status')!r}")
            expected_count = expected_actions.get("expected_action_count")
            actual_count = expected_actions.get("actual_action_count")
            if expected_count != actual_count:
                add_error(errors, f"expected_action_count={expected_count} actual_action_count={actual_count}")

    if not isinstance(command, dict):
        add_error(errors, "missing command object")
        command = {}
    simulator_runs = command.get("simulator_runs")
    simulator_passes = command.get("simulator_passes")
    if not isinstance(simulator_passes, list):
        add_error(errors, "command.simulator_passes must be a list")
        simulator_passes = []
    if simulator_runs is not None and simulator_runs != len(simulator_passes):
        add_error(errors, f"simulator_runs={simulator_runs} but simulator_passes has {len(simulator_passes)} entries")
    if idle_only and simulator_runs not in (0, None):
        add_error(errors, f"idle-only summary has simulator_runs={simulator_runs}")

    previous_completed = command.get("started_utc")
    for index, simulator_pass in enumerate(simulator_passes, start=1):
        if not isinstance(simulator_pass, dict):
            add_error(errors, f"simulator pass {index} is not an object")
            continue
        elapsed = number(simulator_pass.get("elapsed_seconds"))
        if elapsed is None or elapsed <= 0:
            add_error(errors, f"simulator pass {index} elapsed_seconds must be positive")
        started = simulator_pass.get("started_utc")
        completed = simulator_pass.get("completed_utc")
        if not isinstance(started, str) or not started:
            add_error(errors, f"simulator pass {index} missing started_utc")
        if not isinstance(completed, str) or not completed:
            add_error(errors, f"simulator pass {index} missing completed_utc")
        if isinstance(started, str) and isinstance(completed, str) and completed < started:
            add_error(errors, f"simulator pass {index} completed before it started")
        if isinstance(previous_completed, str) and isinstance(started, str) and started < previous_completed:
            add_error(errors, f"simulator pass {index} started before previous pass completed")
        if isinstance(completed, str):
            previous_completed = completed

    command_elapsed = number(command.get("elapsed_seconds"))
    if command_elapsed is not None and command_elapsed <= 0:
        add_error(errors, "command.elapsed_seconds must be positive when present")
    command_completed = command.get("completed_utc")
    if isinstance(command_completed, str) and isinstance(previous_completed, str) and command_completed < previous_completed:
        add_error(errors, "command.completed_utc is before the last simulator pass completed")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("summaries", nargs="+", type=Path)
    parser.add_argument("--no-require-pass", action="store_true", help="validate shape without requiring pass=true")
    args = parser.parse_args()

    failed = False
    for summary in args.summaries:
        errors = validate_summary(summary, require_pass=not args.no_require_pass)
        if errors:
            failed = True
            print(f"{summary}: FAIL")
            for error in errors:
                print(f"  - {error}")
        else:
            print(f"{summary}: OK")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
