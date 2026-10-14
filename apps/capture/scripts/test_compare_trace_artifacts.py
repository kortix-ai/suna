#!/usr/bin/env python3

import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).with_name("compare_trace_artifacts.py")


def load_module():
    spec = importlib.util.spec_from_file_location("compare_trace_artifacts", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    module = load_module()

    assert module.normalize_hotkey_keys(["ctrl", "Y"]) == ["ctrl", "Y"]
    assert module.normalize_hotkey_keys(["ctrl", "\u0019"]) == ["ctrl", "y"]
    assert module.normalize_hotkey_keys(["alt", "space"]) == ["alt", " "]
    assert module.normalize_key("backspace") == "backspace"
    assert module.normalize_key("\u007f") == "backspace"
    assert module.normalize_key("delete") == "delete"
    assert module.normalize_key("del") == "delete"

    expected = {"keys": ["ctrl", "Y"]}
    rust_actual = {"keys": ["ctrl", "Y"]}
    collapsed_actual = {"keys": ["ctrl", "y"]}
    control_byte_actual = {"keys": ["ctrl", "\u0019"]}

    assert module.compare_expected_arg_subset("hotkey", expected, rust_actual)[0]
    assert not module.compare_expected_arg_subset("hotkey", expected, collapsed_actual)[0]
    assert not module.compare_expected_arg_subset("hotkey", expected, control_byte_actual)[0]
    assert module.compare_expected_arg_subset("hotkey", {"keys": ["alt", "space"]}, {"keys": ["alt", " "]})[0]

    rust_events = [
        {"type": "sleep", "args": {"duration": 3}},
        {"type": "click", "args": {"x": 0.1, "y": 0.2, "clicks": 1, "button": "left", "modifiers": []}},
        {"type": "sleep", "args": {"duration": 3}},
        {"type": "press", "args": {"key": "backspace"}},
    ]
    python_events = [
        {"type": "sleep", "args": {"duration": 5}},
        {"type": "click", "args": {"x": 0.1, "y": 0.2, "clicks": 1, "button": "left", "modifiers": []}},
        {"type": "press", "args": {"key": "backspace"}},
    ]
    comparison = module.compare_action_arguments(rust_events, python_events)
    assert comparison["status"] == "pass", comparison
    assert comparison["rust_action_count"] == 2
    assert comparison["python_action_count"] == 2
    assert comparison["rust_sleep_count"] == 2
    assert comparison["python_sleep_count"] == 1

    sequence = module.compare_sequences(
        module.action_types(rust_events),
        module.action_types(python_events),
        {"click": {"click"}, "hotkey_or_press": {"hotkey", "press"}},
    )
    assert not sequence["action_type_sequence_exact"], sequence
    assert sequence["non_sleep_action_type_sequence_exact"], sequence

    print("compare_trace_artifacts tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
