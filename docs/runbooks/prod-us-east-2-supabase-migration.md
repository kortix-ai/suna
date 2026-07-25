# Production Supabase migration to `us-east-2`

## Status

- Source project: `jbriwassebxdwoieikga` in `eu-west-2`.
- Target project: `uhrwvisbqjfxhxjvoofd` in `us-east-2`.
- Target status: `ACTIVE_HEALTHY`.
- Target PostgreSQL version: `17.6`.
- Target compute: XL with 4 dedicated vCPU and 16 GB RAM.
- Target disk: 500 GB gp3 with 3,000 IOPS and 125 MiB/s throughput.
- Target PITR: 7 days.
- Target dedicated IPv4: enabled.
- Target credentials: AWS Secrets Manager secret `kortix/prod-us-east-2-migration`.
- Target database password: rotated on 2026-07-25.
- Migration and runtime database URLs: updated after the password rotation.
- US API and gateway tasks: restarted after the password rotation.
- Fresh-project bootstrap: applied.
- Repository migration ledger: 79 migrations applied through
  `20260725012141489_gateway_cost_precision_sync`.
- `pg_cron`: enabled at version 1.6.4 with zero scheduled jobs.
- Application logical replication: `101/101` relations ready.
- Auth logical replication: `22/22` relations ready.
- Replication apply errors: `0`.
- Application replication sync errors: `3`.
- Auth replication sync errors: `0`.
- The three application sync errors are historical initial-copy retries.
- Both subscriptions have active apply workers.
- A source GoTrue refresh token exchanges successfully on target Auth.
- The target issues the exchanged token with `HS256` and signing-key ID
  `9871968b-feba-4720-b80e-ba8ae1bbec17`.
- The target Auth non-secret Apple, Google, GitHub, SAML, and Twilio identifiers
  match the source where applicable.
- Apple Auth and SAML are enabled on both projects.
- Google Auth, GitHub Auth, and phone MFA remain disabled on the target until
  their plaintext secrets are installed.
- Source WAL retention limit: 32 GB.
- Replication credential: rotated after the initial copy.
- Storage copied: all 79 `avatars` objects with byte and SHA-256 verification.
- Legacy Storage copied: none.
- US API shadow: two healthy ECS tasks on image `kortix/kortix-api:0.10.14`.
- US gateway shadow: two healthy ECS tasks on image
  `kortix/kortix-gateway:0.10.14`.
- US API task definition: `kortix-prod-use2:2`.
- US gateway task definition: `kortix-prod-use2-gateway:2`.
- Shadow Terraform state: `prod-us-east-2-shadow/ecs-api.tfstate`.
- Shadow Terraform state bucket:
  `kortix-terraform-state-us-east-2-935064898258` in `us-east-2`.
- Shadow Terraform lock table: `kortix-terraform-locks-us-east-2`.
- Shadow Terraform state and lock data use customer-managed KMS encryption.
- Shadow Terraform state keeps noncurrent versions for 365 days.
- Shadow verification hosts:
  - `api-use2-shadow.kortix.com`
  - `gateway-use2-shadow.kortix.com`
- Target Auth email rate limit: 30,000 per hour, equal to the source.
- Production release workflow: deploys and verifies the US shadow.
- Runtime database endpoint: regional session pooler
  `aws-0-us-east-2.pooler.supabase.com:5432`.
- Logical replication endpoint: direct target database host
  `db.uhrwvisbqjfxhxjvoofd.supabase.co:5432`.
- US frontend project: `suna-us-east-2-shadow`.
- US frontend deployment: `dpl_9Fs1dXprKoGqVPro17GTZtWxqeWL`.
- US frontend host: `https://us.kortix.com`.
- US frontend function region: Vercel `cle1`.
- Cloudflare contains inactive US East 2 API and gateway origins.
- Cloudflare active backend values remain `ecs-fargate`.
- US shadow worker, scheduler, channel, tunnel, warm-pool, managed-provider,
  legacy-migration, and Suna-migration flags: disabled.
- Production traffic still uses the source project.
- The obsolete US West 2 Supabase project is deleted.
- The obsolete US West 2 VPC, ECS services, ALBs, DNS records, NAT gateways,
  task definitions, publications, replication slots, and replication role are
  deleted or inactive.
- Two obsolete US West 2 KMS keys are in AWS `PendingDeletion` until
  2026-08-24.
- Two obsolete US West 2 Secrets Manager secrets have a seven-day recovery
  window until 2026-08-01.

Do not print or copy secret values into this document, shell output, or Git.

## Verified source inventory

| Item                |                Value |
| ------------------- | -------------------: |
| PostgreSQL version  |                 15.8 |
| Provisioned disk    |               378 GB |
| Database data       | approximately 286 GB |
| Storage objects     |              452,290 |
| Storage data        | approximately 138 GB |
| Auth users          |              405,870 |
| Auth identities     |              409,636 |
| MFA factors         |                8,606 |
| Auth refresh tokens |            9,538,250 |
| `public` schema     |               250 GB |
| `kortix` schema     |                29 GB |
| `auth` schema       |                11 GB |
| `cron` schema       |                33 GB |
| `net` schema        |               2.7 GB |

The source has `wal_level=logical`. It has 24 replication slots and 24 WAL
senders. The measured WAL rate is approximately 0.39 MB/s. The current
`max_slot_wal_keep_size` is 32 GB.

Monitor retained WAL until both subscriptions are disabled after cutover.

## Migration scope

### Verified live `public` dependencies

The source `pg_stat_statements` counters were reset on 2026-06-24.
The counters prove that the application still reads these legacy Suna tables:

| Relation           | Calls since reset |
| ------------------ | ----------------: |
| `public.projects`  |             6,206 |
| `public.resources` |               149 |
| `public.threads`   |             1,086 |
| `public.messages`  |             1,076 |

The same counters distinguish the retired and current credit tables:

| Relation                 | Calls since reset |
| ------------------------ | ----------------: |
| `public.credit_accounts` |                 0 |
| `public.credit_ledger`   |                 1 |
| `kortix.credit_accounts` |         4,475,763 |
| `kortix.credit_ledger`   |           311,776 |

The application also called the public credit RPC functions at least 295,678
times since the reset. These functions operate on `kortix.credit_accounts` and
`kortix.credit_ledger`.

The current control-table row counts are:

| Relation                        |    Rows |
| ------------------------------- | ------: |
| `public.daily_refresh_tracking` | 389,009 |
| `public.renewal_processing`     |   3,450 |
| `public.contact_forms`          |     101 |
| `public.webhook_config`         |       1 |

Do not treat the complete `public` schema as one migration unit. Select live
relations by verified repository dependency, production query activity, and
the approved retention policy.

### Always migrate

1. All `kortix` schema data.
2. All Supabase Auth users, identities, MFA factors, and required Auth data.
3. The current `avatars` Storage bucket.
4. These `public` control tables:

   - `daily_refresh_tracking`
   - `renewal_processing`
   - `contact_forms`
   - `webhook_config`

5. The `public` credit functions and Auth signup trigger from
   `packages/db/drizzle/0000_bootstrap.sql`.
6. The `kortix_global_tick` cron job created by
   `kortix.configure_scheduler(...)` after source writers stop at cutover.

### Do not migrate as live runtime data

1. `cron.job_run_details`.
2. `net._http_response`.
3. `net.http_request_queue`.
4. The 3,537 legacy jobs named `trigger_<uuid>`.
5. Legacy `public` billing tables superseded by `kortix.credit_accounts` and
   `kortix.credit_ledger`.
6. Legacy `public` API keys superseded by `kortix.api_keys`.
7. Legacy operational and analytics tables with no current repository
   dependency.

The legacy trigger jobs call removed routes:

- 2,201 jobs call `/api/triggers/<uuid>/webhook`.
- 1,336 jobs call `/v1/triggers/<uuid>/webhook`.

The latest 24,538 `pg_net` responses all returned HTTP `404`. Do not recreate
these jobs on the target.

### Product decision: legacy Suna data

The self-service Suna migration feature reads four legacy tables:

- `public.projects`
- `public.resources`
- `public.threads`
- `public.messages`

The complete four-table corpus is approximately 112 GiB. The current
repository still exposes these routes:

- `GET /v1/projects/suna-migration/eligibility`
- `POST /v1/projects/suna-migration/start`
- `GET /v1/projects/suna-migration/status`

Verified account scope on 2026-07-25:

| Scope                                       | Accounts | Projects | Resources | Threads |  Messages |
| ------------------------------------------- | -------: | -------: | --------: | ------: | --------: |
| Active in the last 30 days and not migrated |      712 |    6,011 |     4,196 |   5,897 |   706,172 |
| Active 31 to 90 days ago and not migrated   |    2,955 |   88,141 |    17,319 |  86,858 | 2,457,654 |
| Active in the last 90 days and not migrated |    3,667 |   94,152 |    21,515 |  92,755 | 3,163,826 |

The 90-day subset is approximately 6.4 GiB with proportional index overhead.

Migration policy:

1. Do not copy `public.projects`.
2. Do not copy `public.resources`.
3. Do not copy `public.threads`.
4. Do not copy `public.messages`.
5. Keep `KORTIX_SUNA_MIGRATION_WORKER_ENABLED=false` on the US shadow.
6. Keep the EU source unchanged through cutover and rollback.

The API treats a missing `public.projects` relation as zero eligible projects.
The retired self-service Suna migration path therefore stays unavailable on the
US target.

### Product decision: legacy Storage

Do not copy these source buckets:

- `agent-profile-images`
- `browser-screenshots`
- `file-uploads`
- `image-uploads`
- `legacy-migrations`
- `staged-files`

The current repository directly reads and writes `avatars`. The migration tool
therefore defaults to `STORAGE_BUCKETS=avatars`.

## Supabase support requirements

Open one Supabase support case before the production cutover.

Request these actions:

1. Validate the live logical replication of all 22 selected Auth relations.
2. Clone or safely reapply the original Google OAuth secret, GitHub OAuth
   secret, and Twilio Verify auth token.
3. Set or explain these platform-managed Auth differences:

   - `mfa_allow_low_aal`: source `true`, target `false`.
   - `audit_log_disable_postgres`: source `false`, target `true`.
   - `index_worker_ensure_user_search_indexes_exist`: source `false`, target
     `true`.

4. Validate the imported source HS256 compatibility key.
5. Validate PostgreSQL 15.8 to 17.6 compatibility.
6. Coordinate the `supa.kortix.com` custom-domain transfer.
7. Confirm the write-freeze, final synchronization, and rollback procedure.
8. Confirm that no platform action is required for the completed `avatars`
   object copy.

Submit the request through:

<https://supabase.com/dashboard/support/new>

The Management API personal access token cannot submit this form. The
`/platform/feedback/send` request returns HTTP `401` without a dashboard JWT.

Official references:

- <https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore>
- <https://supabase.com/docs/guides/resources/migrating-to-supabase/postgres>
- <https://supabase.com/docs/guides/platform/custom-domains>

## Pre-cutover blockers

Do not start the production write freeze until all four blockers close.

1. Supabase Support confirms the Auth replication, JWT compatibility, and
   custom-domain procedure.
2. The target receives the original plaintext Google OAuth secret, GitHub OAuth
   secret, and Twilio Verify token.
3. Google login, GitHub login, and phone MFA complete on the target.
4. The maintenance window and rollback owner are assigned.

The source Management API returns one-way 64-character representations for
configured provider secrets. Do not copy those values to another project.

The source access-token header uses `HS256` with non-UUID
`kid=b2pXFwm+imtLLxBI`. Supabase signing-key IDs must be UUIDs. The target has
the original source secret as the active signing key
`9871968b-feba-4720-b80e-ba8ae1bbec17`.

- A direct source access token returns HTTP `403` from target Auth.
- A source refresh token exchanges successfully on target Auth.
- The exchanged target access token uses `HS256` with
  `kid=9871968b-feba-4720-b80e-ba8ae1bbec17`.

Supabase Support must map the source non-UUID `kid` to the imported target key,
or approve a cutover that forces active sessions through refresh-token
exchange. Do not assume active access tokens work directly on target Auth.

The Management API accepted a PATCH for the three platform-managed Auth fields.
It kept the target values unchanged. Supabase Support must change or approve
those fields.

SMTP is complete. The target uses the original Mailtrap token. SMTP
authentication returns `235 2.7.0 Ok`. Auth recovery returns HTTP `200`.

The target Google and GitHub client IDs match the source. Their providers
remain disabled because the original plaintext secrets are unavailable. The
target Twilio Verify account SID and messaging-service SID match the source.
Phone MFA remains disabled because the original Twilio Verify auth token is
unavailable.

Apple Auth requires no source provider secret. Its client ID matches, and the
provider is enabled on the target. SAML is also enabled on the target.

## Current validation evidence

The target smoke returns:

```json
{
  "passwordLogin": true,
  "emailRecovery": true,
  "apiAuthenticated": true,
  "targetSchemaUserVisible": true,
  "totpEnrollment": true,
  "totpChallenge": true,
  "aal2Token": true,
  "signedAvatar": true,
  "publicAvatar": true,
  "cleanupRows": 0
}
```

The cleanup check covers:

- `auth.audit_log_entries`
- `auth.identities`
- `auth.mfa_factors`
- `auth.refresh_tokens`
- `auth.sessions`
- `auth.users`
- `kortix.audit_events`

The source refresh-token smoke returns:

```json
{
  "sourcePasswordLogin": true,
  "sourceRowsReplicated": true,
  "targetRefreshToken": true,
  "targetUserEndpoint": true,
  "sourceTokenAlg": "HS256",
  "sourceTokenKid": "<source-non-UUID-kid>",
  "targetTokenAlg": "HS256",
  "targetTokenKid": "<target-key-UUID>",
  "targetSequenceReserved": true,
  "cleanupSourceRows": 0,
  "cleanupTargetRows": 0,
  "error": null
}
```

Auth row counts, primary-key hashes, and critical-row hashes match.

Application row counts and hashes change while production accepts writes.
Observed differences occur on active tables such as:

- `audit_events`
- `credit_ledger`
- `stripe_webhook_events_processed`
- `api_keys.last_used_at`
- `session_sandboxes.last_used_at`
- `session_sandboxes.metadata`
- `session_sandboxes.updated_at`

The repair command removes target-only smoke state and copies the current source
values for mutable shadow-tested columns. Exact equality remains a cutover gate.

All 79 `avatars` objects pass complete source and target SHA-256 verification.

The US shadow endpoints return:

- API `/v1/health`: HTTP `200`, version `0.10.14`.
- Gateway `/health/live`: HTTP `200`, version `0.10.14`.
- Gateway `/health`: HTTP `200`, API dependency `up`.
- Frontend `/`: HTTP `200` from Vercel `fra1::cle1`.
- Frontend HTML contains `api-use2-shadow.kortix.com`.
- Frontend HTML contains the target project ref `uhrwvisbqjfxhxjvoofd`.

### Database connection requirement

The direct target database endpoint accepts connections from the migration
host. A Fargate probe returned `ECONNREFUSED` for the same endpoint.

The regional session pooler accepted the Fargate connection. The
`kortix-prod-us-east-2-env` secret therefore uses the session pooler on port
`5432` with user `postgres.uhrwvisbqjfxhxjvoofd`.

Do not replace the runtime `DATABASE_URL` with the direct database endpoint.
Keep the direct endpoint in `kortix/prod-us-east-2-migration` for logical
replication and migration administration.

## Target preparation

1. Run the fresh-project bootstrap.
2. Apply the repository migration ledger with `pnpm migrate`.
3. Verify every migration on PostgreSQL 17.6.
4. Verify all required extensions, functions, triggers, RLS policies, grants,
   and sequences.
5. Insert the source `webhook_config` row without printing its values.
6. Keep `cron.job` empty until source writers stop at cutover.
7. Keep application traffic disabled.

Do not use `supabase db push`. The repository migration ledger is the schema
source of truth.

## Data movement

1. Take a consistent initial copy.
2. Start logical replication for approved application tables.
3. Copy Auth through its dedicated logical subscription.
4. Copy `avatars` with byte and SHA-256 reconciliation.
5. Do not copy the legacy Suna tables or legacy Storage buckets.
6. Reset every migrated sequence to `max(column) + 1`.
7. Monitor replication lag and retained WAL.

Logical replication does not advance target sequences. Do not accept target
Auth writes while source Auth remains writable. A stale
`auth.refresh_tokens_id_seq` causes refresh-token rotation to return HTTP `500`
after a duplicate primary-key insert.

Do not publish Supabase-owned internal tables through a publication owned by
the application role. Supabase Support must handle those schemas.

### Continuous synchronization commands

Inspect both subscriptions:

```bash
bash scripts/prod-us-east-2/db-sync.sh status
bash scripts/prod-us-east-2/auth-sync.sh status
```

Refresh the application publication after source and target migrations:

```bash
ALLOW_REPLICATION_REFRESH=1 \
  bash scripts/prod-us-east-2/refresh-replication.sh
```

Repair target-only smoke mutations:

```bash
ALLOW_TARGET_SHADOW_REPAIR=1 \
  bash scripts/prod-us-east-2/db-sync.sh repair-shadow-mutations

ALLOW_TARGET_AUTH_SHADOW_REPAIR=1 \
  bash scripts/prod-us-east-2/auth-sync.sh repair-shadow-mutations
```

Synchronize and verify `avatars`:

```bash
bash scripts/prod-us-east-2/storage-sync.sh
STORAGE_VERIFY_ALL=1 bash scripts/prod-us-east-2/storage-sync.sh
```

Run the target smoke:

```bash
bash scripts/prod-us-east-2/target-smoke.sh
```

Run the source refresh-token compatibility smoke:

```bash
ALLOW_SOURCE_AUTH_REFRESH_SMOKE=1 \
  bash scripts/prod-us-east-2/auth-refresh-smoke.sh
```

The refresh smoke reserves a temporary high target sequence range. It restores
`auth.refresh_tokens_id_seq` to the current target maximum after cleanup.

The production release calls
`.github/workflows/deploy-prod-us-east-2-shadow.yml`. It applies target
migrations, refreshes application replication, synchronizes `avatars`, deploys
the released API and gateway images, and verifies the shadow endpoints.

## Reconciliation gates

The cutover cannot complete until all gates pass.

1. Row counts match for every migrated table.
2. Primary-key set hashes match for every migrated table.
3. Critical aggregate hashes match for Auth, billing, accounts, projects,
   sessions, and API keys.
4. The `avatars` object count and total bytes match.
5. A deterministic object sample passes content checksum verification.
6. Auth password login succeeds on the target.
7. MFA enrollment and challenge succeed on the target.
8. Signed Storage URLs and public object URLs succeed on the target.
9. Credit use, credit add, and renewal idempotency succeed on the target.
10. New-user signup fires the welcome webhook once.
11. API-key authentication uses `kortix.api_keys`.
12. `kortix_global_tick` fires once per minute after source writers stop.
13. Logical replication lag reaches zero.
14. The target passes the production smoke suite before DNS changes.

## Application topology

The active production backend uses ECS Fargate in `eu-west-2`.

- EU API: `4/4` tasks.
- EU gateway: `2/2` tasks.
- EU EKS: standby.

The prepared US backend uses the same active topology.

- US API: `2/2` tasks, autoscaling range `2..10`.
- US gateway: `2/2` tasks, autoscaling range `2..6`.
- US EKS: not provisioned.
- US frontend: Vercel project `suna-us-east-2-shadow` in `cle1`.

US EKS is not required for the database and traffic cutover. The US ECS stack
matches the current active production backend. Provision US EKS later if the
post-cutover design requires a same-region standby.

## Cutover

1. Confirm all pre-cutover blockers are closed.
2. Raise the production maintenance notice.
3. Block new API, gateway, and `supa.kortix.com` requests at Cloudflare.
4. Stop EU ECS and EKS application writers.
5. Disable the source scheduler, trigger scheduler, channels, workers, and cron
   writers.
6. Wait for both replication slots to reach the source WAL position.
7. Run both target-only repair commands.
8. Run exact application and Auth row-count reconciliation.
9. Run exact application and Auth primary-key hash reconciliation.
10. Run exact application and Auth critical-row hash reconciliation.
11. Copy application and Auth sequence state.
12. Run the final complete `avatars` synchronization and SHA-256 verification.
13. Disable both target subscriptions only after all final checks pass.
14. Transfer `supa.kortix.com` to the target project with Supabase Support.
15. Update the production application secret to the target Supabase URLs and
    keys.
16. Confirm all production secret values contain no source project reference.
17. Roll the US API and gateway with worker flags still disabled.
18. Switch `api.kortix.com` and `gateway.kortix.com` to the US ECS origins.
19. Run authenticated API, web, Auth, Storage, billing, OAuth, MFA, scheduler,
    trigger, and gateway checks.
20. Enable US schedulers and workers one group at a time.
21. Remove the Cloudflare maintenance block.
22. Clear the production maintenance notice.

Target downtime: the final write freeze, final reconciliation, secret switch,
custom-domain activation, and smoke checks.

The Cloudflare Worker switch values are:

- `ACTIVE_BACKEND=us-east-2`
- `GATEWAY_ACTIVE_BACKEND=us-east-2`

Do not set either value before step 18.

## Rollback

Rollback is permitted only before target writes reopen.

1. Keep the source project unchanged until all target checks pass.
2. Keep target schedulers and workers disabled during validation.
3. If a target check fails, restore the production application secret.
4. Point `api.kortix.com`, `gateway.kortix.com`, and `supa.kortix.com` back to
   their source origins.
5. Start EU ECS and EKS application services.
6. Re-enable source schedulers, workers, channels, and cron.
7. Remove the Cloudflare maintenance block.
8. Discard target writes from the failed rehearsal.

After target writes reopen, use a forward recovery plan. Do not run two
writable primaries.
