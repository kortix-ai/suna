---
recorded: 2026-10-11T12:37:00Z
incident_date: 2026-10-11
---
# Typecheck a shared workspace package under the strictest consumer that compiles it

**Rule:** A workspace package (`packages/*`) is compiled by every consumer that imports its source, under that consumer's `tsconfig`. kortixd adds `noUncheckedIndexedAccess`, which `packages/api-contract` does not set. A change that passes the package's own `tsc` can still fail kortixd's. The `packages` lane runs `pnpm --filter kortixd typecheck`, so run `pnpm test -- --packages-only` (or that command) before merging a change to a package kortixd imports.

**Trigger surface:** Editing `packages/api-contract`, `packages/shared`, or any package imported by `apps/kortix-sandbox-agent-server`, especially new array or index access.

**Incident:** 2026-10-11, #9556 (`session-log/v1.ts`): `ids[i]` and `threads[0].messages` passed api-contract's typecheck and every local lane. kortixd's image build runs `bun run typecheck` before `bun build --compile` (`scripts/build.sh:58`), and it failed with TS2345/TS2532. Deploy Dev run 38139009554 failed at "Build API image". Dev kept serving the previous API, and the staging promotion of that dev head would have failed its build the same way.

**Enforcement:** `tests/bin/package-quality.ts` runs `pnpm --filter kortixd typecheck` beside the API and CLI typechecks (`pnpm test`, `packages` lane). On the unfixed tree it reports exactly the two errors the image build hit.
