#!/bin/sh
# Binary-dump guard: refuses a commit or push that adds a crash dump or a file
# over 20 MB.
#
# On 2026-10-04 a factory worker committed a 60 MB ELF core dump at the
# repository root. A core dump holds the process environment, so it carried
# every secret the worker had. GitHub push protection skips binary files and
# let it through. The largest tracked file is 7.3 MB, so 20 MB has headroom.
#
# Refused:
#   - an ELF core file (magic 7f 45 4c 46, e_type 4 = ET_CORE);
#   - a Mach-O core file (magic cf fa ed fe, filetype 4 = MH_CORE);
#   - any file larger than 20 MB.
#
# Modes:
#   check-binary-dumps.sh staged   staged files (pre-commit)
#   check-binary-dumps.sh push     pre-push stdin: files the new commits add or edit
set -e

max_bytes=20971520
zero=0000000000000000000000000000000000000000

# Reads `git diff --raw` lines (":mode mode old new status<TAB>path") on stdin
# and prints "  path: reason" for every refused blob.
scan() {
  while IFS="$(printf '\t')" read -r meta path; do
    blob=$(printf '%s' "$meta" | awk '{print $4}')
    [ -n "$blob" ] && [ "$blob" != "$zero" ] || continue
    size=$(git cat-file -s "$blob")
    if [ "$size" -gt "$max_bytes" ]; then
      echo "  $path: $((size / 1048576)) MB is larger than 20 MB"
      continue
    fi
    head=$(git cat-file blob "$blob" | od -An -tx1 -N18 | tr -d ' \n')
    case "$head" in
      7f454c46??01????????????????????0400) echo "  $path: ELF core dump" ;;
      7f454c46??02????????????????????0004) echo "  $path: ELF core dump" ;;
      cffaedfe????????????????04000000*) echo "  $path: Mach-O core dump" ;;
    esac
  done
}

case "$1" in
  staged)
    out=$(git diff --cached --raw --no-abbrev --diff-filter=AM | scan)
    what=commit
    ;;
  push)
    out=$(while read -r _ local_sha _ _; do
      [ -n "$local_sha" ] && [ "$local_sha" != "$zero" ] || continue
      git log --raw --no-abbrev --no-merges --format= --diff-filter=AM "$local_sha" --not --remotes
    done | scan | sort -u)
    what=push
    ;;
  *)
    echo "usage: check-binary-dumps.sh staged | push" >&2
    exit 2
    ;;
esac

if [ -n "$out" ]; then
  echo "binary-dumps: this $what adds a crash dump or an oversized file:" >&2
  printf '%s\n' "$out" >&2
  echo "  A core dump carries the whole process environment, secrets included." >&2
  echo "  Unstage it (git rm --cached <path>) and stage files by name, never git add -A." >&2
  exit 1
fi
