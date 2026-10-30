---
recorded: 2026-10-21T21:53:57Z
incident_date: 2026-10-21
---
# Rebuild a Vercel prod deployment with the same --env and --build-env deploy-prod.yml passes, never a bare redeploy

**Rule:** To rebuild kortix.com outside `deploy-prod.yml` (for example after changing a Vercel env var), pass the same per-deployment values the workflow passes: `env.KORTIX_PUBLIC_VERSION` and `build.env.NEXT_PUBLIC_KORTIX_VERSION` set to the live version. Then check `https://kortix.com/api/runtime-config` shows that `VERSION`.

**Trigger surface:** A Vercel "Redeploy" (dashboard button or `POST /v13/deployments` with `deploymentId`) of the production `suna` project. `deploy-prod.yml` deploys with `vercel deploy --prod --env KORTIX_PUBLIC_VERSION=… --build-env NEXT_PUBLIC_KORTIX_VERSION=…`. Those flags belong to that one deployment and are not project env vars, so a redeploy rebuilds without them.

**Incident:** 2026-10-21, during the Supabase publishable-key rollover (pentest 2026-07 finding 3). A bare redeploy of the live v0.14.4 deployment, to bake in the new anon key, served `VERSION: "dev"` on kortix.com for about 3 minutes. A second rebuild with the two values restored `0.14.4`. Sign-in and data were not affected. The version label and the deploy verification read that value.

**Enforcement:** none yet. To build: a scheduled check that `kortix.com/api/runtime-config` `VERSION` equals the `:stable` release version, or a project-level `KORTIX_PUBLIC_VERSION` that `deploy-prod.yml` updates before it deploys, so a redeploy keeps the version.
