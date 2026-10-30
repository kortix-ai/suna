---
recorded: 2026-10-30T00:30:43Z
incident_date: 2026-10-30
---
# Let the topmost dialog consume Escape before closing an embedded detail

**Rule:** An embedded detail's document Escape listener must yield to an already-consumed event, an open floating menu, or a dialog above the detail. An ancestor container does not count as a covering dialog. Keep mobile dismissal with the native drawer.

**Trigger surface:** Opening Comments, a menu, or a confirmation above an embedded Artifact detail.

**Incident:** Section 5 preview verification found one Escape closed both Comments and its underlying Artifact detail. Enter on Close dismissed only Comments. The detail listener ignored defaultPrevented and active child layers.

**Enforcement:** `detail-view-escape.test.tsx` mounts the real Modal and dropdown menu, then verifies sequential Escape dismissal. It also covers unconsumed confirmation/menu events, a consumed event, the ordinary detail close, and native mobile drawer dismissal. Hosted browser verification repeats nested Escape before merge.
