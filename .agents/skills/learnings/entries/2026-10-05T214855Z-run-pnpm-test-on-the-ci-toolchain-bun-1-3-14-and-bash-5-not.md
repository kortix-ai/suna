---
recorded: 2026-10-05T21:48:55Z
incident_date: 2026-10-05
---
# Run pnpm test on the CI toolchain: bun 1.3.14 and bash 5, not macOS defaults

**Rule:** Run `pnpm test` with the Bun that `.github/workflows/tests.yml` pins (`bun-version: 1.3.14`) and with bash 5 first on `PATH`. A red lane on a clean `main` checkout is a toolchain mismatch until proven otherwise: re-run on the pinned toolchain before you debug or attest.

**Trigger surface:** running `pnpm test` (the attestation the pre-push hook checks) on a Mac where Homebrew upgraded Bun, or where `/bin/bash` is Apple's bash 3.2.

**Incident:** 2026-10-05, on the R4 API-layers branch. `pnpm test` was red on clean `main` (`e60ed971f1`) on one Mac:
- `secrets/relay-transport.test.ts` `MEASURED: bun does NOT preserve duplicate…` failed: it pins Bun 1.3.14 behavior, and Bun 1.4.0 keeps duplicate response headers.
- `db-sync-shadow-repair.integration.test.ts` failed: `scripts/prod-us-east-2/db-sync.sh` hit `SOURCE_SESSION[0]: unbound variable`, because bash 3.2 rejects an empty array under `set -u`.

Both passed with `PATH="<bun-1.3.14 dir>:$(brew --prefix bash)/bin:$PATH"`. Bun 1.3.14 for macOS is `bun-darwin-aarch64.zip` from the `bun-v1.3.14` GitHub release.

**Enforcement:** none yet. The enforcer to build: `tests/bin/local.ts` warns when `Bun.version` differs from the `tests.yml` pin, or when `bash` on `PATH` is older than 4.
