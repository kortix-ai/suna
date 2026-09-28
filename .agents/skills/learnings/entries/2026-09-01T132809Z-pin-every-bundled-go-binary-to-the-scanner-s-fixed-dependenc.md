---
recorded: 2026-09-01T13:28:09Z
incident_date: 2026-09-01
commit: 66a703aaca
---
# Pin every bundled Go binary to the scanner's fixed dependency floor

**When:** you add or update a Go binary copied into `apps/api/Dockerfile`, or a
root dependency installed by its `--filter kortix --prod=false` layer. The
production image contains both. Pin each binary's module graph to Trivy's fixed
version, then scan the complete `linux/amd64` image.

*Incident:* Deploy Dev run `33501907712`, job `99838193732`, failed on
`CVE-2026-56854`. Caddy contained `x/crypto v0.53.0`; Supabase CLI contained
`v0.54.0`. Both were below the fixed `v0.55.0`.
*Enforcer:* `apps/kortix-app-runtime/build_test.go`,
`scripts/worktree/__tests__/contract.test.ts`, and the Deploy Dev Trivy gate.
