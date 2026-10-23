---
recorded: 2026-10-23T01:00:32Z
incident_date: 2026-10-20
---
# Open a Better Stack incident only for failures customers see, never for failures a fallback absorbs

**Rule:** A Better Stack monitor opens an incident, and every incident is SOC 2 audit evidence. Point a monitor only at a customer-facing failure that lasts: requests that fail after every upstream and fallback, sustained for minutes. Report a failure the gateway absorbs (an upstream 429 that a fallback answers, an open circuit, a Langfuse streak) as a warning in the authenticated `/health` body, never in the public `status`.

**Trigger surface:** adding or changing a Better Stack monitor, heartbeat or keyword; adding an entry to `incidents` in `apps/llm-gateway/src/health.ts`; changing what sets the public `/health` `status`.

**Incident:** near miss, no customer impact. #10277 added `upstream capacity` to the gateway `/health` incidents at 20% of a model's requests meeting an upstream failure, fallbacks included, and a Better Stack `keyword_absence` monitor (5096440) on that text. 2026-10-20 05:44 to 2026-10-21 17:41 UTC it opened 9 incidents (9 to 76 min). In those hours at most 1.6% of managed requests failed after the fallbacks (hourly, prod `gateway_request_logs`). After #10749 the public body carries only `status`, so the keyword monitor could never fire again: dead in prod since v0.14.7. Fix: the incidents/warnings split in `health.ts` and `traffic.ts`; monitor 5096440 became an HTTP status check, and becomes `keyword_absence` `degraded` with `confirmation_period` 600 once prod serves the split.

**Enforcement:** `apps/llm-gateway/src/traffic.test.ts` (absorbed 429s are a warning only; failures after every fallback are an incident from 20% of 20+ requests over 300 s) and `apps/llm-gateway/src/health.test.ts` (a warning keeps the public status `healthy`). No gate checks the Better Stack monitor config: none yet, the enforcer to build is monitors as Terraform (`betterstack` provider).
