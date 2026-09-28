---
recorded: 2026-08-29T21:58:38Z
commit: 7fac1545b8
---
# An action endpoint must refresh a replicated mirror before returning 404

- **Incident (2026-08-29, v0.13.9 release QA):** `CLI-TRG` created a trigger,
  then `triggers ls` and `triggers info` found it through refreshed API
  replicas. The subsequent `triggers fire` request reached a different replica
  whose Git mirror was still inside its 60-second cache interval. That replica
  returned `404 Not found` in two consecutive release-gate attempts.
- **Rule:** a mutable-resource action endpoint can use its replica cache for the
  first lookup. It must force one source refresh before it returns a definitive
  not-found response. A successful read through another replica does not prove
  fleet-wide cache convergence.
- **Enforcement:** `findProjectTriggerBySlug()` retries a missing cached trigger
  through `readManifest(..., { forceRefresh: true })`. A per-project cooldown
  limits forced fetches to one per Git refresh interval. The manual fire route
  uses this helper. Unit tests prove cached-hit, forced-refresh, and bounded-miss
  sequences.
