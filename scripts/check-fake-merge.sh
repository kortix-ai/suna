#!/bin/sh
# Refuse unpublished commits that claim a trunk merge without merge ancestry.
# Usage: pre-push stdin (<local ref> <local sha> <remote ref> <remote sha>).
set -eu
zero=0000000000000000000000000000000000000000
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "$local_sha" ] && [ "$local_sha" != "$zero" ] || continue
  # An existing destination tip is authoritative even if tracking refs are stale.
  if [ "$remote_sha" = "$zero" ]; then
    commits=$(git rev-list --max-parents=1 "$local_sha" --not --remotes)
  else
    commits=$(git rev-list --max-parents=1 "$local_sha" "^$remote_sha" --not --remotes)
  fi
  for commit in $commits; do
    subject=$(git show -s --format=%s "$commit")
    case "$subject" in
      'merge origin/dev'*)
        echo "fake-merge: $commit ($subject) has single-parent or missing merge ancestry." >&2
        echo "  Resolve trunk syncs with a real git merge origin/dev, not a hand-written merge commit." >&2
        exit 1 ;;
    esac
  done
done
