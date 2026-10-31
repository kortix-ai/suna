---
recorded: 2026-10-31T08:13:54Z
incident_date: 2026-10-31
supersedes: 2026-10-20T081244Z-regenerate-staged-web-artifacts-before-committing-their-inpu.md
---
# Stage the audit-actions doc's inputs and its regenerated doc in one commit — the hook regenerates it

**Rule:** The pre-commit hook refreshes THREE generated web artifacts from staged inputs: content timestamps, the web audit route list, and the audit-actions reference doc (`apps/web/content/docs/audit-actions.mdx`). The doc's inputs are the label catalog (`packages/shared/src/audit-*.ts`), the generator (`apps/web/scripts/generate-audit-actions-doc.mjs`), `apps/web/scripts/docs-generated-region.mjs` and `apps/api/src/feature-flags/registry.ts` (a default flip changes which actions the doc lists). The hook refuses partially staged inputs and dirty outputs; without `bun` on PATH it refuses with the regenerate command instead of landing a stale doc.

**Trigger surface:** Adding or renaming audit labels or routes (`packages/shared/src/audit-*.ts`), editing the audit-actions generator, or changing a feature-flag default.

**Incident:** 2026-10-31, KRTX-3758: #11283 added the Claude-subscription audit labels after #11275 had regenerated the doc (KRTX-3743's fix), so the doc was stale at the trunk and the guard `tests/unit/audit-actions-doc.test.ts` failed on every run. Same class as KRTX-1849 and KRTX-3743: the hook covered two artifacts but not this one. Fixed in PR #11297.

**Enforcement:** `scripts/refresh-staged-web-artifacts.test.mjs` — the audit-actions leg proves regeneration and staging from a staged labels change, the dirty-output refusal, and the no-bun refusal. `tests/unit/audit-actions-doc.test.ts` stays the trunk guard (core-db lane nightly, release suite at promote).
