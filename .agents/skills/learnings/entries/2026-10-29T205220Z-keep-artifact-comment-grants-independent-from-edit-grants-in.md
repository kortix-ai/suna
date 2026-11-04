---
recorded: 2026-10-29T20:52:20Z
incident_date: 2026-10-29
---
# Keep Artifact comment grants independent from edit grants in role controls

**Rule:** Give Artifact comments their own role control. Grant only the selected permission and its server-defined implications. Never require Artifact or file writes to grant comments. Extend seeded-role fixtures when a new migration uses another SQL seed shape.

**Trigger surface:** Adding a permission to the catalog or grouping permissions in the role capability matrix.

**Incident:** PR #11110 CI found four role-matrix drift failures after `project.artifact.comment` joined the catalog. The matrix grouped comments with Artifact writes, and the role fixture missed the migration's `IN ('manager', 'member')` seed. The UI needed a separate Comment cell and a parser that preserved both built-in grants.

**Enforcement:** `role-capability-matrix.test.ts` verifies independent toggles, implication removal, complete catalog coverage, and lossless folds. `role-capability-matrix.render.test.tsx` invokes the displayed Comment checkbox and asserts the emitted role contains exactly comment and read. All nine web catalogs contain the new label and accessible label.
