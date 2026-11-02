---
recorded: 2026-11-02T14:10:05Z
incident_date: 2026-11-02
---
# Give every child-process stdin pipe an error listener; on Bun 1.4 an EPIPE exits the daemon

**Rule:** Before you write to a child process's stdin in kortixd, attach `child.stdin.on('error', …)`. The child can exit before it reads (`git check-ignore --stdin` outside a repository exits 128 at once). On Bun 1.4 the write then fails with EPIPE, and an unhandled pipe error exits the whole daemon. The child's exit code already carries the result. Test a Bun upgrade of the daemon with the pinned Bun (`engines.bun`), not the laptop's Bun.

**Trigger surface:** Adding or changing a `spawn` with `stdio: 'pipe'` stdin in `apps/kortix-sandbox-agent-server`; upgrading `SANDBOX_AGENT_BUN_VERSION` / `engines.bun`.

**Incident:** 2026-11-02, release v0.14.15 gate, 3 of 3 attempts. #11437 moved the daemon build from Bun 1.3.11 to 1.4.3. On staging, deployed flow FILE-9 got upload 200, read 200, list 200, then `DELETE /file` 503 with `x-kortix-upstream-status: 502` and `upstream unreachable: Failed to connect`. The list call had killed the daemon. Locally the bug did not show, because the laptop compiled the daemon with Bun 1.3.14. A daemon compiled with Bun 1.4.3 on the local stack restarted after every non-empty `GET /file` (uptime 29 s to 1 s). Every `GET /file` of a non-empty directory outside a git repository (the SDK `file.list` call) restarted the daemon of the box.

**Enforcement:** `src/__tests__/files-routes.test.ts` ("lists a workspace that is not a git repository and keeps serving the next call") and `src/__tests__/platform-tools.test.ts` ("a CLI that exits before it reads stdin …"). Both go red only on Bun 1.4; the CI `packages-kortixd` lane runs Bun 1.4.3. No lint rule for a new `spawn` yet.
