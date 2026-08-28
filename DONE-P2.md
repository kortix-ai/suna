# P2 — kortixd as the clean INTERFACE to the existing convergent-runtime supervisor (Option A)

`kortixd update`/`rollback` are now context-aware. In-sandbox they DRIVE the
existing entrypoint supervisor (stage → exit 75 → supervisor swaps); standalone
they keep the safe self-swap. The supervisor's staged-swap / crash-loop-rollback
machinery is UNCHANGED — kortixd stages, the supervisor swaps.

Branch: `p2/kortixd-supervisor-interface` (off `origin/main`). Committed, not
pushed. 3 files changed, +382/-18.

## Files changed

1. `apps/kortix-sandbox-agent-server/src/cli.ts` — context-aware update/rollback.
2. `apps/sandbox/entrypoint.sh` — set `KORTIX_SUPERVISED=1` (+ export state dir).
3. `apps/kortix-sandbox-agent-server/src/__tests__/cli-update.test.ts` — new tests.

## The exact entrypoint diff

The ONLY entrypoint change is two exported env vars before the supervisor loop
(no change to the swap/rollback/crash-loop logic, no `kortixd install` added):

```diff
 mkdir -p "${AGENT_STATE_DIR}" 2>/dev/null || true
 
+# Tell the daemon (and any `kortixd` invocation that inherits this env) that a
+# supervisor owns the binary swap. `kortixd update` then STAGES ${AGENT_NEXT}
+# and exits ${SWAP_CODE} for this loop to install, instead of self-swapping its
+# own running binary — which is unsafe and which warm-fork/resume/restart would
+# not re-run anyway. Export the resolved state dir so it stages into the exact
+# slot select_agent/promote_staged_agent read. See apps/kortix-sandbox-agent-server/src/cli.ts.
+export KORTIX_SUPERVISED=1
+export KORTIX_AGENT_STATE_DIR="${AGENT_STATE_DIR}"
+
 COMPILED_RUNTIME_PATH=""
```

`KORTIX_SUPERVISED=1` is only read by `kortixd`'s management verbs
(update/rollback). The daemon's normal `serve` path never reads it, so boot is
byte-for-byte unchanged. **No `kortixd install` was added to boot**: the baked
binary is already the immutable floor and `select_agent` already resolves it, so
an extra boot-time install would add risk for zero benefit.

## How kortixd now stages vs self-swaps

Detection (`detectSupervised`): supervised iff `KORTIX_SUPERVISED=1` (primary,
set by the entrypoint), OR — fallback for an older baked entrypoint — the running
binary is a supervisor-managed path (`<state>/agent.current` or the baked floor)
and the state dir exists. A standalone kortixd on a normal machine matches
neither. `--standalone` / `--supervised` force either path (testing/recovery).

**SUPERVISED (`kortixd update`, in-sandbox):**
1. Resolve target (manifest / `--from`). No-op if the running binary already
   matches, or if `agent.next.sha256` already equals the target (idempotent).
2. Download → verify content digest → **smoke-test** the candidate
   (`version` + `--health-check`).
3. Stage into `<state-dir>` using the EXACT contract of
   `runtime-assets.ts:stageAgentBinary` and `entrypoint.sh:promote_staged_agent`:
   write `agent.next.sha256` (content `"<sha>\n"`) FIRST via atomic rename, then
   rename the verified binary into `agent.next`. Never touches the live binary.
4. Return exit code **75** (`AGENT_SWAP_EXIT_CODE`). Under the supervisor loop
   this triggers the atomic swap + health-supervision + crash-loop rollback.
   Run from a shell, the exit is harmless and the stage persists for next boot.

**STANDALONE (`kortixd update`, off-sandbox):** unchanged — download → verify →
smoke-test → atomic self-swap (keep `<name>.prev`) → post-swap health →
auto-rollback to `.prev` on failure.

**ROLLBACK:** supervised → `performSupervisorRollback` mirrors
`entrypoint.sh:rollback_agent` exactly (restore `agent.prev`→`agent.current`, or
drop the override to fall back to the baked floor; latch `agent.pinned`; discard
any staged `agent.next`). Standalone → consume `<name>.prev` (unchanged).

One extra hardening in `realRun`: a non-executable smoke-test candidate can throw
`ENOEXEC` synchronously from `child_process.spawn`, escaping the `'error'`
handler. It is now caught and mapped to exit 126, so a bad candidate is a clean
"candidate failed — kept current binary" with temp-file cleanup, never an
uncaught throw. This fixes both the supervised and standalone paths.

## Verification (real outputs)

### `bun run typecheck` (tsc --noEmit) — clean
```
$ bun tsc --noEmit
(no output, exit 0)
```

### `bun test src/__tests__/cli-update.test.ts` — 19 pass / 0 fail
New tests: supervised staging (exit 75, live binary untouched, agent.next +
matching sha256), supervised no-op, supervised broken-candidate refusal,
supervised already-staged re-run, `detectSupervised`, `performSupervisorRollback`
(with prev / no prev / nothing-to-roll-back). Plus the original 9 standalone
tests (self-swap, digest mismatch, pre/post-swap smoke failure, auto-rollback,
best-effort, digest cache).
```
 19 pass  0 fail  58 expect() calls
```
`runtime-assets.test.ts` + `runtime-convergence.test.ts` also green (77 pass / 0
fail together with cli-update).

### `apps/sandbox/scripts/test-entrypoint-swap.sh` — 12 passed / 0 failed
The supervisor still swaps a staged `agent.next` and rolls back a crash-looper.
The staged-file contract is UNCHANGED, so the harness needed no edits.
```
PASS  swap: staged binary promoted, relaunched, installed as current
PASS  bad digest: staged binary discarded, live binary kept running
PASS  crash-looping update rolls back to the baked binary and pins
PASS  update installs beside the baked binary and never overwrites it
PASS  first bad update with no predecessor falls back to the baked binary
PASS  pinned box refuses staged updates
... (12 passed, 0 failed)
```

### Keystone — real compiled host-native `kortixd` (`bun build --compile`), run as a process
- **A. Supervised staging** (`KORTIX_SUPERVISED=1 kortixd update`): `exit=75`;
  `sha256(agent.next) == agent.next.sha256` (so the supervisor's independent
  re-verification accepts it); LIVE BINARY UNTOUCHED; target NOT self-swapped; no
  `.prev`.
- **B. Standalone** (`--standalone`): `exit=0`; target self-swapped to the build;
  `.prev` kept.
- **C. Supervised rollback** (prev present): restores `agent.prev`, latches
  `agent.pinned`, consumes prev, discards staged `agent.next`; `exit=0`.
- **D. Supervised rollback** (no prev): removes `agent.current` → drops to the
  baked floor, latches pin; `exit=0`.
- **E. Broken staged candidate**: smoke test fails (`version exited 126`);
  `exit=1`; nothing staged; no leaked temp file — the supervisor never sees a bad
  build.

## Supervisor safety properties preserved

1. **Immutable baked floor.** The root-owned baked binary is never written by
   kortixd; supervised rollback with no predecessor drops back to it by removing
   the `agent.current` override (harness 6b/6c still green).
2. **Independent re-verification.** The supervisor re-hashes `agent.next` against
   `agent.next.sha256` before promoting. kortixd writes the identical
   `"<sha>\n"` + verified-binary contract (proven: keystone A shows the two match).
3. **Atomic, no partial binary.** kortixd stages via same-filesystem `rename(2)`,
   side-car first then binary — the exact order `stageAgentBinary` uses; any
   interruption leaves a state the supervisor already refuses.
4. **Crash-loop rollback + pin.** Untouched. A kortixd-staged binary that dies
   fast still rolls back and pins (harness test 6 green).
5. **`agent.prev` rollback target.** Untouched; supervised CLI rollback follows
   the same restore-prev / drop-to-floor + pin logic.
6. **Pinned box refuses staged updates.** Untouched (harness test 7 green).
7. **No self-overwrite of a running binary.** kortixd never self-swaps
   in-sandbox — it stages and exits 75, exactly the case the supervisor exists to
   handle for warm-fork/resume/restart.
8. **Failure-biased.** A bad artifact, bad digest, or unrunnable candidate leaves
   a working box: kortixd smoke-tests before staging, and the supervisor
   re-verifies before promoting.

## Shippable: YES (pending coordinator diff review + dev deploy)

Highest-risk change in the epic; kept minimal and reviewable. Not pushed — the
coordinator reviews the diff with the user before merge, since this touches the
sandbox boot for every box.
