---
recorded: 2026-09-28T10:34:09Z
incident_date: 2026-09-28
---
# Prove that something never happened with a positive record, never with missing best-effort ones

**Rule:** Decide "this never happened" only from a record that says so, such as a complete read of the runtime that found no messages. A missing best-effort record is not evidence. The turn ledger (`kortix.session_turns`, since 2026-08-17 on dev and v0.13.0 on prod) and `metadata.last_activity_at` (since v0.12.8) swallow failed writes. They are also empty for everything that happened before them, and a self-hosted install gets them only when it upgrades.

**Trigger surface:** Any rule that reads the absence of a ledger row, a stamp, a mirror row or a cache entry as "never": empty-session detection, "first run" or "new user" gates, cleanup of "unused" rows.

**Incident:** 2026-09-28, before merge. The first fix for "an empty session opens on the boot screen" called a session empty when it had no saved copy and `/turn` had no `last_ended`. An older session with history and no saved copy says exactly that, so it would have opened as an empty conversation until its computer answered. The shipped rule reads the saved copy's proof (`total: 0` on a head-complete mirror) instead.

**Enforcement:** `packages/sdk/src/react/use-session-saved-transcript.test.ts` ("no saved copy is not an empty conversation, even with no turn on record") and `packages/sdk/src/core/session-sync/saved-transcript.test.ts` ("no saved copy is not evidence").
