#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

cargo_bin="${CARGO:-cargo}"
if ! "$cargo_bin" --version >/dev/null 2>&1; then
  echo "cargo is required. Install Rust first or set CARGO to a working cargo binary." >&2
  exit 1
fi
build_profile="${MANUAL_MODIFIERS_BUILD_PROFILE:-release}"

raw_root="tests/manual_recording_contracts/raw_data"
recordings_dir="$raw_root/recordings"
mkdir -p "$recordings_dir"

name="${MANUAL_MODIFIERS_RECORDING_NAME:-3_modifiers}"
if [[ ! "$name" =~ ^[A-Za-z0-9._-]+$ ]] || [ "$name" = "." ] || [ "$name" = ".." ]; then
  echo "MANUAL_MODIFIERS_RECORDING_NAME may only contain letters, numbers, dots, underscores, and dashes." >&2
  exit 1
fi

port="${LOCAL_PORT:-18295}"
config_path="$raw_root/3_modifiers_config.yaml"
log_path="$raw_root/3_modifiers_backend.log"
start_response="$raw_root/3_modifiers_start_response.json"
stop_response="$raw_root/3_modifiers_stop_response.json"
recording_dir="$recordings_dir/$name"
raw_path="$recording_dir/${name}_raw.jsonl"
processed_path="$recording_dir/${name}_preprocessed.jsonl"
html_view="$recording_dir/${name}_visualization.html"

if [ "${MANUAL_MODIFIERS_VALIDATE_EXISTING:-0}" != "0" ]; then
  validation_raw_path="${MANUAL_MODIFIERS_RAW_JSONL:-$raw_path}"
  validation_processed_path="${MANUAL_MODIFIERS_PREPROCESSED_JSONL:-$processed_path}"
  validation_html_view="${MANUAL_MODIFIERS_HTML_VIEW:-$html_view}"
  case "$validation_raw_path" in
    /*) validation_raw_abs="$validation_raw_path" ;;
    *) validation_raw_abs="$PWD/$validation_raw_path" ;;
  esac
  case "$validation_processed_path" in
    /*) validation_processed_abs="$validation_processed_path" ;;
    *) validation_processed_abs="$PWD/$validation_processed_path" ;;
  esac
  case "$validation_html_view" in
    /*) validation_html_abs="$validation_html_view" ;;
    *) validation_html_abs="$PWD/$validation_html_view" ;;
  esac

  if [ ! -s "$validation_raw_abs" ]; then
    echo "Expected raw JSONL not found or empty: $validation_raw_abs" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$validation_processed_abs")" "$(dirname "$validation_html_abs")"

  echo "MANUAL_MODIFIERS_STEP validate_existing_raw"
  set +e
  MANUAL_MODIFIERS_RAW_JSONL="$validation_raw_abs" \
  MANUAL_MODIFIERS_PREPROCESSED_JSONL="$validation_processed_abs" \
  "$cargo_bin" test --test manual_recording_contracts \
    --features native-recorders \
    manual_3_modifiers_recording_capture_matches_contract -- --ignored --nocapture
  validation_status=$?
  set -e

  echo "MANUAL_MODIFIERS_STEP render_html"
  if [ -s "$validation_processed_abs" ]; then
    python3 scripts/render_processed_trace_html.py "$validation_processed_abs" \
      --raw-jsonl "$validation_raw_abs" \
      --output "$validation_html_abs"
  else
    echo "Processed JSONL was not written, so HTML cannot be rendered: $validation_processed_abs" >&2
  fi

  if [ -s "$validation_html_abs" ]; then
    echo "MANUAL_MODIFIERS_STEP open_html path=$validation_html_abs"
    if [ "${MANUAL_MODIFIERS_OPEN_HTML:-1}" = "0" ]; then
      echo "Open HTML with: open \"$validation_html_abs\""
    elif command -v open >/dev/null 2>&1; then
      if ! open "$validation_html_abs"; then
        echo "Could not open HTML automatically. Run: open \"$validation_html_abs\"" >&2
      fi
    else
      echo "Open HTML with: $validation_html_abs" >&2
    fi
  else
    echo "HTML viewer is missing or empty: $validation_html_abs" >&2
  fi

  cat <<EOF

MANUAL_MODIFIERS_DONE validation_status=$validation_status
raw:          $validation_raw_abs
preprocessed: $validation_processed_abs
html view:    $validation_html_abs
open command: open "$validation_html_abs"

EOF

  exit "$validation_status"
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This manual recorder contract is intended for local macOS recorder testing." >&2
  exit 1
fi

rm -rf "$recording_dir" "$start_response" "$stop_response"

cat >"$config_path" <<YAML
screen_recorder:
  fps: 4
  burst_fps: 8
  burst_after_seconds: 1
  idle_interval_seconds: 1
  idle_after_seconds: 3
  quality: 60
  scale_factor: 0.5
  frame_queue_capacity: 50
  capture_mode: all_displays
a11y_recorder:
  interval_seconds: 10
  max_depth: 12
  max_children: 200
recordings:
  directory: "$PWD/$recordings_dir"
  stop_screenshot_delay_ms: 500
YAML

backend_bin="${KORTIX_BACKEND_BIN:-}"
if [ -z "$backend_bin" ]; then
  echo "MANUAL_MODIFIERS_STEP build_backend profile=$build_profile"
  case "$build_profile" in
    release)
      "$cargo_bin" build --release --features native-recorders --bin kortix-backend
      backend_bin="target/release/kortix-backend"
      ;;
    debug)
      "$cargo_bin" build --features native-recorders --bin kortix-backend
      backend_bin="target/debug/kortix-backend"
      ;;
    *)
      echo "MANUAL_MODIFIERS_BUILD_PROFILE must be 'release' or 'debug'." >&2
      exit 1
      ;;
  esac
fi

cleanup() {
  if [ -n "${backend_pid:-}" ] && kill -0 "$backend_pid" >/dev/null 2>&1; then
    kill "$backend_pid" >/dev/null 2>&1 || true
    wait "$backend_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "MANUAL_MODIFIERS_STEP start_backend port=$port"
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

echo "MANUAL_MODIFIERS_STEP start_recording name=$name"
echo "MANUAL_MODIFIERS_STEP output_dir=$recording_dir"
curl -fsS \
  -X POST "http://127.0.0.1:$port/recording/start" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$name\",\"enable_audio\":false,\"save_raw_data\":true,\"detailed_events\":true}" \
  >"$start_response"

cat <<EOF

Manual 3_modifiers recorder test is recording now.

This contract is frozen from the confirmed local raw trace. For regression
checks, run it with MANUAL_MODIFIERS_VALIDATE_EXISTING=1 against the existing
3_modifiers_raw.jsonl. Capturing a new trace is useful for exploration, but a
new raw file will only pass after the exact assertions in the Rust contract are
intentionally updated.

The confirmed trace covers:
  1. Multi-monitor click/drag activity on displays 1 and 2.
  2. Ctrl, Command, and Shift modified mouse actions.
  3. Delayed visual page transition after a click, then a double-click.
  4. Ctrl and Command drags plus normal clicks.
  5. Long q key sequence.
  6. Held Backspace auto-repeat, expected as press backspace x10.
  7. Final click on display 2 and Enter to stop.

The validator checks exact raw event counts, exact processed action sequence,
exact timestamps, and exact screenshot/action/screenshot alignment.

EOF

read -r -p "Press Enter to stop recording and run the contract..."

echo "MANUAL_MODIFIERS_STEP stop_recording"
curl -fsS -X POST "http://127.0.0.1:$port/recording/stop" >"$stop_response"

if [ ! -s "$raw_path" ]; then
  echo "Expected raw JSONL not found or empty: $raw_path" >&2
  echo "Backend log:" >&2
  tail -n 120 "$log_path" >&2 || true
  exit 1
fi

echo "MANUAL_MODIFIERS_STEP validate_raw"
set +e
MANUAL_MODIFIERS_RAW_JSONL="$PWD/$raw_path" \
MANUAL_MODIFIERS_PREPROCESSED_JSONL="$PWD/$processed_path" \
"$cargo_bin" test --test manual_recording_contracts \
  --features native-recorders \
  manual_3_modifiers_recording_capture_matches_contract -- --ignored --nocapture
validation_status=$?
set -e

echo "MANUAL_MODIFIERS_STEP render_html"
if [ -s "$processed_path" ]; then
  python3 scripts/render_processed_trace_html.py "$processed_path" \
    --raw-jsonl "$raw_path" \
    --output "$html_view"
else
  echo "Processed JSONL was not written, so HTML cannot be rendered: $processed_path" >&2
fi

html_abs="$PWD/$html_view"
if [ -s "$html_abs" ]; then
  echo "MANUAL_MODIFIERS_STEP open_html path=$html_abs"
  if [ "${MANUAL_MODIFIERS_OPEN_HTML:-1}" = "0" ]; then
    echo "Open HTML with: open \"$html_abs\""
  elif command -v open >/dev/null 2>&1; then
    if ! open "$html_abs"; then
      echo "Could not open HTML automatically. Run: open \"$html_abs\"" >&2
    fi
  else
    echo "macOS open command not found. Run: open \"$html_abs\"" >&2
  fi
else
  echo "HTML viewer is missing or empty: $html_abs" >&2
fi

cat <<EOF

MANUAL_MODIFIERS_DONE validation_status=$validation_status
raw:          $PWD/$raw_path
preprocessed: $PWD/$processed_path
html view:    $html_abs
open command: open "$html_abs"
backend log:  $PWD/$log_path

EOF

if [ "$validation_status" -ne 0 ]; then
  exit "$validation_status"
fi
