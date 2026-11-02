---
recorded: 2026-10-30T13:48:05Z
incident_date: 2026-10-30
---
# Capture pending document saves before mount effects run

**Rule:** Capture the pending save promise when initializing a waiting document editor. Subscribe to that promise after mount. Do not look it up again in an effect: completion can remove it between render and effect.

**Trigger surface:** Reopening a Doc Artifact while its previous editor finishes a save.

**Incident:** On 2026-10-30, browser crash investigation exposed a second loading failure. The initial render saw a pending save and disabled content reads. The save completed before the mount effect, which found no pending promise and left the editor waiting forever. This failure is separate from the code block mutation loop.

**Enforcement:** `doc-editor.handoff.test.tsx` controls only the handoff effect while using the actual saver, pending map, editor, and React cleanup. It verifies completion before and after effect registration, resumed content reads, and no initial saves. The original lookup fails the before-effect case.
