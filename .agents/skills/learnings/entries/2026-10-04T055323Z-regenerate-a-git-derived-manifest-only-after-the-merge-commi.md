---
recorded: 2026-10-04T05:53:23Z
incident_date: 2026-10-04
---
# Regenerate a git-derived manifest only after the merge commit exists: git log reads HEAD, never the working tree

**Rule:** Rebase a branch, resolve the conflicts, COMMIT the merge, and only then
regenerate any manifest derived from git history (`content-timestamps.json`,
route manifests, snapshots). During conflict resolution HEAD is still the
pre-merge branch commit, so `git log` answers from the old history: entries for
files main renamed or newly committed get stale dates or the mtime fallback,
and the values silently disagree with the tree you are about to commit.

**Trigger surface:** rebasing or merging `main` into a branch that carries a
regenerated git-derived manifest; any script that runs `git log` to stamp
generated files (`apps/web/scripts/build-content-timestamps.mjs`).

**Incident:** 2026-10-04, PR #8989 (KRTX-1177 rework). The content-timestamps
manifest was regenerated mid-merge-resolution: two entries carried the old
branch's dates and one fell back to the file mtime because the file's commits
existed only in main's history. Caught before push by re-reading the diff after
the merge commit; regenerating post-commit produced the correct values. The
same staleness was live on `main` itself (its committed manifest predates the
AI-OS marketing rename), which the branch fixes by regenerating at the merged
head.

**Enforcement:** `apps/web/scripts/build-content-timestamps.test.mjs`
("matches the current git history when full history is available") fails on any
stale committed manifest. It cannot catch a regeneration that runs against the
wrong HEAD before commit — the discipline above is the guard; a `git log`-vs-
working-tree probe before regenerating would be the mechanical form.
