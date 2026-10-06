---
recorded: 2026-10-06T11:17:27Z
incident_date: 2026-10-05
---
# Never run a source-mutation auditor under a timeout or inside a sweep: a killed run leaves the mutant in tracked source

**Rule:** Run a `test/mutate-*.mjs` auditor only on purpose, alone, with no
timeout or alarm around it. The auditor rewrites a tracked source file in
place and restores it at exit; a kill skips the restore. Run `git status` after
every auditor run and before every commit that follows one.

**Trigger surface:** running suites in `apps/pi-worker-js/test/`, writing a
sweep or a CI lane over them, or wrapping any suite in a timeout.

**Incident:** 2026-10-05, branch `pi-worker-js`, near-miss caught before
commit. A sweep ran every suite under a 90 s alarm. The alarm killed a
`mutate-*` auditor mid-mutation. `apps/pi-worker-js/src/cell-git.js` was left
holding the mutant `if (false) newLines.pop();`, and several files had changed
mode bits. `git diff` showed both; the files were restored from `HEAD`. Had the
tree been committed, the cell would have shipped a disabled guard that every
non-mutation suite still passed.

**Enforcement:** `apps/pi-worker-js/test/all.sh` never runs `mutate-*`; its
header states why. None yet for the leftover mutant itself: the enforcer to
build is a pre-commit check that fails while any auditor's restore marker is
present.
