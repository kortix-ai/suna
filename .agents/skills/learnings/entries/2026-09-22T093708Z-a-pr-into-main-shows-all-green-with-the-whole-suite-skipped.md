---
recorded: 2026-09-22T09:37:08Z
incident_date: 2026-09-22
commit: 5cad939147
---
# A PR into `main` shows all-green with the whole suite skipped

**Rule:** before merging any PR into `main`, read the CHECK NAMES, not the
pass count. `tests.yml` gates its lane matrix on
`contains(labels, 'test') || contains(labels, 'preview')` for pull requests
into `main`, so an unlabelled PR skips all six lanes — core, browser-1..4,
packages — and still reports every remaining check green. `${{ matrix.lane }}
lane: skipping` beside `9 pass / 0 fail` is a PR that ran CodeQL, gitleaks and
a typecheck, and nothing else. Add the `test` label and wait, or merge knowing
only lint ran. **Near-miss:** PR #7483 (transcript mirror paging, apps/api +
packages/sdk) was `MERGEABLE`/`CLEAN` with zero lanes run; labelled, the core
lane then failed and four browser lanes passed. **Gotcha within the gotcha:**
`gh pr edit --add-label` can fail on a Projects-classic GraphQL error and
apply NOTHING while exiting noisily — check
`gh pr view --json labels`, or use
`gh api -X POST repos/<owner>/<repo>/issues/<n>/labels -f 'labels[]=test'`.
*Enforcer:* none — the skip is by design, so nothing will ever fail for it.
The check-name read is the control.
