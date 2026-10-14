#!/usr/bin/env bash
# Build kortix-capture_<tag>_amd64.deb from built release binaries.
#
#   installer/linux/build-deb.sh v0.4.2 target/release dist/kortix-capture_v0.4.2_amd64.deb
#
# <bin-dir> holds kortix-capture, kortix-capture-engine, kortix-backend (built with
# --features native-recorders,memory-ui,tray-linux), libonnxruntime.so.1.23.2 and
# privacy-runtime-notices.txt (scripts/install_privacy_runtime.py --platform linux-x86_64).
set -euo pipefail
tag="${1:?usage: build-deb.sh <tag> <bin-dir> <out.deb>}"
bin="$(cd "${2:?usage: build-deb.sh <tag> <bin-dir> <out.deb>}" && pwd)"
out="${3:?usage: build-deb.sh <tag> <bin-dir> <out.deb>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
recorder="$(cd "$here/../.." && pwd)"

# A Debian version starts with a digit; a pre-release suffix sorts before the release (~).
version="$(printf '%s' "$tag" | sed -E 's/^v//; s/-/~/')"
case "$version" in [0-9]*) ;; *) echo "version $tag does not start with a digit" >&2; exit 1 ;; esac

root="$(mktemp -d "${TMPDIR:-/tmp}/kortix-capture-deb.XXXXXX")"
trap 'rm -rf "$root"' EXIT
install -d -m 755 "$root/DEBIAN" "$root/usr/bin" "$root/usr/lib/systemd/system" "$root/usr/lib/systemd/user" \
  "$root/usr/share/applications" "$root/etc/xdg/autostart" "$root/usr/share/icons/hicolor/256x256/apps" \
  "$root/usr/share/doc/kortix-capture" "$root/usr/share/kortix-capture"

# The engine and the action recorder are found next to kortix-capture, and so is the ONNX runtime.
for f in kortix-capture kortix-capture-engine kortix-backend; do install -m 755 "$bin/$f" "$root/usr/bin/$f"; done
install -m 644 "$bin/libonnxruntime.so.1.23.2" "$root/usr/bin/libonnxruntime.so.1.23.2"
install -m 644 "$bin/privacy-runtime-notices.txt" "$root/usr/share/doc/kortix-capture/privacy-runtime-notices.txt"
cp -R "$recorder/skill/kortix-capture" "$root/usr/share/kortix-capture/skill"
install -m 644 "$here/kortix-capture-machine.service" "$root/usr/lib/systemd/system/"
install -m 644 "$here/kortix-capture.service" "$root/usr/lib/systemd/user/"
install -m 644 "$here/kortix-capture.desktop" "$root/usr/share/applications/"
install -m 644 "$here/kortix-capture-tray.desktop" "$root/etc/xdg/autostart/"
install -m 644 "$here/kortix-capture-onboard.desktop" "$root/etc/xdg/autostart/"
install -m 644 "$here/../../assets/icons/app-256.png" "$root/usr/share/icons/hicolor/256x256/apps/kortix-capture.png"
sed "s/@VERSION@/$version/" "$here/control.in" > "$root/DEBIAN/control"
for s in postinst prerm postrm; do install -m 755 "$here/$s" "$root/DEBIAN/$s"; done
find "$root/usr/share/kortix-capture" -type d -exec chmod 755 {} +
find "$root/usr/share/kortix-capture" -type f -exec chmod 644 {} +

mkdir -p "$(dirname "$out")"
dpkg-deb --root-owner-group --build "$root" "$out"
dpkg-deb --info "$out" | sed -n '1,20p'
echo "DEB_OK $out"
