# Sandbox memory guard during a detached API unit suite

## Observed sequence

- 19:11:04 UTC: an agent started `apps/api/scripts/test.sh` with `setsid`.
- 19:11:25 UTC: three Bun workers held 4,474,868 KiB RSS combined. The suite used four workers.
- 19:11:38 UTC: sandbox memory reached 65% used. OpenCode held 734 MB RSS.
- 19:12:38 UTC: sandbox memory reached 87% used. OpenCode held 686 MB RSS.
- 19:12:48 UTC: sandbox memory reached 96% used, with 438 MB available. OpenCode held 674 MB RSS.
- 19:12:51 UTC: the daemon aborted the active turn through `SandboxMemoryGuard`.
- 19:12:58 UTC: memory fell to 18% used after the detached suite exited.

The suite completed with `RC=1`: 10,621 tests passed, 12 skipped, and 23 failed.
The guard stopped the agent's turn. It did not stop the detached suite.
The `oom_kill` counter was unavailable on this box, so it does not prove whether
any unrelated process was killed by the kernel.

## Failure mechanism

`scripts/test.sh` selected four Bun isolate workers without reading the box's
available memory. The suite spans hundreds of files, so each worker retains
memory across many tests. The process scanner also matched a Bun test runner as
an `opencode serve` process because it searched the entire command line for
two words. The UI then blamed the last command, which was only a log poll.

## Changes

- Select one to four API test workers from available host and cgroup memory.
  Reserve 2 GiB for the agent and OS, then budget 4 GiB per worker. An explicit
  `KORTIX_API_TEST_WORKERS` still overrides the default for dedicated runners.
- At elevated memory use, sample the six largest processes through `/proc`.
  Record only allowlisted process names, PID and RSS. Include the largest
  non-runtime process in the guard reason.
- Match the OpenCode executable and `serve` subcommand by argument position.
- Tell users to inspect background work because aborting a turn does not end a
  process started with `setsid`.

## Verification

The resource tests cover process classification, top-process ordering, and the
guard reason. The test-runner contract executes the worker-selection function
against 2, 8, 10.6 and 32 GiB budgets. The UI test checks the recovery copy.

The worker budget reduces this suite's default concurrency on a 12 GiB box
from four to two. Other commands can still exhaust a box. The guard continues
to stop turns at its configured threshold and reports the available evidence.
