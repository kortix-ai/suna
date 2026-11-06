---
recorded: 2026-11-05T14:35:04Z
incident_date: 2026-11-05
---
# Bind project identifiers to their route account before checking owner roles

**Rule:** Check that every client-supplied project_id belongs to the account in the route before checking roles, reading project secrets, or using cached provider usage. Account-owner authorization alone does not establish this relationship. Recheck access before returning cached results.

**Trigger surface:** Account-scoped endpoints that accept project identifiers, secret consumer adapters, and authenticated caches.

**Incident:** 2026-11-05, PR #11832: the subscription usage routes checked account membership and project read permission but omitted project/account binding. An account owner could supply a different tenant project UUID and reach its legacy ChatGPT login. The ordinary-member negative test passed because it did not exercise implicit owner permissions. Strix found the gap after the dev merge. A local two-account owner regression reproduced HTTP 200 instead of 403. No production deployment occurred in this session.

**Enforcement:** apps/api/src/__tests__/integration-subscription-discovery-http.test.ts covers an owner of one account supplying another account project to list and refresh routes. apps/api/src/llm-gateway/legacy-subscription-usage.test.ts covers adapter binding, authorization before cache reuse, concurrent fetch coalescing, and the 60-second read window.
