---
name: dotenvx-secrets
description: "How this repo manages API secrets and the three local-dev environments (local/dev/prod). They are dotenvx-ENCRYPTED in git and the keys live in Dotenv Armor. Load this WHENEVER you touch a secret, API key, token, credential, or any apps/api/.env* file; whenever the user pastes a key/token/secret to store or use; whenever choosing/switching which environment to run (local vs dev vs prod); and whenever adding, reading, rotating, or sharing a secret."
---

# Secrets & environments (this repo)

API secrets are **encrypted in git** with [dotenvx](https://dotenvx.com); the decryption keys live **off-device in Dotenv Armor**. This is mandatory — a plaintext secret never belongs in a tracked file.

## The three environments (local-dev secrets)

There are **three environments**, each a separate encrypted file with its **own keypair**. They differ only in *which backend the locally-running API talks to* — same code, different DB / Stripe / keys:

| `pnpm` command | Env | File | API talks to | private key in `.env.keys` |
| --- | --- | --- | --- | --- |
| `pnpm dev` | **local** | `apps/api/.env` | 100% local stack (local Supabase in Docker, test Stripe) + runs web + tunnel | `DOTENV_PRIVATE_KEY` |
| `pnpm dev:dev-env` | **dev** | `apps/api/.env.dev` | the **dev** stack — dev Supabase DB, **test** Stripe, dev keys (`dev-api.kortix.com`) | `DOTENV_PRIVATE_KEY_DEV` |
| `pnpm dev:prod-env` | **prod** | `apps/api/.env.prod` | the **prod** stack — prod Supabase DB, **LIVE** Stripe, prod keys (`api.kortix.com`) | `DOTENV_PRIVATE_KEY_PROD` |

- `pnpm dev` runs the **full local stack** (web + API + local Supabase + tunnel) via `scripts/dev-local.sh`.
- `pnpm dev:dev-env` / `pnpm dev:prod-env` run the **API only**, locally, against the remote dev/prod backend (`dotenvx run -f apps/api/.env.<dev|prod> -- bun run --hot src/index.ts`). They do not start local Supabase.
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
| Run local / dev / prod | `pnpm dev` · `pnpm dev:dev-env` · `pnpm dev:prod-env` |
| Verify all 3 envs decrypt + are separated | `pnpm test:envs` |
| Read a secret | `dotenvx get KEY -f apps/api/.env[.dev|.prod]` |
| Add / change a secret | `dotenvx set KEY value -f apps/api/.env[.dev|.prod]`, then commit |
| First time / new machine | `dotenvx-armor login` then `cd apps/api && for f in .env .env.dev .env.prod; do dotenvx-armor pull -f "$f"; done` |
| Share a NEW profile / rotated key | `dotenvx-armor push -f <file>` |
| Remove a key from the cloud | `dotenvx-armor down -f <file>` |

## Machine-local overrides

Need a different value just on your machine? Put it in the gitignored `apps/api/.env.local` (plaintext is fine — never committed). Bun loads it at higher precedence than `apps/api/.env`. **Never** edit a committed profile file to a machine-local value.

## Guardrails (don't bypass)

- `apps/api/.env.keys`, `apps/api/.env.local`, `apps/web/.env`, `supabase/.env` are gitignored.
- Version-controlled git hooks in `.githooks/` (enable per clone: `git config core.hooksPath .githooks`). Pre-commit **auto-encrypts** the three profile files and then blocks the commit if any unencrypted, non-gitignored `.env` remains; pre-push re-checks.
- `.gitleaks.toml` allowlists the encrypted `apps/api/.env*` so `secret-scan` passes while still catching real plaintext anywhere else.
- GitHub secret-scanning **push protection** is enabled on the repo.

If a guard fires, the fix is to **encrypt the value**, never to bypass it.

## Out of scope (not dotenvx-managed)

`apps/web/.env` (client-facing `NEXT_PUBLIC_*` + a couple of Vercel keys) and `supabase/.env` (local Supabase CLI / GitHub OAuth) are intentionally **plaintext + gitignored** — not encrypted, not in Armor. Don't try to `dotenvx`-manage them.
