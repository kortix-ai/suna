#!/usr/bin/env bash
# Build KortixCapture-<tag>-universal.pkg: `Kortix Capture.app` (window and menu-bar app,
# bundle id ai.kortix.capture), the machine LaunchDaemon and the global LaunchAgent.
#
#   installer/macos/build-pkg.sh v0.4.2 /path/to/KortixCapture-v0.4.2-universal.pkg
#
# Builds arm64 and x86_64 (lipo -> universal). ARCHS=arm64 builds the arm64-only
# package (named -arm64.pkg by the caller).
#
# Environment:
#   APPLE_CODESIGN_IDENTITY  Developer ID Application identity; "-" signs ad hoc (CI verify). Required.
#   APPLE_INSTALLER_IDENTITY Developer ID Installer identity for the .pkg; found in the keychain when unset;
#                            without one the .pkg is unsigned (the app inside is still signed and notarized).
#   MACOS_NOTARIZE=1         notarize and staple the app (and the .pkg when it is signed).
#   APPLE_NOTARY_KEY_P8_BASE64 + APPLE_NOTARY_KEY_ID + APPLE_NOTARY_ISSUER_ID  notary API key,
#   or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID (Apple ID notarization).
#   KORTIX_RELEASE_TAG / KORTIX_DEFAULT_ISSUER_URL  passed to cargo (the version devices report; the baked issuer).
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then echo "macOS packaging runs on macOS." >&2; exit 1; fi
tag="${1:?usage: build-pkg.sh <tag> <out.pkg>}"
out="${2:?usage: build-pkg.sh <tag> <out.pkg>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
recorder="$(cd "$here/../.." && pwd)"
identity="${APPLE_CODESIGN_IDENTITY:-${MACOS_CODESIGN_IDENTITY:-}}"
[ -n "$identity" ] || { echo "APPLE_CODESIGN_IDENTITY is required (\"-\" signs ad hoc)." >&2; exit 1; }
archs="${ARCHS:-arm64 x86_64}"
notarize="${MACOS_NOTARIZE:-0}"
export KORTIX_RELEASE_TAG="${KORTIX_RELEASE_TAG:-$tag}"

# CFBundleShortVersionString is major.minor.patch: a pre-release suffix is dropped.
version="$(printf '%s' "$tag" | sed -E 's/^v//; s/[-+].*$//')"
case "$version" in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "version $tag is not major.minor.patch" >&2; exit 1 ;; esac

work="$(mktemp -d "${TMPDIR:-/tmp}/kortix-capture-pkg.XXXXXX")"
trap 'rm -rf "$work"' EXIT
app="$work/root/Applications/Kortix Capture.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$work/root/Library/LaunchDaemons" "$work/root/Library/LaunchAgents" "$work/bin"

# ── 1. Build each architecture ──────────────────────────────────────────────
slices=()
for arch in $archs; do
  case "$arch" in
    arm64) triple=aarch64-apple-darwin ;;
    x86_64) triple=x86_64-apple-darwin ;;
    *) echo "unknown arch $arch" >&2; exit 1 ;;
  esac
  rustup target add "$triple" >/dev/null 2>&1 || true
  echo "PKG_STEP build $triple"
  (cd "$recorder" && cargo build --release --features native-recorders --target "$triple" --bin kortix-capture --bin kortix-backend)
  bin="${CARGO_TARGET_DIR:-$recorder/target}/$triple/release"
  # build.rs compiles the Swift capture engine into cargo's OUT_DIR for this target.
  engine="$(find "$bin/build" -path '*/out/kortix-capture-engine' -type f -exec ls -t {} + 2>/dev/null | head -n 1)"
  [ -x "$engine" ] || { echo "no kortix-capture-engine under $bin/build" >&2; exit 1; }
  mkdir -p "$work/slice-$arch"
  cp "$bin/kortix-capture" "$work/slice-$arch/kortix-capture"
  cp "$bin/kortix-backend" "$work/slice-$arch/kortix-backend"
  cp "$engine" "$work/slice-$arch/kortix-capture-engine"
  python3 "$recorder/scripts/install_privacy_runtime.py" --platform "macos-$arch" --destination "$work/slice-$arch"
  slices+=("$work/slice-$arch")
done

# ── 2. Assemble the app ─────────────────────────────────────────────────────
merge() { # <source name> <destination name>
  local inputs=()
  for s in "${slices[@]}"; do inputs+=("$s/$1"); done
  if [ "${#inputs[@]}" -gt 1 ]; then lipo -create "${inputs[@]}" -output "$app/Contents/MacOS/$2"; else cp "${inputs[0]}" "$app/Contents/MacOS/$2"; fi
  chmod 755 "$app/Contents/MacOS/$2"
}
# The main executable is the engine CLI itself: opened from Finder with no
# arguments it is the menu-bar app, and it is the process macOS grants Screen
# Recording, Accessibility, Input Monitoring and the Microphone to. Its children
# (recorder, capture engine, action recorder) inherit the grants.
merge kortix-capture "Kortix Capture"
merge kortix-backend kortix-backend
merge kortix-capture-engine kortix-capture-engine
merge libonnxruntime.1.23.2.dylib libonnxruntime.1.23.2.dylib
cp "${slices[0]}/privacy-runtime-notices.txt" "$app/Contents/Resources/"
sed "s/@VERSION@/$version/g" "$here/Info.plist.in" > "$app/Contents/Info.plist"
# The app icon: every size macOS asks for, made from the 1024 px master.
iconset="$work/kortix-capture.iconset"
mkdir -p "$iconset"
master="$recorder/assets/icons/app-1024.png"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$master" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$master" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/kortix-capture.icns"
cp "$here/uninstall.sh" "$app/Contents/Resources/uninstall.sh"
chmod 755 "$app/Contents/Resources/uninstall.sh"
mkdir -p "$app/Contents/Resources/skill"
cp -R "$recorder/skill/kortix-capture" "$app/Contents/Resources/skill/kortix-capture"
cp "$here/ai.kortix.capture.machine.plist" "$work/root/Library/LaunchDaemons/"
cp "$here/ai.kortix.capture.agent.plist" "$work/root/Library/LaunchAgents/"

# ── 3. Sign (hardened runtime, timestamp; ad hoc skips both) ────────────────
sign() {
  local args=(--force --sign "$identity" --entitlements "$recorder/packaging/macos/kortix-capture.entitlements")
  if [ "$identity" != "-" ]; then args+=(--timestamp --options runtime); fi
  codesign "${args[@]}" "$1"
}
echo "PKG_STEP sign"
for f in libonnxruntime.1.23.2.dylib kortix-capture-engine kortix-backend "Kortix Capture"; do sign "$app/Contents/MacOS/$f"; done
sign "$app"
codesign --verify --deep --strict --verbose=2 "$app"

# ── 4. Notarize the app and staple its ticket ───────────────────────────────
notary_args=()
if [ "$notarize" = "1" ]; then
  if [ -n "${APPLE_NOTARY_KEY_P8_BASE64:-}" ]; then
    key="$work/AuthKey.p8"
    printf '%s' "$APPLE_NOTARY_KEY_P8_BASE64" | base64 --decode > "$key" 2>/dev/null || printf '%s' "$APPLE_NOTARY_KEY_P8_BASE64" | base64 -D > "$key"
    chmod 600 "$key"
    notary_args=(--key "$key" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID")
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
  else
    echo "MACOS_NOTARIZE=1 needs a notary API key (APPLE_NOTARY_KEY_*) or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID." >&2; exit 1
  fi
  echo "PKG_STEP notarize app"
  ditto -c -k --keepParent "$app" "$work/app.zip"
  xcrun notarytool submit "$work/app.zip" "${notary_args[@]}" --wait
  xcrun stapler staple "$app"
fi

# ── 5. The package ──────────────────────────────────────────────────────────
echo "PKG_STEP pkgbuild"
pkgbuild --analyze --root "$work/root" "$work/components.plist" >/dev/null
# The app must stay in /Applications: no relocation to another copy on disk.
# The installer must replace the app whatever version is there: a dev build differs from the
# next one only below the bundle version, and the updater's rollback installs an older one.
for i in $(seq 0 9); do
  /usr/libexec/PlistBuddy -c "Set :$i:BundleIsRelocatable false" "$work/components.plist" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Set :$i:BundleIsVersionChecked false" "$work/components.plist" >/dev/null 2>&1 || true
done
mkdir -p "$(dirname "$out")"
unsigned="$work/KortixCapture-unsigned.pkg"
pkgbuild --root "$work/root" --component-plist "$work/components.plist" \
  --scripts "$here/scripts" --identifier ai.kortix.capture.pkg --version "$version" \
  --install-location / --ownership recommended "$unsigned"

installer_identity="${APPLE_INSTALLER_IDENTITY:-}"
if [ -z "$installer_identity" ] && [ "$identity" != "-" ]; then
  installer_identity="$(security find-identity -v -p basic 2>/dev/null | sed -n 's/.*"\(Developer ID Installer:[^"]*\)".*/\1/p' | head -n 1)"
fi
if [ -n "$installer_identity" ]; then
  echo "PKG_STEP productsign ($installer_identity)"
  productsign --sign "$installer_identity" --timestamp "$unsigned" "$out"
  if [ "$notarize" = "1" ]; then
    echo "PKG_STEP notarize pkg"
    xcrun notarytool submit "$out" "${notary_args[@]}" --wait
    xcrun stapler staple "$out"
  fi
else
  cp "$unsigned" "$out"
  echo "PKG_NOTE the .pkg is unsigned: no Developer ID Installer identity (APPLE_INSTALLER_IDENTITY). The app inside is signed$([ "$notarize" = 1 ] && echo ', notarized and stapled')."
fi
echo "PKG_OK $out ($(lipo -archs "$app/Contents/MacOS/Kortix Capture"))"
