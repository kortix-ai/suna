---
recorded: 2026-08-25T22:39:45Z
incident_date: 2026-08-25
commit: 3aa4dfd0dd
---
# A runner label is a tested contract, and a third-party runner pool is a deploy dependency

**When:** changing any `runs-on` / matrix `runner:` in `.github/workflows/`,
including an auto-generated PR (Blacksmith's Migration Wizard, Dependabot).
Two rules. (1) Run the workflow-pinning unit lane before merging —
`pnpm --dir tests test:unit` — because `tests/unit/*-workflow.test.ts` pin
runner labels, cache directives and step order as source text; a label
rewrite that touches nothing else still turns `main` red. (2) Never commit a
bare runner label. Every Linux `runs-on` is
`${{ vars.CI_RUNNER_<tier> || '<blacksmith label>' }}` so a repository
variable can move a tier back to GitHub-hosted without a PR — a PR cannot fix a
runner outage, its checks need runners. Off-Blacksmith the Docker actions
fall back (cold) instead of failing. Runbook: `docs/runbooks/ci-runners.md`.
*Incident:* PR #6901 (wizard, 125 label rewrites) merged at 22:00 UTC with its
`warm core worker` check red on 3 `image-build-speed-workflow.test.ts`
assertions (`ubuntu-24.04-arm` pinned) and three amd64 matrix legs left on
`ubuntu-latest`; in the following hour Deploy Dev jobs waited 14 s – 6 min in
`queued` for a Blacksmith runner while ≤3 ran. No prod impact.
*Enforcer:* `image-build-speed-workflow.test.ts` "every Linux job keeps the
Blacksmith runner kill switch" rejects any bare label in any workflow.
*Addendum (same day):* a vendor's cache claim is not a measurement. Five
consecutive builds of one `cache-key` on Blacksmith's sticky-disk builder
reused 0 layers (`WORKDIR /app` re-executed) while the registry cache reused
34–45 on the same Dockerfile; `grep -c ' CACHED'` on the build log is the only
proof of a warm build. Keep `cache-from`/`cache-to: type=registry` until a
re-measurement shows the sticky disk hitting (PR #6905).
