---
recorded: 2026-10-30T00:24:23Z
incident_date: 2026-10-30
---
# Reserve a Close control lane beside overlay discussion headers

**Rule:** When a discussion header sits beneath an overlay Close control, reserve a separate header lane for that control. Keep the reservation local to the overlay. Verify native pointer clicks at the Close button's center; DOM presence does not prove reachability.

**Trigger surface:** Artifact discussion in an embedded viewer or a narrow standalone viewer.

**Incident:** Section 5 preview verification found the full-width Activity tab above the Modal Close button at a 1440px viewport. Native clicks hit Activity while Escape still closed the overlay. The docked sidebar had no overlapping control.

**Enforcement:** `artifact-discussion-layout.test.tsx` covers overlay-only header spacing, embedded and narrow layouts, docked spacing, and the real Modal Close callback. `artifact-discussion-sidebar.test.tsx` verifies the exact header boundary. Hosted browser verification requires native Close hit-testing before merge.
