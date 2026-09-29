---
recorded: 2026-09-28T16:52:19Z
incident_date: 2026-09-28
supersedes: 2026-09-28T161235Z-never-trigger-ci-on-a-pull-request-into-main-the-developer-s.md
---
# Run CI before a main merge only when a person adds a label, once; never from a push or automation

**Rule:** A pull request into `main` runs nothing by itself. Adding `test` runs the six `Tests` lanes once; adding `preview` deploys and runs `--target-full` once. A push re-runs neither. Never add either label by default, from a template, or from automation. A red post-merge run on `main` is fixed forward by the culprit's author; after 1 hour red, anyone may revert the culprit PR.

**Trigger surface:** Adding a PR label, writing agent or factory instructions, editing `tests.yml` / `deploy-preview.yml` triggers or concurrency.

**Incident:** 2026-09-28. The first fix (PR #7995) removed the labels entirely; a person could no longer ask for CI before a merge. The old labels re-ran on every push, and every agent PR carried `preview`, which drove ~$60/day of Blacksmith spend. A labelled run also shared the PR's concurrency group, so a later push cancelled it.

**Enforcement:** `tests/unit/sandbox-workflow.test.ts` pins both label gates to the label-added event, the separate `-label` concurrency group, and `deploy-preview.yml` without a push event; it fails when any other workflow triggers on a pull request into `main`.
