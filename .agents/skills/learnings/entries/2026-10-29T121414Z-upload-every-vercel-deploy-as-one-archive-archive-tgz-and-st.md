---
recorded: 2026-10-29T12:14:14Z
incident_date: 2026-10-29
---
# Upload every Vercel deploy as one archive (--archive=tgz) and stamp the commit explicitly

**Rule:** Every `vercel deploy` in a workflow passes `--archive=tgz`. Vercel refuses a deploy of more than 15,000 files, and the repository tree passed that number. An archive deploy does not promise git metadata, so a deploy that reports its commit passes `--build-env NEXT_PUBLIC_KORTIX_COMMIT=<sha>`.

**Trigger surface:** Adding or editing a `vercel deploy` step in `.github/workflows/`, or deploying kortix.com by hand.

**Incident:** v0.14.9, 2026-10-29. The tree had 15,077 files. `Deploy prod web to Vercel` failed with "`files` should NOT have more than 15000 items, received 15088" (Deploy Prod 40868757807) after the API already served 0.14.9. kortix.com stayed on 0.14.8 for ~35 min, and the GitHub Release, the installers, the Slack post and the VERSION syncs never ran, because they need that job. A rerun cannot pass: it uses the workflow file on `prod`. Recovery: the same deploy by hand with `--archive=tgz` and the commit stamp, then the blocked jobs by hand. Staging already used `--archive=tgz`.

**Enforcement:** `tests/unit/web-ecs-workflow.test.ts` ("uploads every Vercel deploy as one archive") fails when a `vercel deploy` line in `deploy-prod.yml` or `deploy-staging.yml` lacks `--archive=tgz`, or prod does not stamp `NEXT_PUBLIC_KORTIX_COMMIT`.
