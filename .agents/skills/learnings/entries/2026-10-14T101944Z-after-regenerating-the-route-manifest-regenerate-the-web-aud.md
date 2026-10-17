---
recorded: 2026-10-14T10:19:44Z
incident_date: 2026-10-13
---
# After regenerating the route manifest, regenerate the web audit route list in the same commit

**Rule:** A new API route needs three generated files, in one commit: `cd apps/api && … bun scripts/dump-routes.ts` (the placeholder env in its header) writes `tests/spec/routes.generated.json`; `node apps/web/scripts/generate-audit-http-routes.mjs` writes `apps/web/src/components/iam/audit-http-routes.generated.ts` from it; the audit catalog line goes in `packages/shared/src/audit-route-labels.ts`. Then run the web audit registry test (`cd apps/web && bun test --isolate src/components/iam`) before the merge. A dump that fails config validation leaves the manifest unchanged: check that the new route is in it.

**Trigger surface:** Adding or renaming an API route (`createRoute` in `apps/api/src/**/routes/*.ts`).

**Incident:** 2026-10-13, dev. kortix-ai/suna#9792 (KRTX-1734) added `POST /v1/projects/:projectId/sessions/:sessionId/restore` and its audit label, but not the web audit route list. The branch's own manifest also lacked the route, because the builder's dump had failed on config validation; the manifest was regenerated only at merge time. Dev's packages lane went red (`audit HTTP route registry > maps every API route to a readable label`) from `65ef173b84` until kortix-ai/suna#9803 regenerated the list about 3 hours later.

**Enforcement:** `apps/web` audit registry test (`maps every API route to a readable label`) and the route coverage gate (`cd tests && bun bin/ke2e.ts coverage`). Both catch it only when someone runs them before the merge; nothing runs on a pull request into `dev`.
