---
recorded: 2026-09-28T16:12:35Z
incident_date: 2026-09-28
supersedes: 2026-09-26T171321Z-run-the-install-lanes-on-a-dependency-bump-before-it-merges.md
---
# Never trigger CI on a pull request into main; the developer's box is the pre-merge gate

**Rule:** A pull request into `main` runs no GitHub Actions job, label or not. Run `pnpm test` and the local equivalent of every CI job you touch (testing skill → "Your machine is the pre-merge gate") before the merge. New checks go on `push: main` (non-blocking) or on pull requests into `staging` / `prod`. For a dependency bump, run `pnpm install --frozen-lockfile --lockfile-only --ignore-scripts` locally; the `test` label no longer runs anything.

**Trigger surface:** Adding or editing a workflow trigger; adding a PR label that runs CI; merging a Dependabot PR.

**Incident:** 2026-09-28. Blacksmith billed ~$2.7k in September. The last 7 days ran at ~$130/day. 46% was the six 8-vCPU `Tests` lanes on pull requests: the `preview` label opted in, and every agent PR carried it, so every push re-ran the suite. PRs also waited on `CI`, `CodeQL` (8 vCPU), and scans. The fix moved all of it to push-to-`main` and release PRs.

**Enforcement:** `tests/unit/sandbox-workflow.test.ts` → "no workflow runs a job on a pull request into main" fails when any workflow except the label-gated `deploy-preview.yml` triggers on a pull request into `main`.
