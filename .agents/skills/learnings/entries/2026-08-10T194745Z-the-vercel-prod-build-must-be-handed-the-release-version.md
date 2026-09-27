---
recorded: 2026-08-10T19:47:45Z
incident_date: 2026-08-10
commit: 427fc1a175
---
# The Vercel prod build must be handed the release version

**When:** touching deploy-prod's Vercel deploy or apps/web/next.config version
resolution. The Vercel build (rootDirectory apps/web) cannot reliably read the
repo-root VERSION file, so runtime-config reports "dev" and
frontend-auth-proof's `VERSION === X.Y.Z` check fails. Pass
`--build-env NEXT_PUBLIC_KORTIX_VERSION=<version>` on every prod deploy (the
`deploy-web-vercel` job does); the project env `NEXT_PUBLIC_KORTIX_VERSION` is
a static fallback that goes stale — the build-env override wins.
*Incident:* v0.12.7 frontend served VERSION "dev"; gate exhausted 30 attempts;
fixed by `vercel redeploy` after setting the env.
