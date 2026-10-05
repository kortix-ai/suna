---
recorded: 2026-09-04T11:45:20Z
incident_date: 2026-09-04
commit: 0ea36cfd55
---
# A persistent preview cannot assume its dependency store matches the new lockfile

- **Incident (2026-09-04, `pi-worker` preview):** the branch preview reused its
  persistent Platinum sandbox after the branch added the Pi worker package.
  The new lockfile-specific warm template contained the dependency, but the
  reusable sandbox did not switch templates. Its bootstrap ran only
  `pnpm install --offline --frozen-lockfile`. pnpm returned
  `ERR_PNPM_NO_OFFLINE_TARBALL` for `@earendil-works/pi-agent-core@0.84.3`.
  The command failed before Docker started, so the new origin never served
  `/v1/health` and the router kept the previous target.
- **Rule:** an offline dependency install is an accelerator, not a correctness
  boundary, in any sandbox that survives lockfile changes. Retry the same
  frozen lockfile install with network access after an offline cache miss.
  Never retry without `--frozen-lockfile`.
- **Enforcement:** `buildPreviewBootstrapScript()` runs
  `pnpm install --offline --frozen-lockfile || pnpm install --frozen-lockfile`.
  `sandbox-preview.test.ts` pins both commands in that order.
