---
recorded: 2026-08-24T04:24:38Z
commit: 83c3bc6936
---
# A wake budget is a deadline, not an attempt count

2026-08-24. Auto-resume was three attempts spaced 1500 ms — about three
seconds — and a self-host's E2B resume takes 8.0–8.8 s. Every healthy sleeping
box ran out of budget mid-wake, and the page replaced its loader with
"session <id> is stopped — open a new session to continue" moments before the
same box came up. Users read it as "all my sessions are broken".

**The rule.** Anything that waits for a machine to boot is bounded by a
deadline measured from the first observation of the resumable box, never by
how many times we asked. A count describes our retry spacing, not the machine.

**The enforcement.** `apps/web/src/features/session/session-resume.test.ts`
asserts `AUTO_RESUME_WINDOW_MS >= 60_000` and that a null clock is
"just started", not "expired".

*Incident:* sampleco, every stopped session, 2026-08-24. PR #6827.
