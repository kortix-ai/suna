---
recorded: 2026-10-03T08:22:57Z
incident_date: 2026-10-03
---
# Unset the platform-injected KORTIX_* variables and repair localhost resolution before running the hermetic suites in a factory sandbox

**Rule:** Before running the repo's test suites inside a managed (factory)
sandbox, run them with the platform-injected environment removed and with
`localhost` resolvable: `env -u KORTIX_SUPERVISED -u KORTIX_SESSION_ID -u
KORTIX_PROJECT_ID -u KORTIX_API_URL -u KORTIX_TOKEN -u KORTIX_FRONTEND_URL -u
KORTIX_BASE_SHA -u KORTIX_BASE_REF`, plus an `LD_PRELOAD` getaddrinfo shim that
answers `localhost` when the box's `/etc/hosts` is unreadable. The suites are
hermetic and assert the dev-box/CI state; the box's runtime state is not test
input.

**Trigger surface:** Any factory worker (or a person on a Kortix box) running
`pnpm test`, `pnpm test -- --packages-only`, a package's own `bun test`, or the
attestation lanes in a session sandbox; debugging "why does this test fail
here and pass on main".

**Incident:** 2026-10-03, KRTX-1173 worker sandbox (no Docker: kernel without
netfilter). Five separate leak classes made green lanes impossible until named:
(1) `KORTIX_SUPERVISED=1` turned every CLI update-check test toward the
supervised path (`resolveUpdateStatus` returns null by design on a managed
box); (2) `KORTIX_SESSION_ID`/`KORTIX_API_URL`/`KORTIX_PROJECT_ID` leaked into
the CLI's host-notice breadcrumbs and default-host resolution, breaking golden
stderr and provider-matrix assertions; (3) `KORTIX_BASE_SHA` (exported by the
box for base-branch tracking) made the compiled pi/OpenCode runtime children
exit 78 with "Compiled pi runtime identity mismatch" — the check compares the
baked manifest against the inherited env and assumes the variable is unset on
a dev box; (4) `/etc/hosts` is root-only in the sandbox, so `localhost` does
not resolve at all — vitest's startup bind died with `ENOTFOUND localhost`
and every `Bun.serve({ port: 0 })` (default hostname `localhost`) bind failed
with a misleading `EACCES`, taking down marketplace/CLI-face/MCP face test
servers; (5) the `kortixd` test script runs plain `bun test` without
`--timeout`, so its daemon-spawning tests ride bun's 5 s default and flake
under the package-quality wave concurrency — load sensitivity, not a defect.
None of these reproduce at `origin/main` on a dev box or in CI; all five were
reproduced and cleared in the sandbox without changing a test.

**Enforcement:** none yet: the cheap enforcer is a test-preload that records
which `KORTIX_*` variables were inherited (the suites already sanitize `CI`
and force `isTTY`; the same block should neutralize the platform-injected
`KORTIX_*` set and assert `localhost` resolves), so a future box leak fails
loudly instead of turning dozens of unrelated tests red.
