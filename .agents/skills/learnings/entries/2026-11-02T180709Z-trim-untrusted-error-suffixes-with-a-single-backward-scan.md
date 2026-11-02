---
recorded: 2026-11-02T18:07:09Z
incident_date: 2026-11-02
---
# Trim untrusted error suffixes with a single backward scan

**Rule:** Trim repeated whitespace and periods with one backward scan. An unanchored quantified suffix regex retries from each possible start and can take quadratic time.

**Trigger surface:** Rendering server error text in session wake status notes.

**Incident:** 2026-11-02, release v0.14.16. CodeQL blocked release PR #11485 on the status-note suffix regex. A synthetic 100,000-tab prefix took 16 seconds before the fix and milliseconds after it.

**Enforcement:** `packages/ui/src/session/status/session-starting-loader.test.ts` exercises the real formatter with long prefixes and suffixes; the release CodeQL gate checks the implementation.
