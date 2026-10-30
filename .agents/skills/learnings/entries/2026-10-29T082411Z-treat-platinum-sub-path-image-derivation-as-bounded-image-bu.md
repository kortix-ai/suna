---
recorded: 2026-10-29T08:24:11Z
incident_date: 2026-10-29
---
# Treat Platinum sub_path image derivation as bounded image-building work

**Rule:** Map Platinum's exact 503/unavailable sub_path derivation refusal to SnapshotStillBuildingError. Reuse the bounded image-building retry window and retain the create identity.

**Trigger surface:** Platinum sandbox creation from a template whose sub_path image is still being derived.

**Incident:** 2026-10-29, KRTX-3648: six background provisioning failures occurred within seven minutes. Generic three-attempt retries exhausted before provider derivation completed. Unrelated 503s must remain ordinary provider failures.

**Enforcement:** apps/api/src/platform/providers/platinum-region.test.ts exercises recovery after four refusals, stable create identity, the 30-attempt bound, home/regional creates, and unrelated error passthrough.
