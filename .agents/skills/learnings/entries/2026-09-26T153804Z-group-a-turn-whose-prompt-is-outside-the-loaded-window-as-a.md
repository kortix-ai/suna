---
recorded: 2026-09-26T15:38:04Z
incident_date: 2026-09-26
---
# Group a turn whose prompt is outside the loaded window as a partial turn, in display order

**Rule:** A transcript window is a bounded tail, so a long run's prompt is often not loaded. Group the replies whose parent prompt is missing as a `partial` turn, in display order, under a stand-in with the parent's id. Never place orphans one at a time with `unshift`: that reverses them.

**Trigger surface:** Changing `groupMessagesIntoTurns`, the saved-copy (mirror) window, the tail read's backfill bound, or how a host renders a turn's prompt row.

**Incident:** On 2026-09-26, most long automated sessions opened with their run in reverse order (newest step first), filed under a later prompt. It looked like the page had stopped fetching messages. The bug was present on v0.13.31 and v0.13.32. The trigger is a page that holds only the saved-copy window, as a stopped session does, or a run longer than the 500-message tail backfill. Fixed in PR #7738.

**Enforcement:** `packages/sdk/src/core/turns/grouping-partial-turns.test.ts` (8 cases, each red on the old grouping). Journey 33 "a long run whose prompt is outside the saved window reads in order" asserts the DOM order in a real browser.
