#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS release packaging must run on macOS." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$backend_dir/.." && pwd)"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/package_macos_release.sh <tag> [platform] [binary-dir] [assets-dir] [dist-dir]

Required environment:
  APPLE_CODESIGN_IDENTITY or MACOS_CODESIGN_IDENTITY

Optional notarization environment:
  MACOS_NOTARIZE=1
  APPLE_NOTARY_PROFILE
    or APPLE_NOTARY_KEY_PATH + APPLE_NOTARY_KEY_ID + APPLE_NOTARY_ISSUER_ID
    or APPLE_NOTARY_KEY_P8_BASE64 + APPLE_NOTARY_KEY_ID + APPLE_NOTARY_ISSUER_ID
    or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID

Release manifests are signed once in the publish job (release.yml).
EOF
}

tag="${1:-}"
if [ -z "$tag" ]; then
  usage
  exit 1
fi

platform="${2:-macos}"
binary_dir="${3:-$backend_dir/target/release}"
assets_dir="${4:-$repo_root/release-assets}"
dist_dir="${5:-$repo_root/dist}"

abspath() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$PWD/$1" ;;
  esac
}

binary_dir="$(abspath "$binary_dir")"
assets_dir="$(abspath "$assets_dir")"
dist_dir="$(abspath "$dist_dir")"

codesign_identity="${APPLE_CODESIGN_IDENTITY:-${MACOS_CODESIGN_IDENTITY:-}}"
if [ -z "$codesign_identity" ]; then
  echo "APPLE_CODESIGN_IDENTITY or MACOS_CODESIGN_IDENTITY is required for macOS packaging." >&2
  exit 1
fi

for binary in kortix-capture kortix-backend; do
  if [ ! -x "$binary_dir/$binary" ]; then
    echo "Missing executable: $binary_dir/$binary" >&2
    exit 1
  fi
done

# build.rs compiles the Swift capture engine into cargo's OUT_DIR; pick the newest one.
capture_engine="${KORTIX_CAPTURE_ENGINE:-}"
if [ -z "$capture_engine" ]; then
  capture_engine="$(find "$binary_dir/build" -path '*/out/kortix-capture-engine' -type f -exec ls -t {} + 2>/dev/null | head -n 1)"
fi
if [ -z "$capture_engine" ] || [ ! -x "$capture_engine" ]; then
  echo "Missing kortix-capture-engine (built by build.rs under $binary_dir/build/*/out)." >&2
  exit 1
fi

notarize="${MACOS_NOTARIZE:-0}"
case "$notarize" in
  1|true|TRUE|yes|YES) notarize=1 ;;
  0|false|FALSE|no|NO|"") notarize=0 ;;
  *)
    echo "MACOS_NOTARIZE must be 0/1, true/false, or yes/no." >&2
    exit 1
    ;;
esac

decode_base64() {
  local encoded="$1"
  local output="$2"
  if printf '%s' "$encoded" | base64 --decode >"$output" 2>/dev/null; then
    return 0
  fi
  printf '%s' "$encoded" | base64 -D >"$output"
}

sign_path() {
  local path="$1"
  local kind="${2:-binary}"
  local args=(--force --sign "$codesign_identity")

  if [ "$codesign_identity" != "-" ]; then
    args+=(--timestamp --options runtime)
  fi

  # The hardened runtime blocks the microphone (audio memory) unless the
  # binary carries com.apple.security.device.audio-input.
  args+=(--entitlements "${APPLE_CODESIGN_ENTITLEMENTS:-$backend_dir/packaging/macos/kortix-capture.entitlements}")

  codesign "${args[@]}" "$path"
  if [ "$kind" = "app" ]; then
    codesign --verify --deep --strict --verbose=2 "$path"
  else
    codesign --verify --strict --verbose=2 "$path"
  fi
}

notary_args=()
prepare_notary_args() {
  if [ -n "${APPLE_NOTARY_PROFILE:-}" ]; then
    notary_args=(--keychain-profile "$APPLE_NOTARY_PROFILE")
    return 0
  fi

  if [ -n "${APPLE_NOTARY_KEY_ID:-}" ] || [ -n "${APPLE_NOTARY_ISSUER_ID:-}" ] || [ -n "${APPLE_NOTARY_KEY_PATH:-}" ] || [ -n "${APPLE_NOTARY_KEY_P8_BASE64:-}" ]; then
    if [ -z "${APPLE_NOTARY_KEY_ID:-}" ] || [ -z "${APPLE_NOTARY_ISSUER_ID:-}" ]; then
      echo "APPLE_NOTARY_KEY_ID and APPLE_NOTARY_ISSUER_ID are required for API-key notarization." >&2
      exit 1
    fi

    local key_path="${APPLE_NOTARY_KEY_PATH:-}"
    if [ -z "$key_path" ]; then
      if [ -z "${APPLE_NOTARY_KEY_P8_BASE64:-}" ]; then
        echo "APPLE_NOTARY_KEY_PATH or APPLE_NOTARY_KEY_P8_BASE64 is required for API-key notarization." >&2
        exit 1
      fi
      key_path="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/AuthKey_${APPLE_NOTARY_KEY_ID}.p8"
      decode_base64 "$APPLE_NOTARY_KEY_P8_BASE64" "$key_path"
      chmod 600 "$key_path"
    fi

    notary_args=(--key "$key_path" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID")
    return 0
  fi

  if [ -n "${APPLE_ID:-}" ] || [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || [ -n "${APPLE_TEAM_ID:-}" ]; then
    if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
      echo "APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID must all be set for Apple ID notarization." >&2
      exit 1
    fi
    notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
    return 0
  fi

  echo "Notarization credentials are required when MACOS_NOTARIZE=1." >&2
  exit 1
}

notarize_zip() {
  local zip_path="$1"
  prepare_notary_args
  xcrun notarytool submit "$zip_path" "${notary_args[@]}" --wait
}

# One package: the binaries the Kortix desktop app bundles (it is the visible
# host and signs them again with its own identity), each signed with the
# hardened runtime, notarized as one zip. There is no headless package.
rm -rf "$dist_dir" "$assets_dir"
mkdir -p "$dist_dir" "$assets_dir"

privacy_arch=arm64
if file "$binary_dir/kortix-capture" | grep -q x86_64; then privacy_arch=x86_64; fi
python3 "$backend_dir/scripts/install_privacy_runtime.py" --platform "macos-$privacy_arch" --destination "$binary_dir"

echo "MACOS_PACKAGE_STEP sign"
name="kortix-capture-${tag}-${platform}"
pkg="$dist_dir/$name"
mkdir -p "$pkg/skill"
cp "$binary_dir/kortix-capture" "$binary_dir/kortix-backend" "$binary_dir/libonnxruntime.1.23.2.dylib" \
  "$binary_dir/privacy-runtime-notices.txt" "$pkg/"
cp "$capture_engine" "$pkg/kortix-capture-engine"
cp -R "$backend_dir/skill/kortix-capture" "$pkg/skill/kortix-capture"
chmod +x "$pkg/kortix-capture" "$pkg/kortix-backend" "$pkg/kortix-capture-engine"
for f in kortix-capture-engine kortix-capture kortix-backend libonnxruntime.1.23.2.dylib; do
  sign_path "$pkg/$f"
done
(cd "$dist_dir" && ditto -c -k --keepParent "$name" "$assets_dir/${name}.zip")

if [ "$notarize" -eq 1 ]; then
  # Bare binaries cannot be stapled; Gatekeeper checks the ticket online.
  echo "MACOS_PACKAGE_STEP notarize"
  notarize_zip "$assets_dir/${name}.zip"
fi

echo "MACOS_PACKAGE_OK $assets_dir"
find "$assets_dir" -type f -print
