---
recorded: 2026-09-14T23:03:23Z
incident_date: 2026-09-14
commit: 3274c25bed
---
# Preview runtime secret contracts span two Git revisions

**When:** a preview fails in `validatePreviewRuntimeSecrets` before the API starts.
The orchestration code runs from `main`; the bootstrap reads the exact PR head.
A newly allowlisted runtime secret on `main` can therefore reach an older PR
bootstrap that rejects it. Merge the upstream contract change into the canonical
branch before retrying. Do not bypass validation or remove the allowlist.

*Incident:* PR #7233, preview run `34893648765`, rejected `PLATINUM_API_KEY`.
The publisher carried #7221's new field, while the PR bootstrap predated it.
Merging `8767572f10` brought in the matching allowlist and provider configuration.
*Automation:* `tests/unit/preview-stack.test.ts` checks the allowlist and Platinum
configuration within one revision. Cross-revision compatibility is not covered.
