#!/bin/sh
# A `pnpm worktree` checkout belongs to one canonical branch (AGENTS.md: one
# canonical branch, one worktree). Refuse a commit on any other branch there:
# it means someone switched a worktree another session may still be using
# (2026-09-28: a session committed in another's worktree, and the owner's next
# commit landed on the wrong pull request). `<canonical>/…` sub-branches pass.
# Override for a deliberate case: KORTIX_WORKTREE_ANY_BRANCH=1.
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
marker="$top/.kortix-worktree.json"
[ -f "$marker" ] || exit 0
[ -n "${KORTIX_WORKTREE_ANY_BRANCH:-}" ] && exit 0

canonical=$(sed -n 's/^[[:space:]]*"branch":[[:space:]]*"\([^"]*\)".*/\1/p' "$marker" | head -n 1)
current=$(git branch --show-current)
[ -z "$canonical" ] && exit 0
case "$current" in
  "$canonical" | "$canonical"/*) exit 0 ;;
esac

echo "pre-commit: this worktree ($top) belongs to branch '$canonical'; HEAD is '$current'." >&2
echo "  Another session may be working here. Switch back with: git switch $canonical" >&2
echo "  Work on a new branch in its own worktree: pnpm worktree create --name <slug> --yes --no-start" >&2
exit 1
