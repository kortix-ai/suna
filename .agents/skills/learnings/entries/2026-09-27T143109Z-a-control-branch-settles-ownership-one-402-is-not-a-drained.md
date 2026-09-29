---
recorded: 2026-09-27T14:31:09Z
incident_date: 2026-09-26
---
# A control branch settles ownership; one 402 is not a drained environment

Two corollaries of the truncation entry recorded the same night
(`2026-09-27T041809Z`, which owns the primary rule: pull `results.json`, never
read a cut console line as an empty value). These are the two reasoning
mistakes made while chasing that failure, each of which cost real time.

**Rule 1 — a control settles ownership, suspicion does not.** When a branch is
suspected of causing a deployed-suite failure, run or find the same suite on a
branch that contains NONE of the change, and compare. Reading the diff cannot
do this: a new awaited gate on the exact chokepoint a flow exercises looks
guilty no matter how carefully it is written. PR #7796 (`latency-sweep`, 77
files, zero lines of the suspected gate) failed `CFG-11`/`CFG-12` in preview
run 36287293649 with identical reason strings and an identical
`547/557 passed · 5 failed`. That ended an argument that three separate code
readings had not.

**Rule 2 — one 402 is not a drained environment.** Check which flow OWNS a
suspicious response before building a theory on it. A single
`402 Out of credits … balance: 0` in preview run 36279090948 was read as
"the preview account drained mid-run, which is why later flows failed"; its
owner was `BILL-17`, a PASSING flow that asserts that refusal deliberately on
its own account. Suites contain flows whose whole purpose is to provoke the
error you are hunting, so an error's presence proves nothing until its owner
is known. In `results.json`, walk parents until the enclosing flow id.

**Trigger surface:** triaging any `--target-full` or release-gate failure,
especially one where a branch under test is the obvious suspect, or where a
4xx/5xx appears somewhere in the run and looks like an environment problem.

**Enforcement:** none — both are reasoning habits, not code. The register is
the enforcement.
