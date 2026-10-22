---
recorded: 2026-10-20T16:58:21Z
incident_date: 2026-10-16
---
# A branch that carries trunk content without trunk's ancestry lies in every diff built from the merge-base. Resolve a trunk sync with a real `git merge origin/dev` — a single-parent commit whose message says "merge origin/dev" poisons the PR diff (trunk's work shows as the PR's own, a G9 reviewer reads scope that is not there) and the attestation certifies a diff the PR does not contain.

**Rule:** A branch that carries trunk content without trunk's ancestry lies in every diff built from the merge-base. Resolve a trunk sync with a real `git merge origin/dev` — a single-parent commit whose message says "merge origin/dev" poisons the PR diff (trunk's work shows as the PR's own, a G9 reviewer reads scope that is not there) and the attestation certifies a diff the PR does not contain.

**Trigger surface:** Resolving a `dev` conflict by hand-committing the resolution instead of merging; continuing a stalled session that left such a commit; reviewing a PR whose diff contains hunks another PR authored.

**Incident:** 2026-10-16, PR #9995 (KRTX-1903). The stalled session's `bded282` ("merge origin/dev (6766162e1c)") had ONE parent: trunk's #9974 connect-card localization and #9983's codemode narration fix appeared in the PR diff as this PR's work, and the session re-created #9983's fix by hand on top (`5bcf7b5`), byte-identical to trunk. A real merge of origin/dev collapsed all of it — the PR went from 31 files / +365−52 to 21 files / +258−16, and the "packages lane fails at trunk" story in the PR body was dead (trunk had fixed it). Near-miss: the false diff nearly shipped as the PR's scope.

**Enforcement:** To build: a push/commit guard (`scripts/check-*.sh`) that fails when a new commit's message starts with `merge origin/dev` but the commit has fewer than 2 parents; pin it in the worktree-tool tests like the other `check-*` guards. Until then: a reviewer check — `git rev-list --count --parents -1 <merge-commit> ` and `git diff origin/dev...HEAD --name-only` scanned for files a named trunk PR authored.


Enforcer implemented by KRTX-2515: `scripts/check-fake-merge.sh` runs in `.githooks/pre-push`; `scripts/worktree/__tests__/fake-merge.test.ts` exercises real Git ancestry and the installed hook. The incident text above preserves the original attestation context; attestations were removed on 2026-10-16.
