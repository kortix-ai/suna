---
recorded: 2026-10-07T13:26:19Z
incident_date: 2026-10-07
---
# Exclude tests/attestations from every repository-wide text guard

**Rule:** A guard that scans every tracked file for a forbidden string excludes `tests/attestations/`, the same way it excludes `tests/test-results/`. An attestation lists the paths its branch changed (`diff_files`), so a file NAME the guard allowlists becomes forbidden CONTENT there.

**Trigger surface:** Adding or editing a `tests/unit/*.test.ts` guard that walks `git ls-files` and greps file contents; merging a PR whose changed files include an allowlisted file name.

**Incident:** 2026-10-07. The docker-volume leak fix (#9345) changed the retired-provider migration test in `packages/db/scripts/`, which `tests/unit/retired-local-provider.test.ts` allowlists by name. The merged attestation `tests/attestations/ino-test-docker-volume-leak.json` listed that path, so the guard found the retired provider id in it. Every branch that merged `dev` afterwards failed the flow-runner-unit lane on its first run (the run deletes other attestations only after the tests). Caught on the next branch's run within the hour.

**Enforcement:** `tests/unit/retired-local-provider.test.ts` excludes `tests/attestations/` (KRTX-1735 PR). None yet for new guards: copy both generated-output prefixes when writing one.
