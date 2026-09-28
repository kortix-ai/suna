---
recorded: 2026-09-28T20:04:46Z
incident_date: 2026-09-28
---
# A helper that reads committed env files treats dotenvx ciphertext as absent

**Rule:** Code that parses a committed `.env` file without dotenvx treats an
`encrypted:` value as absent and falls through to the next source. A committed
`.env` value is ciphertext, never a credential.

**Trigger surface:** Adding a key to `apps/api/.env` or `apps/web/.env` that a
test helper, script, or runner also looks up by name.

**Incident:** 2026-09-28. #7981 added an encrypted `SUPABASE_ANON_KEY` to
`apps/api/.env`. The e2e `signIn` helper looked that name up before
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, read the ciphertext as the key, and every
browser journey failed before it opened a page: all four browser lanes red on
`main` (run 36473195004). Fixed in #8013.

**Enforcement:** `tests/e2e/helpers/env.ts` `parseEnvFile` skips `encrypted:`
values; `tests/unit/e2e-env-ciphertext.test.ts` fails if it stops.
