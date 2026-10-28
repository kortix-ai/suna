---
recorded: 2026-10-27T17:16:59Z
incident_date: 2026-10-27
---
# Read boot timings from server timestamps or one open connection, never from a poll that starts a process per poll

**Rule:** A bench or probe that times a boot reads the server's own timestamps (`session_sandboxes.active_since`, `metadata.providerRunningConfirmedAt`, the provision timeline) or polls on one open connection. A poll that starts a process per read (`psql`, `dotenvx`, the CLI) adds its own start time to every sample and rounds every result to that step. Before you trust a difference between two arms, check that it is larger than the poll's resolution.

**Trigger surface:** Writing or reading a boot, resume or wake benchmark against dev or a local stack, including scripts outside the repo that query `kortix.session_sandboxes`.

**Incident:** 2026-10-27. A dev check polled the session row with one new `psql` process per read, and each read took 1.15–1.25 s. It reported that reopening a stopped session with a workspace volume cost +1.3 s at row active (2.88 vs 1.55 s, n=3). A background agent spent ~1.8 h on Platinum before server timestamps showed the real cost: +0.57 s at row active (1.65 vs 1.08 s p50) and +0.36 s at runtime ready (2.09 vs 1.73 s p50), n=10 per arm. The wrong numbers also went into ledger entry 2026-10-27T143356Z (corrected in the same change as this entry).

**Enforcement:** none yet: the enforcer to build is a shared timing helper for bench scripts that reads server timestamps. `apps/api/scripts/prompt-latency-bench.ts` (the hourly canary) polls `/start` over HTTP with a 500 ms sleep, so its absolute boot times also carry that step. Compare canary runs only with each other.
