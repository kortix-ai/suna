# kortixd (sandbox agent daemon)

## Architecture

The source has four layers, bottom to top: **shared** (`src/lib/`, `src/types/`),
**services** (`src/services/<name>/`), **harness** (`src/harness/`), and **app**
(`src/main.ts`, `src/app/`, `src/routes/`). A layer imports only from the layers below it.
[ARCHITECTURE.md](ARCHITECTURE.md) lists the folders, the import rules and where new code
goes. `bun run lint` enforces them, and `bun test` runs the lint.

- **Never disable the boundary rule.** When it fires, move the code, or hand the lower
  layer what it needs from the layer above (`HarnessBootContext.serve`,
  `registerHarnessAssets`). Do not import upward "just for a type".
- **A file lives next to its only consumer.** Move it to `src/harness/shared/`, `src/lib/`
  or `src/types/` only when a second consumer exists. Update every importer and test, and
  delete the old path, in the same change.
- **A type two isolated modules share goes to `src/types/`** (two adapters, a service and
  an adapter, two services) instead of being copied. `src/types/` holds type declarations
  only.
- **A rule change ships with its proof:** `eslint.config.mjs`, a case in
  `scripts/check-architecture.mjs`, and ARCHITECTURE.md, in one PR.

## Tests

One `bun test` process runs every file in this package (`pnpm --filter kortixd test`).
Each rule below comes from a test that passed while the behavior it named was broken.

- **Own the contract at the process or HTTP boundary.** Drive the OpenCode lifecycle
  through the fake `opencode` binary in `opencode-lifecycle.e2e.test.ts`, daemon routes
  through `buildOpenCodeTestApp` (it composes the production `composeOpenCodeHarnessService`),
  and upstream calls through a `Bun.serve` fake on a real port. Text reads of `boot.ts`
  live only in `boot-source-guards.test.ts`, which strips comments first: a guard that
  matched a word in a comment passed with the guarded `return` deleted.
- **Restore `process.env` to its prior value** after every test that writes it. Save the
  snapshot, then delete only the names the test added. Deleting a name the test did not
  set leaks in the other direction.
- **Fakes return the production shape.** A fake `reloadConfig` returns
  `{ how, turnEnded }`, as the lifecycle does, not a bare string.
- **The OpenCode session pin lives under a per-test `KORTIX_RUNTIME_STATE_DIR`.** The pin
  paths resolve on each call; write the pin there instead of passing a root id.
- **Production code carries no test-only mode or injection option.** Faux model mode,
  `brokerFetch`, `resolveTarget` and `fetchImpl` options were deleted for this reason:
  point `KORTIX_LLM_BASE_URL` or `apiUrl` at a local fake instead.
- **A negative row sets every other precondition,** so the one input under test is the
  only reason it can pass.
