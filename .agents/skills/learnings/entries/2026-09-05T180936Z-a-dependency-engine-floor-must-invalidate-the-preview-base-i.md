---
recorded: 2026-09-05T18:09:36Z
incident_date: 2026-09-05
commit: 393474361a
---
# A dependency engine floor must invalidate the preview base image

PR #7109 failed to build both Platinum and Daytona base caches. The preview
base image pinned Node `22.22.0`. The resolved `write-file-atomic@8.0.0`
package requires Node `^22.22.2 || ^24.15.0 || >=26.0.0`. The exact provider
command exited at `pnpm install --frozen-lockfile` with
`ERR_PNPM_UNSUPPORTED_ENGINE`.

**The rule.** The preview base image Node version must satisfy every resolved
package engine. A Node image change must also increment the Platinum and
Daytona base-cache versions. Failed caches must never retain the old runtime.

*Fix:* the shared preview image now pins the multi-platform digest for Node
`22.22.2-bookworm`. Platinum base cache `v12` and Daytona base cache `v4`
force fresh builds. *Enforcer:* `tests/unit/platinum-ci.test.ts` and
`tests/unit/daytona-ci.test.ts` assert both new cache names and the exact image
digest.
