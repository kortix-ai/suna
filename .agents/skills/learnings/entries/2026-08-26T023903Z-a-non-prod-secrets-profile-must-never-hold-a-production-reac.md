---
recorded: 2026-08-26T02:39:03Z
commit: a1ce61c62b
---
# A non-prod secrets profile must never hold a production-reaching credential

Found 2026-08-26 while scoping Dotenvx Armor access. `apps/api/.env` — the
local profile every Armor member decrypts daily — carried 22 secrets
byte-identical to `apps/api/.env.prod`. One of them, `SUPABASE_MGMT_TOKEN`,
was a personal Supabase management token that executed SQL on the Kortix
PROD project (`POST /v1/projects/<ref>/database/query` → 201) and was used
nowhere in the repository. Restricting the PROD keypair to the owner had
protected nothing, because the same credentials lived in the file everyone
had.

**Rules.**
1. Classify a profile by what its credentials can reach, not by which
   database URL it names. A local DB with production vendor keys is a
   production profile.
2. A secret-classed key in `.env`, `.env.dev`, or `.env.staging` must not
   equal its `.env.prod` value. Every exception is a listed debt with the
   rotation that removes it.
3. Delete a credential the code never reads. A dead key is pure exposure.
4. Personal tokens never belong in a shared profile. Use a service credential
   scoped to one environment.
5. A per-key access control (Armor FGAC) only works after the split above.
   Do the split first, then restrict the prod keypair.
6. Classify each environment's data explicitly. The dev Supabase project
   holds 2.7k signups that the owner classifies as synthetic; that decision
   is recorded, not assumed. Until the shared vendor keys are split, only
   `.env` qualifies for people without production clearance.

*Automation:* `pnpm test:envs` runs `scripts/secrets-envs-separation.py`,
which fails on any unlisted non-prod secret that equals its prod value;
`scripts/secrets-shared-with-prod.allowlist` is the tracked exception list.

*Incident:* no known misuse. The Armor audit log shows the PROD keypairs were
decrypted by 4 members and 1 former member before the restriction; the shared
vendor credentials remain to be rotated per the allowlist (PR #6910).
