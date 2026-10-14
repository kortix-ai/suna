#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This verifier must run on macOS because it checks native event taps, screenshots, and AX snapshots." >&2
  exit 1
fi

cargo_bin="${CARGO:-cargo}"
if ! "$cargo_bin" --version >/dev/null 2>&1; then
  echo "cargo is required. Install Rust first or set CARGO to a working cargo binary." >&2
  exit 1
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc is required for the local CGEvent simulator." >&2
  exit 1
fi

artifact_dir="${MACOS_TRACE_ARTIFACT_DIR:-artifacts/macos-trace-simulation}"
recordings_dir="$artifact_dir/recordings"
config_path="$artifact_dir/config.yaml"
mkdir -p "$recordings_dir"

a11y_enabled="${MACOS_TRACE_A11Y_ENABLED:-0}"
case "$a11y_enabled" in
  1 | true | TRUE | yes | YES | on | ON)
    a11y_enabled_yaml=true
    ;;
  0 | false | FALSE | no | NO | off | OFF)
    a11y_enabled_yaml=false
    ;;
  *)
    echo "MACOS_TRACE_A11Y_ENABLED must be 0/1, true/false, yes/no, or on/off." >&2
    exit 1
    ;;
esac

cat >"$config_path" <<YAML
screen_recorder:
  fps: 4
  burst_fps: 8
  burst_after_seconds: 1
  idle_interval_seconds: 1
  idle_after_seconds: 3
  quality: 60
  scale_factor: 0.5
a11y_recorder:
  enabled: $a11y_enabled_yaml
  interval_seconds: 2
  max_depth: 12
  max_children: 200
recordings:
  directory: "$PWD/$recordings_dir"
  stop_screenshot_delay_ms: 700
YAML

echo "MACOS_TRACE_STEP cargo_build"
"$cargo_bin" build --features native-recorders --bin kortix-backend
backend_bin="target/debug/kortix-backend"

port="${LOCAL_PORT:-18292}"
name="macos_trace_$(date +%Y%m%d_%H%M%S)"
recording_dir="$recordings_dir/$name"
log_path="$artifact_dir/backend.log"
text_path="$artifact_dir/textedit-trace.txt"
swift_source="$artifact_dir/macos_trace_simulator.swift"
sim_bin="$artifact_dir/macos_trace_simulator"
printf "kortix macOS trace simulation\n" >"$text_path"

osascript <<'APPLESCRIPT' >/dev/null 2>&1 || true
tell application "TextEdit" to quit saving no
APPLESCRIPT

cleanup() {
  if [ -n "${backend_pid:-}" ] && kill -0 "$backend_pid" >/dev/null 2>&1; then
    kill "$backend_pid" >/dev/null 2>&1 || true
    wait "$backend_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "MACOS_TRACE_STEP start_backend port=$port"
KORTIX_CONFIG="$PWD/$config_path" \
LOCAL_PORT="$port" \
"$backend_bin" --serve-http >"$log_path" 2>&1 &
backend_pid=$!

for _ in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$backend_pid" >/dev/null 2>&1; then
    echo "Backend exited during startup. Last log lines:" >&2
    tail -n 100 "$log_path" >&2 || true
    exit 1
  fi
  sleep 0.25
done

curl -fsS "http://127.0.0.1:$port/health" >/dev/null

echo "MACOS_TRACE_STEP start_recording name=$name"
curl -fsS \
  -X POST "http://127.0.0.1:$port/recording/start" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$name\",\"enable_audio\":false,\"save_raw_data\":true}" \
  >"$artifact_dir/start-response.json"

echo "MACOS_TRACE_STEP prepare_textedit"
open -a TextEdit "$PWD/$text_path"
sleep 1
bounds_csv="$(osascript <<'APPLESCRIPT'
set deadline to (current date) + 10
tell application "System Events"
  repeat until exists process "TextEdit"
    if (current date) > deadline then error "TextEdit process did not appear"
    delay 0.1
  end repeat
  tell process "TextEdit"
    repeat until exists window 1
      if (current date) > deadline then error "TextEdit window did not appear"
      delay 0.1
    end repeat
    set frontmost to true
    set position of window 1 to {160, 140}
    set size of window 1 to {800, 480}
    delay 0.3
    set p to position of window 1
    set s to size of window 1
    set pidValue to unix id
    return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text) & "," & (pidValue as text)
  end tell
end tell
APPLESCRIPT
)"

read -r text_x text_y click_x click_y double_x double_y drag_start_x drag_start_y drag_end_x drag_end_y scroll_x scroll_y right_x right_y middle_x middle_y target_pid < <(
  python3 - "$bounds_csv" <<'PY'
import sys

parts = [part.strip() for part in sys.argv[1].split(",")]
x, y, w, h = [float(part) for part in parts[:4]]
pid = int(parts[4])
text_x = x + w * 0.50
text_y = y + h * 0.38
click_x = x + w * 0.50
click_y = y + h * 0.55
double_x = x + w * 0.42
double_y = y + h * 0.58
drag_start_x = x + w * 0.35
drag_end_x = x + w * 0.65
drag_y = y + h * 0.62
scroll_x = x + w * 0.70
scroll_y = y + h * 0.55
right_x = x + w * 0.48
right_y = y + h * 0.50
middle_x = x + w * 0.53
middle_y = y + h * 0.50
print(
    f"{text_x:.1f} {text_y:.1f} "
    f"{click_x:.1f} {click_y:.1f} "
    f"{double_x:.1f} {double_y:.1f} "
    f"{drag_start_x:.1f} {drag_y:.1f} {drag_end_x:.1f} {drag_y:.1f} "
    f"{scroll_x:.1f} {scroll_y:.1f} "
    f"{right_x:.1f} {right_y:.1f} "
    f"{middle_x:.1f} {middle_y:.1f} "
    f"{pid}"
)
PY
)

cat >"$swift_source" <<'SWIFT'
import CoreGraphics
import Foundation

func numberArg(_ index: Int) -> Double {
    guard CommandLine.arguments.count > index,
          let value = Double(CommandLine.arguments[index]) else {
        fputs("missing numeric argument \(index)\n", stderr)
        exit(2)
    }
    return value
}

let clickX = numberArg(1)
let clickY = numberArg(2)
let textX = clickX
let textY = clickY
let commandClickX = numberArg(3)
let commandClickY = numberArg(4)
let doubleClickX = numberArg(5)
let doubleClickY = numberArg(6)
let dragStartX = numberArg(7)
let dragStartY = numberArg(8)
let dragEndX = numberArg(9)
let dragEndY = numberArg(10)
let scrollX = numberArg(11)
let scrollY = numberArg(12)
let rightClickX = numberArg(13)
let rightClickY = numberArg(14)
let middleClickX = numberArg(15)
let middleClickY = numberArg(16)
let targetPid = Int64(numberArg(17))
let source = CGEventSource(stateID: .hidSystemState)

func pauseMs(_ ms: UInt32) {
    usleep(ms * 1000)
}

func post(_ event: CGEvent) {
    if targetPid > 0 {
        event.setIntegerValueField(CGEventField(rawValue: 89)!, value: targetPid)
    }
    event.post(tap: .cghidEventTap)
}

func keyCode(_ name: String) -> CGKeyCode {
    switch name.lowercased() {
    case "a": return 0x00
    case "3": return 0x14
    case "return", "enter": return 0x24
    case "backspace", "delete": return 0x33
    case "escape", "esc": return 0x35
    default:
        fputs("unknown key \(name)\n", stderr)
        exit(2)
    }
}

func postKey(_ name: String, flags: CGEventFlags = []) {
    let code = keyCode(name)
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
        fputs("failed to create keyboard event\n", stderr)
        exit(2)
    }
    down.flags = flags
    up.flags = flags
    post(down)
    pauseMs(30)
    post(up)
    pauseMs(80)
}

func typeText(_ text: String) {
    for character in text {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            fputs("failed to create unicode keyboard event\n", stderr)
            exit(2)
        }
        var utf16 = Array(String(character).utf16)
        down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        post(down)
        post(up)
        pauseMs(15)
    }
}

func postMouse(
    _ type: CGEventType,
    _ x: Double,
    _ y: Double,
    button: CGMouseButton = .left,
    clickState: Int64 = 1,
    flags: CGEventFlags = [],
    delayMs: UInt32 = 80
) {
    guard let event = CGEvent(
        mouseEventSource: source,
        mouseType: type,
        mouseCursorPosition: CGPoint(x: x, y: y),
        mouseButton: button
    ) else {
        fputs("failed to create mouse event\n", stderr)
        exit(2)
    }
    event.flags = flags
    if type == .leftMouseDown || type == .leftMouseUp || type == .rightMouseDown || type == .rightMouseUp || type == .otherMouseDown || type == .otherMouseUp {
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
    }
    post(event)
    pauseMs(delayMs)
}

func click(_ x: Double, _ y: Double, button: CGMouseButton = .left, count: Int = 1, flags: CGEventFlags = []) {
    let downType: CGEventType
    let upType: CGEventType
    switch button {
    case .left:
        downType = .leftMouseDown
        upType = .leftMouseUp
    case .right:
        downType = .rightMouseDown
        upType = .rightMouseUp
    default:
        downType = .otherMouseDown
        upType = .otherMouseUp
    }
    postMouse(.mouseMoved, x, y, button: button, flags: flags, delayMs: 60)
    for index in 1...count {
        if index > 1 {
            pauseMs(50)
        }
        postMouse(downType, x, y, button: button, clickState: Int64(index), flags: flags, delayMs: 30)
        postMouse(upType, x, y, button: button, clickState: Int64(index), flags: flags, delayMs: 30)
    }
}

func drag(_ fromX: Double, _ fromY: Double, _ toX: Double, _ toY: Double) {
    postMouse(.mouseMoved, fromX, fromY, delayMs: 50)
    postMouse(.leftMouseDown, fromX, fromY, delayMs: 100)
    let steps = 20
    for step in 1...steps {
        let t = Double(step) / Double(steps)
        let smooth = t * t * (3.0 - 2.0 * t)
        let x = fromX + (toX - fromX) * smooth
        let y = fromY + (toY - fromY) * smooth
        postMouse(.leftMouseDragged, x, y, delayMs: 8)
    }
    pauseMs(50)
    postMouse(.leftMouseUp, toX, toY)
}

func postScroll(_ x: Double, _ y: Double, clicks: Int32) {
    postMouse(.mouseMoved, x, y)
    let steps = 8
    let perStep = clicks / Int32(steps)
    for step in 0..<steps {
        guard let event = CGEvent(
            scrollWheelEvent2Source: source,
            units: .line,
            wheelCount: 2,
            wheel1: perStep,
            wheel2: 0,
            wheel3: 0
        ) else {
            fputs("failed to create scroll event\n", stderr)
            exit(2)
        }
        event.setIntegerValueField(CGEventField(rawValue: 99)!, value: 1)
        if step == 0 {
            event.setIntegerValueField(CGEventField(rawValue: 123)!, value: 2)
        } else if step == steps - 1 {
            event.setIntegerValueField(CGEventField(rawValue: 123)!, value: 4)
        } else {
            event.setIntegerValueField(CGEventField(rawValue: 123)!, value: 2)
        }
        post(event)
        pauseMs(16)
    }
}

click(textX, textY)
typeText("macos trace alpha beta")
postKey("return")
postKey("a", flags: .maskCommand)
postKey("backspace")
typeText("macos trace fixed")
postKey("return")
postKey("3", flags: .maskAlternate)
pauseMs(700)

click(commandClickX, commandClickY, flags: .maskCommand)
postMouse(.mouseMoved, commandClickX + 5, commandClickY + 5)
pauseMs(700)

click(doubleClickX, doubleClickY, count: 2)
pauseMs(700)

drag(dragStartX, dragStartY, dragEndX, dragEndY)
pauseMs(700)

postScroll(scrollX, scrollY, clicks: -40)
pauseMs(700)

click(rightClickX, rightClickY, button: .right)
postKey("escape")
pauseMs(700)

click(middleClickX, middleClickY, button: .center)
SWIFT

echo "MACOS_TRACE_STEP action_simulation"
swiftc "$swift_source" -o "$sim_bin"
"$sim_bin" "$text_x" "$text_y" "$click_x" "$click_y" "$double_x" "$double_y" "$drag_start_x" "$drag_start_y" "$drag_end_x" "$drag_end_y" "$scroll_x" "$scroll_y" "$right_x" "$right_y" "$middle_x" "$middle_y" "$target_pid"

echo "MACOS_TRACE_STEP wait_for_a11y_snapshot"
sleep 4

echo "MACOS_TRACE_STEP stop_recording"
curl -fsS \
  -X POST "http://127.0.0.1:$port/recording/stop" \
  >"$artifact_dir/stop-response.json"

raw_path="$recording_dir/${name}_raw.jsonl"
processed_path="$recording_dir/${name}_preprocessed.jsonl"
a11y_path="$recording_dir/${name}_a11y.jsonl"
summary_path="$artifact_dir/summary.json"

python3 - "$raw_path" "$processed_path" "$a11y_path" "$summary_path" "$a11y_enabled_yaml" <<'PY'
import json
import sys
from collections import Counter
from pathlib import Path

raw_path, processed_path, a11y_path, summary_path = map(Path, sys.argv[1:5])
a11y_enabled = sys.argv[5].lower() == "true"

def read_required_jsonl(path: Path):
    if not path.is_file() or path.stat().st_size == 0:
        raise SystemExit(f"missing or empty output file: {path}")
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

def read_optional_jsonl(path: Path):
    if not path.is_file() or path.stat().st_size == 0:
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

raw = read_required_jsonl(raw_path)
processed = read_required_jsonl(processed_path)
a11y = read_optional_jsonl(a11y_path)
raw_types = Counter(event.get("type") for event in raw)
processed_types = Counter(event.get("type") for event in processed)
actions = [event for event in processed if event.get("type") not in {"screenshot", "sleep"}]
action_types = [event.get("type") for event in actions]
a11y_has_windows = any(
    event.get("type") == "a11y+screenshot"
    and event.get("data", {}).get("a11y", {}).get("windows_data")
    for event in a11y
)

coverage = {
    "keyboard": any(name in raw_types for name in ("key_down", "key_up")),
    "mouse": any(name in raw_types for name in ("mouse_down", "mouse_up", "mouse_move")),
    "screenshot": raw_types.get("screenshot", 0) > 0,
    "drag_signal": any(
        event.get("type") == "mouse_move" and event.get("data", {}).get("is_dragging")
        for event in raw
    ),
    "scroll": raw_types.get("mouse_scroll", 0) > 0,
}

families = {
    "click": "click" in action_types,
    "drag": "drag" in action_types,
    "scroll": "scroll" in action_types,
    "typewrite": "typewrite" in action_types,
    "hotkey_or_press": any(kind in action_types for kind in ("hotkey", "press")),
}

has_command_a = any(
    event.get("type") == "hotkey"
    and event.get("args", {}).get("keys") == ["command", "a"]
    for event in actions
)
has_command_click = any(
    event.get("type") == "click"
    and "command" in event.get("args", {}).get("modifiers", [])
    for event in actions
)
def action_args(event):
    value = event.get("args")
    return value if isinstance(value, dict) else {}

def is_type(event, kind):
    return event.get("type") == kind

def key_is(event, key):
    return is_type(event, "press") and action_args(event).get("key") == key

def hotkey_is(event, keys):
    return is_type(event, "hotkey") and action_args(event).get("keys") == keys

def click_is(event, button, clicks=None, modifier=None, min_clicks=None):
    args = action_args(event)
    if not is_type(event, "click") or args.get("button") != button:
        return False
    observed_clicks = int(args.get("clicks") or 0)
    if clicks is not None and observed_clicks != clicks:
        return False
    if min_clicks is not None and observed_clicks < min_clicks:
        return False
    if modifier is not None and modifier not in args.get("modifiers", []):
        return False
    return True

def drag_left(event):
    args = action_args(event)
    return (
        is_type(event, "drag")
        and args.get("button") == "left"
        and abs(float(args.get("end_x", 0.0)) - float(args.get("start_x", 0.0))) >= 0.03
    )

def scroll_down(event):
    return is_type(event, "scroll") and int(action_args(event).get("clicks") or 0) < 0

expected_sequence = [
    ("left click", lambda event: click_is(event, "left", clicks=1)),
    (
        "typewrite macos trace alpha beta",
        lambda event: is_type(event, "typewrite")
        and action_args(event).get("text") == "macos trace alpha beta",
    ),
    ("enter press", lambda event: key_is(event, "enter")),
    ("command+a hotkey", lambda event: hotkey_is(event, ["command", "a"])),
    ("backspace press", lambda event: key_is(event, "backspace")),
    (
        "typewrite macos trace fixed",
        lambda event: is_type(event, "typewrite")
        and action_args(event).get("text") == "macos trace fixed",
    ),
    ("enter press after replacement", lambda event: key_is(event, "enter")),
    ("option+3 hotkey", lambda event: hotkey_is(event, ["alt", "3"])),
    ("command click", lambda event: click_is(event, "left", clicks=1, modifier="command")),
    ("double click", lambda event: click_is(event, "left", min_clicks=2)),
    ("left drag", drag_left),
    ("scroll down", scroll_down),
    ("right click", lambda event: click_is(event, "right", clicks=1)),
    ("escape press", lambda event: key_is(event, "esc")),
    ("middle click", lambda event: click_is(event, "middle", clicks=1)),
]

matched_sequence = []
search_start = 0
for label, predicate in expected_sequence:
    match_index = None
    for index in range(search_start, len(actions)):
        if predicate(actions[index]):
            match_index = index
            break
    if match_index is None:
        break
    matched_sequence.append({"label": label, "action_index": match_index})
    search_start = match_index + 1

expected_sequence_matched = len(matched_sequence) == len(expected_sequence)

triple_count = 0
for index in range(1, len(processed) - 1):
    if (
        processed[index - 1].get("type") == "screenshot"
        and processed[index].get("type") not in {"screenshot", "sleep"}
        and processed[index + 1].get("type") == "screenshot"
    ):
        triple_count += 1

summary = {
    "status": "pass",
    "raw": {
        "event_count": len(raw),
        "types": dict(raw_types),
        "coverage": coverage,
    },
    "a11y": {
        "enabled": a11y_enabled,
        "event_count": len(a11y),
        "has_windows_data": a11y_has_windows,
    },
    "processed": {
        "event_count": len(processed),
        "types": dict(processed_types),
        "action_count": len(actions),
        "action_types": action_types,
        "families": families,
        "screenshot_action_screenshot_triples": triple_count,
        "expected_sequence_matched": expected_sequence_matched,
        "expected_sequence": [label for label, _ in expected_sequence],
        "matched_sequence": matched_sequence,
        "extra_action_count": max(0, len(actions) - len(matched_sequence)),
    },
    "assertions": {
        "command_a_hotkey": has_command_a,
        "command_click_modifier": has_command_click,
    },
}

failures = [
    f"raw coverage missing {name}" for name, ok in coverage.items() if not ok
]
failures += [
    f"processed family missing {name}" for name, ok in families.items() if not ok
]
if a11y_enabled and not a11y_has_windows:
    failures.append("a11y enabled but no nonempty windows_data was captured")
if not a11y_enabled and a11y:
    failures.append(f"a11y disabled but emitted {len(a11y)} rows")
if not has_command_a:
    failures.append("processed hotkey missing ['command', 'a']")
if not has_command_click:
    failures.append("processed click missing command modifier")
if not expected_sequence_matched:
    missing = expected_sequence[len(matched_sequence)][0]
    failures.append(
        "expected scenario subsequence missing "
        f"{missing}; actual_actions={action_types}"
    )
if triple_count <= 0:
    failures.append("processed trace has no screenshot/action/screenshot triples")

if failures:
    summary["status"] = "fail"
    summary["failures"] = failures

summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
print(
    "MACOS_TRACE_SUMMARY "
    f"raw={len(raw)} processed={len(processed)} actions={len(actions)} "
    f"screenshots={processed_types.get('screenshot', 0)} triples={triple_count} "
    f"a11y_enabled={str(a11y_enabled).lower()} a11y_rows={len(a11y)}"
)
print("MACOS_TRACE_ACTIONS " + ",".join(action_types))
if failures:
    raise SystemExit("; ".join(failures))
PY

echo "MACOS_TRACE_OK summary=$PWD/$summary_path artifacts=$PWD/$artifact_dir"
