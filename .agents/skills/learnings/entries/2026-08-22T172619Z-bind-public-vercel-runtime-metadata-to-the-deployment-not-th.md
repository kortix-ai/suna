---
recorded: 2026-08-22T17:26:19Z
incident_date: 2026-08-22
commit: 3cbea56afe
---
# Bind public Vercel runtime metadata to the deployment, not the project environment

**When:** passing public release metadata to a Vercel Production deployment.
Use `vercel deploy --env KORTIX_PUBLIC_<NAME>=<value>`. Do not add a
`NEXT_PUBLIC_*` Production project variable. Vercel CLI 59.4.0 infers secret
visibility and rejects public framework prefixes. *Incident:* v0.13.3 left
`kortix.com` on v0.13.2 after `env add NEXT_PUBLIC_KORTIX_VERSION` failed.
*Enforcer:* `web-ecs-workflow.test.ts` pins the deployment-scoped runtime value.
