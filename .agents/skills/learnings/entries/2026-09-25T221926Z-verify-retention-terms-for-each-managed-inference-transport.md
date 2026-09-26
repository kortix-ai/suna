---
recorded: 2026-09-25T22:19:26Z
incident_date: 2026-09-26
---
# Verify retention terms for each managed inference transport

**Rule:** Verify ZDR terms and data location for each direct API transport before
adding it to a managed model. An OpenRouter ZDR listing does not establish the
terms for the same provider's separate direct API. Enforce approved endpoint
allowlists at request resolution, including operator overlays.

**Trigger surface:** `MANAGED_MODELS`, `managedCandidates`, or managed credentials.

**Incident:** On 2026-09-26, an audit found managed turns routed directly to
Morph while its public standard paid policy allowed content retention. No
enterprise ZDR agreement was verified. The affected surface included three
managed models.

**Enforcement:** `managed.test.ts` excludes Morph from bundled OpenRouter pools;
`descriptors.test.ts` checks the per-model Morph selection and rejects
unverified OpenRouter endpoints. Direct Morph remains selected for two models
by default; its contractual controls require separate review.
