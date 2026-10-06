---
recorded: 2026-09-04T06:43:16Z
incident_date: 2026-09-04
commit: 7602bc1251
---
# A secret allowlist and its runtime collector must be one definition

**When:** forwarding CI secrets into a generated preview or deployment runtime.
**Incident:** `deploy-preview.yml` exported `MANAGED_GIT_GITHUB_TOKEN` and the preview
allowlist accepted it, but `sandbox-preview.ts` copied a separate ten-key list that omitted it.
Adding the Actions secret would still have left managed Git unavailable inside the API container.
**Rule:** derive collection and forwarding from one allowlist. Never duplicate secret key names.
**Enforcer:** `preview-stack.test.ts` iterates `PREVIEW_RUNTIME_SECRET_ALLOWLIST` and proves every
listed value is trimmed, forwarded, and isolated from unlisted environment variables.
