---
recorded: 2026-10-30T13:16:54Z
incident_date: 2026-10-30
---
# Keep code block DOM mutations scoped to Tiptap contentDOM

**Rule:** Let Tiptap classify code block mutations against its real `contentDOM`. A `NodeViewContent` wrapper is not the content node. Keep caption and diagram event routing separate from mutation ownership.

**Trigger surface:** React code block node views, mutation observers, and document editor rendering.

**Incident:** On 2026-10-30, a dev document with a code fence froze the browser and exhausted memory. A custom mutation handler treated the initial content node insertion as an edit. ProseMirror reparsed and remounted the node repeatedly. An isolated reproduction exceeded 700 MiB in less than two seconds. The same document without code fences loaded.

**Enforcement:** `doc-editor.wiring.test.tsx` mounts real editable and read-only code blocks with a bounded mutation observer. It verifies stable code content, no writes during mount, and subsequent code editing. The old handler fails without exhausting memory.
