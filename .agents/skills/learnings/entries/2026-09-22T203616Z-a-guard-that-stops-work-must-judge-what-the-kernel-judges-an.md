---
recorded: 2026-09-22T20:36:16Z
incident_date: 2026-09-22
commit: 97beeb6c01
---
# A guard that stops work must judge what the kernel judges, and every stop must name its cause

**Rule:** A memory guard compares the cgroup WORKING SET (`memory.current -
inactive_file`) to `memory.max`, never raw `memory.current`: the page cache is
reclaimed before any OOM kill. Every writer that ends a turn `failed` records a
cause in `end_error`; a turn with no cause is still shown to the user, never
hidden. A stop a person asked for is stamped `UserStop` on every path, not only
the proxy. **Incident:** a prod session lost 3 turns in 20 min to the memory
guard during `tsc --noEmit` (92 % "used", <1 GB anon, 5 GB inactive file,
`oom_kill 0`), and the UI said "No reason was reported"; 20-30 % of failed turns
per hour had no cause and were hidden. **Enforcers:** `resources.test.ts`
(working set), `integration-sandbox-turn-lifecycle.test.ts`,
`sandbox-reaper.test.ts`, flows SESS-34 and SESS-35.
