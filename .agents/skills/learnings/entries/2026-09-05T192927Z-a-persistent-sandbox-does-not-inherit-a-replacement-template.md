---
recorded: 2026-09-05T19:29:27Z
incident_date: 2026-09-05
commit: b37d6388a5
---
# A persistent sandbox does not inherit a replacement template runtime

PR #7109 selected the ready Node `22.22.2` Platinum template. The workflow then
reused the branch sandbox created with Node `22.22.0`. The sandbox rootfs did
not change. Every checkout after the dependency floor change failed at
`pnpm install --frozen-lockfile` with `ERR_PNPM_UNSUPPORTED_ENGINE`. The worker
then reported stale test output from an earlier commit.

**The rule.** A bootstrap that reuses a persistent sandbox must enforce its
runtime floor inside that sandbox before it runs the package manager. A new
template only affects newly created sandboxes. Runtime repair must use a pinned
version and a verified checksum.

*Fix:* `buildPreviewBootstrapScript()` installs the official Node `22.22.2`
Linux x64 archive when the sandbox reports another version. It verifies the
official SHA-256 before extraction. *Enforcer:*
`tests/unit/sandbox-preview.test.ts` requires the repair before the first pnpm
install and asserts the exact version and checksum.
