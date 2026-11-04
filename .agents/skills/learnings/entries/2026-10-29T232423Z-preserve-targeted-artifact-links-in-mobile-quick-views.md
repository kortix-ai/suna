---
recorded: 2026-10-29T23:24:23Z
incident_date: 2026-10-30
---
# Preserve targeted Artifact links in mobile quick views

**Rule:** Preserve the target through each responsive quick-view branch. Render Artifact URLs through the registered Artifact Viewer without waiting for a session runtime. Clear the target on close and a real session change. Scope one-time Browser navigation to both the tab ID and target URL.

**Trigger surface:** Session chat links, mobile tool drawers, and targeted Browser quick views.

**Incident:** Section 5 preview preparation found that widths below 768px discarded the link target. A chat Artifact link opened the ordinary Browser drawer instead of the discussion Viewer. Desktop tests did not cover that branch.

**Enforcement:** `mobile-tool-drawer.test.tsx` mounts the actual drawer at 720px with the registered Viewer. It checks boot independence, A-to-B draft isolation, native close, and ordinary URL navigation. `kortix-computer-store.test.ts` checks target replacement, close, reset, and session isolation.
