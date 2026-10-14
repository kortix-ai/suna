#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

cargo_bin="${CARGO:-cargo}"
if ! "$cargo_bin" --version >/dev/null 2>&1; then
  echo "cargo is required. Install Rust first or set CARGO to a working cargo binary." >&2
  exit 1
fi

name="${1:-}"
if [ -z "$name" ]; then
  read -r -p "Recording number_name [5_other_keys]: " name
  name="${name:-5_other_keys}"
fi

if [[ ! "$name" =~ ^[A-Za-z0-9._-]+$ ]] || [ "$name" = "." ] || [ "$name" = ".." ]; then
  echo "Recording name may only contain letters, numbers, dots, underscores, and dashes." >&2
  exit 1
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This manual recorder helper is intended for local macOS recorder testing." >&2
  exit 1
fi

build_profile="${MANUAL_RECORDING_BUILD_PROFILE:-release}"
port="${LOCAL_PORT:-18296}"

raw_root="${MANUAL_RECORDING_OUTPUT_ROOT:-tests/manual_recording_contracts/raw_data}"
raw_root="${raw_root%/}"
recordings_dir="$raw_root/recordings"
recording_dir="$recordings_dir/$name"
config_path="$raw_root/${name}_config.yaml"
log_path="$raw_root/${name}_backend.log"
start_response="$raw_root/${name}_start_response.json"
stop_response="$raw_root/${name}_stop_response.json"
raw_path="$recording_dir/${name}_raw.jsonl"
processed_path="$recording_dir/${name}_preprocessed.jsonl"
html_view="$recording_dir/${name}_visualization.html"

mkdir -p "$recordings_dir"
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
  echo "MANUAL_RECORDING_STEP build_backend profile=$build_profile"
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
      echo "MANUAL_RECORDING_BUILD_PROFILE must be 'release' or 'debug'." >&2
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

echo "MANUAL_RECORDING_STEP start_backend port=$port"
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

echo "MANUAL_RECORDING_STEP start_recording name=$name"
echo "MANUAL_RECORDING_STEP output_dir=$recording_dir"
curl -fsS \
  -X POST "http://127.0.0.1:$port/recording/start" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$name\",\"enable_audio\":false,\"save_raw_data\":true,\"detailed_events\":true}" \
  >"$start_response"

cat <<EOF

Manual recorder is running now.

Name: $name
No scenario is enforced. Do the actions you want to inspect, then press Enter
in this terminal to stop, process, render, and open the HTML viewer.

EOF

read -r -p "Press Enter to stop recording..."

echo "MANUAL_RECORDING_STEP stop_recording"
curl -fsS -X POST "http://127.0.0.1:$port/recording/stop" >"$stop_response"

if [ ! -s "$raw_path" ]; then
  echo "Expected raw JSONL not found or empty: $raw_path" >&2
  echo "Backend log:" >&2
  tail -n 120 "$log_path" >&2 || true
  exit 1
fi

echo "MANUAL_RECORDING_STEP process_raw"
"$cargo_bin" run --bin kortix-process-raw -- \
  --file "$raw_path" \
  --output "$processed_path"

echo "MANUAL_RECORDING_STEP render_html"
python3 scripts/render_processed_trace_html.py "$processed_path" \
  --raw-jsonl "$raw_path" \
  --output "$html_view"

html_abs="$PWD/$html_view"
if [ -s "$html_abs" ]; then
  echo "MANUAL_RECORDING_STEP open_html path=$html_abs"
  if [ "${MANUAL_RECORDING_OPEN_HTML:-1}" = "0" ]; then
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

MANUAL_RECORDING_DONE
raw:          $PWD/$raw_path
preprocessed: $PWD/$processed_path
html view:    $html_abs
open command: open "$html_abs"
backend log:  $PWD/$log_path

EOF
