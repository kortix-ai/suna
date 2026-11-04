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
- **`@/` across top-level folders of `src/`, relative inside one** (`@/services/...` from
  `harness/`, `../shared/...` inside `harness/`). `bun run lint --fix` rewrites either way.
- **A rule change ships with its proof:** `eslint.config.mjs`, a case in
  `scripts/check-architecture.mjs`, and ARCHITECTURE.md, in one PR.

## Tests

One `bun test` process runs every file in this package (`pnpm --filter kortixd test`).
Each rule below comes from a test that passed while the behavior it named was broken.

- **Own the contract at the process or HTTP boundary.** Drive host routes through
  `buildDaemonApp` with the helpers in `src/__tests__/helpers/daemon-test-app.ts`:
  `testConfig` (a complete host config), `fakeHarness` (every operation throws unless
  the test supplies it) and `signTestUserContext`. Drive harness behavior through the pi
  rig in `pi-harness.test.ts`: the production pi service, booted against a fake model
  gateway. Drive upstream calls through a `Bun.serve` fake on a real port. Never test
  source text.
- **Restore `process.env` to its prior value** after every test that writes it. Save the
  snapshot, then delete only the names the test added. Deleting a name the test did not
  set leaks in the other direction.
- **Fakes return the production shape.** A fake harness operation returns what the
  production service returns, not a simplified value.
- **Runtime state lives under a per-test `KORTIX_RUNTIME_STATE_DIR`.** Its paths resolve
  on each call; point the variable at a temp directory instead of passing a path in.
- **Production code carries no test-only mode or injection option.** Faux model mode,
  `brokerFetch`, `resolveTarget` and `fetchImpl` options were deleted for this reason:
  point `KORTIX_LLM_BASE_URL` or `apiUrl` at a local fake instead.
- **A negative row sets every other precondition,** so the one input under test is the
  only reason it can pass.
