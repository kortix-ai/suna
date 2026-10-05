---
recorded: 2026-09-03T12:06:52Z
incident_date: 2026-09-03
commit: a19b406cee
---
# A single-origin preview turns service base paths into part of the test contract

- **Incident (2026-09-03, `pi-worker` preview):** `target-full` configured the
  standalone gateway as `https://pi.kortix.com/_gateway`. The black-box client
  reduced every configured URL to its origin, so gateway `/health` reached the
  API `/health`, and gateway `/v1/*` calls reached API routes or 404 responses.
  The same preview disabled its landing page while the browser lane required
  the public `/` and `/pricing` contracts.
- **Rule:** preserve a deployed service's configured path prefix when requests
  use service-relative route templates. A preview runtime configuration must
  expose every public surface that its strict target suite exercises.
- **Enforcement:** `Client.forBaseUrl()` keeps the prefix through auth and retry
  clones while retaining the original coverage key. `client-resilience.test.ts`
  pins prefixed and root service URLs. `preview-stack.test.ts` requires preview
  marketing pages to remain enabled.
