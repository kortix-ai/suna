---
recorded: 2026-09-22T16:34:43Z
incident_date: 2026-09-22
commit: 5aefbc8a2e
---
# Resolve the LLM payee before touching the Kortix wallet

**Rule:** Every BYOK descriptor uses `billingMode: 'none'`, `markup: 0`, and
only customer-owned credentials. Never append a managed fallback. Run wallet
admission only after resolution selects a Kortix-billed descriptor. Account
Billing sums `final_cost`; provider spend belongs only in Gateway observability.
**Incident:** A new free account showed provider-side BYOK spend as a Kortix LLM
charge, while active compute stayed at $0 until stop. **Enforcers:**
`resolve-candidates.test.ts`, `simple-handler.test.ts`,
`handlers-byok.test.ts`, `session-costs.test.ts`, and `cost-rollups.test.ts`.
