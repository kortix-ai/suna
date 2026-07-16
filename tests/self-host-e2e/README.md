# self-host-e2e

Black-box test suite for `kortix self-host` (the generic Docker Compose
appliance — see `apps/cli/src/commands/self-host.ts`). Two layers:

- **`fast/`** — pure CLI-artifact tests. Spawn the real CLI entrypoint
  (`apps/cli/src/index.ts`) against a throwaway config dir and assert the
  rendered `.env` + `docker-compose.yml`. No Docker daemon, no network — runs
  in a few seconds, always on in CI.
- **`live/`** — opt-in Docker-backed tests. Bring up a real (throwaway,
  uniquely-named, isolated-port) self-host stack and assert runtime/HTTP
  behavior the fast layer can't reach. **Never run by default** — gated on
  `RUN_SELFHOST_LIVE=1` so this suite never collides with another self-host
  instance (or another agent's) running on the same machine.

This directory has no `package.json` of its own on purpose: every `fast/`
test imports only `bun:test` + Node built-ins (no `yaml`/etc.), so `bun test`
runs it with zero install step. `support/cli.ts` parses the rendered compose
file as plain text (regex over the known 2/4/6-space indentation) instead of
pulling in a YAML parser.

## Running

```bash
# fast (no Docker, no setup)
bun test tests/self-host-e2e/fast/

# live (opt-in — needs Docker + the API image built locally)
RUN_SELFHOST_LIVE=1 API_IMAGE=kortix/kortix-api:selfhost-local \
  bash tests/self-host-e2e/live/graceful-degradation.live.sh
RUN_SELFHOST_LIVE=1 API_IMAGE=kortix/kortix-api:selfhost-local \
  bash tests/self-host-e2e/live/rolling-update.live.sh
```

## Coverage map (see task spec for the numbered cases)

| # | Case | File | Layer |
|---|------|------|-------|
| 1 | Fresh `init` renders a valid `.env` + compose | `fast/init-defaults.test.ts` | fast |
| 2 | Feature-flag matrix (landing / enterprise / billing) | `fast/feature-flags.test.ts` | fast |
| 3 | Required-secrets warning (never hard-blocks) | `fast/required-secrets.test.ts` | fast |
| 4 | Run-any-version / local-images mode (`--version`/`--tag`/`--channel`/`--local-images`) | `fast/version-channel-images.test.ts` | fast |
| 5 | Rolling update / zero-downtime updater | `apps/cli/src/self-host/__tests__/compose-assets.test.ts` (unit, NOT duplicated here) + `live/rolling-update.live.sh` | unit + live |
| 6 | Feature-flag graceful degradation at the HTTP layer | `live/graceful-degradation.live.sh` | live |

## Skip-pending / capability-gated tests

`support/cli.ts` exports `selfHostCapabilities()`, which probes the CLI's own
`-h` output once and gates a file's `describe.skipIf(...)` on a specific
in-flight flag/subcommand landing. `version-channel-images.test.ts` (case 4)
gates on `--local-images`; as of this writing it's present, so every test in
that file runs for real. If it's ever missing again (an older CLI build, a
revert), the file degrades to a clean `describe.skip` instead of a false
failure — no manual toggle to remember to flip back.

The one genuinely still-unimplemented piece of case 4 — automatic
`KORTIX_AUTO_UPDATE=false` when only `--local-images`/`--version` is passed
without a domain — is not; it was confirmed live and is covered directly
(see "an explicit `--auto-update` always wins" and the `--local-images`
tests in `version-channel-images.test.ts`).
