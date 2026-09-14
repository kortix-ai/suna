#!/bin/sh

set -eu

root="${STANDALONE_ROOT:-/app}"
case "$root" in
  /*) ;;
  *) echo "STANDALONE_ROOT must be an absolute path" >&2; exit 2 ;;
esac
[ "$root" != "/" ] || { echo "STANDALONE_ROOT cannot be /" >&2; exit 2; }

root_modules="$root/node_modules"
app_modules="$root/apps/web/node_modules"
store="$root_modules/.pnpm"

rm -rf "$app_modules"
mkdir -p "$app_modules"

find "$store" -mindepth 3 -maxdepth 3 \( -type d -o -type l \) -path '*/node_modules/*' | sort |
  while read -r target; do
    pkg=$(basename "$target")
    case "$pkg" in @*|.bin|node_modules) continue ;; esac
    [ -f "$target/package.json" ] || continue
    [ -e "$root_modules/$pkg" ] || [ -L "$root_modules/$pkg" ] || ln -s "$target" "$root_modules/$pkg"
    [ -e "$app_modules/$pkg" ] || [ -L "$app_modules/$pkg" ] || ln -s "$target" "$app_modules/$pkg"
  done

find "$store" -mindepth 4 -maxdepth 4 \( -type d -o -type l \) -path '*/node_modules/@*/*' | sort |
  while read -r target; do
    [ -f "$target/package.json" ] || continue
    scope=$(basename "$(dirname "$target")")
    pkg=$(basename "$target")
    mkdir -p "$root_modules/$scope" "$app_modules/$scope"
    [ -e "$root_modules/$scope/$pkg" ] || [ -L "$root_modules/$scope/$pkg" ] || ln -s "$target" "$root_modules/$scope/$pkg"
    [ -e "$app_modules/$scope/$pkg" ] || [ -L "$app_modules/$scope/$pkg" ] || ln -s "$target" "$app_modules/$scope/$pkg"
  done
