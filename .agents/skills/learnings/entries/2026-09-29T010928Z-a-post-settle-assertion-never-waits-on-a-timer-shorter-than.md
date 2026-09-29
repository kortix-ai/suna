---
recorded: 2026-09-29T01:09:28Z
incident_date: 2026-09-29
---
# A post-settle assertion never waits on a timer shorter than the window it checks; flush microtasks or budget the TTL above the timer

**Rule:** When a test must observe that an async side effect (a background
refresh, a cache write) has settled, flush microtasks (`await
Promise.resolve()`) when one hop is provably enough, or budget the wall-clock
window well above any timer the assertion still compares against. A
macrotask `sleep(0)` between settle and a freshness check races the very TTL
window the check reads: on a loaded runner the timer fires after the window
and the assertion flips. The assertion's margin must be measured from the
side effect's settle time, never from the operation's start time.

**Trigger surface:** Writing or reviewing a timer-based unit test around a
cache/memo, a background revalidation, or any "settled → assert state" hop —
especially in `bun test` where files interleave and a 0 ms `setTimeout` can
land tens of milliseconds late.

**Incident:** 2026-09-29, merge 5f2ae97 (PR #8044) red the `Tests` packages
lane on `main` right after it merged. `ttlMemo`'s new stale-while-revalidate
mode reset the entry's freshness at refresh START, and the two new tests
asserted "no extra background load" behind an `await sleep(0)`. The runner's
delayed macrotask pushed the final call past the 10 ms TTL, the entry read
stale, and the memo started a third/fourth background load: the tests failed
in CI while passing 29/29 in the authoring worker's sandbox. Reproduced
deterministically by injecting a 15 ms delay between settle and the check.
Two independent fixes landed the same day: #8064 deflaked the tests by
driving `Date.now()` with `setSystemTime`; this fix also corrects the
production cadence (freshness measured from settle).

**Enforcement:** `apps/api/src/__tests__/unit-ttl-memo.test.ts` drives
`Date.now()` with `setSystemTime` for the tests that assert "fresh again",
and `a refresh that settles after its own TTL still buys a full window`
pins the settle-based freshness (fails on the start-based code). No lint
gate yet: a lint that flags an `await sleep(<ttl>)` (or shorter) between an
async settle and an assertion that compares against that same TTL.
