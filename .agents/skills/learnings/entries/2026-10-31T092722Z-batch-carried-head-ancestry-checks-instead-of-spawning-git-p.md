---
recorded: 2026-10-31T09:27:22Z
incident_date: 2026-10-31
---
# Batch carried-head ancestry checks instead of spawning Git per request

**Rule:** Use Git's `for-each-ref --merged=<tip>` to classify carried branch tips in one process. Filter the result by exact requested refs; never pass untrusted refs as patterns. Preserve the request deadline.

**Trigger surface:** Change-request merge follow-up ancestry checks in `projects/git/merge.ts`.

**Incident:** KRTX-3761, production v0.14.12: merge requests returned 25 s deadline 503s. Completed Git work consumed 10–14 s in sampled failures, with 14–39 operations already complete. The carried-head check added two sequential subprocesses for each of up to 200 heads after the push. This removes that amplification; production recovery still requires the 24 h rate check, and logs do not prove the exact slow stage.

**Enforcement:** `apps/api/src/projects/git/landed-heads.test.ts` classifies 200 carried heads plus equal, divergent, missing and invalid heads against real Git, asserting one query. `CR-14` verifies HTTP merge and persisted carried-request states.
