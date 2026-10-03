---
recorded: 2026-10-03T21:53:43Z
incident_date: 2026-10-03
---
# Retain recovery records until every test resource is removed

**Rule:** Remove every external resource before deleting its recovery records or synthetic owner. Stop the browser before enumerating all project sessions. Confirm provider removal before purging the project. Preserve identity and metadata when cleanup fails.

A missing provider ID is unresolved provisioning, not proof of removal. Do not let an empty query or a null ID satisfy the cleanup check.

**Trigger surface:** A live test creates cloud sessions or a managed repository and later deletes its synthetic account.

**Incident:** On 2026-10-03, the fresh agentic session test passed every prompt and transcript assertion. Repository purge then returned an upstream timeout. The fixture deleted its account despite that error, which removed recovery records. The project also contained a second session created automatically; the fixture only deleted its explicit session. A private recovery script confirmed repository deletion and removed the remaining synthetic sandbox. No customer resource was involved.

**Enforcement:** `tests/session-prompt.e2e.ts` enumerates all project sessions, checks persisted provider removal, and bounds repository purge retries. Its cleanup throws before purging the project or deleting identity when session cleanup fails. It also preserves identity when repository purge fails. `tests/bin/agentic.ts` rejects hook failures. `pnpm test -- --agentic-only tests/session-prompt.e2e.ts --no-cache` passed the corrected journey and teardown: one passed, zero skipped, zero flaky, root duration 86.3 seconds. Its preceding retry stopped before execution because Docker was unavailable.

**Later verification:** A cold-image comparison exposed a warm-session allocation that acquired its provider ID after the cleanup poll accepted a null ID. Private recovery confirmed both sessions and the repository removed before deleting identity. The fixture now disables the auxiliary warm pool with the real project flag and requires nonempty sandbox rows with provider IDs and confirmed removal. The latest revision passed through the root command in 82.1 seconds: one passed, zero skipped, zero flaky, complete cleanup.
