# Contributing

## Local secrets

API secrets live in **`apps/api/.env`, encrypted with [dotenvx](https://dotenvx.com)** and
committed to the repo — the ciphertext is safe in git; only the private decryption key is secret.
To run locally you need that key, which we keep off-device in
**[Dotenv Armor](https://dotenvx.com/armor)**:

```bash
curl -sfS https://dotenvx.sh/armor | sh   # one-time install
dotenvx-armor login                        # grants this machine decryption
pnpm dev                                   # dev-local.sh decrypts apps/api/.env on boot
```

Four encrypted environments for local dev, one file each (each with its own keypair in
`apps/api/.env.keys`):

| Run | Env | File | API backend |
| --- | --- | --- | --- |
| `pnpm dev` | local | `apps/api/.env` | 100% local stack (local Supabase, test Stripe) + web + tunnel |
| `pnpm dev:dev-env` | dev | `apps/api/.env.dev` | dev stack — dev DB, test Stripe, dev keys |
| `pnpm dev:staging-env` | staging | `apps/api/.env.staging` | staging stack — staging DB, test Stripe, staging keys |
| `pnpm dev:prod-env` | prod | `apps/api/.env.prod` | prod stack — prod DB, **LIVE** Stripe |

Verify all four decrypt + are separated: `pnpm test:envs`. Add/rotate a secret:
`pnpm dlx @dotenvx/dotenvx set KEY value -f apps/api/.env[.dev|.staging|.prod]`, then commit. The
env-specific run scripts use `dotenvx run --overload` so the selected profile wins over exported
local cloud credentials.

These files are for **local development only**. The deployed **production** infra loads its real
env from **AWS Secrets Manager** at runtime — `apps/api/.env.prod` is just for running locally
against the prod backend and does not affect what prod runs. `apps/web` has the **same four
encrypted profiles** (`apps/web/.env` / `.env.dev` / `.env.staging` / `.env.prod`, mostly public
`NEXT_PUBLIC_*`). Only `supabase/.env` (local Supabase CLI) stays a plain gitignored file.

CI doesn't need any of these today (builds use placeholders, and the `secret-scan` workflow
allowlists the encrypted file via `.gitleaks.toml`). If a future job needs real values, add the
dotenvx private key as a single `DOTENV_PRIVATE_KEY` GitHub Actions secret and prefix the step with
`dotenvx run -- …` — it decrypts `apps/api/.env` in memory, no other secrets required.

Never write a plaintext secret into a tracked file. Full procedure: the
[`dotenvx-secrets` skill](./.claude/skills/dotenvx-secrets/SKILL.md).

## Testing

This repo has one consolidated test framework. See **[TESTING.md](./TESTING.md)** for the
full taxonomy, CI cadences, reporting, and quality gates, and the **[`testing` skill](./.claude/skills/testing/SKILL.md)**
for the test-with-every-change discipline (loaded automatically when you edit code).

**THE RULE:** every change that touches behaviour ships with tests in the same change. CI enforces
it — the `tests-required` gate fails any PR that changes source under `apps/**` or `packages/**`
without changing a test (override with the `no-tests-needed` label for formatting/docs-only PRs).

Quick start:

```bash
make install     # test deps + Playwright browser
make fast        # lint + typecheck + unit + smoke (the local loop)
make <lane>      # unit | integration | api | contract | smoke | e2e | visual | a11y |
                 # performance | security | migration | infra | chaos | mutation | pentest
make gates       # evaluate quality gates over test-results/
```

**Test-driven expectation:** when you add or change an HTTP route under `apps/api/src/**`,
add or update the matching `ke2e` flow in `tests/src/flows/` and keep its `meta.routes` in
sync. The coverage gate (`make gates`, and the `qa-pr` workflow) fails on any uncovered or
unknown route. `tests/spec/end-to-end.md` is the human source of truth; see the
`ke2e-tests` agent skill for the full add-a-test workflow.

**Unit-test expectation:** when you add or change an exported function/class/module in any
`apps/**` or `packages/**` package, add or update a co-located `*.test.ts` next to it
(`bun:test`). Every package has a `test` script; run the whole set with `pnpm test`, or one
package with `pnpm --filter <name> test`. The `package-tests` workflow runs them on every PR.

Run tests before pushing:

```bash
pnpm ci:pr                     # run the FULL PR gate locally (mirrors .github/workflows) — push clean
pnpm ci:release                # the full pre-prod gate (what runs on a PR into prod)
pnpm test                      # just all co-located unit suites
pnpm --filter <name> test      # just the package you touched
make fast                      # lint + typecheck + unit + smoke (cross-cutting)
```

`pnpm ci:pr` runs each GitHub check (tests-required, focused-test guard, unit
suites, typecheck, biome, `make ci-pr`, terraform fmt/tflint, checkov/trivy,
gitleaks) and prints a pass/fail/skip summary. Anything that needs Docker,
`apps/api/.env.keys`, or terraform that you don't have locally is **skipped**
(it still runs in CI) — so a green local run means the PR will be green too.

### Test review checklist (for PR authors and reviewers)

- [ ] New/changed exports have co-located unit tests; new/changed routes have a `ke2e` flow.
- [ ] Tests are deterministic — no real wall-clock, network, or runner-timezone/ICU dependence; config comes from env, not hardcoded URLs/ports/secrets.
- [ ] Each test is isolated — no shared mutable module state, no order dependency; `beforeEach`/`afterEach` restore any env/global they touch.
- [ ] Assertions are targeted (behaviour, not implementation); no `expect(true).toBe(false)` guards, no over-broad snapshots, no exact file-list pins that bitrot.
- [ ] No `.only(` / focused tests committed (the gate rejects them).
- [ ] Mocks are at the boundary and reset per test; no real production data or credentials.

CI runs the fast lanes and the per-package unit suites on every PR, heavier regression on
merge to `main`, and the slow suites (performance, DAST, mutation, chaos) nightly. A red gate
blocks the merge/release.
