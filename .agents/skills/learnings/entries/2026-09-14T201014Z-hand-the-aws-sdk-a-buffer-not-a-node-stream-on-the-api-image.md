---
recorded: 2026-09-14T20:10:14Z
incident_date: 2026-09-13
commit: ccd3f7596d
---
# Hand the AWS SDK a Buffer, not a Node stream, on the API image's Bun 1.2

**When:** uploading a file with `@aws-sdk/client-s3` from `apps/api` (image
`BUN_VERSION=1.2`, 1.2.23). `PutObjectCommand({ Body: createReadStream(path) })`
never completes on that Bun and pins a core at 90 % — the same call with
`Body: await readFile(path)` finishes in 15–30 ms, and HeadObject, GetObject,
conditional put (412) and presigning all work. Laptop/CI Bun 1.3/1.4 stream
fine, so unit + integration tests are green while the deployed leader's
snapshot worker would spin forever without publishing.
*Near-miss:* the project-snapshot producer (`project-snapshot-store.ts`),
caught pre-merge by running the call shapes under `oven/bun:1.2-slim`.
*Enforcer:* `apps/api/scripts/project-snapshot-s3-probe.ts` run inside the
image's Bun (runbook `project-snapshot-s3.md`); nothing runs it in CI yet.
