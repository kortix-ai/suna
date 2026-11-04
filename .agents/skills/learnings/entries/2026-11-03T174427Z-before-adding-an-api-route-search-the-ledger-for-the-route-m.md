---
recorded: 2026-11-03T17:44:27Z
incident_date: 2026-11-03
---
# Before adding an API route, search the ledger for the route manifest; its audit label is the step that keeps being missed

**Rule:** Before you add an API route, run `grep -i 'route manifest' .agents/skills/learnings/MEMORY.md` and follow the 2026-10-14 entry: `routes.generated.json`, the web audit route list, AND the label in `packages/shared/src/audit-route-labels.ts`, in one commit. Then run `cd apps/web && bun test --isolate src/components/iam` before the merge. The two generated files are rewritten for you by the pre-commit hook; the label is not.

**Trigger surface:** Adding or renaming an API route, including a public one outside a domain router (`apps/api/src/access-control/index.ts`).

**Incident:** 2026-11-03, PR #11615 added `GET /v1/access/branding` with the manifest and the route list but no audit label. The web audit registry test went red on `dev` and on the v0.14.18 release tree after the commit was carried to `staging` (#11620). The release driver fixed it in about 7 minutes (#11622 on `dev`, #11623 on `staging`). Second repeat of the 2026-10-14 entry.

**Enforcement:** The `apps/web` audit registry test (`maps every API route to a readable label`) catches it only when someone runs it. Enforcer to build: `scripts/refresh-staged-web-artifacts.sh` already regenerates the route list when `tests/spec/routes.generated.json` is staged; make it also fail when a route in the manifest has no label in `packages/shared/src/audit-route-labels.ts`.
