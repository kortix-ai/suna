---
recorded: 2026-09-14T22:57:10Z
incident_date: 2026-09-14
commit: f5efb6316c
---
# Stop proxy maintenance timers and isolate background writers in package tests

**When:** stopping the sandbox proxy or running package tests. Cancel boot and
interval offload timers; reject callbacks after stop. Disable automatic offload in
the test runner; explicit offload tests use temporary databases. Use the actual
`kortixd` package name for the sequential lane. *Near-miss:* XLSX verification's
full run entered a background scan of the developer's OpenCode DB; the process
was stopped during its SELECT. *Enforcers:* proxy stop regression and runner contract.
