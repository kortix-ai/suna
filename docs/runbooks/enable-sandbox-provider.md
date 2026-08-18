# Runbook: enable a sandbox provider on a deployed environment

Turning a provider on is **one atomic edit to that environment's secret blob**,
followed by a service rollout. It is not a code change, and doing it in two
steps takes the environment down.

## The hazard, first

`apps/api/src/config.ts` treats a missing provider credential as fatal wherever
billing is on:

```ts
const providerKeyLevel: 'error' | 'warn' = billingOn ? 'error' : 'warn';
```

Dev, staging and prod all run with billing on. So adding a provider to
`ALLOWED_SANDBOX_PROVIDERS` while its API key is absent fails env validation at
boot, and **every API task dies on start**. The provider name and its key must
land in the same `put-secret-value`. Never split them, and never add the name
"first, to see if it works".

The reverse order is safe: a key present with the provider not yet listed is
inert (`parseAllowedProviders` ignores it, and `isE2BEnabled()` and friends
require both).

## What actually carries the value

`modules/ecs-api` prefers `secrets_blob_arn`, so ECS injects the **entire**
secret JSON as one variable and the per-key `secrets` map in
`environments/<env>/variables.tf` is inert. Keep that map exact anyway — its
own comment explains why (if `secrets_blob_arn` is ever removed, a missing
entry silently drops a key) — but understand that editing terraform alone
changes nothing at runtime.

| environment | secret | region | cluster/service |
| --- | --- | --- | --- |
| dev | `kortix-dev-env` | `us-west-2` | `kortix-dev` |
| staging | `kortix-staging-env` | `us-west-2` | `kortix-staging` |
| prod | `kortix-prod-env` | `eu-west-2` | `kortix-prod` |

Secrets resolve at task start, so a rollout is required for the change to take
effect: `aws ecs update-service --force-new-deployment`.

## Procedure

1. Back up the current blob to a local file, `chmod 600`. This is the revert.
2. Read the provider key from the encrypted profile
   (`dotenvx get <KEY> -f apps/api/.env.<env>`) — never paste it on a command
   line or into a tracked file.
3. Merge **both** changes into one payload: add the key, and append the
   provider to `ALLOWED_SANDBOX_PROVIDERS`.
4. `put-secret-value` once.
5. `update-service --force-new-deployment`, then `wait services-stable`.
6. Verify: `/health` returns ok, and a session created with
   `{"provider":"<name>"}` reaches `running` and reports that
   `sandbox_provider`.
7. Add the key to `environments/<env>/variables.tf` so the inert map stays
   exact.

## Provider-specific notes

- **e2b** — needs only `E2B_API_KEY`. `E2B_DOMAIN` defaults to `e2b.dev` and
  `E2B_TEMPLATE` is an optional fallback; omit both unless self-hosting E2B.
  The first session on a new environment triggers a template build, which runs
  with `skipCache: true` (E2B's remote cache has been observed dropping COPY
  layer outputs), so it re-uploads the whole context and takes several minutes.
  Expect the first `POST /sessions` to fail with "still building" and succeed on
  a later attempt — that is the build finishing, not a defect.
- **daytona** — needs `DAYTONA_API_KEY`, `DAYTONA_SERVER_URL`, `DAYTONA_TARGET`;
  all three are checked individually.
- **platinum** — needs `PLATINUM_API_KEY`. It is the only provider with a
  credential edge, so enabling it also changes which network-boundary mechanism
  a project gets (see `docs/NETWORK_BOUNDARY_WITHOUT_PLATINUM.md`).

## Rollback

Put the backup back and roll again. Nothing else holds provider state: the
allow-list is read fresh at boot, and sessions already running on the removed
provider keep working until they end.
