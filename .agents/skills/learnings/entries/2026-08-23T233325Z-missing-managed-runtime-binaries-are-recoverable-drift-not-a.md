---
recorded: 2026-08-23T23:33:25Z
commit: 7686b7900c
---
# Missing managed runtime binaries are recoverable drift, not an unreadable runtime

2026-08-23. Existing sandbox disks created before the managed OpenCode link
could update their CLI and agent, but never became ready. Runtime convergence
treated an unreadable OpenCode health endpoint as a busy or transient runtime.
The required managed binary did not exist, so the endpoint could never recover.

**The rule.** Distinguish a missing managed binary from a temporarily
unreadable process. Install and restart when the managed link is absent. Defer
when the managed link exists but the process cannot report its version.

**The enforcement.** Runtime convergence tests cover both states. A missing
managed link installs the manifest version and restarts OpenCode. An existing
link with unreadable health performs no install and no restart.

*Incident:* old session disks remained in `runtimeReady=false` after a runtime
upgrade because OpenCode convergence reported `opencode did not report its
version` on every start.
