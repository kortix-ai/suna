---
recorded: 2026-09-28T18:16:41Z
incident_date: 2026-09-28
supersedes: 2026-09-28T165219Z-run-ci-before-a-main-merge-only-when-a-person-adds-a-label-o.md
---
# The preview label deploys only; run the deployed suite on a preview only by dispatch

**Rule:** Adding `preview` deploys the branch once (~7 min) and runs no tests. `test` runs the ~9 min local-profile suite once. `pnpm test -- --target-full` (40–80 min: real sandboxes, managed repos, Stripe) runs against a preview only on `gh workflow run deploy-preview.yml -f pr_number=<N>`, and against staging on the prod release gate. A push re-runs nothing. Never add either label by default or from automation.

**Trigger surface:** Editing `PREVIEW_RUN_TESTS` or the triggers in `deploy-preview.yml`; asking for a hosted preview.

**Incident:** 2026-09-28. PR #7997 made the label deploy and then run `--target-full`, so a "preview" took 50–90 min and depended on the shared GitHub App and Platinum pool that failed five concurrent suites earlier that day.

**Enforcement:** `tests/unit/sandbox-workflow.test.ts` and `infra/scripts/test-ecs-preview-runtime.py` pin `PREVIEW_RUN_TESTS` to dispatch-only and `deploy-preview.yml` to `[labeled, unlabeled]`.
