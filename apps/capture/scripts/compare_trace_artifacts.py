#!/usr/bin/env python3
"""Compare Rust and Python real-trace artifacts without exact timestamp parity."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

IMAGE_KEYS = {"image", "image_base64", "screenshot", "bytes", "data_url"}
COORDINATE_TOLERANCE = 0.03
REQUIRED_FAMILIES = {
    "click": {"click"},
    "typewrite": {"typewrite", "write"},
    "drag": {"drag"},
    "scroll": {"scroll"},
    "hotkey_or_press": {"hotkey", "press"},
}


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number}: invalid JSONL: {exc}") from exc
            if isinstance(value, dict):
                events.append(value)
    return events


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        redacted = {}
        for key, item in value.items():
            if key.lower() in IMAGE_KEYS and isinstance(item, str):
                redacted[key] = f"<redacted:{len(item)}>"
            else:
                redacted[key] = redact(item)
        return redacted
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def event_type(event: dict[str, Any]) -> str:
    return str(event.get("type") or "")


def action_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [event for event in events if event_type(event) not in {"", "screenshot", "a11y+screenshot"}]


def action_types(events: list[dict[str, Any]], include_sleep: bool = True) -> list[str]:
    types = [canonical_action_type(event_type(event)) for event in action_events(events)]
    if include_sleep:
        return types
    return [name for name in types if name != "sleep"]


def canonical_action_type(name: str) -> str:
    return {"write": "typewrite"}.get(name, name)


def action_payload(event: dict[str, Any]) -> dict[str, Any]:
    value = event.get("args") or event.get("data") or {}
    return value if isinstance(value, dict) else {}


def normalize_key(value: Any) -> str:
    key = str(value).lower()
    aliases = {
        "\t": "tab",
        "\n": "enter",
        "\r": "enter",
        "\x1b": "escape",
        "\x7f": "backspace",
        "bksp": "backspace",
        "del": "delete",
        "return": "enter",
        "space": " ",
        "spacebar": " ",
        "control": "ctrl",
        "ctl": "ctrl",
        "cmd": "windows",
        "win": "windows",
        "command": "windows",
    }
    if key in aliases:
        return aliases[key]
    if len(key) == 1 and 1 <= ord(key) <= 26:
        return chr(ord("a") + ord(key) - 1)
    return key


def normalize_keys(value: Any) -> list[str]:
    if isinstance(value, list):
        return [normalize_key(item) for item in value]
    if isinstance(value, str):
        if "+" in value:
            return [normalize_key(item.strip()) for item in value.split("+") if item.strip()]
        return [normalize_key(value)]
    return []


def normalize_key_for_hotkey(value: Any) -> str:
    raw = str(value)
    key = raw.lower()
    aliases = {
        "\t": "tab",
        "\n": "enter",
        "\r": "enter",
        "\x1b": "escape",
        "\x7f": "backspace",
        "bksp": "backspace",
        "del": "delete",
        "return": "enter",
        "space": " ",
        "spacebar": " ",
        "control": "ctrl",
        "ctl": "ctrl",
        "cmd": "windows",
        "win": "windows",
        "command": "windows",
    }
    if key in aliases:
        return aliases[key]
    if len(raw) == 1 and 1 <= ord(raw) <= 26:
        return chr(ord("a") + ord(raw) - 1)
    if len(raw) == 1 and raw.isalpha():
        return raw
    return key


def normalize_hotkey_keys(value: Any) -> list[str]:
    if isinstance(value, list):
        return [normalize_key_for_hotkey(item) for item in value]
    if isinstance(value, str):
        if "+" in value:
            return [normalize_key_for_hotkey(item.strip()) for item in value.split("+") if item.strip()]
        return [normalize_key_for_hotkey(value)]
    return []


def normalized_modifiers(value: Any) -> list[str]:
    return sorted(normalize_keys(value))


def expected_families(args: argparse.Namespace) -> dict[str, set[str]]:
    requested = families_from_args(args)
    if requested is None:
        requested = families_from_manifests(args)
    if requested is None:
        return REQUIRED_FAMILIES
    unknown = sorted(set(requested) - set(REQUIRED_FAMILIES))
    if unknown:
        raise ValueError(f"unknown expected action families: {', '.join(unknown)}")
    return {family: REQUIRED_FAMILIES[family] for family in requested}

def families_from_args(args: argparse.Namespace) -> list[str] | None:
    value = getattr(args, "expected_families", None)
    if not value:
        return None
    return [item.strip() for item in value.split(",") if item.strip()]

def families_from_manifests(args: argparse.Namespace) -> list[str] | None:
    values: list[list[str]] = []
    for attr in ("rust_manifest", "python_manifest"):
        path_value = getattr(args, attr, None)
        if not path_value:
            continue
        path = Path(path_value)
        if not path.exists():
            continue
        manifest = json.loads(path.read_text(encoding="utf-8-sig"))
        families = manifest.get("expected_action_families")
        if isinstance(families, list) and all(isinstance(item, str) for item in families):
            values.append(families)
    if not values:
        return None
    first = values[0]
    for value in values[1:]:
        if set(value) != set(first):
            raise ValueError(
                "manifest expected_action_families mismatch: "
                f"{sorted(first)} != {sorted(value)}"
            )
    return first

def expected_actions_from_manifests(args: argparse.Namespace) -> list[dict[str, Any]] | None:
    values: list[list[dict[str, Any]]] = []
    for attr in ("rust_manifest", "python_manifest"):
        path_value = getattr(args, attr, None)
        if not path_value:
            continue
        path = Path(path_value)
        if not path.exists():
            continue
        manifest = json.loads(path.read_text(encoding="utf-8-sig"))
        actions = manifest.get("expected_actions")
        if isinstance(actions, list) and all(isinstance(item, dict) for item in actions):
            values.append(actions)
    if not values:
        return None
    first = values[0]
    for value in values[1:]:
        if value != first:
            raise ValueError("manifest expected_actions mismatch between Rust and Python captures")
    return first

def family_presence(types: list[str], required_families: dict[str, set[str]]) -> dict[str, bool]:
    type_set = set(types)
    return {
        family: bool(type_set.intersection(accepted))
        for family, accepted in required_families.items()
    }


def expected_actions_require_keyboard(expected_actions: list[dict[str, Any]] | None) -> bool:
    for action in expected_actions or []:
        args = action.get("args") if isinstance(action, dict) else None
        if not isinstance(args, dict):
            continue
        if args.get("modifiers"):
            return True
        if action.get("type") in {"hotkey", "press", "typewrite"}:
            return True
    return False


def raw_summary(
    events: list[dict[str, Any]],
    required_families: dict[str, set[str]],
    expected_actions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    counts = Counter(event_type(event) for event in events if event_type(event))
    coverage = {
        "mouse": any(name.startswith("mouse_") for name in counts),
        "keyboard": any(name.startswith("key_") for name in counts),
        "screenshot": counts.get("screenshot", 0) > 0,
        "scroll": counts.get("mouse_scroll", 0) > 0,
        "drag_signal": any(
            event_type(event) == "mouse_move"
            and bool((event.get("data") or {}).get("is_dragging"))
            for event in events
        ),
    }
    required_coverage = {"screenshot": True}
    if any(family in required_families for family in ("click", "drag", "scroll")):
        required_coverage["mouse"] = True
    if (
        any(family in required_families for family in ("typewrite", "hotkey_or_press"))
        or expected_actions_require_keyboard(expected_actions)
    ):
        required_coverage["keyboard"] = True
    if "scroll" in required_families:
        required_coverage["scroll"] = True
    if "drag" in required_families:
        required_coverage["drag_signal"] = True
    coverage_pass = all(coverage[name] for name, required in required_coverage.items() if required)
    return {
        "event_count": len(events),
        "types": dict(sorted(counts.items())),
        "coverage": coverage,
        "required_coverage": sorted(name for name, required in required_coverage.items() if required),
        "coverage_pass": coverage_pass,
    }


def triples(events: list[dict[str, Any]]) -> int:
    total = 0
    for index in range(len(events) - 2):
        left, middle, right = events[index : index + 3]
        if event_type(left) == "screenshot" and event_type(middle) != "screenshot" and event_type(right) == "screenshot":
            total += 1
    return total


def action_screenshot_pairs(events: list[dict[str, Any]]) -> int:
    total = 0
    for index in range(len(events) - 1):
        if event_type(events[index]) != "screenshot" and event_type(events[index + 1]) == "screenshot":
            total += 1
    return total


def processed_summary(events: list[dict[str, Any]], required_families: dict[str, set[str]]) -> dict[str, Any]:
    types = action_types(events)
    presence = family_presence(types, required_families)
    screenshot_count = sum(1 for event in events if event_type(event) == "screenshot")
    triple_count = triples(events)
    return {
        "event_count": len(events),
        "action_count": len(types),
        "screenshot_count": screenshot_count,
        "action_types": types,
        "required_action_families": presence,
        "required_actions_pass": all(presence.values()),
        "action_screenshot_pairs": action_screenshot_pairs(events),
        "screenshot_action_screenshot_triples": triple_count,
        "triples_pass": triple_count > 0,
    }


def compare_sequences(
    rust_types: list[str],
    python_types: list[str],
    required_families: dict[str, set[str]],
) -> dict[str, Any]:
    rust_non_sleep = [name for name in rust_types if name != "sleep"]
    python_non_sleep = [name for name in python_types if name != "sleep"]
    rust_families = family_presence(rust_non_sleep, required_families)
    python_families = family_presence(python_non_sleep, required_families)
    shared = sorted(set(rust_types).intersection(python_types))
    return {
        "action_type_sequence_exact": rust_types == python_types,
        "non_sleep_action_type_sequence_exact": rust_non_sleep == python_non_sleep,
        "rust_non_sleep_action_types": rust_non_sleep,
        "python_non_sleep_action_types": python_non_sleep,
        "rust_sleep_count": rust_types.count("sleep"),
        "python_sleep_count": python_types.count("sleep"),
        "shared_action_types": shared,
        "rust_only_action_types": sorted(set(rust_types) - set(python_types)),
        "python_only_action_types": sorted(set(python_types) - set(rust_types)),
        "required_family_match": {
            family: rust_families[family] == python_families[family]
            for family in required_families
        },
    }


def number(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    return None


def coordinate_deltas(
    rust_args: dict[str, Any],
    python_args: dict[str, Any],
    keys: list[str],
) -> tuple[dict[str, float | None], bool]:
    deltas: dict[str, float | None] = {}
    passed = True
    for key in keys:
        rust_value = number(rust_args.get(key))
        python_value = number(python_args.get(key))
        if rust_value is None or python_value is None:
            deltas[key] = None
            passed = False
            continue
        delta = abs(rust_value - python_value)
        deltas[key] = round(delta, 4)
        passed = passed and delta <= COORDINATE_TOLERANCE
    return deltas, passed


def text_similarity(left: str, right: str) -> float:
    return round(SequenceMatcher(None, left, right).ratio(), 4)


def compare_action_row(index: int, rust: dict[str, Any] | None, python: dict[str, Any] | None) -> dict[str, Any]:
    rust_type = canonical_action_type(event_type(rust or {}))
    python_type = canonical_action_type(event_type(python or {}))
    row: dict[str, Any] = {
        "index": index,
        "rust_type": rust_type,
        "python_type": python_type,
        "type_match": bool(rust and python and rust_type == python_type),
        "strict": rust_type != "sleep" and python_type != "sleep",
    }
    if not rust or not python:
        row["normalized_match"] = False
        row["reason"] = "missing action"
        return row

    rust_args = action_payload(rust)
    python_args = action_payload(python)
    row["rust_args"] = rust_args
    row["python_args"] = python_args
    if not row["type_match"]:
        row["normalized_match"] = False
        return row

    if rust_type == "typewrite":
        rust_text = str(rust_args.get("text", ""))
        python_text = str(python_args.get("text", ""))
        row.update(
            {
                "rust_text": rust_text,
                "python_text": python_text,
                "text_exact": rust_text == python_text,
                "text_similarity": text_similarity(rust_text, python_text),
                "normalized_match": rust_text == python_text,
            }
        )
    elif rust_type == "press":
        rust_key = normalize_key(rust_args.get("key", ""))
        python_key = normalize_key(python_args.get("key", ""))
        row.update(
            {
                "rust_key": rust_key,
                "python_key": python_key,
                "normalized_match": rust_key == python_key,
            }
        )
    elif rust_type == "hotkey":
        rust_keys = normalize_hotkey_keys(rust_args.get("keys"))
        python_keys = normalize_hotkey_keys(python_args.get("keys"))
        row.update(
            {
                "rust_keys": rust_keys,
                "python_keys": python_keys,
                "raw_keys_exact": rust_args.get("keys") == python_args.get("keys"),
                "normalized_match": rust_keys == python_keys,
            }
        )
    elif rust_type == "click":
        deltas, coords_pass = coordinate_deltas(rust_args, python_args, ["x", "y"])
        row.update(
            {
                "coordinate_deltas": deltas,
                "coordinate_tolerance": COORDINATE_TOLERANCE,
                "normalized_match": (
                    coords_pass
                    and rust_args.get("button") == python_args.get("button")
                    and rust_args.get("clicks") == python_args.get("clicks")
                    and normalized_modifiers(rust_args.get("modifiers"))
                    == normalized_modifiers(python_args.get("modifiers"))
                ),
            }
        )
    elif rust_type == "drag":
        deltas, coords_pass = coordinate_deltas(
            rust_args,
            python_args,
            ["start_x", "start_y", "end_x", "end_y"],
        )
        rust_duration = number(rust_args.get("duration")) or 0.0
        python_duration = number(python_args.get("duration")) or 0.0
        row.update(
            {
                "coordinate_deltas": deltas,
                "coordinate_tolerance": COORDINATE_TOLERANCE,
                "duration_delta": round(abs(rust_duration - python_duration), 4),
                "normalized_match": (
                    coords_pass
                    and rust_args.get("button") == python_args.get("button")
                    and normalized_modifiers(rust_args.get("modifiers"))
                    == normalized_modifiers(python_args.get("modifiers"))
                ),
            }
        )
    elif rust_type == "scroll":
        deltas, coords_pass = coordinate_deltas(rust_args, python_args, ["x", "y"])
        row.update(
            {
                "coordinate_deltas": deltas,
                "coordinate_tolerance": COORDINATE_TOLERANCE,
                "normalized_match": coords_pass and rust_args.get("clicks") == python_args.get("clicks"),
            }
        )
    elif rust_type == "sleep":
        rust_duration = number(rust_args.get("duration")) or 0.0
        python_duration = number(python_args.get("duration")) or 0.0
        row.update(
            {
                "duration_delta": round(abs(rust_duration - python_duration), 4),
                "normalized_match": True,
                "note": "sleep duration is diagnostic only",
            }
        )
    else:
        row["normalized_match"] = rust_args == python_args

    return row


def compare_action_arguments(
    rust_events: list[dict[str, Any]],
    python_events: list[dict[str, Any]],
) -> dict[str, Any]:
    rust_all_actions = action_events(rust_events)
    python_all_actions = action_events(python_events)
    rust_actions = non_sleep_actions(rust_events)
    python_actions = non_sleep_actions(python_events)
    rows = [
        compare_action_row(
            index + 1,
            rust_actions[index] if index < len(rust_actions) else None,
            python_actions[index] if index < len(python_actions) else None,
        )
        for index in range(max(len(rust_actions), len(python_actions)))
    ]
    strict_mismatches = [row for row in rows if row["strict"] and not row["normalized_match"]]
    return {
        "status": "pass" if len(rust_actions) == len(python_actions) and not strict_mismatches else "fail",
        "rust_action_count": len(rust_actions),
        "python_action_count": len(python_actions),
        "rust_total_action_count": len(rust_all_actions),
        "python_total_action_count": len(python_all_actions),
        "rust_sleep_count": len(rust_all_actions) - len(rust_actions),
        "python_sleep_count": len(python_all_actions) - len(python_actions),
        "strict_mismatch_count": len(strict_mismatches),
        "strict_mismatches": strict_mismatches,
        "rows": rows,
        "notes": [
            "control-key byte aliases such as ctrl+\\x01 are normalized for hotkey comparison",
            "letter case is preserved for hotkeys so Ctrl+Shift+letter does not collapse into Ctrl+letter",
            "sleep rows are diagnostic and excluded from strict argument alignment",
        ],
    }


def non_sleep_actions(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        event
        for event in action_events(events)
        if canonical_action_type(event_type(event)) != "sleep"
    ]


def compare_expected_arg_subset(
    expected_type: str,
    expected_args: dict[str, Any],
    actual_args: dict[str, Any],
) -> tuple[bool, dict[str, Any]]:
    details: dict[str, Any] = {}
    if expected_type == "typewrite":
        expected_text = str(expected_args.get("text", ""))
        actual_text = str(actual_args.get("text", ""))
        details.update(
            {
                "expected_text": expected_text,
                "actual_text": actual_text,
                "text_similarity": text_similarity(expected_text, actual_text),
            }
        )
        return expected_text == actual_text, details

    if expected_type == "press":
        expected_key = normalize_key(expected_args.get("key", ""))
        actual_key = normalize_key(actual_args.get("key", ""))
        details.update({"expected_key": expected_key, "actual_key": actual_key})
        if "count" in expected_args:
            expected_count = int(expected_args.get("count") or 1)
            actual_count = int(actual_args.get("count") or 1)
            details.update({"expected_count": expected_count, "actual_count": actual_count})
            return expected_key == actual_key and expected_count == actual_count, details
        return expected_key == actual_key, details

    if expected_type == "hotkey":
        expected_keys = normalize_hotkey_keys(expected_args.get("keys"))
        actual_keys = normalize_hotkey_keys(actual_args.get("keys"))
        details.update({"expected_keys": expected_keys, "actual_keys": actual_keys})
        return expected_keys == actual_keys, details

    if expected_type == "click":
        deltas, coords_pass = coordinate_deltas(expected_args, actual_args, ["x", "y"])
        details.update({"coordinate_deltas": deltas, "coordinate_tolerance": COORDINATE_TOLERANCE})
        return (
            coords_pass
            and expected_args.get("button") == actual_args.get("button")
            and expected_args.get("clicks") == actual_args.get("clicks")
            and normalized_modifiers(expected_args.get("modifiers")) == normalized_modifiers(actual_args.get("modifiers"))
        ), details

    if expected_type == "drag":
        deltas, coords_pass = coordinate_deltas(
            expected_args,
            actual_args,
            ["start_x", "start_y", "end_x", "end_y"],
        )
        details.update({"coordinate_deltas": deltas, "coordinate_tolerance": COORDINATE_TOLERANCE})
        return (
            coords_pass
            and expected_args.get("button") == actual_args.get("button")
            and normalized_modifiers(expected_args.get("modifiers")) == normalized_modifiers(actual_args.get("modifiers"))
        ), details

    if expected_type == "scroll":
        keys = ["x", "y"] if "x" in expected_args and "y" in expected_args else []
        deltas, coords_pass = coordinate_deltas(expected_args, actual_args, keys) if keys else ({}, True)
        details.update({"coordinate_deltas": deltas, "coordinate_tolerance": COORDINATE_TOLERANCE})
        return coords_pass and expected_args.get("clicks") == actual_args.get("clicks"), details

    return expected_args == actual_args, details


def compare_expected_row(
    index: int,
    expected: dict[str, Any] | None,
    actual: dict[str, Any] | None,
) -> dict[str, Any]:
    expected_type = canonical_action_type(str((expected or {}).get("type") or ""))
    actual_type = canonical_action_type(event_type(actual or {}))
    row: dict[str, Any] = {
        "index": index,
        "expected_type": expected_type,
        "actual_type": actual_type,
        "type_match": bool(expected and actual and expected_type == actual_type),
    }
    if not expected or not actual:
        row["match"] = False
        row["reason"] = "missing expected or actual action"
        return row

    expected_args = expected.get("args") if isinstance(expected.get("args"), dict) else {}
    actual_args = action_payload(actual)
    row["expected_args"] = expected_args
    row["actual_args"] = actual_args
    if not row["type_match"]:
        row["match"] = False
        return row

    args_match, details = compare_expected_arg_subset(expected_type, expected_args, actual_args)
    row.update(details)
    row["match"] = args_match
    return row


def compare_expected_actions(
    expected_actions: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    actual_actions = non_sleep_actions(events)
    rows = [
        compare_expected_row(
            index + 1,
            expected_actions[index] if index < len(expected_actions) else None,
            actual_actions[index] if index < len(actual_actions) else None,
        )
        for index in range(max(len(expected_actions), len(actual_actions)))
    ]
    mismatches = [row for row in rows if not row["match"]]
    return {
        "status": "pass" if len(expected_actions) == len(actual_actions) and not mismatches else "fail",
        "expected_action_count": len(expected_actions),
        "actual_action_count": len(actual_actions),
        "mismatch_count": len(mismatches),
        "mismatches": mismatches,
        "rows": rows,
        "notes": ["sleep actions are excluded from manifest expected-action validation"],
    }


def load_all(args: argparse.Namespace) -> dict[str, list[dict[str, Any]]]:
    return {
        "rust_raw": read_jsonl(Path(args.rust_raw)),
        "rust_preprocessed": read_jsonl(Path(args.rust_preprocessed)),
        "python_raw": read_jsonl(Path(args.python_raw)),
        "python_preprocessed": read_jsonl(Path(args.python_preprocessed)),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rust-raw", required=True)
    parser.add_argument("--rust-preprocessed", required=True)
    parser.add_argument("--python-raw", required=True)
    parser.add_argument("--python-preprocessed", required=True)
    parser.add_argument("--rust-manifest")
    parser.add_argument("--python-manifest")
    parser.add_argument(
        "--expected-families",
        help="Comma-separated required action families. Defaults to manifest expected_action_families, then all known families.",
    )
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    summary: dict[str, Any] = {"status": "fail", "errors": []}
    try:
        required_families = expected_families(args)
        expected_actions = expected_actions_from_manifests(args)
        artifacts = load_all(args)
        rust_raw = raw_summary(artifacts["rust_raw"], required_families, expected_actions)
        python_raw = raw_summary(artifacts["python_raw"], required_families, expected_actions)
        rust_processed = processed_summary(artifacts["rust_preprocessed"], required_families)
        python_processed = processed_summary(artifacts["python_preprocessed"], required_families)
        sequence = compare_sequences(
            rust_processed["action_types"],
            python_processed["action_types"],
            required_families,
        )
        argument_comparison = compare_action_arguments(
            artifacts["rust_preprocessed"],
            artifacts["python_preprocessed"],
        )
        expected_action_validation = None
        if expected_actions is not None:
            expected_action_validation = {
                "rust": compare_expected_actions(expected_actions, artifacts["rust_preprocessed"]),
                "python": compare_expected_actions(expected_actions, artifacts["python_preprocessed"]),
            }

        pass_checks = {
            "rust_raw_coverage": rust_raw["coverage_pass"],
            "python_raw_coverage": python_raw["coverage_pass"],
            "rust_required_actions": rust_processed["required_actions_pass"],
            "python_required_actions": python_processed["required_actions_pass"],
            "rust_triples": rust_processed["triples_pass"],
            "python_triples": python_processed["triples_pass"],
            "action_type_sequence": sequence["non_sleep_action_type_sequence_exact"],
            "required_family_match": all(sequence["required_family_match"].values()),
        }
        if expected_action_validation is not None:
            pass_checks["rust_expected_actions"] = expected_action_validation["rust"]["status"] == "pass"
        summary.update(
            {
                "status": "pass" if all(pass_checks.values()) else "fail",
                "pass_checks": pass_checks,
                "rust": {"raw": rust_raw, "processed": rust_processed},
                "python": {"raw": python_raw, "processed": python_processed},
                "sequence_comparison": sequence,
                "argument_comparison": argument_comparison,
                "expected_action_validation": expected_action_validation,
                "expected_action_families": sorted(required_families),
                "redaction": "screenshot image/string payloads ignored",
            }
        )
    except Exception as exc:  # Keep output machine-readable even on parser/data failures.
        summary["errors"].append(str(exc))

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(redact(summary), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(output)
    return 0 if summary.get("status") == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
