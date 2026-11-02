---
recorded: 2026-10-30T16:37:44Z
incident_date: 2026-10-30
---
# A self-hosted Next.js image must carry earlier builds' static chunks

**Rule:** Every Next.js frontend image that a deploy rolls in place of another (ECS, a self-host upgrade) must still serve the hashed `_next/static` files of the builds before it. A tab loaded before the deploy keeps requesting its own build's chunk names. Vercel keeps old deployment assets; a container image holds only its own build.

**Trigger surface:** Moving a web surface from Vercel to ECS or another container host (the `*-fe-ecs` cutovers for staging and prod); changing `build-frontend` in `deploy-dev.yml`; changing `apps/web/Dockerfile`'s static COPY.

**Incident:** 2026-10-30, dev.kortix.com. Two frontend rollouts landed 10 min apart (`26a25c5034` at 15:37, `61db0e7bdd` at 15:46 UTC). A tab on the first build crashed on its next lazy import: "Something went wrong — Failed to load chunk /_next/static/chunks/<hash>.js". The chunk existed only in the previous image. The reload-once client recovery reloads the old URL, so the click is lost, and a second failure within 45 s shows the crash card. Fixed in #11228.

**Enforcement:** `infra/scripts/carry-web-static.sh` runs in `deploy-dev.yml` `build-frontend` (keeps the newest 5 builds) and `tests/unit/carry-web-static.test.ts` covers carry and prune. None yet for the staging/prod ECS web builds: wire the same script into their image builds before any DNS cutover.
