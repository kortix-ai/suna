---
recorded: 2026-10-30T10:08:03Z
incident_date: 2026-10-30
---
# Select the exact pooled frame before focus and callbacks

**Rule:** After claiming a pooled frame, select the iframe whose `data-frame-key` equals the requested key. Use that frame for focus and ownership callbacks. A released frame can remain in the same slot until its parking microtask runs.

**Trigger surface:** Artifact frame-key changes, including saved and historical versions.

**Incident:** The historical HTML comment probe displayed the correct document but received no host handshake or pins. `slot.querySelector('iframe')` returned the old frame before deferred parking. The channel then rejected messages because its cached frame no longer belonged to the Viewer slot.

**Enforcement:** `packages/ui/src/artifacts/artifact-frame.test.tsx` changes the immutable frame key in a mounted component. It asserts the new callback, keyboard focus, new source URL, and old-frame parking. The real historical probe verifies three readonly pins and zero comment POSTs.
