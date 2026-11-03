---
recorded: 2026-11-03T16:20:00Z
incident_date: 2026-11-03
---
# Mint time-relative test ids with the clock's own function

**Rule:** A fixture that must sit a fixed distance from "now" on a time-encoded id is minted by that id's own mint function at `now ± offset`. Never build it from `Date.now()` with ad-hoc arithmetic. When a CI diff against a control run shows new failures in code the PR does not touch, rerun the control in the same minute before blaming the PR.

**Trigger surface:** Tests that build message ids, ULIDs, or any wrapping, time-encoded id relative to the current time.

**Incident:** From 2026-11-03 12:37:53 UTC, three API tests failed on every branch: two in `sandbox-proxy/routes/forward.test.ts` and one in `projects/routes/session-prompts.test.ts`. Their "far-future" id was hex(ms × 16) on the 48-bit wire-id ring (clock = ms × 4096 mod 2^48). The real clock sweeps that ring 256 times faster than the fixture moves, so the fixture flips between ahead and behind about every 5 days. A `dev` control run at 12:04 passed, and PR #11574's run at 13:28 failed the same tests on trunk code. Fixed in PR #11580.

**Enforcement:** The fixtures use `mintWireMessageId({ nowMs: now + 40 days })`, the distance the pre-fix CLI produced, so they read as ahead at any date. Verified after the flip on trunk `e2984ba8`: `forward.test.ts` 27 pass / 0 fail and `session-prompts.test.ts` 78 / 0, against 25 / 2 and 77 / 1 before.
