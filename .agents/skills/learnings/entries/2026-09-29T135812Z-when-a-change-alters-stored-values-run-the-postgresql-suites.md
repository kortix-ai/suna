---
recorded: 2026-09-29T13:58:12Z
incident_date: 2026-09-29
---
# When a change alters stored values, run the PostgreSQL suites that read them before merging

**Rule:** When a change alters a value the platform stores (a MIME type, a status, a key name), run `pnpm test -- --db-only <module>` for every PostgreSQL suite that reads that value before merging into `main`. A focused unit test of the changed function does not prove the integration suites still agree. If your box cannot run PostgreSQL, add the `test` label to the pull request once instead of merging on unit tests alone.

**Trigger surface:** Any change under `apps/api` that writes a stored field, for example `apps/api/src/services/attachments/prompt-attachment-upload.ts`, and every `*.integration.test.ts` / `integration-*.test.ts` that asserts that field.

**Incident:** 2026-09-29, main red. `0a62a6b497` (KRTX-778) began storing non-native prompt attachment types as `application/octet-stream`. Its pull request ran the focused unit test only; its author's box could not run the PostgreSQL suites. `apps/api/src/__tests__/integration-prompt-attachments.test.ts` still expected `text/plain`, and 3 of its 17 tests failed on every `pnpm test` from that merge onward. Found while verifying KRTX-639, and reproduced on a clean `origin/main` checkout.

**Enforcement:** The post-merge `Tests` core lane runs the PostgreSQL suites and comments a red run on the commit. The KRTX-639 branch updated the three expectations, and `pnpm test -- --db-only integration-prompt-attachments` passes 17 of 17.
