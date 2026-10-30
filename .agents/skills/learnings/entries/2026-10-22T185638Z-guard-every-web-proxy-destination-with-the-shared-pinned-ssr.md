---
recorded: 2026-10-22T18:56:38Z
incident_date: 2026-10-22
---
# Guard every web-proxy destination with the shared pinned SSRF resolver

**Rule:** Resolve every caller-selected destination through the shared SSRF guard,
regardless of port. Connect to the vetted address and recheck redirects.
Register bundled shared sources in the daemon fingerprint and standalone build.

**Trigger surface:** Changing daemon forward-proxy targets or shared egress imports.

**Incident:** 2026-10-22, KRTX-3071, source-review finding. The previous check
only protected selected control-plane ports. No live exploitation was reproduced.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/web-proxy-ssrf.test.ts`
rejects private targets on ordinary ports and proves DNS pinning and redirect checks.
`shared-sources.test.ts` verifies the fingerprint registry and Docker copies.
