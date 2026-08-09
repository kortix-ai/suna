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

| Run                    | Env     | File                    | API backend                                                   |
| ---------------------- | ------- | ----------------------- | ------------------------------------------------------------- |
| `pnpm dev`             | local   | `apps/api/.env`         | 100% local stack (local Supabase, test Stripe) + web + tunnel |
| `pnpm dev:dev-env`     | dev     | `apps/api/.env.dev`     | dev stack — dev DB, test Stripe, dev keys                     |
| `pnpm dev:staging-env` | staging | `apps/api/.env.staging` | staging stack — staging DB, test Stripe, staging keys         |
| `pnpm dev:prod-env`    | prod    | `apps/api/.env.prod`    | prod stack — prod DB, **LIVE** Stripe                         |

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

This repo has one local-first test system. See **[tests/README.md](./tests/README.md)**
and the **[`testing` skill](./.claude/skills/testing/SKILL.md)**.

**THE RULE:** every change that touches behaviour ships with tests in the same change.

Run tests from the repository root:

```bash
pnpm test                       # Local REST/CLI flows, SDK, runner units, route coverage
pnpm test -- --id ACC-4        # One product flow
pnpm test -- --domain access   # One product domain
pnpm test -- --sdk-only        # SDK only
pnpm test -- --browser-only    # Browser only; owns the deterministic local stack
pnpm test -- --full            # Browser and all app/package tests
```

Browser and full modes start local Supabase, migrations, API, gateway, and web.
Stop an ordinary development stack before either command.

**Test-driven expectation:** when you add or change an HTTP route under `apps/api/src/**`,
add or update the matching `ke2e` flow in `tests/src/flows/` and keep its `meta.routes` in
sync. `bun tests/bin/ke2e.ts coverage` fails on any uncovered or unknown route.
`tests/spec/end-to-end.md` is the human source of truth.

**Unit-test expectation:** when you add or change an exported function/class/module in any
`apps/**` or `packages/**` package, add or update a co-located `*.test.ts` next to it
(`bun:test`). Every package has a `test` script. Run one package with
`pnpm --filter <name> test`. The root `--full` mode runs every package test.

Run tests before pushing:

```bash
pnpm test
pnpm test -- --full
```

### Test review checklist (for PR authors and reviewers)

- [ ] New/changed exports have co-located unit tests; new/changed routes have a `ke2e` flow.
- [ ] Tests are deterministic — no real wall-clock, network, or runner-timezone/ICU dependence; config comes from env, not hardcoded URLs/ports/secrets.
- [ ] Each test is isolated — no shared mutable module state, no order dependency; `beforeEach`/`afterEach` restore any env/global they touch.
- [ ] Assertions are targeted (behaviour, not implementation); no `expect(true).toBe(false)` guards, no over-broad snapshots, no exact file-list pins that bitrot.
- [ ] No `.only(` / focused tests committed (the gate rejects them).
- [ ] Mocks are at the boundary and reset per test; no real production data or credentials.

CI runs `pnpm test -- --full` inside an ephemeral Platinum sandbox. A red
required check blocks the merge.
