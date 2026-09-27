---
recorded: 2026-09-27T04:16:45Z
incident_date: 2026-09-26
---
# A truncated console line is a pointer to evidence, never the evidence

**Rule:** diagnose a deployed-suite failure from the run's `results.json`
artifact, not from the console line. The runner truncates a failure reason at
200 characters, and a reason that ends in `: ` is a cut string, not an empty
value. Before proposing any cause, download the artifact and read the failing
step's captured requests: the status, the body, and the error the body carries.

**Trigger surface:** triaging a `tests-release` or `deploy-preview`
`--target-full` failure; any report that quotes a `✗ [n/m] FAIL <ID>` line as
the failure.

**Incident (2026-09-26, preview run 36279090948).** `CFG-11` and `CFG-12`
printed `the answer does not come from the new release: ` with nothing after
the colon. Three conclusions were drawn from that line and all three were
wrong: that a base move was not reaching a running session (reported to the
owner, twice), that a newly added awaited catalog gate was cutting the turn
short, and that the preview account had run out of credits. The artifact held
the answer the whole time — the `POST .../message` returned **200** with a
complete OpenCode message whose body carried
`"deepseek-v4.1-flash" requires a paid plan.` /
`code: plan_upgrade_required` / `statusCode: 400`, which is
`noManagedModelsError` in
`apps/api/src/llm-gateway/resolution/resolve-candidates.ts`. A plan-tier gate,
not an empty answer, not config releases, not the catalog.

**Two corollaries, both paid for in the same session.** (1) **Ownership is
settled by a control, not by suspicion.** PR #7796 — a branch with zero lines
of the suspected change — failed the same two flows with identical reason
strings in run 36287293649 (`547/557 passed · 5 failed`). One control run
ended an argument that code reading could not. (2) **One `402` is not a
drained environment.** The single `Out of credits` in that run belonged to
`BILL-17`, which asserts it deliberately on its own account; a theory was built
on it before its owning flow was checked.

**Enforcement:** none. The console truncation is by design and the artifact is
already published per run. The check is a habit: `gh api
repos/<owner>/<repo>/actions/artifacts/<id>/zip`, unzip, read the failing
flow's captured requests, and quote the status and body — never the console
line — in any report.
