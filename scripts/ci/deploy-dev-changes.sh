#!/usr/bin/env bash
#
# deploy-dev-changes.sh — decide which dev surfaces a `surface=changed` Deploy
# Dev run builds. Each surface is diffed against the commit THAT surface serves,
# not against one shared base.
#
# Before 2026-11-06 every surface diffed against the API's /health commit. When
# the API rolled and the web (or gateway, or CLI) roll failed in the same run,
# the next run's base was already past the failed commit: the web stayed on the
# old build until a later commit touched the frontend paths again.
#
# Environment:
#   FILTERS      the path filters, one block per surface (the deploy-dev.yml
#                `filters:` text): `name:` lines, then `- 'glob'` lines.
#                `#` starts a comment.
#   BASE_<NAME>  the commit the surface serves (NAME = the surface name in upper
#                case, e.g. BASE_API, BASE_APPS_ROUTER). Empty, `unknown`, or a
#                commit not in this clone's history: the surface builds
#                (fail-safe: a redundant build is cheap, a stranded surface is
#                the bug).
#   HEAD_SHA     the commit to deploy (default HEAD).
#
# Output on stdout: one `<name>=true|false` line per surface. Reasons go to
# stderr. Exit 0, or 2 when FILTERS is empty.

set -euo pipefail

head_sha="${HEAD_SHA:-HEAD}"
filters="${FILTERS:-}"
[ -n "$filters" ] || { echo "deploy-dev-changes: FILTERS is empty" >&2; exit 2; }

# Two parallel indexed arrays (bash 3 on macOS has no associative arrays).
names=()
specs=()
while IFS= read -r line; do
  line="${line%%#*}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -n "${line//[[:space:]]/}" ] || continue
  if [[ "$line" =~ ^[[:space:]]*([a-z_]+):$ ]]; then
    names+=("${BASH_REMATCH[1]}")
    specs+=("")
  elif [[ "$line" =~ ^[[:space:]]*-[[:space:]]*\'([^\']+)\'$ ]] && [ "${#names[@]}" -gt 0 ]; then
    last=$(( ${#specs[@]} - 1 ))
    specs[$last]="${specs[$last]}${BASH_REMATCH[1]}"$'\n'
  else
    echo "deploy-dev-changes: cannot parse filter line: $line" >&2
    exit 2
  fi
done <<<"$filters"

for i in "${!names[@]}"; do
  name="${names[$i]}"
  var="BASE_$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
  base="${!var:-}"
  if [ -z "$base" ] || [ "$base" = unknown ] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
    echo "$name: base '${base}' is not a known commit -> build (fail-safe)" >&2
    echo "$name=true"
    continue
  fi
  pathspecs=()
  while IFS= read -r glob; do
    [ -n "$glob" ] && pathspecs+=(":(glob)$glob")
  done <<<"${specs[$i]}"
  if git diff --quiet "$base" "$head_sha" -- "${pathspecs[@]}"; then
    echo "$name: no change since ${base:0:10}" >&2
    echo "$name=false"
  else
    echo "$name: changed since ${base:0:10}" >&2
    echo "$name=true"
  fi
done
