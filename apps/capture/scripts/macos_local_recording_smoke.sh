#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This smoke test must run on macOS because it verifies TCC permissions, event taps, and AXUIElement capture." >&2
  exit 1
fi

cargo_bin="${CARGO:-cargo}"
backend_bin="${KORTIX_BACKEND_BIN:-}"
if [ -z "$backend_bin" ] && ! "$cargo_bin" --version >/dev/null 2>&1; then
  echo "cargo is required. Install Rust first or set KORTIX_BACKEND_BIN to an existing macOS backend binary." >&2
  exit 1
fi

artifact_dir="${MACOS_SMOKE_ARTIFACT_DIR:-artifacts/macos-local-smoke}"
recordings_dir="$artifact_dir/recordings"
config_path="$artifact_dir/config.yaml"
mkdir -p "$recordings_dir"

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
  interval_seconds: 3
  max_depth: 12
  max_children: 200
recordings:
  directory: "$PWD/$recordings_dir"
  stop_screenshot_delay_ms: 500
YAML

if [ -z "$backend_bin" ]; then
  echo "SMOKE_STEP cargo_build_macos_debug"
  "$cargo_bin" build --features native-recorders --bin kortix-backend
  backend_bin="target/debug/kortix-backend"
fi

port="${LOCAL_PORT:-18291}"
name="macos_smoke_$(date +%Y%m%d_%H%M%S)"
recording_dir="$recordings_dir/$name"
log_path="$artifact_dir/backend.log"
text_path="$artifact_dir/textedit-smoke.txt"
printf "kortix macOS smoke\n" >"$text_path"

cleanup() {
  if [ -n "${backend_pid:-}" ] && kill -0 "$backend_pid" >/dev/null 2>&1; then
    kill "$backend_pid" >/dev/null 2>&1 || true
    wait "$backend_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "SMOKE_STEP start_backend port=$port"
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
    tail -n 80 "$log_path" >&2 || true
    exit 1
  fi
  sleep 0.25
done

if ! curl -fsS "http://127.0.0.1:$port/health" >/dev/null; then
  echo "Backend did not become healthy. Last log lines:" >&2
  tail -n 80 "$log_path" >&2 || true
  exit 1
fi

echo "SMOKE_STEP start_recording name=$name"
if ! curl -fsS \
  -X POST "http://127.0.0.1:$port/recording/start" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$name\",\"enable_audio\":false,\"save_raw_data\":true}" \
  >"$artifact_dir/start-response.json"; then
  echo "Failed to start recording. Response:" >&2
  cat "$artifact_dir/start-response.json" >&2 || true
  echo "Backend log:" >&2
  tail -n 120 "$log_path" >&2 || true
  exit 1
fi

echo "SMOKE_STEP generate_textedit_input"
open -a TextEdit "$PWD/$text_path"
sleep 1
osascript <<'APPLESCRIPT'
tell application "TextEdit" to activate
delay 0.5
tell application "System Events"
  keystroke "kortix macos native input"
  key code 36
  keystroke "a" using command down
  key code 51
  keystroke "a11y snapshot check"
end tell
APPLESCRIPT

echo "SMOKE_STEP wait_for_a11y_snapshot"
sleep 8

echo "SMOKE_STEP stop_recording"
if ! curl -fsS \
  -X POST "http://127.0.0.1:$port/recording/stop" \
  >"$artifact_dir/stop-response.json"; then
  echo "Failed to stop recording. Response:" >&2
  cat "$artifact_dir/stop-response.json" >&2 || true
  echo "Backend log:" >&2
  tail -n 120 "$log_path" >&2 || true
  exit 1
fi

raw_path="$recording_dir/${name}_raw.jsonl"
processed_path="$recording_dir/${name}_preprocessed.jsonl"
a11y_path="$recording_dir/${name}_a11y.jsonl"

python3 - "$raw_path" "$processed_path" "$a11y_path" <<'PY'
import json
import sys
from pathlib import Path

raw_path, processed_path, a11y_path = map(Path, sys.argv[1:])
for path in (raw_path, processed_path, a11y_path):
    if not path.is_file() or path.stat().st_size == 0:
        raise SystemExit(f"missing or empty output file: {path}")

def read_jsonl(path: Path):
    rows = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows

raw = read_jsonl(raw_path)
processed = read_jsonl(processed_path)
a11y = read_jsonl(a11y_path)

raw_types = [event.get("type") for event in raw]
processed_types = [event.get("type") for event in processed]
has_input = any(t in {"key_down", "key_up", "mouse_down", "mouse_up", "mouse_move", "mouse_scroll"} for t in raw_types)
action_count = sum(1 for t in processed_types if t not in {"screenshot", "sleep"})
screenshot_count = processed_types.count("screenshot")
has_a11y_tree = any(
    event.get("type") == "a11y+screenshot"
    and event.get("data", {}).get("a11y", {}).get("windows_data")
    for event in a11y
)

if not has_input:
    raise SystemExit("raw JSONL has no native input events")
if action_count <= 0:
    raise SystemExit("processed JSONL has no non-sleep actions")
if screenshot_count <= 0:
    raise SystemExit("processed JSONL has no screenshots")
if not has_a11y_tree:
    raise SystemExit("a11y JSONL has no nonempty windows_data")

print(
    "SMOKE_OK "
    f"raw={len(raw)} processed={len(processed)} actions={action_count} "
    f"screenshots={screenshot_count} a11y={len(a11y)}"
)
PY

echo "SMOKE_ARTIFACTS $PWD/$artifact_dir"
