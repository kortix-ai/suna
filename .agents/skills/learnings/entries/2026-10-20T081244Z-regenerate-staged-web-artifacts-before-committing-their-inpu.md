---
recorded: 2026-10-20T08:12:44Z
incident_date: 2026-10-07
---
# Regenerate staged web artifacts before committing their inputs

**Rule:** The pre-commit hook refreshes content timestamps and audit routes when their inputs are staged. Stage all relevant input edits first; the hook refuses partially staged inputs or dirty outputs instead of committing unstaged work. Timestamp generation uses strict error handling in the hook; builds retain best-effort behavior. Timestamp checks still compare tree membership and ISO validity, never git dates across squash merges.

**Trigger surface:** Committing web content, marketing sources, the route manifest, or their generators.

**Incident:** KRTX-1849: docs and route changes repeatedly left committed web artifacts stale. The next unrelated package-lane run inherited the failures. The route list also left new routes with raw audit labels.

**Enforcement:** `scripts/refresh-staged-web-artifacts.test.mjs` runs the hook helper and real generators against a temporary Git index. It checks regeneration, staging, deletion, partial-input refusal, dirty-output refusal and generation errors.
