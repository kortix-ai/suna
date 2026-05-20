#!/usr/bin/env bash
#
# Fast iteration — build only the current host's target and symlink
# `bundle/kortix → bundle/kortix-<host>` so you can run `./bundle/kortix …`.
set -euo pipefail

HERE="$(dirname "${BASH_SOURCE[0]}")"
source "$HERE/_build.sh"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac
case "$OS" in
  darwin|linux) ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

SCRIPT="$HERE/bundle-${OS}-${ARCH}.sh"
if [[ ! -f "$SCRIPT" ]]; then
  echo "No bundle script for ${OS}-${ARCH}" >&2
  exit 1
fi

bash "$SCRIPT"
link_host "kortix-${OS}-${ARCH}"

# Print a path the user can actually paste. pnpm cd's into the package
# dir before running scripts, so $PWD here is apps/cli — not where the
# user typed `pnpm cli:bundle`. pnpm preserves the original cwd in
# $INIT_CWD; prefer that when present.
BIN_ABS="$OUT_DIR/kortix"
USER_CWD="${INIT_CWD:-$PWD}"
if command -v python3 >/dev/null 2>&1; then
  REL="$(python3 -c "import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))" "$BIN_ABS" "$USER_CWD")"
else
  REL="$BIN_ABS"
fi
echo
echo "Done. Run:  ./${REL} --help"
