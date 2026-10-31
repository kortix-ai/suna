---
recorded: 2026-10-31T05:45:56Z
incident_date: 2026-10-31
---
# Add a kortixd dependency with pnpm and bun both, and commit pnpm-lock.yaml with bun.lock

**Rule:** `apps/kortix-sandbox-agent-server` has two lockfiles. After a
dependency change there, run `bun install --lockfile-only` in that directory and
`pnpm install --lockfile-only` at the repo root, and commit both lockfiles.
`bun add` alone leaves `pnpm-lock.yaml` behind.

**Trigger surface:** Adding, removing or bumping a dependency of kortixd.

**Incident:** 2026-10-31, #11283 added the Claude Agent SDK and the MCP SDK with
`bun add`. Every `pnpm install --frozen-lockfile` on `dev` failed. deploy-dev
run 41172695941 built no frontend image, applied no DB migration and built no
dev CLI; the API stayed on the previous commit. Fixed forward in #11286 about 20
minutes later.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/bun-lock-sync.test.ts`
("pnpm-lock.yaml records the dependency specs package.json declares") fails
when the kortixd importer in `pnpm-lock.yaml` lacks a declared spec.
