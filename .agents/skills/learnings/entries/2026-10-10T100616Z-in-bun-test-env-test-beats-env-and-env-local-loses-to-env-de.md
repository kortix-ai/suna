---
recorded: 2026-10-10T10:06:16Z
incident_date: 2026-10-09
---
# In bun test, .env.test beats .env (and .env.local loses to .env); decrypt dotenvx secrets into .env.test for API unit tests

**Rule:** Running `bun test` in `apps/api` needs real config values, but `apps/api/.env` is
dotenvx-encrypted and bun auto-loads it raw, so config validation fails with
`encrypted:…` values. Decrypt once into `apps/api/.env.test` (gitignored) with
`DOTENV_PRIVATE_KEY="$SUNA_API_DOTENV_PRIVATE_KEY" dotenvx get <KEY> -f .env` per key — or
a tiny bun script over `@dotenvx/dotenvx`'s `config()` for correct multiline handling — and
set sane test values for the handful of keys whose ciphertext decrypts to empty
(KORTIX_URL, DOCKER_HOST, LLM_GATEWAY_BASE_URL, E2B_API_KEY). Write plaintext env files
with newlines escaped as `\n` inside double quotes: a raw multiline PEM breaks every line
after it.

**Trigger surface:** Any worker running `bun test` (or `pnpm --filter kortix-api test`) in a
fresh checkout of `kortix-ai/suna` where `apps/api/.env` is encrypted.

**Incident:** 2026-10-09 KRTX-2064 (prod API process crash, Better Stack pattern
`SecretGrantResolutionError` as an uncaughtException). Reproducing the crash class needed
the API's unit harness; the encrypted `.env` blocked every run (`SUPABASE_URL must be a
valid HTTP(S) URL`). `bun -e` honored `.env.local` but `bun test` did not — under
`bun test`, `.env` wins over `.env.local`, and `.env.test` wins over both.

**Enforcement:** none yet: the API test setup could detect `encrypted:` values reaching
process.env during config validation and fail with a pointer to this entry instead of a
zod error.
