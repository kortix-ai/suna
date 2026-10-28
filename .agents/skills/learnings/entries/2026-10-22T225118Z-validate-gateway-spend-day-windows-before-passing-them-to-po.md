---
recorded: 2026-10-22T22:51:18Z
incident_date: 2026-10-22
---
# Validate gateway spend day windows before passing them to PostgreSQL

**Rule:** Reject fractional and non-finite day windows at the HTTP boundary before integer-typed SQL interval arguments.

**Trigger surface:** Gateway spend overview, series, sessions and breakdown query validation.

**Incident:** KRTX-3194, 2026-10-22, production 0.14.6. A 1.5-day series request returned 500 with PostgreSQL 22P02 because range clamping preserves fractions.

**Enforcement:** gateway-characterization.test.ts calls all four real HTTP routes with fractional days and expects 400.
