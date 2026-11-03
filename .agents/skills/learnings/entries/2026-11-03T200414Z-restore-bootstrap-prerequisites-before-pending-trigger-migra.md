---
recorded: 2026-11-03T20:04:14Z
incident_date: 2026-11-03
---
# Restore bootstrap prerequisites before pending trigger migrations

**Rule:** Check public-schema tables against the current full migration chain before adding durable triggers. A table in the retired Drizzle bootstrap is not necessarily created by the current baseline. Repair immutable migration ordering through the checksum-guarded runtime correction, not by skipping the trigger.

**Trigger surface:** A migration adds a trigger on public contact capture storage.

**Incident:** KRTX-4004: fresh dev migrations stopped at the Sales producer because public.contact_forms existed only in the retired bootstrap. The blocked chain prevented Sales integration verification.

**Enforcement:** packages/db/scripts/contact-forms-prerequisite.integration.test.ts runs the pending producer against real PostgreSQL twice, preserves a submission, and verifies durable enqueue and anonymous capture. The Sales outbox integration suite exercises the full migration chain.
