---
recorded: 2026-10-04T22:54:03Z
incident_date: 2026-10-04
---
# Rotate the web gate password in every blob the deploy verifier reads, not only the env being served

**Rule:** when you rotate `WEB_PROTECTION_PASSWORD`, write the same value to
`kortix-dev-web-env` AND `kortix-staging-web-env` in AWS SM, redeploy both web
services, and prove each host returns `200` with the new value before the next
Deploy Dev. The dev verifier reads the password from the **staging** blob.

**Trigger surface:** rotating the dev or staging web gate password, or editing
`WEB_PROTECTION_PASSWORD` in `apps/web/.env.dev` / `.env.staging`.

**Incident:** 2026-10-04, during the leaked-secrets rotation. `#9151` committed
one new value for dev and staging, but `kortix-staging-web-env` held a
different value. Deploy Dev 37240152717 then failed "Verify canonical Dev
frontend on ECS" with `protected=401` for 160 attempts, although the API build
and dev migrations succeeded and dev served the new commit. Fix: set the staging
blob to the dev value and force a new `kortix-staging-web` deployment.

**Enforcement:** none yet: a `pnpm test:envs --sm` check that
`kortix-dev-web-env.WEB_PROTECTION_PASSWORD == kortix-staging-web-env.WEB_PROTECTION_PASSWORD`,
because `deploy-dev.yml` reads the staging blob for the dev check.
