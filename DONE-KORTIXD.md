# kortixd — build report

Turn the sandbox agent server into a clean, installable, self-updating single
binary named `kortixd`, with a management CLI, safe atomic updates, and
auto-rollback on a failed update.

Branch: `kortixd-daemon-app` (off `origin/main` @ `46cf3e9c87`). Committed, not
pushed, no PR — the coordinator reviews + ships.

Shippable: **YES** for Phases 1 + 2 (the functional core). Phase 3 done as a
**safe, non-breaking subset** — product/package identity renamed to `kortixd`;
the load-bearing on-disk artifact + directory names deliberately kept as a
documented compatibility contract (rationale below). No fleet-risking rename was
performed.

---

## What each phase added

### Phase 1 — the `kortixd` management CLI
New file `apps/kortix-sandbox-agent-server/src/cli.ts` (772 LOC). Wired into the
existing subcommand dispatch in `src/main.ts` (+19 lines: one import, one
`else if (isManagementSubcommand(...))` branch). The default path and the two
pre-existing subcommands (`git-credential`, `install-compiled-runtime`) are
untouched. Subcommands:

- `kortixd` / `kortixd serve` → run the daemon exactly as today (unchanged).
- `kortixd version` → prints `kortixd <pkg.version> (<digest12>)` + bun/platform/
  binary/digest. The build digest is the running binary's own sha256 — the exact
  value `update` compares against a manifest.
- `kortixd install [--dir <path>] [--force]` → install the binary onto PATH.
  Presence-based idempotent (see Phase-2 boot note).
- `kortixd update [--from <path|url>] [--channel] [--version] [--boot] [--target]`
  → self-update (Phase 2).
- `kortixd rollback` → revert to `<name>.prev`.
- `kortixd --health-check [--port] [--timeout]` → boots a self-contained health
  server on an ephemeral port, hits `/kortix/health`, exits 0/non-zero.
- `kortixd --help` / `-h` / `help` → usage.

Bootstrap installer `apps/kortix-sandbox-agent-server/install.sh` (114 LOC),
curl | sh style: detects os/arch, downloads the target binary (or `--from` a
local file), verifies it runs `version`, atomic-renames it onto PATH. Flags/env:
`--url`/`KORTIXD_URL`, `--base`/`KORTIXD_BASE_URL`, `--version`, `--dir`,
`--from`/`KORTIXD_LOCAL_BINARY`.

### Phase 2 — safe update + rollback (the core reliability property)
Implemented in `src/cli.ts` (`performUpdate`, `performRollback`, `smokeTest`,
digest cache). Flow:

```
resolve target (manifest digest, or --from file/url)
  → CHEAP no-op check FIRST (compare target digest to the local binary's cached
    sha256; exit 0 with no download when equal)
  → download bytes (only on a real mismatch)
  → verify content digest (sha256)
  → smoke-test the candidate: `<tmp> version` AND `<tmp> --health-check` must
    both exit 0
  → atomic swap: copy current → <name>.prev, then rename(2) tmp → target
  → post-swap health-check: `<target> --health-check`
  → on any failure: keep/rollback to <name>.prev, non-zero exit + clear message
```

- Never leaves a half-written binary: bytes are written to a temp file in the
  destination dir and only `rename(2)`d in after every gate passes.
- Keeps exactly one previous version (`<name>.prev`), mirroring the
  `entrypoint.sh` "current + previous" supervisor policy.
- `--boot` / `KORTIXD_UPDATE_BEST_EFFORT=1` → best-effort: any failure keeps the
  last-good binary and exits 0 so the boot proceeds to `serve`. Manual `update`
  (no `--boot`) hard-fails non-zero.
- Digest cache (`.kortixd-state.json`, keyed by path+size+mtime) so a converged
  box answers "already current" without re-hashing a ~96 MB binary every boot.

Manifest resolution reuses the daemon's existing runtime-assets contract:
`GET {KORTIX_API_URL}/v1/runtime-assets/manifest` → agent `sha256` + `path`,
download at `/v1/runtime-assets/agent`, same-origin URL guard, `policy
.agent_self_update === false` kill switch respected.

### Phase 3 — the rename (safe subset)
- `package.json`: `name` `@kortix/sandbox-agent-server` → **`kortixd`**;
  `bin` now `{ "kortixd": "./dist/kortixd", "kortix-agent": "./dist/kortix-agent" }`;
  `start` → `./dist/kortixd`; description updated. Verified the old package name
  is **not imported by name anywhere** (grep: only self-refs in package.json +
  bun.lock), so this is safe.
- `bun.lock`: root name synced to `kortixd`; `bun install --frozen-lockfile`
  passes (the sandbox Dockerfile depends on frozen install).
- `scripts/build.sh`: emits `dist/kortixd` (primary) **and** `dist/kortix-agent`
  (compat copy) from one compile.
- `README.md`: retitled `kortixd`, documents the CLI, the reliability flow, the
  boot sequence, install.sh, and the compatibility note.

---

## Compatibility shims kept, and why

The binary artifact name `kortix-agent` and the directory
`apps/kortix-sandbox-agent-server` are **load-bearing fleet contracts**, not
cosmetic names:

- `apps/sandbox/entrypoint.sh` treats `/usr/local/bin/kortix-agent` as the
  immutable baked floor (`AGENT_BAKED`), and swaps `agent.current`/`.next`/
  `.prev` beside it. Every already-deployed box has that exact path on disk.
- `apps/sandbox/Dockerfile` + `apps/api/Dockerfile` `COPY dist/kortix-agent →
  /usr/local/bin/kortix-agent` and embed the runtime path.
- `apps/api` snapshots + git-proxy + `runtime-assets/manifest.ts` serve that
  binary as the `/agent` artifact with its digest.
- CI (`.github/workflows/ci.yml`, `deploy-dev.yml`) filters and asserts on the
  directory path and `dist/kortix-agent`.

Renaming those is a staged fleet migration (new images bake both names, deprecate
the old over releases), not a mechanical rename. A single missed reference
silently 502s every sandbox — the exact 2026-06-19 class the `build.sh` tsc gate
exists to prevent. So both names ship from one compile, the directory is kept,
and `kortixd` is the new product/local identity. Documented in `build.sh`,
`README.md`, and `src/cli.ts`.

`install` idempotency is **presence-based, not digest-based**, on purpose: the
boot path runs `install` (image-baked source) then `update` (newer published
binary) into the same target every start. A digest-equality reinstall would
re-copy the older baked binary over the update on every post-update boot. So a
target that already exists is left untouched; `update` owns currency, `install`
only guarantees presence. `--force` overwrites deliberately.

---

## Verification (real, pasted)

### Gates
- `bun run build` → `Built dist/kortixd (+ compat dist/kortix-agent) for
  bun-linux-x64 (95819904 bytes) and dist/server.mjs`. Both artifacts present.
- `tsc --noEmit` → clean (0 errors).
- `bun test` (whole daemon suite) → **1117 pass, 0 fail** (92 files).
- `bun install --frozen-lockfile` → no changes (frozen OK after name sync).
- `./dist/kortixd-host version` → `kortixd 0.1.0 (a7f3d09778a1) …`.
- `./dist/kortixd-host --health-check` → `health-check ok`, exit 0.

### Unit tests — `src/__tests__/cli-update.test.ts` (10 pass)
Covers: flag parsing; no-op digest match; happy-path swap + `.prev`; digest
mismatch (no swap); pre-swap smoke fail (no swap); **post-swap health fail →
auto-rollback to `.prev`**; best-effort exit 0; digest-cache write; rollback
restore/consume; rollback-with-no-prev fails.

### End-to-end with COMPILED binaries — 34/34 pass
Script builds two distinct valid binaries (A = 0.1.0, B = 0.1.0-next) + a broken
candidate, then exercises the real CLI. Key results:

```
PASS: install placed executable / installed bytes == binA / reports 0.1.0
PASS: 2nd install reports already-installed / left the binary untouched
PASS: update exited 0 / live binary swapped to B / .prev holds A / serves health-check
PASS: no-op update reports already-current / was fast (67-81 ms < 1500)
--- KEYSTONE (broken candidate = garbage shell script) ---
PASS: broken update exited non-zero (1)
PASS: live binary UNCHANGED after broken update (still B)
PASS: original still serves after broken update
PASS: error names the failed smoke test
    -> rc=1  [update] candidate failed smoke test: `version` exited 1 — kept current binary
--- KEYSTONE (real binary whose --health-check fails) ---
PASS: health-failing update exited non-zero (1)
PASS: live binary UNCHANGED (health-check gate blocked the swap)
    -> rc=1  [update] candidate failed smoke test: `--health-check` exited 1 — kept current binary
--- rollback ---
PASS: rollback exited 0 / rolled back to A / .prev consumed / 2nd rollback exits non-zero
--- BOOT SEQUENCE (install + update --boot + serve, twice) ---
PASS: boot#1 update --boot exited 0 / converged target to B
PASS: boot#2 install left the updated B in place (no clobber)
PASS: boot#2 update is a fast no-op (68-70 ms)
--- BOOT with a bad publish ---
PASS: boot update --boot with a bad publish exits 0 (boot proceeds)
PASS: original (A) still in place / box still serves / no half-written temp binary left behind
--- serve dispatch ---
PASS: serve launched the daemon (still running after 3s, not an instant CLI exit)
RESULT: 34 passed, 0 failed
```

The post-swap auto-rollback branch (candidate passes as a temp file but fails at
the live path) is deterministically covered by the unit test with an injected
spawn seam; the real-binary e2e covers the pre-swap smoke-fail and health-fail
gates.

Test artifacts (not committed): `scratchpad/verify-kortixd.sh`,
`scratchpad/test-install-sh.sh`.

---

## What is NOT done / risks

- Full directory rename `apps/kortix-sandbox-agent-server → apps/kortixd` and the
  on-disk artifact rename `kortix-agent → kortixd` are **deliberately deferred**
  as a staged fleet migration (see Compatibility). ~84 files reference the dir
  and ~60 the artifact name across Dockerfiles/CI/api-runtime/snapshots/deploy.
- `--channel` / `--version` update flags are parsed and reserved but not yet
  wired to a channel/version selection in the manifest (the manifest exposes one
  current agent build). Manifest resolution + `--from`/`--url` are fully working.
- The `--health-check` smoke test is self-contained (proves the binary runs and
  can bind+serve HTTP); it does not boot the full opencode/session stack, by
  design — that keeps it fast and deterministic as an update gate.

## Files
- new: `src/cli.ts`, `src/__tests__/cli-update.test.ts`, `install.sh`
- changed: `src/main.ts`, `package.json`, `bun.lock`, `scripts/build.sh`,
  `README.md`
