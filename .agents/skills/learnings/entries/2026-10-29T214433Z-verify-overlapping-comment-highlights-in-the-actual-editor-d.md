---
recorded: 2026-10-29T21:44:33Z
incident_date: 2026-10-29
---
# Verify overlapping comment highlights in the actual editor DOM

**Rule:** Group overlapping comment ranges into disjoint segments with every covering thread ID. Test the actual EditorView DOM and events in editable and read-only modes. Keep text selection intact. Never infer DOM reachability from DecorationSet entries alone.

**Trigger surface:** Adding interactive ProseMirror decorations or focusing a comment from its highlighted text.

**Incident:** Section 5 browser verification created two threads on the same quote. Both decorations existed, but ProseMirror merged their DOM attributes and hid one thread. The review also found that ordinary handleKeyDown does not run in read-only views. Grouped segments and DOM event handlers preserve access to both threads without changing Markdown.

**Enforcement:** `doc-comment-decorations.test.ts` mounts actual EditorView instances. It checks exact and partial overlaps, pointer and keyboard cycling, read-only activation, preserved selection, unchanged document data, membership scrolling, and late focus. The section 5 browser proof uses thread membership selectors.
