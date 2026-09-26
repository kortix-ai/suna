# Contributing

This guide is for humans and coding agents. Agents: load the **`contributing`** skill
(`.agents/skills/contributing/SKILL.md`). It is the step-by-step procedure behind this page,
with verified commands. `AGENTS.md` holds the rules every change follows.

## Set up

```bash
pnpm install                               # also arms .githooks and the catalog merge driver
curl -sfS https://dotenvx.sh/armor | sh    # one-time: Dotenv Armor, holds the decryption key
dotenvx-armor login                        # grants this machine decryption
pnpm dev                                   # local stack: Supabase, API, web, tunnel
```

For isolated work, use a worktree per branch: `pnpm worktree create --name <slug> --yes
--no-start` (the **worktree** skill).

Tools every contributor needs:

| Tool | Minimum | Why |
| --- | --- | --- |
| `gh` | 2.99.0 | `--attach` uploads demo videos and screenshots to PRs |
| `agent-browser` | current (`npm i -g agent-browser && agent-browser install`) | The browser for agents: UI verification and demo videos |
| `ffmpeg` | libvpx + libx264 | `agent-browser record` (check with `agent-browser doctor`) |

## The pull request loop

1. **Branch.** One canonical branch per objective, in its own worktree.
2. **Commit.** Conventional subjects (`fix(api): …`, `feat(web): …`). The hooks must pass.
   Never use `--no-verify`.
3. **Open a draft PR against `main` with the `preview` label.** Fill every section of
   `.github/pull_request_template.md`.
4. **Test.** Run the narrowest relevant test, then `pnpm test`. CI runs the suite on a PR
   into `main` only with the `test` or `preview` label.
5. **Record a demo video** of the change with agent-browser, on the PR's preview origin.
6. **Attach it** with `gh pr edit <pr> --body-file output/pr/body.md --attach ./output/pr/demo.mp4`.
   `gh` uploads the video and puts a player in the PR body.
7. **Hand off.** Mark the PR ready. Merge to `main` only on explicit approval, because
   `main` deploys to dev for the whole team.

The skill covers each step with its commands and completion check.

## Labels and preview environments

| Label | Effect |
| --- | --- |
| `preview` | Deploys a full self-host environment for the branch: its own PostgreSQL, Supabase, API, gateway, frontend, Mailpit, and HTTPS origin. Runs `pnpm test -- --target-full` against it and the six-lane `Tests` suite. A push redeploys it in place. Removing the label or deleting the branch tears it down. Closing the PR does not. |
| `test` | Runs the six-lane `Tests` suite (~8 min) without a push. |
| `i18n-reorder` | Allows an intentional key reorder in the translation catalogs. |

- The preview origin appears in the sticky PR comment and in the `preview/pr-<N>` GitHub
  deployment. `.agents/skills/contributing/scripts/preview-origin.sh <pr> --wait` prints it
  once the head commit is live.
- Sign in with a synthetic email. The magic link arrives in the preview's own Mailpit
  (API: `<origin>/_mailpit/api/v1/messages`). `.agents/skills/contributing/scripts/preview-sign-in.sh <origin>
  <agent-browser-session>` does the whole sign-in.
- Previews run only for branches of this repository, and the label needs write access.
- Full reference: `.agents/skills/contributing/references/preview-environments.md`.

## Demo videos and attachments

Every PR body carries a video of the change, recorded with agent-browser:

```bash
agent-browser record start output/pr/demo.mp4 "<origin>/<route>" --cursor
#   … drive the change …
agent-browser record stop
gh pr edit <pr> --body-file output/pr/body.md --attach ./output/pr/demo.mp4
```

- `gh --attach` uploads to GitHub's attachment storage (`github.com/user-attachments/assets/…`).
  Attach media only this way. Never commit it or push it on a separate branch.
- Limits: images 10 MB (`png jpg gif webp svg`), videos 100 MB (`mp4 mov webm`). The token must
  be `gho_`, `ghp_`, or `github_pat_`, with write access.
- The repository is public. Record synthetic data only.
- Full reference: `.agents/skills/contributing/references/attachments.md`.

## Agent skills

- `.agents/skills/<name>/` holds every repo skill. `.claude/skills/<name>` is a symlink to it,
  so Claude Code, Codex, OpenCode, and other agents read the same files.
- **Add a skill:** create `.agents/skills/<name>/SKILL.md`, then
  `ln -s ../../.agents/skills/<name> .claude/skills/<name>`.
- **Add a third-party skill:** `npx skills add <owner/repo>`. Move it to
  `.agents/skills/<name>` if it lands in `.claude/skills`, symlink it back, and commit the
  `skills-lock.json` change. Do not edit a third-party skill in place. Update it with
  `npx skills update`.
- **Browser automation:** use **agent-browser** before any other browser tool. Its skill is a
  stub. Load the version-matched guide with `agent-browser skills get core`.

## Local secrets

API secrets live in **`apps/api/.env`, encrypted with [dotenvx](https://dotenvx.com)** and
committed to the repo. The ciphertext is safe in git. Only the private decryption key is
secret, and it lives in **[Dotenv Armor](https://dotenvx.com/armor)** (see Set up).

Four encrypted environments for local dev, one file each (each with its own keypair in
`apps/api/.env.keys`):

| Run                    | Env     | File                    | API backend                                                   |
| ---------------------- | ------- | ----------------------- | ------------------------------------------------------------- |
| `pnpm dev`             | local   | `apps/api/.env`         | 100% local stack (local Supabase, test Stripe) + web + tunnel |
| `pnpm dev:dev-env`     | dev     | `apps/api/.env.dev`     | dev stack: dev DB, test Stripe, dev keys                      |
| `pnpm dev:staging-env` | staging | `apps/api/.env.staging` | staging stack: staging DB, test Stripe, staging keys          |
| `pnpm dev:prod-env`    | prod    | `apps/api/.env.prod`    | prod stack: prod DB, **LIVE** Stripe                          |

Verify all four decrypt and are separated: `pnpm test:envs`. Add or rotate a secret:
`pnpm dlx @dotenvx/dotenvx set KEY value -f apps/api/.env[.dev|.staging|.prod]`, then commit.
The env-specific run scripts use `dotenvx run --overload`, so the selected profile wins over
exported local cloud credentials.

These files are for **local development only**. Deployed **production** loads its env from
**AWS Secrets Manager** at runtime. `apps/api/.env.prod` only runs a local process against the
prod backend. `apps/web` has the **same four encrypted profiles** (mostly public
`NEXT_PUBLIC_*`). Only `supabase/.env` (local Supabase CLI) stays a plain gitignored file.

CI needs none of these today: builds use placeholders, and `.gitleaks.toml` exempts the dotenvx
ciphertext lines. If a job needs real values, add the dotenvx private key as one
`DOTENV_PRIVATE_KEY` Actions secret and prefix the step with `dotenvx run -- …`.

Never write a plaintext secret into a tracked file. Full procedure: the **dotenvx-secrets**
skill (`.agents/skills/dotenvx-secrets/SKILL.md`).

### What stops a plaintext leak

Three gates, in the order they fire. `pnpm install` arms the first one: its `prepare` script
runs `git config core.hooksPath .githooks`.

| # | Gate | When | Catches |
|---|------|------|---------|
| 1 | `.githooks/pre-commit` + `pre-push` | before the commit, on your machine | auto-**encrypts** every staged `.env`, then `dotenvx ext precommit` blocks anything still plaintext |
| 2 | `secrets-guard.yml` → `pnpm secrets:check` | on the PR | **structural**: every value in a committed profile must start with `encrypted:` |
| 3 | `secret-scan.yml` (gitleaks) + GitHub push protection | on the PR / on push | **pattern**-based: known provider keys and high-entropy strings |

Gate 2 exists because gate 3 is pattern-based and gate 1 inspects only the *staged* diff.
Run gate 2 any time with `pnpm secrets:check`.

Editing `.gitleaks.toml`? Every allowlist must be `condition = "AND"` with `regexes`. A
path-only allowlist exempts the whole file. That is how a plaintext `apps/api/.env` once
scanned as `no leaks found`. `secrets-guard.yml` fails the build if a path-only allowlist
reappears.

The same hooks refuse customer names and other blocked terms in added lines, commit messages,
and branch names (`scripts/check-blocked-terms.sh`). They do not see PR titles, bodies,
comments, or attached media. Those are your responsibility.

## Translation catalogs

`apps/web/translations/<locale>.json` holds the UI text for 9 locales. Each catalog is exactly
what `JSON.stringify(value, null, 2)` writes, and keeps its keys in the order they were added.
Nothing at runtime reads that order, but every merge and review diff does, and
`starterPrompts.items` must follow `STARTER_PROMPTS` (`src/lib/starter-prompts.test.ts`).

- **Merges go key by key.** `.gitattributes` routes the catalogs to an order-preserving merge
  driver, and `pnpm install` registers it (`scripts/register-merge-drivers.sh`). Two branches
  that add keys do not conflict. A key changed two different ways gets conflict markers around
  that key only.
- **Never resolve a catalog conflict with a program that rebuilds the file.** On 2026-09-22 one
  did: it reordered 473 of 840 objects in every catalog and brought back 4 deleted keys. To redo
  a conflicted catalog with the driver, run `pnpm install`, then
  `git checkout -m apps/web/translations/<locale>.json` and `git add` it.
- **CI checks it.** `i18n-catalogs.yml` runs on every pull request that touches a catalog: each
  one must be canonical and keep the base branch's key order. The same check, locally:
  `node apps/web/scripts/i18n-catalogs.mjs check --base=origin/main`. Repair a reorder without
  changing a value: `node apps/web/scripts/i18n-catalogs.mjs restore-order --from=origin/main`.
  An intentional reorder takes the `i18n-reorder` label.

## Testing

This repo has one local-first test system: **[tests/README.md](./tests/README.md)** and the
**testing** skill (`.agents/skills/testing/SKILL.md`).

**THE RULE:** every change that touches behaviour ships with tests in the same change.

Run tests from the repository root:

```bash
pnpm test                       # Local REST/CLI flows, SDK, runner units, route coverage
pnpm test -- --id ACC-4        # One product flow
pnpm test -- --domain access   # One product domain
pnpm test -- --sdk-only        # SDK only
pnpm test -- --browser-only    # Browser only; owns the deterministic local stack
pnpm test -- --packages-only   # All app/package tests and publish contracts
pnpm test -- --full            # Browser and all app/package tests
pnpm test -- --target-smoke    # Deployed staging API SHA and browser smoke
pnpm test -- --target-full     # Every deployed staging flow and browser journey
```

Browser and full modes start local Supabase, migrations, API, gateway, and web. Stop an
ordinary development stack before either command.

- **Routes:** when you add or change an HTTP route under `apps/api/src/**`, add or update the
  matching `ke2e` flow in `tests/src/flows/` and keep its `meta.routes` in sync.
  `bun tests/bin/ke2e.ts coverage` fails on any uncovered or unknown route.
  `tests/spec/end-to-end.md` is the human source of truth.
- **Units:** when you add or change an exported function, class, or module in any `apps/**` or
  `packages/**` package, add or update a co-located `*.test.ts` (`bun:test`). Run one package
  with `pnpm --filter <name> test`.

### Test review checklist (for PR authors and reviewers)

- [ ] New/changed exports have co-located unit tests; new/changed routes have a `ke2e` flow.
- [ ] Tests are deterministic — no real wall-clock, network, or runner-timezone/ICU dependence; config comes from env, not hardcoded URLs/ports/secrets.
- [ ] Each test is isolated — no shared mutable module state, no order dependency; `beforeEach`/`afterEach` restore any env/global they touch.
- [ ] Assertions are targeted (behaviour, not implementation); no `expect(true).toBe(false)` guards, no over-broad snapshots, no exact file-list pins that bitrot.
- [ ] No `.only(` / focused tests committed (the gate rejects them).
- [ ] Mocks are at the boundary and reset per test; no real production data or credentials.

### What CI runs

| Pull request into | Runs |
| --- | --- |
| `main`, no label | `ci.yml`, security and compliance scans, migration checks. `Tests` shows as skipped. |
| `main` + `test` | the above + the six-lane `Tests` suite (`core`, `browser-1`…`4`, `packages`) |
| `main` + `preview` | the above + the preview deploy and `--target-full` against it |
| `staging` | the no-label checks + `Tests`, always |
| `prod` | `tests-release.yml` against deployed staging. Its `full suite + quality gates` check is the only required check. |

Every push to `main` also runs `Tests`. A red run comments the failing lanes on the commit.
