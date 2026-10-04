---
recorded: 2026-09-28T23:48:10Z
incident_date: 2026-09-26
---
# An alertable log line marks the transition into a state, never a repeat of it

**Rule:** A `warn` (or any alertable log line) fires when the system ENTERS a
state, not every time an operation runs while the state persists. Emit the
typed outcome on every occurrence; the caller and the books already carry it.

**Trigger surface:** writing or reviewing any periodic warn — a settlement
path, a sweep, a reaper, anything a cron touches more than once per state.

**Incident:** 2026-09-26 (KRTX-338, fixed in PR #8047). `wallet.settle`
warned per overdraft settlement; a box left running on a wallet at or below
zero settles every 5-minute maintenance tick, so one drained-but-running box
produced 37 warn lines in an hour against a 0.54/hour baseline (68×) — the
Better Stack log spike this repo pages on. The settlements themselves were
correct and each one's ledger row was already written.

**Enforcement:** `apps/api/src/services/billing/wallet/wallet.test.ts` "settlement
overdraft logging" — three successive settlements on a drained wallet warn
exactly once, and a re-drain after a top-up warns again; both assertions fail
without the transition gate in `wallet.settle`.
