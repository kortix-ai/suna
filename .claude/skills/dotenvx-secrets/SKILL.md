---
name: dotenvx-secrets
description: "How this repo manages API secrets and the four local-run environments (local/dev/staging/prod). They are dotenvx-ENCRYPTED in git and the keys live in Dotenv Armor. Load this WHENEVER you touch a secret, API key, token, credential, or any apps/api/.env* file; whenever the user pastes a key/token/secret to store or use; whenever choosing/switching which environment to run; and whenever adding, reading, rotating, or sharing a secret."
---

# Secrets & environments (this repo)

API secrets are **encrypted in git** with [dotenvx](https://dotenvx.com); the decryption keys live **off-device in Dotenv Armor**. This is mandatory — a plaintext secret never belongs in a tracked file.

## Armor organization and access boundary

The canonical Armor organization is **`kortix-ai`**. All API and web keypairs
must be pushed to and pulled from that team explicitly; never rely on the CLI's
personal-team default.

Each `.env.<environment>` has its own keypair, so Armor access can be gated by
environment. Restrict the two prod keys (`apps/api/.env.prod` and
`apps/web/.env.prod`) to the smallest production-authorized group. Separate
Armor organizations are also possible, but only create one when a distinct
billing/admin boundary is intentional.

## The four environments (local-run secrets)

There are **four environments**, each a separate encrypted file with its **own keypair**. They differ only in *which backend the locally-running API talks to* — same code, different DB / Stripe / keys:

| `pnpm` command | Env | File | API talks to | private key in `.env.keys` |
| --- | --- | --- | --- | --- |
| `pnpm dev` | **local** | `apps/api/.env` | 100% local stack (local Supabase in Docker, test Stripe) + runs web + tunnel | `DOTENV_PRIVATE_KEY` |
| `pnpm dev:dev-env` | **dev** | `apps/api/.env.dev` | the **dev** stack — dev Supabase DB, **test** Stripe, dev keys (`dev-api.kortix.com`) | `DOTENV_PRIVATE_KEY_DEV` |
| `pnpm dev:staging-env` | **staging** | `apps/api/.env.staging` | the **staging** stack — staging Supabase DB, test Stripe, staging keys (`staging-api.kortix.com`) | `DOTENV_PRIVATE_KEY_STAGING` |
| `pnpm dev:prod-env` | **prod** | `apps/api/.env.prod` | the **prod** stack — prod Supabase DB, **LIVE** Stripe, prod keys (`api.kortix.com`) | `DOTENV_PRIVATE_KEY_PROD` |

- `pnpm dev` runs the **full local stack** (web + API + local Supabase + tunnel) via `scripts/dev-local.sh`.
- `pnpm dev:dev-env` / `pnpm dev:staging-env` / `pnpm dev:prod-env` run the **API only**, locally, against the selected remote backend (`dotenvx run -f apps/api/.env.<environment> -- bun run --hot src/index.ts`). They do not start local Supabase.
- ⚠️ `pnpm dev:prod-env` points your local API at **production** — DB writes and Stripe calls are **real**. Use deliberately.

### CRITICAL — `.env.prod` is NOT what production runs

The deployed **production infra loads its env from AWS Secrets Manager** at runtime. `apps/api/.env.prod` is **only** for running locally against the prod backend. Editing `apps/api/.env.prod` does **not** change what production runs — to change real prod secrets, update **AWS Secrets Manager**.

## The one rule (non-negotiable)

**Never write a plaintext secret into a tracked file, a commit, or a code/PR artifact.** Every secret goes in through `dotenvx`, which encrypts it in place. The only plaintext that ever exists is in process memory at runtime and in the gitignored `apps/api/.env.keys` / `apps/api/.env.local`.

### When the user pastes a key/token/secret

Do **not** paste it into a file, echo it back, or commit it. Store it encrypted in the right env file:

```sh
dotenvx set THE_KEY_NAME 'pasted-value' -f apps/api/.env        # local
dotenvx set THE_KEY_NAME 'pasted-value' -f apps/api/.env.dev    # dev
dotenvx set THE_KEY_NAME 'pasted-value' -f apps/api/.env.staging # staging
dotenvx set THE_KEY_NAME 'pasted-value' -f apps/api/.env.prod   # prod
```

This re-encrypts the file in place (value becomes `KEY=encrypted:…`). Then commit. **No Armor push is needed for a new/changed secret** — the keypair is unchanged, so teammates can already decrypt it; the new ciphertext just rides in git.

## How it works

- Every value is AES-encrypted. The **public key** (encrypts) sits at the top of each file and is safe to commit; the **private key** (decrypts) never touches git.
- Private keys live in **Dotenv Armor** (cloud) and/or the gitignored `apps/api/.env.keys`.
- `dotenvx run -f <file> -- <cmd>` decrypts **in memory** and injects real env vars — nothing plaintext hits disk.

## Commands

| Task | Command |
| --- | --- |
| Run local / dev / staging / prod | `pnpm dev` · `pnpm dev:dev-env` · `pnpm dev:staging-env` · `pnpm dev:prod-env` |
| Verify all 4 envs decrypt + are separated | `pnpm test:envs` |
| Read a secret | `dotenvx get KEY -f apps/api/.env` (or `.env.dev` / `.env.staging` / `.env.prod`) |
| Add / change a secret | `dotenvx set KEY value -f apps/api/.env` (or `.env.dev` / `.env.staging` / `.env.prod`), then commit |
| First time / new machine | `dotenvx armor login` then `cd apps/api && for f in .env .env.dev .env.staging .env.prod; do dotenvx armor pull --team kortix-ai -f "$f"; done` |
| Share a NEW profile / rotated key | `dotenvx armor push --team kortix-ai -f <file>` |
| Remove a key from the cloud | `dotenvx armor down -f <file>` |

## Armor login security

Use dotenvx **2.7.1 or newer** for Armor authentication. Since 2.7.1, a fresh
login stores `DOTENVX_ARMOR_TOKEN` in the native OS secret store when available
instead of the plaintext settings file. Existing users must upgrade once and
re-authenticate:

```sh
dotenvx armor logout
dotenvx armor login
```

Verify with `dotenvx armor status` and `dotenvx armor settings username`. Never
print or paste `dotenvx armor settings token --unmask` into logs, tickets, or
shell history.

## Rotating every keypair

The repo pins dotenvx 1.75.x because dotenvx 2.x temporarily removed `rotate`.
Run rotation through the repo binary (`pnpm exec dotenvx rotate`), while Armor
login/push/pull use the current global CLI.

`rotate --no-armor` deliberately leaves a transitional `old,new` value in
`.env.keys`. Armor accepts exactly one private key, so **never push that combined
value**. After proving the new ciphertext decrypts, retain only the new private
key, push it explicitly to `kortix-ai`, then prove a clean Armor pull matches all
eight keys before merging. Remove the old armored keys only after the rotated
ciphertext is merged and available to every consumer.

## Machine-local overrides

Need a different value just on your machine? Put it in the gitignored `apps/api/.env.local` (plaintext is fine — never committed). Bun loads it at higher precedence than `apps/api/.env`. **Never** edit a committed profile file to a machine-local value.

## Guardrails (don't bypass)

- `apps/api/.env.keys`, `apps/api/.env.local`, `apps/web/.env`, `supabase/.env` are gitignored.
- Version-controlled git hooks in `.githooks/` (enable per clone: `git config core.hooksPath .githooks`). **Every committable `.env` is dotenvx-managed, no exceptions:** the pre-commit hook discovers *any* staged `.env`/`.env.<env>` (new services included) and **auto-encrypts** it (`--no-armor`, mints a keypair into the adjacent `.env.keys` for new files), then blocks the commit if any unencrypted, non-gitignored `.env` remains; pre-push re-checks. Excluded: `.env.keys` (private keys) and `.env.example` (templates); gitignored files like `.env.local` / `supabase/.env` are never staged so they're untouched.
- `.gitleaks.toml` allowlists the encrypted `apps/api/.env*` so `secret-scan` passes while still catching real plaintext anywhere else.
- GitHub secret-scanning **push protection** is enabled on the repo.

If a guard fires, the fix is to **encrypt the value**, never to bypass it.

## The web app (apps/web) — same setup

`apps/web` has the **same four encrypted profiles** (`apps/web/.env` / `.env.dev` / `.env.staging` / `.env.prod`), own keypairs in `apps/web/.env.keys`, armored under `kortix-ai`. Decrypted the same way: `pnpm dev` (via `load_local_env`) and the environment-specific web scripts. Pull on a new machine: `cd apps/web && for f in .env .env.dev .env.staging .env.prod; do dotenvx armor pull --team kortix-ai -f "$f"; done`.

Maintenance flags are **DB-backed** now (was Vercel Edge Config): stored in `kortix.platform_settings['maintenance_config']`, read via public `GET /v1/system/maintenance`, written via admin-only `PUT /v1/system/maintenance`, set from `/admin/utils`. The `EDGE_CONFIG`/`EDGE_CONFIG_ID`/`VERCEL_API_TOKEN` secrets + the `@vercel/edge-config` dep are gone.

## Out of scope (not dotenvx-managed)

`supabase/.env` (local Supabase CLI / GitHub OAuth) is intentionally **plaintext + gitignored** — it's auto-loaded by the Supabase CLI, which can't read dotenvx encryption. Don't try to `dotenvx`-manage it.
