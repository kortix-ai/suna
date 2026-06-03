---
name: dotenvx-secrets
description: "How this repo manages API secrets — they are dotenvx-ENCRYPTED in git and the keys live in Dotenv Armor. Load this WHENEVER you touch a secret, API key, token, credential, or any apps/api/.env* file; whenever the user pastes a key/token/secret and wants it stored or used; and whenever adding, reading, rotating, or sharing a secret. Enforces the non-negotiable rule: never write a plaintext secret into a tracked file — always go through dotenvx."
---

# dotenvx secrets (this repo)

API secrets are **encrypted in git** with [dotenvx](https://dotenvx.com); the decryption keys live **off-device in Dotenv Armor**. This is mandatory — there is no path where a plaintext secret belongs in a tracked file.

## The one rule (non-negotiable)

**Never write a plaintext secret into a tracked file, a commit, or a code/PR artifact.** Every secret goes in through `dotenvx`, which encrypts it in place. The only plaintext that ever exists is in process memory at runtime and in the gitignored `apps/api/.env.keys` / `apps/api/.env.local`.

If you're ever about to type a real key into a file, stop — use `dotenvx set` instead.

## When the user pastes a key/token/secret

Do **not** paste it into a file, echo it back, or commit it. Instead, store it encrypted:

```sh
dotenvx set THE_KEY_NAME 'the-pasted-value' -f apps/api/.env
```

This re-encrypts `apps/api/.env` in place (value becomes `KEY=encrypted:…`). Then commit the file. If it's a brand-new value that teammates need, also `dotenvx-armor push -f apps/api/.env`. Never leave the raw value sitting in chat output, a scratch file, or a comment.

## How it works (briefly)

- Each value in `apps/api/.env` is AES-encrypted. The **public key** (encrypts) sits in the file and is safe to commit; the **private key** (decrypts) never touches git.
- Private keys live in **Dotenv Armor** (cloud) and/or the gitignored `apps/api/.env.keys`.
- At boot, `dotenvx run` decrypts **in memory** and injects real env vars — nothing plaintext hits disk.
- Three profiles, one file each, each with its own keypair: `apps/api/.env` (local, the default), `apps/api/.env.dev`, and `apps/api/.env.prod` — the latter two are opt-in via `-f` (e.g. `dotenvx run -f apps/api/.env.prod -- …`). The deployed prod runtime still injects its own env; `.env.prod` is only for running locally against prod.

## Commands

| Task | Command |
| --- | --- |
| Read a secret | `dotenvx get KEY -f apps/api/.env` |
| Add / change a secret | `dotenvx set KEY value -f apps/api/.env` (or `.env.dev`), then commit |
| Run with decrypted env | `dotenvx run -f apps/api/.env -- <cmd>` (this is what `pnpm dev` does) |
| First time / new machine | `dotenvx-armor login` then `cd apps/api && for f in .env .env.dev; do dotenvx-armor pull -f "$f"; done` |
| Share a new/rotated key | `dotenvx-armor push -f <file>` (one file at a time) |
| Remove a key from the cloud | `dotenvx-armor down -f <file>` |

## Machine-local overrides

Need a different value just on your machine? Put it in the gitignored `apps/api/.env.local` (plaintext is fine — it's never committed). Bun loads it at higher precedence than `apps/api/.env`. **Never** edit `apps/api/.env` to a local value.

## Guardrails already in place

- `apps/api/.env.keys`, `apps/api/.env.local`, `apps/web/.env`, `supabase/.env` are gitignored.
- Version-controlled git hooks in `.githooks/` (enable per clone: `git config core.hooksPath .githooks`). The pre-commit hook **auto-encrypts** `apps/api/.env` / `.env.dev` and then blocks the commit if any unencrypted, non-gitignored `.env` remains; pre-push re-checks as a final gate.
- `.gitleaks.toml` allowlists the (encrypted) `apps/api/.env*` so `secret-scan` passes while still catching real plaintext anywhere else.
- GitHub secret-scanning **push protection** is enabled on the repo.

Do not weaken any of these to make a commit go through. If the guard fires, the fix is to encrypt the value, not to bypass it.
