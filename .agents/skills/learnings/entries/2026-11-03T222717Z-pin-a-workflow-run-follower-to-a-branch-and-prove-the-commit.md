---
recorded: 2026-11-03T22:27:17Z
incident_date: 2026-11-03
---
# Pin a workflow_run follower to a branch and prove the commit is on it before it reads any credential

**Rule:** A workflow triggered by `workflow_run` that checks out or runs
`github.event.workflow_run.head_sha` must (1) list `branches:` on the trigger,
(2) gate the job on the triggering run's `event` (push or workflow_dispatch),
`head_branch` and `head_repository`, and (3) run `git merge-base --is-ancestor`
against that branch right after the checkout, before any step reads a credential.

**Trigger surface:** Adding or editing a workflow that follows another one
(`on: workflow_run`), above all one that reads `aws-env` keys or holds
`id-token: write`.

**Incident:** 2026-11-03, PR #11646 (Strix review, HIGH, near miss, no
exploit seen). `workflow_run` matches the triggering workflow by name only. A
pull request could run its own copy of a workflow named "Deploy Prod". Its green
run started Mobile OTA, which checked out the pull request's commit and ran it
with `EXPO_TOKEN` (OTA publish, EAS build and store submit) and AWS OIDC.
Mobile OTA had this hole since it was added. The new Mobile Store workflow
copied it until review. Both are fixed in PR #11646.

**Enforcement:** `tests/unit/workflow-run-trust.test.ts` fails when a workflow
with a `workflow_run` trigger that references `workflow_run.head_sha` lacks
`branches:` on the trigger or a `git merge-base --is-ancestor` check.
