---
recorded: 2026-10-23T17:21:44Z
incident_date: 2026-10-23
---
# Check Git object types before treating bad-file errors as corruption

**Rule:** When a blob read fails, check the object's type. Return file-not-found for a tree or commit; preserve actual Git failures.

**Trigger surface:** Raw repository-file reads through `git cat-file blob`.

**Incident:** KRTX-3405: four production errors occurred when a raw-file request named a directory. Git reports this as `bad file`, not a missing path.

**Enforcement:** `apps/api/src/projects/git/files.test.ts` reproduces the directory error with real Git and verifies that a missing blob remains a GitOperationError.
