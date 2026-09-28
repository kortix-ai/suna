# kortixd (sandbox agent daemon)

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
