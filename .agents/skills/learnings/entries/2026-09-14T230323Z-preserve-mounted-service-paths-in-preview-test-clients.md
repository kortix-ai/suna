---
recorded: 2026-09-14T23:03:23Z
commit: 3274c25bed
---
# Preserve mounted service paths in preview test clients

**Incident (2026-09-14, PR #7233):** preview gateway tests reached the API because the REST test client discarded `/_gateway`. Gateway health returned `kortix-api`, and inference routes returned `404`. The deployed gateway itself remained healthy.

**Rule:** preserve the preview gateway mount in anonymous requests and authenticated client clones. API flows continue to supply their own `/v1` path.

**Enforcer:** `tests/unit/client-ci-passthrough.test.ts` asserts both mounted health and authenticated inference URLs. The regression failed before the client fix; both client suites then passed all 22 tests.
