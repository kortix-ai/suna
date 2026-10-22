#!/bin/sh
# Migration-order guard: refuses a push whose branch adds a migration that does
# not sort after every migration on origin/dev.
#
# On dev, staging and prod, node-pg-migrate runs with checkOrder. It refuses a
# not-run migration that sorts before a run one, so the next deploy stops at
# migrate. On 2026-10-07 #9312 merged 20261006182246238_session_changed_notify
# after dev already had 20261007073001000_…; every Deploy Dev then failed at
# "Apply DB migrations to dev". The "Migrations are sequential" job in
# db-migrations.yml catches this only after the merge.
#
# The check is the same as that job: each migration the branch adds
# (origin/dev...<pushed sha>) needs a 17-digit timestamp above the newest one on
# origin/dev. Fetch origin/dev first; the guard reads the local tracking ref.
# In a fork checkout `origin` is the fork, which often has no `dev` (or a stale
# one), so the guard also reads `upstream/dev` and compares against the newer
# of the two. With neither ref it warns and allows the push: on 2026-10-07 a
# fork checkout with no origin/dev pushed a duplicate of an old migration past
# this guard without a word (#9360).
#
# Usage: pre-push stdin ("<local ref> <local sha> <remote ref> <remote sha>").
set -e

zero=0000000000000000000000000000000000000000
dir=packages/db/migrations
newest() {
  git ls-tree --name-only "$1" -- "$dir/" \
    | sed -En 's#.*/([0-9]{17})_.*\.(sql|concurrent\.ts)$#\1#p' | sort -n | tail -1
}
base=""
base_max=""
for ref in refs/remotes/origin/dev refs/remotes/upstream/dev; do
  sha=$(git rev-parse -q --verify "$ref") || continue
  max=$(newest "$sha")
  [ -n "$max" ] || continue
  if [ -z "$base_max" ] || [ "$max" -gt "$base_max" ]; then
    base=$sha
    base_max=$max
  fi
done
if [ -z "$base" ]; then
  echo "migration-order: no origin/dev or upstream/dev ref with migrations; check skipped." >&2
  echo "  Fetch the canonical dev branch (git fetch <kortix-ai/suna remote> dev) so this guard can run." >&2
  exit 0
fi

out=$(while read -r _ local_sha remote_ref _; do
  [ -n "$local_sha" ] && [ "$local_sha" != "$zero" ] || continue
  [ "$remote_ref" != refs/heads/dev ] || continue
  git diff --no-renames --diff-filter=A --name-only "$base...$local_sha" -- \
    "$dir/*.sql" "$dir/*.concurrent.ts"
done | sort -u | while read -r f; do
  ts=$(basename "$f" | sed -En 's#^([0-9]{17})_.*#\1#p')
  [ -n "$ts" ] && [ "$ts" -le "$base_max" ] && echo "  $f"
done || true)

if [ -n "$out" ]; then
  echo "migration-order: these new migrations sort before origin/dev's newest ($base_max):" >&2
  printf '%s\n' "$out" >&2
  echo "  checkOrder on dev/staging/prod refuses them and the deploy stops at migrate." >&2
  echo "  Rename each to a fresh timestamp (date -u +%Y%m%d%H%M%S000) and re-run pnpm test." >&2
  exit 1
fi
