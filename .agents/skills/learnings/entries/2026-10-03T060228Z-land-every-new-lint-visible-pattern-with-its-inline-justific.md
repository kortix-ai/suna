---
recorded: 2026-10-03T06:02:28Z
incident_date: 2026-10-03
---
# Land every new lint-visible pattern with its inline justification the same commit

**Rule:** A change that adds a lint-visible pattern (a module-level Map, a
`console.log`, a restricted construct) lands in the same commit as its inline
justification comment or its `eslint-suppressions.json` entry. Never merge with
the rule red and the ledger silent.

**Trigger surface:** Editing `apps/api/src` (or any package whose lint rules
gate a package-quality lane) and introducing a construct a custom rule reports.

**Incident:** 2026-10-03. A merged rate-limit fix (KRTX-1039) added a
module-level `Map` with no `replica-local:` justification comment. The API
packages lane went red on `main`, so every later worker's `pnpm test` wrote a
red `packages` attestation and the merge gate's G11 attestation check held each
PR until the comment landed (found while reworking KRTX-1258, PR #8865).

**Enforcement:** `pnpm --filter kortix-api lint` fails on the unsuppressed
pattern, and the root `pnpm test` attestation records `packages: fail`, which
`tests/verify-attestation.mjs` (pre-push hook and merge-gate G11) rejects.
