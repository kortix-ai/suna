import json
from pathlib import Path


def ensure_test_data(test_data_dir: Path) -> None:
    test_data_dir.mkdir(parents=True, exist_ok=True)
    scenarios = {
        "0_basic_recording_raw.jsonl": basic_recording,
        "1_typewrite_hotkey_recording_raw.jsonl": typewrite_hotkey_recording,
        "2_mouse_clicks_recording_raw.jsonl": mouse_clicks_recording,
        "3_modifiers_click_recording_raw.jsonl": modifiers_click_recording,
        "4_modifiers_drag_recording_raw.jsonl": modifiers_drag_recording,
        "5_function_keys_recording_raw.jsonl": function_keys_recording,
        "6_long_press_recording_raw.jsonl": long_press_recording,
        "7_sleep_screenshots_ts_recording_raw.jsonl": sleep_screenshots_recording,
        "8_screenshot_buffer_pressure_recording_raw.jsonl": screenshot_buffer_pressure_recording,
        "9_action_boundary_screenshot_sync_recording_raw.jsonl": action_boundary_screenshot_sync_recording,
    }
    for filename, factory in scenarios.items():
        path = test_data_dir / filename
        events = factory()
        with open(path, "w", encoding="utf-8") as f:
            for event in events:
                f.write(json.dumps(event, separators=(",", ":")) + "\n")


def screenshot(ts: float, label: str = "frame") -> dict:
    return {
        "type": "screenshot",
        "timestamp": ts,
        "data": {
            "image": label,
            "width": 100,
            "height": 100,
            "encoding": "jpg",
        },
    }


def key_down(ts: float, key: str) -> dict:
    return {"type": "key_down", "timestamp": ts, "data": {"key": key}}


def key_up(ts: float, key: str) -> dict:
    return {
        "type": "key_up",
        "timestamp": ts,
        "data": {"key": key, "hold_duration": 0.03},
    }


def key_press(ts: float, key: str) -> list[dict]:
    return [key_down(ts, key), key_up(ts + 0.03, key)]


def type_text(start: float, text: str, step: float = 0.08) -> list[dict]:
    events = []
    ts = start
    for ch in text:
        if ch.isalpha() and ch.isupper():
            events.append(key_down(ts, "shift"))
            events.extend(key_press(ts + 0.01, ch.lower()))
            events.append(key_up(ts + 0.05, "shift"))
        else:
            key = "space" if ch == " " else ch
            events.extend(key_press(ts, key))
        ts += step
    return events

def processor_checkpoint(ts: float) -> dict:
    return {"type": "checkpoint", "timestamp": ts, "data": {}}


def mouse_down(ts: float, x: float, y: float, button: str = "left") -> dict:
    return {
        "type": "mouse_down",
        "timestamp": ts,
        "data": {"x": x, "y": y, "button": button},
    }


def mouse_up(ts: float, x: float, y: float, button: str = "left") -> dict:
    return {
        "type": "mouse_up",
        "timestamp": ts,
        "data": {"x": x, "y": y, "button": button},
    }


def click(ts: float, x: float, y: float, button: str = "left") -> list[dict]:
    return [mouse_down(ts, x, y, button), mouse_up(ts + 0.05, x, y, button)]


def drag(ts: float, x1: float, y1: float, x2: float, y2: float, button: str = "left") -> list[dict]:
    return [
        mouse_down(ts, x1, y1, button),
        {"type": "mouse_move", "timestamp": ts + 0.2, "data": {"x": x2, "y": y2, "is_dragging": True}},
        mouse_up(ts + 0.45, x2, y2, button),
    ]


def basic_recording() -> list[dict]:
    events = [screenshot(0.10, "start")]
    events += click(0.20, 0.20, 0.20)
    events.append(screenshot(0.50, "after_click"))
    events.append(screenshot(5.90, "before_drag"))
    events += drag(6.00, 0.25, 0.25, 0.45, 0.45)
    events.append(screenshot(6.80, "after_drag"))
    events += key_press(7.00, "enter")
    events.append(screenshot(7.30, "after_enter"))
    return events


def typewrite_hotkey_recording() -> list[dict]:
    events = [screenshot(0.10, "start")]
    events += type_text(0.20, "o")
    events += key_press(0.50, "enter")
    events += key_press(0.80, "backspace")
    events += type_text(1.20, "Hello ")
    events += key_press(2.00, "tab")
    events += key_press(2.30, "capslock")
    events += type_text(2.60, "world")
    events += key_press(3.30, "esc")
    events += [key_down(3.70, "ctrl"), key_down(3.80, "s"), key_up(3.83, "s"), key_up(3.90, "ctrl")]
    events += [key_down(4.30, "alt"), key_down(4.40, "tab"), key_up(4.43, "tab"), key_up(4.50, "alt")]
    events += [key_down(4.90, "alt"), key_down(5.00, "tab"), key_up(5.03, "tab"), key_up(5.10, "alt")]
    events.append(screenshot(5.60, "end"))
    return events


def mouse_clicks_recording() -> list[dict]:
    events = [screenshot(0.10, "start")]
    events += click(0.20, 0.10, 0.10, "right")
    events += click(1.00, 0.20, 0.10, "middle")
    events += click(2.00, 0.30, 0.10)
    events += click(2.20, 0.30, 0.10)
    events += click(3.00, 0.40, 0.10)
    events += click(3.20, 0.40, 0.10)
    events += click(3.40, 0.40, 0.10)
    events += click(4.50, 0.50, 0.10)
    events += click(4.70, 0.50, 0.10)
    events += click(4.90, 0.50, 0.10)
    events += click(5.10, 0.50, 0.10)
    events.append(processor_checkpoint(6.00))
    events.append(screenshot(6.40, "end"))
    return events


def modifiers_click_recording() -> list[dict]:
    events = [screenshot(0.10, "start")]
    events += click(0.20, 0.10, 0.20)
    events.append(processor_checkpoint(0.90))
    events += [key_down(1.00, "ctrl")]
    events += click(1.10, 0.20, 0.20)
    events += click(1.80, 0.30, 0.20)
    events.append(processor_checkpoint(2.40))
    events += [key_up(2.50, "ctrl")]
    events += click(3.00, 0.40, 0.20)
    events += click(3.70, 0.50, 0.20)
    events.append(processor_checkpoint(4.30))
    events += [key_down(4.40, "shift")]
    events += click(4.50, 0.60, 0.20)
    events.append(processor_checkpoint(5.10))
    events += [key_up(5.20, "shift")]
    events.append(screenshot(5.60, "end"))
    return events


def modifiers_drag_recording() -> list[dict]:
    events = [screenshot(0.10, "start")]
    events += [key_down(0.50, "alt")]
    events += drag(0.60, 0.10, 0.20, 0.30, 0.35)
    events += [key_up(1.30, "alt")]
    events += [key_down(1.80, "ctrl")]
    events += drag(1.90, 0.20, 0.25, 0.45, 0.45)
    events += [key_up(2.70, "ctrl")]
    events += drag(3.20, 0.30, 0.30, 0.55, 0.55)
    events.append(screenshot(4.00, "end"))
    return events


def function_keys_recording() -> list[dict]:
    events = [screenshot(0.10, "start")]
    keys = [
        "volume_mute",
        "f1",
        "esc",
        "volume_down",
        "volume_up",
        "play_pause",
        "printscreen",
        "home",
        "insert",
        "delete",
    ]
    ts = 0.30
    for key in keys:
        events += key_press(ts, key)
        ts += 0.50
    events.append(screenshot(ts + 0.50, "end"))
    return events


def long_press_recording() -> list[dict]:
    events = [screenshot(0.10, "start")]
    events += type_text(0.20, "a" * 16, step=0.05)
    events += type_text(4.00, "b" * 31, step=0.05)
    events += key_press(7.00, "backspace")
    ts = 8.00
    for _ in range(18):
        events += key_press(ts, "backspace")
        ts += 0.10
    events.append(screenshot(ts + 0.50, "end"))
    return events


def sleep_screenshots_recording() -> list[dict]:
    events = [
        screenshot(4.95, "start"),
        screenshot(9.50, "before_first_action"),
    ]
    events += click(10.00, 0.25, 0.25)
    events += [
        screenshot(18.93, "after_first_action"),
        screenshot(21.50, "before_second_action"),
    ]
    events += click(22.00, 0.35, 0.35)
    events += [
        screenshot(22.50, "after_second_action"),
    ]
    events.append(processor_checkpoint(30.00))
    events.append(screenshot(30.40, "after_checkpoint"))
    return events

def screenshot_buffer_pressure_recording() -> list[dict]:
    events = [screenshot(0.10, "start")]
    for idx in range(65):
        events.append(screenshot(0.20 + idx * 0.10, f"idle-{idx}"))
    events += click(7.00, 0.25, 0.25)
    events.append(screenshot(7.60, "after_click"))
    return events

def action_boundary_screenshot_sync_recording() -> list[dict]:
    events = [screenshot(0.10, "start")]
    events += drag(1.00, 0.20, 0.20, 0.45, 0.45)
    events += [
        screenshot(1.55, "after_drag_early"),
        screenshot(1.80, "after_drag_best_before_click"),
        screenshot(1.92, "after_drag_too_close_to_click"),
    ]
    events += click(2.00, 0.55, 0.55)
    for idx in range(60):
        events.append(screenshot(2.10 + idx * 0.02, f"post_click_{idx:02}"))
    events.append(processor_checkpoint(4.00))
    return events
