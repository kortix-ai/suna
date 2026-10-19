---
recorded: 2026-10-19T18:34:01Z
incident_date: 2026-10-19
---
# Gate managed models on the plan entitlement alone, with no per-model exemption

**Rule:** An account reaches a Kortix-managed model only when `entitlements.managedModels` is true. Never add an exemption for one model (the platform default), for a fallback, or for a default chain: every exemption is a path for Free credits to buy managed inference.

**Trigger surface:** Changing `plan-catalog.ts` / `tiers.ts` entitlements, `resolveManagedCandidates` in `resolve-candidates.ts`, the default chain (`effective.ts`, `default-model.ts`), the gateway catalog (`catalog-models.ts`), or the SDK picker (`model-visibility.ts`).

**Incident:** 2026-10-19. KRTX-1067 let every plan use the platform default model. #10147 then set `managedModels: true` on Free. #10277 let the platform default's fallback resolve for every plan. Free accounts ran DeepSeek V4.1 Flash, GLM 5.3 Flash and Kimi K3 on their 500 included credits. The model picker on prod listed all three for a Free account.

**Enforcement:** `unit-resolve-candidates-free-tier.test.ts` (every managed id, the platform default included, refuses a Free account), `resolve-candidates.test.ts`, `catalog-models.test.ts` (the Free catalog holds no managed id), `effective.test.ts`, `composer-models.test.ts` (the SDK picker hides every managed model on Free), `model-gate-managed-models.test.ts`.
