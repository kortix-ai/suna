---
recorded: 2026-10-22T10:38:15Z
incident_date: 2026-10-21
---
# Answer a provider's refusal of a Kortix-owned key as Kortix, and log it as an error

**Rule:** When a proxy injects a Kortix-owned key, a provider's refusal of that key is Kortix's outage, not the caller's error. That means a refused key (401), no credit (402), a rate limit (429), or a plan limit (Tavily 432/433). Answer it as Kortix (`503 tool_unavailable` with a sentence that says it is not the caller's account), and log it at error level. Pass it through unchanged only when the key is the caller's own.

**Trigger surface:** adding or changing a service in `apps/api/src/router/config/proxy-services.ts`, or any code that calls a third party with a platform key on a user's behalf.

**Incident:** 2026-10-21, KRTX-3022. The Kortix Tavily account reached its plan limit (38,003 of 38,000 searches). The same key is in the dev, staging and prod env files. From then on, every `web_search` in a session failed with `432 … Please upgrade your plan or contact support@tavily.com`. Users were told to upgrade a plan they do not have. The proxy passed provider 4xx through without a log line, so nothing alerted. A dogfood session found it first.

**Enforcement:** `apps/api/src/router/routes/proxy/handlers-platform-refusal.test.ts` (PR for KRTX-3022). It fails when a platform-key 401/402/429/432 passes through, when the error line is missing, or when a caller's own key stops passing through. Still to build: an alert on the error line, and a usage check of each platform key (Tavily `GET /usage`) before it runs out.
