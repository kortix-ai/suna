#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This FPS probe is intended for local macOS recorder testing." >&2
  exit 1
fi

duration_seconds="30"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --seconds)
      if [ "$#" -lt 2 ]; then
        echo "--seconds requires a value" >&2
        exit 1
      fi
      duration_seconds="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

cargo_bin="${CARGO:-cargo}"
if ! "$cargo_bin" --version >/dev/null 2>&1; then
  echo "cargo is required. Install Rust first or set CARGO to a working cargo binary." >&2
  exit 1
fi
build_profile="${MANUAL_FPS_BUILD_PROFILE:-release}"

raw_root="tests/manual_recording_contracts/raw_data"
recordings_dir="$raw_root/recordings"
mkdir -p "$recordings_dir"

name="${MANUAL_FPS_RECORDING_NAME:-manual_fps_probe}"
target_fps="${MANUAL_FPS_TARGET_FPS:-8}"
port="${LOCAL_PORT:-18294}"
config_path="$raw_root/manual_fps_probe_config.yaml"
log_path="$raw_root/manual_fps_probe_backend.log"
start_response="$raw_root/manual_fps_probe_start_response.json"
stop_response="$raw_root/manual_fps_probe_stop_response.json"
recording_dir="$recordings_dir/$name"
raw_path="$recording_dir/${name}_raw.jsonl"
processed_path="$recording_dir/${name}_preprocessed.jsonl"
html_view="$recording_dir/${name}_visualization.html"

rm -rf "$recording_dir"
mkdir -p "$recording_dir"

cat >"$config_path" <<YAML
screen_recorder:
  fps: $target_fps
  burst_fps: $target_fps
  burst_after_seconds: 9999
  idle_interval_seconds: 1
  idle_after_seconds: 9999
  quality: 60
  scale_factor: 0.5
  frame_queue_capacity: 50
  capture_mode: all_displays
a11y_recorder:
  interval_seconds: 60
  max_depth: 4
  max_children: 50
recordings:
  directory: "$PWD/$recordings_dir"
  stop_screenshot_delay_ms: 500
YAML

backend_bin="${KORTIX_BACKEND_BIN:-}"
if [ -z "$backend_bin" ]; then
  echo "MANUAL_FPS_STEP build_backend profile=$build_profile"
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
      echo "MANUAL_FPS_BUILD_PROFILE must be 'release' or 'debug'." >&2
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

echo "MANUAL_FPS_STEP start_backend port=$port"
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

echo "MANUAL_FPS_STEP start_recording name=$name target_fps=$target_fps seconds=$duration_seconds"
curl -fsS \
  -X POST "http://127.0.0.1:$port/recording/start" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$name\",\"enable_audio\":false,\"save_raw_data\":true,\"detailed_events\":true}" \
  >"$start_response"

sleep "$duration_seconds"

echo "MANUAL_FPS_STEP stop_recording"
curl -fsS -X POST "http://127.0.0.1:$port/recording/stop" >"$stop_response"

if [ ! -s "$raw_path" ]; then
  echo "Expected raw JSONL not found or empty: $raw_path" >&2
  echo "Backend log:" >&2
  tail -n 120 "$log_path" >&2 || true
  exit 1
fi

echo "MANUAL_FPS_STEP analyze"
python3 scripts/analyze_recording_fps.py "$raw_path" --preprocessed "$processed_path"

echo "MANUAL_FPS_STEP render_html"
if [ -s "$processed_path" ]; then
  python3 scripts/render_processed_trace_html.py "$processed_path" \
    --raw-jsonl "$raw_path" \
    --output "$html_view"
fi

html_abs="$PWD/$html_view"
if [ -s "$html_abs" ] && command -v open >/dev/null 2>&1; then
  echo "MANUAL_FPS_STEP open_html path=$html_abs"
  open "$html_abs" || true
fi

cat <<EOF

MANUAL_FPS_DONE
raw:          $PWD/$raw_path
preprocessed: $PWD/$processed_path
html view:    $html_abs
backend log:  $PWD/$log_path

EOF
