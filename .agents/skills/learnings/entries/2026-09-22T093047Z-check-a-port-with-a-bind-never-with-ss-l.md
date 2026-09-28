---
recorded: 2026-09-22T09:30:47Z
incident_date: 2026-09-22
commit: b34b101ccd
---
# Check a port with a bind, never with `ss -l`

**Rule:** To decide whether a host port is free for a container, ATTEMPT THE
BIND. `ss -ltn` lists LISTENING sockets only and reports a port free while
`bind()` still returns EADDRINUSE, so a wait built on it passes instantly on a
port that is not free. **Trigger surface:** any CI step that frees ports before
starting a service. **Incident:** the Supabase port failure was "fixed" three
times — teardown on every lane, then removal by published port, then a wait on
`ss -ltnH`. It recurred a fifth time on browser-2: `supabase stop` returned at
09:19:26.710, the `ss` wait cleared all four ports by 09:19:27.448 (0.74s,
first poll), and `supabase start` still failed to bind 54324 twenty-five
seconds later. The check was passing on a port that was not free, and two
fixes rested on that reading. **Enforcers:** the SO_REUSEADDR bind loop in
`tests.yml`'s "Free the local Supabase ports" (SO_REUSEADDR to match
docker-proxy, or a lingering TIME_WAIT makes it wait the full 30s), pinned by
`tests/unit/sandbox-workflow.test.ts`, which now also forbids the
`ss -ltnH | grep -q` shape.

**Second rule from the same change:** keep embedded scripts inside a workflow
`run: |` block to ONE LINE, or indent every line past the block's own indent.
A multi-line `python3 -c "` whose body starts at column 0 ENDS the block
scalar, and GitHub then fails to parse the whole workflow. The symptom is
silent and misleading: the run completes with **zero jobs**, and the pull
request reads `CLEAN` with **no lane checks at all** — a green that means
"nothing ran". Check with `gh run view <id> --json jobs`; an empty list is a
parse failure, not a pass. Verified locally by asserting every non-blank line
inside each `run: |` is indented past its key.

**Meta-rule, earned the hard way:** a diagnostic that reports "clean" is not
evidence of clean until you have proved the diagnostic can report dirty. This
one was run against four genuinely-held ports and warned on all four; the `ss`
version, run the same way, would have said they were free.
