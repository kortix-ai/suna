---
recorded: 2026-09-28T18:10:58Z
incident_date: 2026-09-28
---
# A test waits on a count that means exactly its claim, on distinct ports held together, and longer than the timer it waits for

**Rule:** A test waits on a counter that means exactly what the test claims.
It reserves a port pair with both binds held until both ports are chosen. A
wait for a periodic timer gets a budget longer than the timer period plus the
work the timer does.

**Trigger surface:** Writing a `waitFor` on a stats counter, reserving ports
with `port: 0`, or waiting for a liveness or poll timer in a kortixd test.

**Incident:** 2026-09-28, the `Tests` packages lane on `main` went red on
retries with three kortixd flakes. (1) `monitor-runner` waited for `dropped >=
375` to mean "line-400 was read". The runner added one `suppressed` note per
overflowing line and counted dropped notes as lines (749 for 375 real drops), so
the wait fired mid-flood when the pipe chunked the output: 2 of 40 runs under
CPU load. The same code dropped up to 50 unsent lines per batch without a count
when an overflow hit during a POST. (2) Two sequential port-0 binds return the
same port 10 in 50,000 times on Linux, and a one-port pair made a verified
reload refuse. (3) A 5 s wait raced the 5 s liveness timer: 5 of 12 runs under
CPU load.

**Enforcement:** `monitor-runner.test.ts` asserts the exact survivors, the
exact drop count, and the in-flight overflow case.
`reserveOpenCodePortPair()` in `src/__tests__/helpers/open-code-harness.ts` is
the one pair reservation for the OpenCode e2e tests. none yet for the timer
rule: a lint that flags a `waitFor` budget below a named timer constant.
