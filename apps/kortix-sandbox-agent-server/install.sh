#!/usr/bin/env sh
# kortixd bootstrap installer — curl | sh style.
#
#   curl -fsSL https://<host>/kortixd/install.sh | sh
#
# Downloads the kortixd binary for this OS/arch and puts `kortixd` on PATH.
# After this runs once, kortixd manages itself: `kortixd update` self-updates,
# `kortixd rollback` reverts, `kortixd version` reports the build.
#
# This is only the BOOTSTRAP. It gets the first binary onto the machine; the
# binary's own `install`/`update`/`rollback` subcommands take over from there.
#
# Configuration (env or flags):
#   --url <u>     / KORTIXD_URL         Exact binary URL (skips OS/arch guessing).
#   --base <u>    / KORTIXD_BASE_URL    Release base; URL = <base>/<version>/kortixd-<os>-<arch>.
#   --version <v> / KORTIXD_VERSION     Release version (default: latest).
#   --dir <d>     / KORTIXD_INSTALL_DIR Install dir (default: /usr/local/bin, else ~/.local/bin).
#   --from <path> / KORTIXD_LOCAL_BINARY  Install from a local file instead of downloading.
set -eu

BASE_URL="${KORTIXD_BASE_URL:-}"
URL="${KORTIXD_URL:-}"
VERSION="${KORTIXD_VERSION:-latest}"
INSTALL_DIR="${KORTIXD_INSTALL_DIR:-}"
FROM="${KORTIXD_LOCAL_BINARY:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --base) BASE_URL="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "kortixd install: unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { echo "kortixd install: $1" >&2; }
die() { log "$1"; exit 1; }

# Detect OS and architecture, normalised to the release naming.
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in
  linux) os="linux" ;;
  darwin) os="darwin" ;;
  *) die "unsupported OS: $os" ;;
esac
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) die "unsupported architecture: $arch" ;;
esac
log "target: ${os}-${arch}"

# Choose an install directory that is writable.
if [ -z "$INSTALL_DIR" ]; then
  if [ -w /usr/local/bin ] 2>/dev/null; then
    INSTALL_DIR="/usr/local/bin"
  elif mkdir -p /usr/local/bin 2>/dev/null && [ -w /usr/local/bin ]; then
    INSTALL_DIR="/usr/local/bin"
  else
    INSTALL_DIR="${HOME}/.local/bin"
  fi
fi
mkdir -p "$INSTALL_DIR" || die "cannot create install dir: $INSTALL_DIR"
TARGET="${INSTALL_DIR}/kortixd"

# Stage into a temp file in the SAME directory, so the final move is an atomic
# rename and never leaves a half-written binary at $TARGET.
TMP="${INSTALL_DIR}/.kortixd.install.$$"
cleanup() { rm -f "$TMP" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if [ -n "$FROM" ]; then
  # Local-file install path — used for offline installs and testing.
  [ -f "$FROM" ] || die "local binary not found: $FROM"
  log "installing from local file: $FROM"
  cp "$FROM" "$TMP"
else
  # Network install path.
  if [ -z "$URL" ]; then
    [ -n "$BASE_URL" ] || die "no download source: set --url, or --base (KORTIXD_BASE_URL)"
    URL="${BASE_URL%/}/${VERSION}/kortixd-${os}-${arch}"
  fi
  log "downloading: $URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$TMP" || die "download failed: $URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMP" "$URL" || die "download failed: $URL"
  else
    die "need curl or wget to download"
  fi
fi

chmod 0755 "$TMP" || die "chmod failed"

# Verify the downloaded binary actually runs before it takes the name.
if ! "$TMP" version >/dev/null 2>&1; then
  die "downloaded binary failed to run \`version\` — not installing"
fi

mv -f "$TMP" "$TARGET" || die "could not move binary into $TARGET"
trap - EXIT INT TERM
log "installed → $TARGET"
"$TARGET" version || true

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) : ;;
  *) log "add ${INSTALL_DIR} to your PATH to run \`kortixd\` directly" ;;
esac
